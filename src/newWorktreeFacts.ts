import fs from 'node:fs';
import path from 'node:path';

import { gitIn } from './guards.ts';
import type { LinkDeps } from './ignoredLinks.ts';
import type { WorktreeTarget } from './newWorktreeArgs.ts';
import type { RegisteredWorktree, TargetFacts } from './newWorktreeDecide.ts';
import type { RepoLayout } from './newWorktreeRepo.ts';
import type { CommandResult } from './types.ts';
import { safeText } from './validate.ts';
import { canonical, entryExists, listWorktrees, samePath, type WorktreeEntry } from './watchWorktree.ts';

export type StartResult = { ok: true; sha: string } | { ok: false; reason: string };

export type FactsResult = { ok: true; facts: TargetFacts } | { ok: false; reason: string };

type LockState = 'locked' | 'unlocked' | 'unknown';

type RefCheck = { ok: true; exists: boolean } | { ok: false; reason: string };

const GITDIR_LINE = /^gitdir: (.+?)\r?\n?$/u;

const OBJECT_ID = /^(?:[\da-f]{40}|[\da-f]{64})$/u;

// show-ref --verify --quiet exits 1 for a ref that does not exist; every other nonzero exit is an error.
const REF_ABSENT_CODE = 1;

const BRANCH_REJECTED_CODE = 1;

function errorCode(error: unknown): unknown {
    return error instanceof Error && 'code' in error ? error.code : undefined;
}

function failureLine(result: CommandResult): string {
    const line = result.stderr.split('\n', 1)[0]?.trim() ?? '';
    if (result.spawnError !== undefined) {
        return result.spawnError;
    }
    return line.length > 0 ? line : `git exited with ${result.code}`;
}

// The base, or HEAD of the working tree at current when no base is given, peeled to a commit.
export async function resolveStartCommit(
    deps: LinkDeps,
    gitPath: string,
    current: string,
    base?: string
): Promise<StartResult> {
    if (base?.startsWith('-')) {
        return { ok: false, reason: `unknown commit: ${safeText(base)}` };
    }
    const ref = base ?? 'HEAD';
    const result = await gitIn(deps, gitPath, canonical(current), [
        'rev-parse',
        '--verify',
        '--quiet',
        `${ref}^{commit}`,
    ]);
    const sha = result.stdout.trim();
    if (result.code === 0 && OBJECT_ID.test(sha)) {
        return { ok: true, sha };
    }
    if (result.code === 0) {
        return { ok: false, reason: `cannot resolve commit: ${safeText(ref)}` };
    }
    return base === undefined
        ? { ok: false, reason: 'the current branch has no commits yet' }
        : { ok: false, reason: `unknown commit: ${safeText(base)}` };
}

export type BranchNameCheck = { kind: 'valid' } | { kind: 'invalid' } | { kind: 'error'; reason: string };

// check-ref-format exits 1 for a name it rejects; any other failure means git itself could not run the check.
export async function isGitBranchName(
    deps: LinkDeps,
    gitPath: string,
    current: string,
    branch: string
): Promise<BranchNameCheck> {
    const result = await gitIn(deps, gitPath, canonical(current), ['check-ref-format', `refs/heads/${branch}`]);
    if (result.spawnError === undefined && result.code === 0) {
        return { kind: 'valid' };
    }
    if (result.spawnError === undefined && result.code === BRANCH_REJECTED_CODE) {
        return { kind: 'invalid' };
    }
    return {
        kind: 'error',
        reason: `cannot check branch name ${safeText(branch)}: ${safeText(failureLine(result))}`,
    };
}

// The real path of the longest existing ancestor joined with the rest, so a path through a symlinked parent and its
// real spelling compare equal even when the final folder is gone. An existing path resolves completely.
function canonicalLoose(file: string): string {
    const tail: string[] = [];
    let head = path.resolve(file);
    for (;;) {
        try {
            return path.join(fs.realpathSync.native(head), ...tail.toReversed());
        } catch {
            const parent = path.dirname(head);
            if (parent === head) {
                return path.resolve(file);
            }
            tail.push(path.basename(head));
            head = parent;
        }
    }
}

// The admin directory a worktree's .git file points at, accepted only when its gitdir file points back at that
// .git file, so a stray or forged .git line cannot borrow the lock state of an unrelated directory.
function adminDirOf(worktreePath: string): string | undefined {
    const dotGit = path.join(worktreePath, '.git');
    let text: string;
    try {
        text = fs.readFileSync(dotGit, 'utf8');
    } catch {
        return undefined;
    }
    const adminDir = GITDIR_LINE.exec(text)?.[1];
    if (adminDir === undefined) {
        return undefined;
    }
    const adminPath = path.resolve(worktreePath, adminDir);
    let backLink: string;
    try {
        backLink = fs.readFileSync(path.join(adminPath, 'gitdir'), 'utf8');
    } catch {
        return undefined;
    }
    const record = backLink.endsWith('\n') ? backLink.slice(0, -1) : backLink;
    if (record.length === 0 || record.includes('\n')) {
        return undefined;
    }
    return canonicalLoose(path.resolve(adminPath, record)) === canonicalLoose(dotGit) ? adminPath : undefined;
}

