import fs from 'node:fs';
import path from 'node:path';

import { gitIn } from './guards.ts';
import { isLinkExcluded, isOwnLink, removeIgnoredLinks, type LinkDeps } from './ignoredLinks.ts';
import { acquireWorktreeLock, releaseWorktreeLock } from './locks.ts';
import type { Deps, Session, WatchWorktree } from './types.ts';
import { safeText } from './validate.ts';

export const WORKTREE_PREFIX = 'alex-pr-watch-comments-pr-';

export interface WorktreeEntry {
    path: string;
    branch: string | undefined;
    bare: boolean;
    prunable: boolean;
}

export type WorktreeResult = { ok: true; worktree: WatchWorktree; created: boolean } | { ok: false; reason: string };

export interface WorktreeRequest {
    gitPath: string;
    sourceToplevel: string;
    prNumber: number;
    remote: string;
    branch: string;
}

const BRANCH_REF_PREFIX = 'refs/heads/';
const IN_PLACE_HINT = 'or start the watcher with --in-place';

// The watch worktree sits next to the owner's clone.
export function watchWorktreePath(sourceToplevel: string, prNumber: number): string {
    return path.join(path.dirname(sourceToplevel), `${WORKTREE_PREFIX}${prNumber}`);
}

// Parses git worktree list --porcelain: one block per working tree, separated by empty lines, the main one first.
export function parseWorktreeList(text: string): WorktreeEntry[] {
    const entries: WorktreeEntry[] = [];
    let current: WorktreeEntry | undefined;
    for (const line of text.split('\n')) {
        if (line.startsWith('worktree ')) {
            current = { path: line.slice('worktree '.length), branch: undefined, bare: false, prunable: false };
            entries.push(current);
        } else if (current !== undefined) {
            if (line.startsWith(`branch ${BRANCH_REF_PREFIX}`)) {
                current.branch = line.slice(`branch ${BRANCH_REF_PREFIX}`.length);
            } else if (line === 'bare') {
                current.bare = true;
            } else if (line === 'prunable' || line.startsWith('prunable ')) {
                current.prunable = true;
            }
        }
    }
    return entries;
}

function canonical(file: string): string {
    try {
        return fs.realpathSync.native(file);
    } catch {
        return file;
    }
}

function samePath(left: string, right: string): boolean {
    return left === right || canonical(left) === canonical(right);
}

async function listWorktrees(deps: LinkDeps, gitPath: string, dir: string): Promise<WorktreeEntry[] | undefined> {
    const listed = await gitIn(deps, gitPath, dir, ['worktree', 'list', '--porcelain']);
    return listed.code === 0 ? parseWorktreeList(listed.stdout) : undefined;
}

function entryExists(file: string): boolean {
    try {
        fs.lstatSync(file);
        return true;
    } catch {
        return false;
    }
}

// The working tree whose ignored paths are linked: the owner's clone, or the main working tree when the watcher was
// started from inside the watch worktree itself.
function linkSource(entries: readonly WorktreeEntry[], sourceToplevel: string, target: string): string {
    if (!samePath(sourceToplevel, target)) {
        return sourceToplevel;
    }
    const main = entries[0];
    return main !== undefined && !main.bare && !main.prunable ? main.path : target;
}

function refuse(reason: string): WorktreeResult {
    return { ok: false, reason };
}

function errorLine(stderr: string): string {
    const [first = ''] = stderr.trim().split('\n', 1);
    return safeText(first);
}

// Fetches into the remote-tracking ref only: the owner's FETCH_HEAD is left alone. Returns git's error text on a
// failure, undefined on success.
async function createWorktree(deps: LinkDeps, request: WorktreeRequest, target: string): Promise<string | undefined> {
    const { gitPath, sourceToplevel: dir, remote, branch } = request;
    const tracking = `refs/remotes/${remote}/${branch}`;
    const fetchArgs = [
        'fetch',
        '--quiet',
        '--no-write-fetch-head',
        remote,
        `+${BRANCH_REF_PREFIX}${branch}:${tracking}`,
    ];
    const fetched = await gitIn(deps, gitPath, dir, fetchArgs);
    if (fetched.code !== 0) {
        return `fetch failed: ${errorLine(fetched.stderr)}`;
    }
    const local = await gitIn(deps, gitPath, dir, ['show-ref', '--verify', '--quiet', `${BRANCH_REF_PREFIX}${branch}`]);
    const addArgs =
        local.code === 0
            ? ['worktree', 'add', '--quiet', target, branch]
            : ['worktree', 'add', '--quiet', '--track', '-b', branch, target, tracking];
    const added = await gitIn(deps, gitPath, dir, addArgs);
    return added.code === 0 ? undefined : errorLine(added.stderr);
}

type Decision = { kind: 'reuse' } | { kind: 'create' } | { kind: 'unregister' } | { kind: 'refuse'; reason: string };

function decide(entries: readonly WorktreeEntry[], target: string, branch: string): Decision {
    const shownTarget = safeText(target);
    const registered = entries.find((entry) => samePath(entry.path, target));
    if (registered !== undefined && (registered.prunable || !entryExists(registered.path))) {
        return { kind: 'unregister' };
    }
    if (registered !== undefined) {
        if (registered.branch === branch) {
            return { kind: 'reuse' };
        }
        return {
            kind: 'refuse',
            reason: `the watch worktree ${shownTarget} is not on ${branch} (switch it back or remove it with: git worktree remove ${shownTarget})`,
        };
    }
    if (entryExists(target)) {
        return {
            kind: 'refuse',
            reason: `${shownTarget} exists and is not a worktree of this repository (move it away, ${IN_PLACE_HINT})`,
        };
    }
    const holder = entries.find((entry) => entry.branch === branch);
    if (holder !== undefined) {
        return {
            kind: 'refuse',
            reason: `${branch} is checked out in ${safeText(holder.path)} (switch that working tree to another branch, ${IN_PLACE_HINT})`,
        };
    }
    return { kind: 'create' };
}

