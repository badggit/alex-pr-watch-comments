import { gitIn } from './guards.ts';
import type { LinkDeps } from './ignoredLinks.ts';
import type { WorktreeTarget } from './newWorktreeArgs.ts';
import { matchesTarget } from './newWorktreeFacts.ts';
import type { RepoLayout } from './newWorktreeRepo.ts';
import type { CommandResult } from './types.ts';
import { safeText } from './validate.ts';
import { listWorktrees } from './watchWorktree.ts';

export type ApplyStep =
    { kind: 'reuse' } | { kind: 'checkout' } | { kind: 'track'; remote: string } | { kind: 'create'; startSha: string };

export type ApplyResult = { ok: true } | { ok: false; reason: string };

// A branch this invocation created: sha is where it pointed right after creation, tracked tells whether git
// wrote branch.BRANCH.remote and branch.BRANCH.merge for it.
interface OwnedBranch {
    sha: string;
    tracked: boolean;
}

type BranchResult = { ok: true; owned: OwnedBranch | undefined } | { ok: false; reason: string };

const BRANCH_REF_PREFIX = 'refs/heads/';
const SHORT_SHA_LENGTH = 7;
// git config --unset exits 5 when the key is absent.
const CONFIG_KEY_ABSENT = 5;
const UPSTREAM_KEYS: readonly string[] = ['remote', 'merge'];

function errorLine(result: CommandResult): string {
    const [first = ''] = result.stderr.trim().split('\n', 1);
    return first.length > 0 ? safeText(first) : `git exited with code ${String(result.code)}`;
}

function refuse(reason: string): ApplyResult {
    return { ok: false, reason };
}