// Reads the lock marker in the worktree's admin directory: git 2.29 prints no locked line in porcelain output.
export function lockedByAdminDir(worktreePath: string): LockState {
    const adminPath = adminDirOf(worktreePath);
    if (adminPath === undefined) {
        return 'unknown';
    }
    try {
        fs.lstatSync(path.join(adminPath, 'locked'));
        return 'locked';
    } catch (error) {
        return errorCode(error) === 'ENOENT' ? 'unlocked' : 'unknown';
    }
}

function targetStateOf(target: string): TargetFacts['targetState'] {
    try {
        return fs.lstatSync(target).isSymbolicLink() ? 'symlink' : 'present';
    } catch (error) {
        return errorCode(error) === 'ENOENT' ? 'absent' : 'unreadable';
    }
}

// True when a listed worktree path and the target name the same folder, also through a symlinked parent and
// when the folder itself is gone.
export function matchesTarget(entryPath: string, target: string): boolean {
    return entryPath === target || canonicalLoose(entryPath) === canonicalLoose(target);
}

function findRegistered(entries: readonly WorktreeEntry[], target: string): WorktreeEntry | undefined {
    return entries.find((entry) => entry.path === target) ?? entries.find((entry) => matchesTarget(entry.path, target));
}

function describeRegistered(entry: WorktreeEntry): RegisteredWorktree {
    const missing = entry.prunable || !entryExists(entry.path);
    return {
        path: entry.path,
        folderName: path.basename(canonicalLoose(entry.path)),
        branch: entry.branch,
        detached: entry.detached,
        // Fails closed: a lock state that cannot be read counts as locked. A missing folder has no .git file to read.
        locked: entry.locked || (!missing && lockedByAdminDir(entry.path) !== 'unlocked'),
        missing,
    };
}

async function checkRef(
    deps: LinkDeps,
    gitPath: string,
    current: string,
    ref: string,
    kind: string
): Promise<RefCheck> {
    const result = await gitIn(deps, gitPath, current, ['show-ref', '--verify', '--quiet', ref]);
    if (result.spawnError === undefined && (result.code === 0 || result.code === REF_ABSENT_CODE)) {
        return { ok: true, exists: result.code === 0 };
    }
    return { ok: false, reason: `cannot check ${kind} ${safeText(ref)}: ${safeText(failureLine(result))}` };
}

type RemoteMatches = { ok: true; matches: string[] } | { ok: false; reason: string };

// The REMOTE/BRANCH names of the remote-tracking refs already fetched.
async function remoteMatchesOf(
    deps: LinkDeps,
    gitPath: string,
    current: string,
    branch: string
): Promise<RemoteMatches> {
    const listed = await gitIn(deps, gitPath, current, ['remote']);
    if (listed.code !== 0 || listed.spawnError !== undefined) {
        return { ok: false, reason: 'cannot list the remotes of the repository' };
    }
    const matches: string[] = [];
    const remotes = listed.stdout.split('\n').filter((line) => line.length > 0);
    for (const remote of remotes) {
        const check = await checkRef(deps, gitPath, current, `refs/remotes/${remote}/${branch}`, 'remote branch');
        if (!check.ok) {
            return check;
        }
        if (check.exists) {
            matches.push(`${remote}/${branch}`);
        }
    }
    return { ok: true, matches };
}

export async function gatherFacts(
    deps: LinkDeps,
    gitPath: string,
    repo: RepoLayout,
    target: WorktreeTarget,
    baseGiven: boolean
): Promise<FactsResult> {
    const { current } = repo;
    const entries = await listWorktrees(deps, gitPath, current);
    if (entries === undefined) {
        return { ok: false, reason: 'cannot list the worktrees of the repository' };
    }
    const remote = await remoteMatchesOf(deps, gitPath, current, target.branch);
    if (!remote.ok) {
        return remote;
    }
    const local = await checkRef(deps, gitPath, current, `refs/heads/${target.branch}`, 'branch');
    if (!local.ok) {
        return local;
    }
    const entry = findRegistered(entries, target.path);
    const holder = entries.find((other) => other !== entry && other.branch === target.branch);
    return {
        ok: true,
        facts: {
            target: target.path,
            branch: target.branch,
            baseGiven,
            targetIsOwnTree: samePath(target.path, repo.main),
            targetState: targetStateOf(target.path),
            registered: entry === undefined ? undefined : describeRegistered(entry),
            holder: holder?.path,
            localBranch: local.exists,
            remoteMatches: remote.matches,
        },
    };
}
