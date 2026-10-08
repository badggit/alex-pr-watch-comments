import path from 'node:path';

import { gitIn } from './guards.ts';
import type { LinkDeps } from './ignoredLinks.ts';
import { canonical, listWorktrees } from './watchWorktree.ts';

// Both directories are canonical and absolute.
export interface GitDirs {
    gitDir: string;
    commonDir: string;
}

// The single line git printed, or undefined when git failed or printed nothing.
async function revParse(deps: LinkDeps, gitPath: string, dir: string, flag: string): Promise<string | undefined> {
    const result = await gitIn(deps, gitPath, dir, ['rev-parse', flag]);
    const value = result.stdout.endsWith('\n') ? result.stdout.slice(0, -1) : result.stdout;
    return result.code === 0 && value.length > 0 ? value : undefined;
}

// A relative directory printed by rev-parse is relative to the directory git ran in.
export async function canonicalDir(
    deps: LinkDeps,
    gitPath: string,
    dir: string,
    flag: string
): Promise<string | undefined> {
    const value = await revParse(deps, gitPath, dir, flag);
    return value === undefined ? undefined : canonical(path.resolve(dir, value));
}

// Undefined when git cannot tell; --path-format=absolute needs git 2.31, so relative output is resolved here.
export async function gitDirsOf(deps: LinkDeps, gitPath: string, dir: string): Promise<GitDirs | undefined> {
    const gitDir = await canonicalDir(deps, gitPath, dir, '--absolute-git-dir');
    const commonDir = await canonicalDir(deps, gitPath, dir, '--git-common-dir');
    return gitDir === undefined || commonDir === undefined ? undefined : { gitDir, commonDir };
}

// A linked worktree has a git directory of its own under the common one; a main working tree, a submodule and a
// separate-git-dir clone share one directory for both.
export function isLinked(dirs: GitDirs): boolean {
    return dirs.gitDir !== dirs.commonDir;
}

// The first worktree list entry is the main working tree only when it is a real working tree of our repository:
// a bare clone or a separate git dir puts a git directory there instead.
export async function confirmedMainTree(
    deps: LinkDeps,
    gitPath: string,
    dir: string,
    commonDir: string
): Promise<string | undefined> {
    const [first] = (await listWorktrees(deps, gitPath, dir)) ?? [];
    if (first === undefined || first.bare) {
        return;
    }
    const entry = canonical(first.path);
    const toplevel = await canonicalDir(deps, gitPath, entry, '--show-toplevel');
    const entryCommon = await canonicalDir(deps, gitPath, entry, '--git-common-dir');
    return toplevel === entry && entryCommon === commonDir ? entry : undefined;
}
