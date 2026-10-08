import path from 'node:path';

import { gitIn } from './guards.ts';
import type { LinkDeps } from './ignoredLinks.ts';
import type { CommandResult } from './types.ts';
import { safeText } from './validate.ts';
import { canonical, listWorktrees } from './watchWorktree.ts';

// current and main are canonical absolute top levels; main equals current when mainFound is false.
export interface RepoLayout {
    current: string;
    main: string;
    mainFound: boolean;
}

export type RepoResult = { ok: true; repo: RepoLayout } | { ok: false; reason: string };

// The single line git printed, or undefined when git failed or printed nothing.
async function revParse(deps: LinkDeps, gitPath: string, dir: string, flag: string): Promise<string | undefined> {
    const result = await gitIn(deps, gitPath, dir, ['rev-parse', flag]);
    const value = result.stdout.endsWith('\n') ? result.stdout.slice(0, -1) : result.stdout;
    return result.code === 0 && value.length > 0 ? value : undefined;
}

// A relative directory printed by rev-parse is relative to the directory git ran in.
async function canonicalDir(deps: LinkDeps, gitPath: string, dir: string, flag: string): Promise<string | undefined> {
    const value = await revParse(deps, gitPath, dir, flag);
    return value === undefined ? undefined : canonical(path.resolve(dir, value));
}

interface FirstEntry {
    main: string | undefined;
    toplevel: string | undefined;
}

// The first worktree list entry is the main working tree only when it is a real working tree of our repository:
// a bare clone or a separate git dir puts a git directory there instead. The entry's own top level is kept even
// when it does not confirm: for a linked worktree of a submodule it is the submodule's working tree.
async function firstEntry(deps: LinkDeps, gitPath: string, current: string, commonDir: string): Promise<FirstEntry> {
    const [first] = (await listWorktrees(deps, gitPath, current)) ?? [];
    if (first === undefined || first.bare) {
        return { main: undefined, toplevel: undefined };
    }
    const entry = canonical(first.path);
    const toplevel = await canonicalDir(deps, gitPath, entry, '--show-toplevel');
    const entryCommon = await canonicalDir(deps, gitPath, entry, '--git-common-dir');
    return { main: toplevel === entry && entryCommon === commonDir ? entry : undefined, toplevel };
}

interface Located {
    repo: RepoLayout;
    // Every directory whose superproject must be checked: main, plus the first entry's top level when it differs.
    probes: string[];
}

async function locateMain(deps: LinkDeps, gitPath: string, current: string): Promise<Located> {
    const gitDir = await canonicalDir(deps, gitPath, current, '--absolute-git-dir');
    const commonDir = await canonicalDir(deps, gitPath, current, '--git-common-dir');
    if (gitDir !== undefined && gitDir === commonDir) {
        return { repo: { current, main: current, mainFound: true }, probes: [current] };
    }
    const first =
        commonDir === undefined
            ? { main: undefined, toplevel: undefined }
            : await firstEntry(deps, gitPath, current, commonDir);
    let repo: RepoLayout;
    if (first.main === undefined) {
        deps.log.info(
            `the main working tree could not be determined; using the current working tree ${safeText(current)} as the source and name base`
        );
        repo = { current, main: current, mainFound: false };
    } else {
        repo = { current, main: first.main, mainFound: true };
    }
    const probes = [repo.main];
    if (first.toplevel !== undefined && first.toplevel !== repo.main) {
        probes.push(first.toplevel);
    }
    return { repo, probes };
}

function errorLine(result: CommandResult): string {
    const [first = ''] = result.stderr.trim().split('\n', 1);
    return first.length > 0 ? safeText(first) : `git exited with code ${String(result.code)}`;
}

// Fails closed: a probe git could not answer refuses just like a probe that found a superproject.
async function superprojectRefusal(deps: LinkDeps, gitPath: string, dir: string): Promise<string | undefined> {
    const result = await gitIn(deps, gitPath, dir, ['rev-parse', '--show-superproject-working-tree']);
    if (result.code !== 0) {
        return `cannot check whether ${safeText(dir)} is inside a superproject: ${errorLine(result)}`;
    }
    const superproject = result.stdout.endsWith('\n') ? result.stdout.slice(0, -1) : result.stdout;
    if (superproject.length === 0) {
        return;
    }
    return `the main working tree ${safeText(dir)} is a submodule; a sibling worktree would land inside the superproject ${safeText(superproject)}`;
}

export async function locateRepository(deps: LinkDeps, gitPath: string, cwd: string): Promise<RepoResult> {
    const dir = canonical(cwd);
    const shownCwd = safeText(cwd);
    const inside = await gitIn(deps, gitPath, dir, ['rev-parse', '--is-inside-work-tree']);
    if (inside.code !== 0) {
        return { ok: false, reason: `not a git repository: ${shownCwd}` };
    }
    if (inside.stdout.trim() !== 'true') {
        return { ok: false, reason: `not inside a git working tree: ${shownCwd}` };
    }
    const current = await canonicalDir(deps, gitPath, dir, '--show-toplevel');
    if (current === undefined) {
        return { ok: false, reason: `not a git repository: ${shownCwd}` };
    }
    const { repo, probes } = await locateMain(deps, gitPath, current);
    for (const probe of probes) {
        const reason = await superprojectRefusal(deps, gitPath, probe);
        if (reason !== undefined) {
            return { ok: false, reason };
        }
    }
    return { ok: true, repo };
}