// The commit a ref resolves to, or undefined when git cannot resolve it.
async function commitOf(deps: LinkDeps, gitPath: string, dir: string, ref: string): Promise<string | undefined> {
    const result = await gitIn(deps, gitPath, dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    const sha = result.stdout.trim();
    return result.code === 0 && sha.length > 0 ? sha : undefined;
}

// git refuses to overwrite an existing branch, so a failure here means the branch is not ours and is left alone.
async function createBranchAt(
    deps: LinkDeps,
    gitPath: string,
    dir: string,
    branch: string,
    sha: string,
    tracked: boolean
): Promise<BranchResult> {
    const created = await gitIn(deps, gitPath, dir, ['branch', '--no-track', branch, sha]);
    return created.code === 0 ? { ok: true, owned: { sha, tracked } } : { ok: false, reason: errorLine(created) };
}

// Deletes the branch only while it still points where this invocation created it, without following a symbolic
// ref. The upstream keys go only after the branch itself is gone. Another process checking out or recreating the
// branch between the list re-read, the delete and the config unset is an accepted risk: this invocation created
// the branch moments earlier.
async function rollbackBranch(
    deps: LinkDeps,
    gitPath: string,
    dir: string,
    branch: string,
    owned: OwnedBranch
): Promise<void> {
    const deleted = await gitIn(deps, gitPath, dir, [
        'update-ref',
        '--no-deref',
        '-d',
        `${BRANCH_REF_PREFIX}${branch}`,
        owned.sha,
    ]);
    if (deleted.code !== 0) {
        deps.log.warn(`branch ${safeText(branch)} was kept: ${errorLine(deleted)}`);
        return;
    }
    if (!owned.tracked) {
        return;
    }
    // Only the upstream keys are removed; others such as branch.BRANCH.rebase from autoSetupRebase stay.
    for (const key of UPSTREAM_KEYS) {
        const unset = await gitIn(deps, gitPath, dir, ['config', '--unset', `branch.${branch}.${key}`]);
        if (unset.code !== 0 && unset.code !== CONFIG_KEY_ABSENT) {
            deps.log.warn(`cannot remove branch.${safeText(branch)}.${key}: ${errorLine(unset)}`);
        }
    }
}

// The remote commit is pinned before creation, so ownership is the sha this invocation chose and never one that
// another process moved the branch to afterwards.
async function createTrackingBranch(
    deps: LinkDeps,
    gitPath: string,
    dir: string,
    branch: string,
    remote: string
): Promise<BranchResult> {
    const upstream = `${remote}/${branch}`;
    const sha = await commitOf(deps, gitPath, dir, `refs/remotes/${upstream}`);
    if (sha === undefined) {
        return { ok: false, reason: `cannot resolve the remote branch ${safeText(upstream)}` };
    }
    // tracked is true before the upstream is set: a failed set may still have written part of the keys.
    const created = await createBranchAt(deps, gitPath, dir, branch, sha, true);
    if (!created.ok || created.owned === undefined) {
        return created;
    }
    const tracking = await gitIn(deps, gitPath, dir, ['branch', `--set-upstream-to=${upstream}`, branch]);
    if (tracking.code !== 0) {
        const entries = await listWorktrees(deps, gitPath, dir);
        if (entries === undefined || entries.some((entry) => entry.branch === branch)) {
            deps.log.warn(`branch ${safeText(branch)} was kept: it may be checked out in a worktree`);
        } else {
            await rollbackBranch(deps, gitPath, dir, branch, created.owned);
        }
        return {
            ok: false,
            reason: `cannot set the upstream of ${safeText(branch)} to ${safeText(upstream)}: ${errorLine(tracking)}`,
        };
    }
    return created;
}

function createBranch(
    deps: LinkDeps,
    gitPath: string,
    repo: RepoLayout,
    branch: string,
    step: ApplyStep
): Promise<BranchResult> {
    if (step.kind === 'create') {
        return createBranchAt(deps, gitPath, repo.current, branch, step.startSha, false);
    }
    if (step.kind === 'track') {
        return createTrackingBranch(deps, gitPath, repo.current, branch, step.remote);
    }
    return Promise.resolve({ ok: true, owned: undefined });
}

async function failedAdd(
    deps: LinkDeps,
    gitPath: string,
    repo: RepoLayout,
    target: WorktreeTarget,
    owned: OwnedBranch | undefined,
    added: CommandResult
): Promise<ApplyResult> {
    const line = errorLine(added);
    const shownBranch = safeText(target.branch);
    const entries = await listWorktrees(deps, gitPath, repo.current);
    if (entries === undefined) {
        return refuse(`${line}; branch ${shownBranch} was kept`);
    }
    const registered = entries.find((entry) => matchesTarget(entry.path, target.path));
    if (registered !== undefined) {
        const onBranch = registered.branch === undefined ? 'detached' : safeText(registered.branch);
        return refuse(
            `the worktree exists at ${safeText(target.path)} on ${onBranch} but git reported an error: ${line}`
        );
    }
    const checkedOut = entries.some((entry) => entry.branch === target.branch);
    if (owned !== undefined && !checkedOut) {
        await rollbackBranch(deps, gitPath, repo.current, target.branch, owned);
    }
    return refuse(line);
}

function createdMessage(target: WorktreeTarget, step: ApplyStep): string {
    const shownPath = safeText(target.path);
    const shownBranch = safeText(target.branch);
    switch (step.kind) {
        case 'create': {
            return `created worktree ${shownPath} on new branch ${shownBranch} from ${safeText(step.startSha.slice(0, SHORT_SHA_LENGTH))}`;
        }
        case 'track': {
            return `created worktree ${shownPath} on new branch ${shownBranch} tracking ${safeText(step.remote)}/${shownBranch}`;
        }
        case 'checkout':
        case 'reuse': {
            return `created worktree ${shownPath} on existing branch ${shownBranch}`;
        }
    }
}

// Never uses git worktree add -b: the branch is created first so that a failed add can roll back exactly the
// branch this invocation owns, and nothing that existed before.
export async function applyDecision(
    deps: LinkDeps,
    gitPath: string,
    repo: RepoLayout,
    target: WorktreeTarget,
    step: ApplyStep
): Promise<ApplyResult> {
    if (step.kind === 'reuse') {
        deps.log.info(`reusing worktree ${safeText(target.path)} on ${safeText(target.branch)}`);
        return { ok: true };
    }
    const branch = await createBranch(deps, gitPath, repo, target.branch, step);
    if (!branch.ok) {
        return refuse(branch.reason);
    }
    const added = await gitIn(deps, gitPath, repo.current, ['worktree', 'add', '--quiet', target.path, target.branch]);
    if (added.code !== 0) {
        return failedAdd(deps, gitPath, repo, target, branch.owned, added);
    }
    deps.log.info(createdMessage(target, step));
    return { ok: true };
}