// Finds or creates the watch worktree next to the owner's clone, on the PR head branch. Changes nothing in the
// owner's working tree: it only fetches the head branch into its remote-tracking ref, may create the local branch
// and registers the worktree. A start racing with another start of the same PR re-reads the list once.
export async function prepareWatchWorktree(deps: LinkDeps, request: WorktreeRequest): Promise<WorktreeResult> {
    const { gitPath, sourceToplevel, branch } = request;
    const target = watchWorktreePath(sourceToplevel, request.prNumber);
    let failure = '';
    for (let attempt = 0; attempt < 2; attempt += 1) {
        const entries = await listWorktrees(deps, gitPath, sourceToplevel);
        if (entries === undefined) {
            return refuse('cannot list the worktrees of the clone');
        }
        const decision = decide(entries, target, branch);
        switch (decision.kind) {
            case 'refuse': {
                return refuse(decision.reason);
            }
            case 'reuse': {
                return {
                    ok: true,
                    worktree: { path: target, source: linkSource(entries, sourceToplevel, target) },
                    created: false,
                };
            }
            case 'unregister': {
                // Drops only this registration, whose directory is gone; git worktree prune would drop the
                // registrations of the owner's other missing worktrees too.
                const removed = await gitIn(deps, gitPath, sourceToplevel, ['worktree', 'remove', target]);
                failure = removed.code === 0 ? '' : errorLine(removed.stderr);
                break;
            }
            case 'create': {
                const error = await createWorktree(deps, request, target);
                if (error === undefined) {
                    return { ok: true, worktree: { path: target, source: sourceToplevel }, created: true };
                }
                failure = error;
                break;
            }
        }
    }
    const detail = failure.length > 0 ? `: ${failure}` : '';
    return refuse(`cannot create the watch worktree ${safeText(target)} on ${branch}${detail}`);
}

const CLEANUP_RUN_PREFIX = 'cleanup-';

// Ignored files other than own links and build and cache outputs: git worktree remove would delete them without
// asking.
async function ignoredKept(deps: LinkDeps, gitPath: string, worktree: WatchWorktree): Promise<string | undefined> {
    const args = ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'];
    const listed = await gitIn(deps, gitPath, worktree.path, args);
    if (listed.code !== 0) {
        return 'its ignored files cannot be listed';
    }
    const kept = listed.stdout
        .split('\0')
        .map((entry) => (entry.endsWith('/') ? entry.slice(0, -1) : entry))
        .filter(
            (entry) => entry.length > 0 && !isLinkExcluded(entry) && !isOwnLink(worktree.source, worktree.path, entry)
        );
    return kept.length === 0 ? undefined : `it holds ignored files: ${safeText(kept.slice(0, 3).join(', '))}`;
}

async function keepReason(deps: LinkDeps, session: Session, dir: string): Promise<string | undefined> {
    const gitPath = session.tools.git;
    const status = await gitIn(deps, gitPath, dir, ['status', '--porcelain', '--untracked-files=no']);
    if (status.code !== 0 || status.stdout.trim().length > 0) {
        return 'it has uncommitted changes to tracked files';
    }
    const tracking = `refs/remotes/${session.remote}/${session.headRef}`;
    const ahead = await gitIn(deps, gitPath, dir, ['rev-list', '--count', `${tracking}..HEAD`]);
    if (ahead.code !== 0) {
        return 'it cannot be compared with the remote branch';
    }
    return ahead.stdout.trim() === '0' ? undefined : 'it has commits that are not pushed';
}

// Removes the watch worktree of a closed PR when no run holds it, its tracked files are clean, every commit is
// pushed and it holds no ignored files but build and cache outputs; otherwise it is kept and the reason is logged.
// The local branch is kept. Never forced: git refuses a worktree with untracked files, which are then kept too.
export async function removeWatchWorktree(
    deps: Pick<Deps, 'runner' | 'log' | 'nowSeconds'>,
    session: Session
): Promise<boolean> {
    const { worktree, stateDir, worktreeKey: wtKey } = session;
    if (worktree === undefined) {
        return false;
    }
    const shown = safeText(worktree.path);
    const lockId = `${CLEANUP_RUN_PREFIX}${process.pid}`;
    if (!acquireWorktreeLock(stateDir, wtKey, lockId, process.pid, deps.log, deps.nowSeconds())) {
        deps.log.info(`kept the watch worktree ${shown}: a run holds it`);
        return false;
    }
    try {
        const reason = await keepReason(deps, session, worktree.path);
        if (reason !== undefined) {
            deps.log.info(`kept the watch worktree ${shown}: ${reason}`);
            return false;
        }
        const gitPath = session.tools.git;
        const ignored = await ignoredKept(deps, gitPath, worktree);
        if (ignored !== undefined) {
            deps.log.info(`kept the watch worktree ${shown}: ${ignored}`);
            return false;
        }
        if (!(await removeIgnoredLinks(deps, gitPath, worktree.source, worktree.path))) {
            deps.log.warn(`kept the watch worktree ${shown}: its links to the clone could not be removed`);
            return false;
        }
        const removed = await gitIn(deps, gitPath, worktree.source, ['worktree', 'remove', worktree.path]);
        if (removed.code !== 0) {
            deps.log.warn(`kept the watch worktree ${shown}: ${safeText(removed.stderr.trim())}`);
            return false;
        }
        deps.log.info(`removed the watch worktree ${shown}`);
        return true;
    } finally {
        releaseWorktreeLock(stateDir, wtKey, lockId);
    }
}
