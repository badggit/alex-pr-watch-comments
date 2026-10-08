import path from 'node:path';

import { sessionGh } from './gh.ts';
import { lookupComments } from './githubLookup.ts';
import { getNumber } from './json.ts';
import { adoptWorktreeLock, worktreeLockHolder } from './locks.ts';
import { pidAlive } from './proc.ts';
import { markFailed, removeEyes } from './reactions.ts';
import {
    captureRun,
    commentOutcome,
    evaluateRun,
    failTarget,
    isClearedResult,
    notifyOwner,
    releaseRunLock,
} from './runState.ts';
import { claimLaunch, clearRun, launchDecision, listRunIds, mergeRecord, readRecord, workerAlive } from './runStore.ts';
import { readJsonFile, worktreeDir } from './stateStore.ts';
import { paneForRun } from './tmuxControl.ts';
import type { Deps, RecordPatch, RunRecord, RunState, Session } from './types.ts';

export interface RecoveryProblem {
    runId: string;
    reason: 'worker-pane-not-found';
}

// problem belongs to the run returned as inflightRunId only.
export interface ReconcileResult {
    inflightRunId: string | undefined;
    problem: RecoveryProblem | undefined;
}

type DropOutcome = 'dropped' | 'kept' | 'aborted';

const HELD_STATES: ReadonlySet<RunState> = new Set<RunState>([
    'preparing',
    'running',
    'needs_attention',
    'retained',
    'abandoned',
]);

// A run with a live worker belongs to this watcher again: its record and worktree lock name this process. Nothing is
// asked of GitHub; only the pane is looked up, on the tmux server the record names. A preparing run whose worker
// already lives is promoted to running, so the tick evaluates it instead of resuming it into a second pane. A retained
// run whose pane is missing keeps its stored state, outcome and pending marks; the problem is handed to the caller.
async function adoptRun(deps: Deps, session: Session, record: RunRecord): Promise<RecoveryProblem | undefined> {
    const { runId } = record;
    const patch: RecordPatch = { watcherPid: process.pid };
    if (record.state === 'preparing') {
        Object.assign(patch, { state: 'running', reason: 'adopted', startedAt: record.startedAt ?? deps.nowSeconds() });
    }
    mergeRecord(session.stateDir, runId, patch);
    if (!adoptWorktreeLock(session.stateDir, record.worktreeKey, runId, process.pid, deps.nowSeconds())) {
        deps.log.warn(`could not adopt the worktree lock of run ${runId}`);
    }
    const pane = await paneForRun(deps, session.tools.tmux, record.socket, runId);
    let problem: RecoveryProblem | undefined;
    if (pane === undefined) {
        const reason = 'worker-pane-not-found';
        const retained = record.state === 'retained';
        if (retained) {
            problem = { runId, reason };
        } else {
            mergeRecord(session.stateDir, runId, { state: 'needs_attention', reason });
        }
        if (retained || record.state !== 'needs_attention' || record.reason !== reason) {
            await notifyOwner(deps, session, `run ${runId} needs attention: ${reason}`);
        }
    }
    deps.log.info(`re-adopted run ${runId}`);
    return problem;
}

// Marks the comments of an interrupted run that failTarget picks, read from one lookup. When the lookup fails nothing
// is marked (a done comment must not get a -1); every EYES the watcher added is removed instead.
async function closeComments(deps: Deps, session: Session, record: RunRecord, stop?: AbortSignal): Promise<void> {
    const looked = await lookupComments(
        deps,
        sessionGh(session),
        record.comments.map((comment) => comment.nodeId)
    );
    if (looked.kind !== 'ok') {
        deps.log.warn(`run ${record.runId}: could not look up its comments, so none was marked as failed`);
        for (const comment of record.comments.filter((item) => item.eyesAdded)) {
            if (stop?.aborted === true) {
                return;
            }
            await removeEyes(deps, session, comment);
        }
        return;
    }
    const { entries, gone } = looked.result;
    const targets = record.comments
        .map((comment) => {
            const entry = entries.find((item) => item.nodeId === comment.nodeId);
            return failTarget(comment, entry, commentOutcome(comment, entry, gone.includes(comment.nodeId)));
        })
        .filter((target) => target !== undefined);
    await markFailed(deps, session, targets, stop);
}

// The worker is dead: its unfinished comments are marked as failed. A stop observed during that keeps record and lock,
// so the next start marks again; a lock that cannot be released keeps the record as a running run the tick finishes
// later, which marks the comments once more (adding a reaction twice changes nothing).
async function dropRun(deps: Deps, session: Session, record: RunRecord, stop?: AbortSignal): Promise<DropOutcome> {
    await closeComments(deps, session, record, stop);
    if (stop?.aborted === true) {
        return 'aborted';
    }
    deps.log.info(`interrupted run ${record.runId}, add the rocket again to retry`);
    if (!releaseRunLock(deps, session.stateDir, record.worktreeKey, record.runId)) {
        mergeRecord(session.stateDir, record.runId, { state: 'running', reason: 'interrupted' });
        return 'kept';
    }
    clearRun(session.stateDir, record.runId);
    return 'dropped';
}

