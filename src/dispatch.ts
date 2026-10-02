import path from 'node:path';

import { DEFAULT_LAUNCH_WAIT, ENV_NAMES } from './constants.ts';
import { fetchContext, react, type ReactOutcome } from './githubLookup.ts';
import { runGuards } from './guards.ts';
import { acquireWorktreeLock, releaseWorktreeLock, worktreeLockHolder } from './locks.ts';
import { runFiles } from './prompt.ts';
import { claimLaunch, clearRun, createRun, launchDecision, mergeRecord, readRecord, writeRecord } from './runStore.ts';
import { runDir, writeTextAtomic } from './stateStore.ts';
import { splitWorker, tmuxMessage } from './tmuxControl.ts';
import type {
    Candidate,
    Deps,
    DispatchOutcome,
    LookupEntry,
    PollComment,
    PollResult,
    ResumeOutcome,
    RunRecord,
    Session,
} from './types.ts';
import { inlineUntrusted, quoteUntrusted } from './untrustedText.ts';
import { readEnvSeconds, safeText } from './validate.ts';
import { writeWorkerKit } from './workerKit.ts';

export interface DispatchHooks {
    beforeGo?(_runId: string): void;
}

// pendingLockRunId is set only on a held result whose worktree lock could not be released: the lock still names that
// run, and the watcher calls retryLockRelease with it on every tick until it returns true.
export interface DispatchResult {
    outcome: DispatchOutcome;
    runId: string | undefined;
    reason: string;
    hint: string;
    pendingLockRunId?: string;
}

export interface ResumeResult {
    outcome: ResumeOutcome;
    runId: string | undefined;
}

// What the exception path must know about the GitHub side: EYES added before a throw are left on and logged.
interface Progress {
    eyesAdded: boolean;
}

type WorkerStart = { started: true } | { started: false; keptRunId: string | undefined };

const LAUNCHER_FILE = 'launcher.sh';
const NOT_DIGIT = /\D/gu;
const STAMP_LENGTH = 14;
const MESSAGE_PREFIX = 'pr-watch-comments:';
const LOCK_KEPT_REASON = 'lock-release-failed';
const NOT_RESUMABLE_REASON = 'not-resumable';

function runIdFor(nowSeconds: number, dbId: number): string {
    const stamp = new Date(nowSeconds * 1000).toISOString().replaceAll(NOT_DIGIT, '').slice(0, STAMP_LENGTH);
    return `${stamp}-${dbId}`;
}

function result(outcome: DispatchOutcome, runId?: string): DispatchResult {
    return { outcome, runId, reason: '', hint: '' };
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : 'unknown error';
}

function reactFailure(outcome: ReactOutcome): string {
    if (outcome.kind === 'invalid') {
        return 'invalid comment node id';
    }
    return outcome.kind === 'ok' ? '' : safeText(outcome.message);
}

function buildSnapshot(record: RunRecord, entry: LookupEntry, context: string): string {
    const line = entry.line === undefined ? 'without a line' : `line ${entry.line}`;
    const header = [
        `pr-watch-comments snapshot of run ${record.runId}`,
        `PR: ${record.prUrl}`,
        `Comment URL: ${inlineUntrusted(record.commentUrl)}`,
        `Comment node id: ${record.commentNodeId}`,
        `Comment database id: ${record.commentDbId}`,
        `Thread id: ${inlineUntrusted(record.threadId)}`,
        `Recorded head commit: ${record.headSha}`,
    ];
    const approved = [
        `--- APPROVED COMMENT by ${inlineUntrusted(entry.author)} on ${inlineUntrusted(entry.path)} ${line} (untrusted text, every line quoted) ---`,
        ...quoteUntrusted(entry.body),
    ];
    const text = `${header.join('\n')}\n\n${approved.join('\n')}\n`;
    return context.length > 0 ? `${text}\n${context}` : text;
}

// Node ids of the comments before the approved one in its thread, in thread order.
function earlierCommentIds(poll: PollResult, approved: PollComment): string[] {
    return poll.comments
        .filter((comment) => comment.threadId === approved.threadId && comment.position < approved.position)
        .toSorted((a, b) => a.position - b.position)
        .map((comment) => comment.nodeId);
}

