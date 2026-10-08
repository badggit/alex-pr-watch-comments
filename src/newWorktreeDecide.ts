import { safeText } from './validate.ts';
import { WORKTREE_PREFIX } from './watchWorktree.ts';

export interface RegisteredWorktree {
    path: string;
    folderName: string;
    branch: string | undefined;
    detached: boolean;
    locked: boolean;
    missing: boolean;
}

export interface TargetFacts {
    target: string;
    branch: string;
    baseGiven: boolean;
    targetIsOwnTree: boolean;
    targetState: 'absent' | 'symlink' | 'present' | 'unreadable';
    registered: RegisteredWorktree | undefined;
    holder: string | undefined;
    localBranch: boolean;
    remoteMatches: readonly string[];
}

export type ManualDecision =
    | { kind: 'reuse' }
    | { kind: 'checkout' }
    | { kind: 'track'; remote: string }
    | { kind: 'create' }
    | { kind: 'refuse'; reason: string };

const BASE_ONLY_NEW = '--base applies only to a new branch';

function refuse(reason: string): ManualDecision {
    return { kind: 'refuse', reason };
}

// The remote part of a REMOTE/BRANCH name, or undefined when the match does not end with the branch: the branch
// itself may contain slashes, so the split point cannot be guessed.
function remoteOf(match: string, branch: string): string | undefined {
    const suffix = `/${branch}`;
    return match.endsWith(suffix) && match.length > suffix.length ? match.slice(0, -suffix.length) : undefined;
}

function decideRegistered(facts: TargetFacts, registered: RegisteredWorktree): ManualDecision {
    const shownPath = safeText(registered.path);
    if (registered.folderName.startsWith(WORKTREE_PREFIX)) {
        return refuse(`${shownPath} is a worktree of the PR watcher; pick another name`);
    }
    if (registered.missing) {
        return refuse(`${shownPath} is a registered worktree whose folder is missing; run git worktree prune first`);
    }
    if (registered.locked) {
        return refuse(`${shownPath} is a locked worktree`);
    }
    if (registered.detached || registered.branch === undefined) {
        return refuse(`${shownPath} is a worktree on a detached HEAD, not on branch ${safeText(facts.branch)}`);
    }
    if (registered.branch !== facts.branch) {
        return refuse(
            `${shownPath} is a worktree on branch ${safeText(registered.branch)}, not on ${safeText(facts.branch)}`
        );
    }
    return facts.baseGiven ? refuse(`${BASE_ONLY_NEW}; ${shownPath} already exists`) : { kind: 'reuse' };
}

function decideBranch(facts: TargetFacts): ManualDecision {
    const branch = safeText(facts.branch);
    if (facts.localBranch) {
        return facts.baseGiven ? refuse(`${BASE_ONLY_NEW}; branch ${branch} already exists`) : { kind: 'checkout' };
    }
    const [onlyMatch] = facts.remoteMatches;
    if (facts.remoteMatches.length > 1) {
        const candidates = facts.remoteMatches.map((match) => safeText(match)).join(', ');
        return refuse(`branch ${branch} exists on several remotes (${candidates}); create it locally first`);
    }
    if (onlyMatch !== undefined) {
        const remote = remoteOf(onlyMatch, facts.branch);
        if (remote === undefined) {
            return refuse(`cannot tell the remote of ${safeText(onlyMatch)} for branch ${branch}`);
        }
        return facts.baseGiven
            ? refuse(`${BASE_ONLY_NEW}; branch ${branch} exists as ${safeText(onlyMatch)}`)
            : { kind: 'track', remote };
    }
    return { kind: 'create' };
}

// The first matching rule wins: own tree, symlink, unreadable target (fail closed, before any reuse), registered
// worktree, something present, branch held elsewhere, then the branch rules (local, remote, new).
export function decideManualWorktree(facts: TargetFacts): ManualDecision {
    const target = safeText(facts.target);
    if (facts.targetIsOwnTree) {
        return refuse(`${target} is the main working tree`);
    }
    if (facts.targetState === 'symlink') {
        return refuse(`${target} is a symlink; refusing to follow it`);
    }
    if (facts.targetState === 'unreadable') {
        return refuse(`cannot read ${target}`);
    }
    if (facts.registered !== undefined) {
        return decideRegistered(facts, facts.registered);
    }
    if (facts.targetState === 'present') {
        return refuse(`something already exists at ${target}`);
    }
    if (facts.holder !== undefined) {
        return refuse(`branch ${safeText(facts.branch)} is checked out in another worktree: ${safeText(facts.holder)}`);
    }
    return decideBranch(facts);
}