// An abandoned run kept for its worktree lock: cleared once its worker is gone and the lock released, otherwise kept
// for the tick, whose evaluation retries.
function finishAbandonedRun(deps: Deps, session: Session, record: RunRecord): DropOutcome {
    const { stateDir } = session;
    if (workerAlive(stateDir, record.runId) || !releaseRunLock(deps, stateDir, record.worktreeKey, record.runId)) {
        return 'kept';
    }
    clearRun(stateDir, record.runId);
    deps.log.info(`cleared abandoned run ${record.runId}`);
    return 'dropped';
}

async function finishRetainedRun(
    deps: Deps,
    session: Session,
    record: RunRecord,
    stop?: AbortSignal
): Promise<DropOutcome> {
    const signal = stop ?? new AbortController().signal;
    const result = await evaluateRun(
        deps,
        session,
        record.runId,
        captureRun(session.stateDir, record.runId),
        { rate: { remaining: undefined, resetAt: undefined }, entries: [], gone: [] },
        signal
    );
    if (isClearedResult(result.state)) {
        return 'dropped';
    }
    return signal.aborted ? 'aborted' : 'kept';
}

function lockWatcherPid(stateDir: string, wtKey: string): number | undefined {
    return getNumber(readJsonFile(path.join(worktreeDir(stateDir, wtKey), 'lock', 'owner.json')), 'watcherPid');
}

// A run whose record cannot be read belongs to this PR only as far as it holds this clone's worktree lock for a dead
// watcher; its launch is then cancelled, and while the slot is free it takes the slot and its lock is adopted by this
// process (the tick reports it as needing attention). With the slot taken it is only logged: adopting its lock
// without tracking the run would keep the clone busy for as long as this watcher lives.
function claimUnreadable(deps: Deps, session: Session, runId: string, inflightRunId: string | undefined): boolean {
    const { stateDir, worktreeKey } = session;
    const watcherPid = lockWatcherPid(stateDir, worktreeKey);
    if (worktreeLockHolder(stateDir, worktreeKey) !== runId || watcherPid === undefined || pidAlive(watcherPid)) {
        deps.log.warn(`run ${runId} has an unreadable record and is not held for this clone; left alone`);
        return false;
    }
    if (launchDecision(stateDir, runId) !== 'go') {
        claimLaunch(stateDir, runId, 'cancel');
    }
    if (inflightRunId !== undefined) {
        deps.log.warn(`run ${runId} has an unreadable record and needs attention; run ${inflightRunId} holds the slot`);
        return false;
    }
    if (!adoptWorktreeLock(stateDir, worktreeKey, runId, process.pid, deps.nowSeconds())) {
        deps.log.warn(`could not adopt the worktree lock of run ${runId}`);
    }
    deps.log.warn(`run ${runId} has an unreadable record; it keeps the worktree lock and needs attention`);
    return true;
}

// Runs at watcher start for every run of the PR. A launcher still waiting for its decision is cancelled first; the
// worktree lock is released and the run cleared only while workerAlive is false, whatever the pane lookup says. Only
// one run is in flight: a further live run is left alone (its lock stays unreclaimable while its worker lives).
export async function reconcile(deps: Deps, session: Session, stop?: AbortSignal): Promise<ReconcileResult> {
    let inflightRunId: string | undefined;
    let problem: RecoveryProblem | undefined;
    const kept: string[] = [];
    for (const runId of listRunIds(session.stateDir)) {
        if (stop?.aborted === true) {
            break;
        }
        const read = readRecord(session.stateDir, runId);
        if (read.kind !== 'ok') {
            if (claimUnreadable(deps, session, runId, inflightRunId)) {
                inflightRunId = runId;
            }
            continue;
        }
        const { record } = read;
        if (record.prKey !== session.pr.prKey) {
            continue;
        }
        if (launchDecision(session.stateDir, runId) !== 'go') {
            claimLaunch(session.stateDir, runId, 'cancel');
        }
        if (!HELD_STATES.has(record.state)) {
            continue;
        }
        if (record.state === 'abandoned') {
            if (finishAbandonedRun(deps, session, record) === 'kept') {
                kept.push(runId);
            }
            continue;
        }
        if (record.state === 'retained') {
            if (!workerAlive(session.stateDir, runId)) {
                const finished = await finishRetainedRun(deps, session, record, stop);
                if (finished === 'kept') {
                    kept.push(runId);
                }
            } else if (inflightRunId === undefined) {
                const adopted = await adoptRun(deps, session, record);
                if (record.pendingFailures !== undefined) {
                    const finished = await finishRetainedRun(deps, session, record, stop);
                    if (finished === 'dropped') {
                        continue;
                    }
                }
                inflightRunId = runId;
                problem = adopted;
            } else {
                deps.log.warn(`run ${runId} also has a live worker; run ${inflightRunId} stays in flight`);
            }
            continue;
        }
        if (!workerAlive(session.stateDir, runId)) {
            const dropped = await dropRun(deps, session, record, stop);
            if (dropped === 'kept') {
                kept.push(runId);
            }
        } else if (inflightRunId === undefined) {
            await adoptRun(deps, session, record);
            inflightRunId = runId;
        } else {
            deps.log.warn(`run ${runId} also has a live worker; run ${inflightRunId} stays in flight`);
        }
    }
    return inflightRunId === undefined ? { inflightRunId: kept[0], problem: undefined } : { inflightRunId, problem };
}