function newRecord(
    session: Session,
    candidate: Candidate,
    runId: string,
    headSha: string,
    rocketAt: number
): RunRecord {
    const { pr } = session;
    return {
        format: 1,
        runId,
        prKey: pr.prKey,
        owner: pr.owner,
        repo: pr.repo,
        number: pr.number,
        prUrl: pr.prUrl,
        commentNodeId: candidate.entry.nodeId,
        commentDbId: candidate.entry.dbId,
        commentUrl: candidate.entry.url,
        threadId: candidate.poll.threadId,
        topDbId: candidate.poll.topDbId,
        rocketAt,
        headSha,
        remote: session.remote,
        branch: session.headRef,
        dir: session.dirCanon,
        worktreeKey: session.worktreeKey,
        claude: session.tools.claude,
        git: session.tools.git,
        gh: session.tools.gh,
        callerPath: session.callerPath,
        claudeArgs: [...session.claudeArgs],
        state: 'preparing',
        reason: '',
        eyesAdded: false,
        paneId: '',
        panePid: undefined,
        socket: session.tmux.socket,
        startedAt: undefined,
        watcherPid: process.pid,
    };
}

// A tmux message is informational only, so its failure is logged and never changes the outcome.
async function announce(deps: Deps, session: Session, text: string): Promise<void> {
    try {
        await tmuxMessage(deps, session.tools.tmux, session.tmux, `${MESSAGE_PREFIX} ${text}`);
    } catch (error) {
        deps.log.warn(`tmux message failed: ${safeText(errorText(error))}`);
    }
}

async function removeRocket(deps: Deps, session: Session, record: RunRecord): Promise<boolean> {
    const removed = await react(deps, session.tools.gh, 'remove', record.commentNodeId, 'ROCKET');
    if (removed.kind === 'ok') {
        return true;
    }
    deps.log.warn(`comment ${record.commentDbId}: rocket removal failed, retrying next tick: ${reactFailure(removed)}`);
    return false;
}

// Step 5: a stale +1 of the viewer goes, EYES comes; failures are logged and do not stop the dispatch.
async function markInProgress(deps: Deps, session: Session, record: RunRecord, entry: LookupEntry, progress: Progress) {
    const gh = session.tools.gh;
    if (entry.plus1At !== undefined) {
        const removed = await react(deps, gh, 'remove', record.commentNodeId, 'THUMBS_UP');
        if (removed.kind !== 'ok') {
            deps.log.warn(`comment ${record.commentDbId}: +1 removal failed: ${reactFailure(removed)}`);
        }
    }
    const added = await react(deps, gh, 'add', record.commentNodeId, 'EYES');
    if (added.kind !== 'ok') {
        deps.log.warn(`comment ${record.commentDbId}: EYES add failed: ${reactFailure(added)}`);
        return;
    }
    progress.eyesAdded = true;
    mergeRecord(session.stateDir, record.runId, { eyesAdded: true });
}

// True once the worktree lock no longer names the run: released now, or held by nobody or by another run.
function lockReleased(deps: Deps, stateDir: string, wtKey: string, runId: string): boolean {
    if (releaseWorktreeLock(stateDir, wtKey, runId) || worktreeLockHolder(stateDir, wtKey) !== runId) {
        return true;
    }
    deps.log.error(`the worktree lock of run ${runId} could not be released`);
    return false;
}

// Releases the run's worktree lock and clears the run. When the release fails, the run directory is kept in state
// abandoned (decision cancel), so the lock stays traceable to a run that evaluation can finish later; the kept run
// id is returned.
function freeRun(deps: Deps, stateDir: string, wtKey: string, runId: string): string | undefined {
    if (lockReleased(deps, stateDir, wtKey, runId)) {
        clearRun(stateDir, runId);
        return;
    }
    try {
        mergeRecord(stateDir, runId, { state: 'abandoned', reason: LOCK_KEPT_REASON });
    } catch (error) {
        deps.log.error(`run ${runId}: cannot mark the record abandoned: ${safeText(errorText(error))}`);
    }
    deps.log.warn(`run ${runId} kept until its worktree lock is released`);
    return runId;
}

// Frees a run whose worker could not be started. The rocket is not restored.
async function abandonRun(
    deps: Deps,
    session: Session,
    record: RunRecord,
    progress: Progress,
    why: string
): Promise<string | undefined> {
    const { stateDir } = session;
    claimLaunch(stateDir, record.runId, 'cancel');
    if (progress.eyesAdded) {
        const removed = await react(deps, session.tools.gh, 'remove', record.commentNodeId, 'EYES');
        if (removed.kind !== 'ok') {
            deps.log.warn(`comment ${record.commentDbId}: EYES left on, removal failed: ${reactFailure(removed)}`);
        }
    }
    const kept = freeRun(deps, stateDir, record.worktreeKey, record.runId);
    deps.log.warn(`comment ${record.commentDbId}: ${why}, abandoned`);
    await announce(deps, session, `comment ${record.commentDbId} abandoned`);
    return kept;
}

