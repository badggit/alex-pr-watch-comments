import { gitIn } from './guards.ts';
import type { LinkDeps } from './ignoredLinks.ts';
import { canonicalDir, confirmedMainTree, gitDirsOf, isLinked, type GitDirs } from './linkedWorktree.ts';
import type { CommandResult } from './types.ts';
import { safeText } from './validate.ts';
import { canonical } from './watchWorktree.ts';

// current and main are canonical absolute top levels; main equals current when mainFound is false. linked tells
// that current is a linked worktree, not the main working tree.
export interface RepoLayout {
    current: string;
    main: string;
    mainFound: boolean;
    linked: boolean;
}

export type RepoResult = { ok: true; repo: RepoLayout } | { ok: false; reason: string };

// A linked worktree never gets a sibling, so its main tree is looked up only to name it in the reply.
async function linkedLayout(deps: LinkDeps, gitPath: string, current: string, dirs: GitDirs): Promise<RepoLayout> {
    const main = await confirmedMainTree(deps, gitPath, current, dirs.commonDir);
    return main === undefined
        ? { current, main: current, mainFound: false, linked: true }
        : { current, main, mainFound: true, linked: true };
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
    const dirs = await gitDirsOf(deps, gitPath, current);
    if (dirs === undefined) {
        return { ok: false, reason: `cannot read the git directories of ${safeText(current)}` };
    }
    if (isLinked(dirs)) {
        return { ok: true, repo: await linkedLayout(deps, gitPath, current, dirs) };
    }
    const reason = await superprojectRefusal(deps, gitPath, current);
    if (reason !== undefined) {
        return { ok: false, reason };
    }
    return { ok: true, repo: { current, main: current, mainFound: true, linked: false } };
}
