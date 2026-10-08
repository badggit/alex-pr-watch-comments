import path from 'node:path';

import { defaultCloner, type Cloner } from './cowClone.ts';
import { syncIgnoredLinks, type LinkDeps } from './ignoredLinks.ts';
import { deriveTarget, type NewWorktreeArgs, type WorktreeTarget } from './newWorktreeArgs.ts';
import { applyDecision, type ApplyStep } from './newWorktreeCreate.ts';
import { decideManualWorktree, type ManualDecision } from './newWorktreeDecide.ts';
import { gatherFacts, isGitBranchName, resolveStartCommit } from './newWorktreeFacts.ts';
import { locateRepository, type RepoLayout } from './newWorktreeRepo.ts';
import { checkTools, discoverTreesByFs } from './newWorktreeTools.ts';
import type { CommandRunner, Env, Logger } from './types.ts';
import { safeText } from './validate.ts';

export interface NewWorktreeIo {
    env: Env;
    log: Logger;
    makeRunner: (_env: Env) => CommandRunner;
    cloner?: Cloner;
}

export type NewWorktreeOutcome =
    { kind: 'ok'; path: string } | { kind: 'refused'; reason: string } | { kind: 'usage'; message: string };

type StepResult = { ok: true; step: ApplyStep } | { ok: false; outcome: NewWorktreeOutcome };

interface Tooling {
    deps: LinkDeps;
    git: string;
    pathValue: string;
}

const TOOL_IN_TREE = 'a required tool resolves inside the working tree through PATH';

function refused(reason: string): NewWorktreeOutcome {
    return { kind: 'refused', reason };
}

// Runs before any process: the trees are found from the file system and every PATH entry inside them (and inside
// the provisional target) is dropped, so no git or cp from the project can run.
function initialTooling(io: NewWorktreeIo, args: NewWorktreeArgs, cwd: string): Tooling | NewWorktreeOutcome {
    const trees = discoverTreesByFs(cwd);
    const provisional = trees.main === undefined ? undefined : deriveTarget(args, trees.main);
    const provisionalPath = provisional?.ok === true ? provisional.target.path : undefined;
    const roots = [trees.current, trees.main, trees.commonDir, provisionalPath].filter((root) => root !== undefined);
    const check = checkTools(io.env.PATH ?? '', cwd, roots);
    if (!check.ok) {
        return refused(check.reason);
    }
    const runner = io.makeRunner({ ...io.env, PATH: check.pathValue });
    return { deps: { runner, log: io.log }, git: check.git, pathValue: check.pathValue };
}

// The second check covers the real main tree and the final target; a git that changes here means the first PATH
// still led into the project, which is refused rather than silently switched.
function recheckTooling(
    io: NewWorktreeIo,
    tooling: Tooling,
    cwd: string,
    repo: RepoLayout,
    target: WorktreeTarget
): Tooling | NewWorktreeOutcome {
    const check = checkTools(tooling.pathValue, cwd, [repo.main, repo.current, target.path]);
    if (!check.ok) {
        return refused(check.reason);
    }
    if (check.git !== tooling.git) {
        return refused(TOOL_IN_TREE);
    }
    if (check.pathValue === tooling.pathValue) {
        return tooling;
    }
    const runner = io.makeRunner({ ...io.env, PATH: check.pathValue });
    return { deps: { runner, log: io.log }, git: check.git, pathValue: check.pathValue };
}

function isTooling(value: Tooling | NewWorktreeOutcome): value is Tooling {
    return 'deps' in value;
}

// A worktree started from another worktree would only multiply them, so a linked worktree is kept as the answer.
function stayInLinked(log: Logger, repo: RepoLayout): NewWorktreeOutcome {
    const from = repo.mainFound ? `; run it from the main working tree ${safeText(repo.main)} to create one` : '';
    log.info(`already in the worktree ${safeText(repo.current)}: no new worktree is created${from}`);
    return { kind: 'ok', path: repo.current };
}

function logNameBase(log: Logger, repo: RepoLayout): void {
    log.info(`name based on main working tree folder ${safeText(path.basename(repo.main))}`);
}

async function stepFor(
    tooling: Tooling,
    repo: RepoLayout,
    base: string | undefined,
    decision: ManualDecision
): Promise<StepResult> {
    switch (decision.kind) {
        case 'refuse': {
            return { ok: false, outcome: refused(decision.reason) };
        }
        case 'create': {
            const start = await resolveStartCommit(tooling.deps, tooling.git, repo.current, base);
            return start.ok
                ? { ok: true, step: { kind: 'create', startSha: start.sha } }
                : { ok: false, outcome: refused(start.reason) };
        }
        case 'reuse':
        case 'checkout':
        case 'track': {
            return { ok: true, step: decision };
        }
    }
}

// The worktree already exists here, so a sync that throws (a probe cleanup, say) is only a warning.
async function syncQuietly(deps: LinkDeps, git: string, source: string, target: string, cloner: Cloner): Promise<void> {
    try {
        await syncIgnoredLinks(deps, git, source, target, cloner);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        deps.log.warn(`cannot sync ignored paths into the worktree: ${safeText(message)}`);
    }
}

export async function runNewWorktree(
    io: NewWorktreeIo,
    args: NewWorktreeArgs,
    cwd: string
): Promise<NewWorktreeOutcome> {
    const initial = initialTooling(io, args, cwd);
    if (!isTooling(initial)) {
        return initial;
    }
    const located = await locateRepository(initial.deps, initial.git, cwd);
    if (!located.ok) {
        return refused(located.reason);
    }
    const { repo } = located;
    if (repo.linked) {
        return stayInLinked(io.log, repo);
    }
    const derived = deriveTarget(args, repo.main);
    if (!derived.ok) {
        return { kind: 'usage', message: derived.message };
    }
    const { target } = derived;
    logNameBase(io.log, repo);
    const tooling = recheckTooling(io, initial, cwd, repo, target);
    if (!isTooling(tooling)) {
        return tooling;
    }
    const { deps, git } = tooling;
    const branchName = await isGitBranchName(deps, git, repo.current, target.branch);
    if (branchName.kind === 'invalid') {
        return { kind: 'usage', message: `invalid branch name: ${safeText(target.branch)}` };
    }
    if (branchName.kind === 'error') {
        return refused(branchName.reason);
    }
    const facts = await gatherFacts(deps, git, repo, target, args.base !== undefined);
    if (!facts.ok) {
        return refused(facts.reason);
    }
    const step = await stepFor(tooling, repo, args.base, decideManualWorktree(facts.facts));
    if (!step.ok) {
        return step.outcome;
    }
    const applied = await applyDecision(deps, git, repo, target, step.step);
    if (!applied.ok) {
        return refused(applied.reason);
    }
    await syncQuietly(deps, git, repo.main, target.path, io.cloner ?? defaultCloner);
    return { kind: 'ok', path: target.path };
}