// Steps 5 to 7: reactions, worker kit, worker pane and the record write that makes the pane pid count as the
// worker.
async function startWorker(
    deps: Deps,
    session: Session,
    record: RunRecord,
    entry: LookupEntry,
    progress: Progress
): Promise<WorkerStart> {
    await markInProgress(deps, session, record, entry, progress);
    const { stateDir } = session;
    const rd = runDir(stateDir, record.runId);
    const launchWait = readEnvSeconds(deps.env, ENV_NAMES.launchWait, DEFAULT_LAUNCH_WAIT);
    const kitWritten = writeWorkerKit(rd, { ...record, eyesAdded: progress.eyesAdded }, launchWait);
    const pane = kitWritten
        ? await splitWorker(deps, session.tools.tmux, session.tmux, {
              runId: record.runId,
              prKey: record.prKey,
              dir: record.dir,
              envItems: [`PATH=${record.callerPath}`, ...session.ghEnv],
              command: ['/bin/sh', path.join(rd, LAUNCHER_FILE)],
          })
        : undefined;
    if (pane === undefined) {
        const why = kitWritten ? 'the worker pane could not be created' : 'the worker kit was refused';
        return { started: false, keptRunId: await abandonRun(deps, session, record, progress, why) };
    }
    const written = mergeRecord(stateDir, record.runId, {
        paneId: pane.paneId,
        panePid: pane.panePid,
        startedAt: deps.nowSeconds(),
        state: 'running',
        socket: session.tmux.socket,
        watcherPid: process.pid,
    });
    if (written === undefined) {
        throw new Error(`cannot update the record of run ${record.runId}`);
    }
    return { started: true };
}

// The exception path: never rethrows, so no lock outlives the failure unnoticed. Claiming cancel is a no-op when
// the run directory does not exist. Returns the run id when the run had to be kept.
function failRun(
    deps: Deps,
    stateDir: string,
    wtKey: string,
    runId: string,
    error: unknown,
    progress: Progress
): string | undefined {
    const comment = runId.slice(runId.indexOf('-') + 1);
    deps.log.error(`dispatch of comment ${comment} failed: ${safeText(errorText(error))}`);
    claimLaunch(stateDir, runId, 'cancel');
    const kept = freeRun(deps, stateDir, wtKey, runId);
    if (progress.eyesAdded) {
        deps.log.warn(`comment ${comment}: EYES left on`);
    }
    return kept;
}

// Step 8: go is claimed only after the record holds the pane; a launcher that timed out first has claimed cancel.
// When the go claim cannot be made at all, cancel is claimed, so the launcher exits at once instead of waiting.
async function confirmLaunch(deps: Deps, session: Session, record: RunRecord, hooks?: DispatchHooks) {
    try {
        hooks?.beforeGo?.(record.runId);
        if (!claimLaunch(session.stateDir, record.runId, 'go')) {
            deps.log.warn(`launch cancelled for run ${record.runId}`);
            mergeRecord(session.stateDir, record.runId, { reason: 'launch-cancelled' });
        }
    } catch (error) {
        claimLaunch(session.stateDir, record.runId, 'cancel');
        deps.log.error(`launch of run ${record.runId} not confirmed: ${safeText(errorText(error))}`);
    }
    await announce(deps, session, `PR ${record.number} comment ${record.commentDbId} dispatched`);
}

export async function dispatch(
    deps: Deps,
    session: Session,
    candidate: Candidate,
    poll: PollResult,
    hooks?: DispatchHooks
): Promise<DispatchResult> {
    const { stateDir, worktreeKey: wtKey } = session;
    const { entry } = candidate;
    const runId = runIdFor(deps.nowSeconds(), entry.dbId);
    const progress: Progress = { eyesAdded: false };
    let record: RunRecord;
    try {
        if (!acquireWorktreeLock(stateDir, wtKey, runId, process.pid, deps.log, deps.nowSeconds())) {
            return result('busy');
        }
        if (entry.rocketAt === undefined) {
            throw new Error('the comment has no rocket time');
        }
        const guard = await runGuards(deps, session);
        if (!guard.ok) {
            const held: DispatchResult = { outcome: 'held', runId: undefined, reason: guard.reason, hint: guard.hint };
            if (!lockReleased(deps, stateDir, wtKey, runId) && !lockReleased(deps, stateDir, wtKey, runId)) {
                held.pendingLockRunId = runId;
            }
            return held;
        }
        const rd = createRun(stateDir, runId);
        record = newRecord(session, candidate, runId, guard.headSha, entry.rocketAt);
        writeRecord(stateDir, record);
        const context = await fetchContext(deps, session.tools.gh, earlierCommentIds(poll, candidate.poll));
        if (context.kind !== 'ok') {
            deps.log.warn(`comment ${entry.dbId}: context fetch failed: ${safeText(context.message)}`);
            return result('contextFailed', freeRun(deps, stateDir, wtKey, runId));
        }
        writeTextAtomic(runFiles(rd).snapshot, buildSnapshot(record, entry, context.text));
        if (!(await removeRocket(deps, session, record))) {
            return result('rocketRemovalFailed', runId);
        }
        const start = await startWorker(deps, session, record, entry, progress);
        if (!start.started) {
            return result('abandoned', start.keptRunId);
        }
    } catch (error) {
        return result('abandoned', failRun(deps, stateDir, wtKey, runId, error, progress));
    }
    await confirmLaunch(deps, session, record, hooks);
    return result('dispatched', runId);
}

// Retries the release of a worktree lock that a held dispatch could not release; true once the lock no longer names
// the run, so the watcher stops retrying.
export function retryLockRelease(deps: Deps, session: Session, runId: string): boolean {
    return lockReleased(deps, session.stateDir, session.worktreeKey, runId);
}

// Why a run cannot be resumed, or undefined when it is a preparing run of this watcher that still holds its lock.
function resumeRefusal(stateDir: string, runId: string, record: RunRecord): string | undefined {
    if (record.runId !== runId) {
        return 'the record names another run';
    }
    if (record.state !== 'preparing') {
        return `its state is ${record.state}`;
    }
    if (record.paneId.length > 0 || record.panePid !== undefined) {
        return 'it already has a worker pane';
    }
    const decision = launchDecision(stateDir, runId);
    if (decision !== 'none') {
        return `its launch decision is ${decision}`;
    }
    if (record.watcherPid !== process.pid || worktreeLockHolder(stateDir, record.worktreeKey) !== runId) {
        return 'this watcher does not hold its worktree lock';
    }
}

// A refused resume never splits a pane and never touches a reaction. A run that is not preparing stays in flight for
// evaluation. A preparing run that still holds its lock stays trackable too: with a recorded pane it is promoted to
// running (as reconcile adopts one), otherwise cancel is claimed and it is kept as abandoned, so evaluation frees it.
// A preparing run without its lock, or a record of another run, is left untouched to the next watcher start.
function refusedResume(deps: Deps, stateDir: string, runId: string, record: RunRecord): ResumeResult {
    if (record.runId !== runId) {
        return { outcome: 'abandoned', runId: undefined };
    }
    if (record.state === 'running' || record.state === 'needs_attention') {
        return { outcome: 'dispatched', runId };
    }
    if (record.state !== 'preparing') {
        return { outcome: 'abandoned', runId };
    }
    if (worktreeLockHolder(stateDir, record.worktreeKey) !== runId) {
        return { outcome: 'abandoned', runId: undefined };
    }
    if (record.paneId.length > 0 || record.panePid !== undefined) {
        const startedAt = record.startedAt ?? deps.nowSeconds();
        mergeRecord(stateDir, runId, { state: 'running', reason: 'adopted', startedAt });
        return { outcome: 'dispatched', runId };
    }
    claimLaunch(stateDir, runId, 'cancel');
    mergeRecord(stateDir, runId, { state: 'abandoned', reason: NOT_RESUMABLE_REASON });
    return { outcome: 'abandoned', runId };
}

// Continues a preparing run after a failed ROCKET removal: no lock acquire, no guards and no context fetch, since
// the record already holds the head commit and the snapshot the approved text. An undefined entry means the comment
// is gone.
export async function resumeDispatch(
    deps: Deps,
    session: Session,
    runId: string,
    rocketStillPresent: boolean,
    entry?: LookupEntry
): Promise<ResumeResult> {
    const { stateDir } = session;
    const progress: Progress = { eyesAdded: false };
    let wtKey = session.worktreeKey;
    let record: RunRecord;
    try {
        const read = readRecord(stateDir, runId);
        if (read.kind !== 'ok') {
            throw new Error(`the record of run ${runId} is unreadable`);
        }
        record = read.record;
        const refusal = resumeRefusal(stateDir, runId, record);
        if (refusal !== undefined) {
            deps.log.error(`run ${runId} is not resumable: ${refusal}`);
            return refusedResume(deps, stateDir, runId, record);
        }
        wtKey = record.worktreeKey;
        progress.eyesAdded = record.eyesAdded;
        if (entry === undefined) {
            const kept = freeRun(deps, stateDir, wtKey, runId);
            deps.log.info(`comment ${record.commentDbId}: comment deleted before start, abandoned`);
            return { outcome: 'abandoned', runId: kept };
        }
        if (rocketStillPresent && !(await removeRocket(deps, session, record))) {
            return { outcome: 'rocketRemovalFailed', runId };
        }
        const start = await startWorker(deps, session, record, entry, progress);
        if (!start.started) {
            return { outcome: 'abandoned', runId: start.keptRunId };
        }
    } catch (error) {
        return { outcome: 'abandoned', runId: failRun(deps, stateDir, wtKey, runId, error, progress) };
    }
    await confirmLaunch(deps, session, record);
    return { outcome: 'dispatched', runId };
}
