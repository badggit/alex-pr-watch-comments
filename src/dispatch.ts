import path from 'node:path';

import { DEFAULT_LAUNCH_WAIT, ENV_NAMES } from './constants.ts';
import { sessionGh } from './gh.ts';
import { fetchContext, react, type ReactOutcome } from './githubLookup.ts';
import { runGuards } from './guards.ts';
import { syncIgnoredLinks } from './ignoredLinks.ts';
import { acquireWorktreeLock, releaseWorktreeLock, worktreeLockHolder } from './locks.ts';
import { commentFiles } from './prompt.ts';
import { markFailed, type FailTarget } from './reactions.ts';
import { removeRun } from './runRemoval.ts';
import { claimLaunch, createRun, launchDecision, mergeRecord, readRecord, writeRecord } from './runStore.ts';
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
    RunComment,
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

// What the failure paths must know about the GitHub side: comments holds the run's comments with their EYES state,
// rocketless the node ids whose rocket is gone, so only those comments are marked as failed.
interface Progress {
    comments: RunComment[];
    rocketless: Set<string>;
}

type WorkerStart = { started: true } | { started: false; keptRunId: string | undefined };

const LAUNCHER_FILE = 'launcher.sh';
const NOT_DIGIT = /\D/gu;
const STAMP_LENGTH = 14;
const MESSAGE_PREFIX = 'alex-pr-watch-comments:';
const LOCK_KEPT_REASON = 'lock-release-failed';
const NOT_RESUMABLE_REASON = 'not-resumable';
const STALE_REACTIONS = ['THUMBS_UP', 'THUMBS_DOWN'] as const;

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

function newProgress(): Progress {
    return { comments: [], rocketless: new Set() };
}

function idList(comments: readonly { dbId: number }[]): string {
    return comments.map((comment) => comment.dbId).join(',');
}

function buildSnapshot(record: RunRecord, comment: RunComment, entry: LookupEntry, context: string): string {
    const line = entry.line === undefined ? 'without a line' : `line ${entry.line}`;
    const header = [
        `alex-pr-watch-comments snapshot of run ${record.runId}`,
        `PR: ${record.prUrl}`,
        `Comment URL: ${inlineUntrusted(comment.url)}`,
        `Comment node id: ${comment.nodeId}`,
        `Comment database id: ${comment.dbId}`,
        `Thread id: ${inlineUntrusted(comment.threadId)}`,
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

// Undefined when the comment has no rocket time: the queue never offers such a candidate.
function runComment(candidate: Candidate): RunComment | undefined {
    const { entry, poll } = candidate;
    if (entry.rocketAt === undefined) {
        return;
    }
    return {
        nodeId: entry.nodeId,
        dbId: entry.dbId,
        url: entry.url,
        threadId: poll.threadId,
        topDbId: poll.topDbId,
        rocketAt: entry.rocketAt,
        eyesAdded: false,
    };
}

function newRecord(session: Session, comments: RunComment[], runId: string, headSha: string): RunRecord {
    const { pr } = session;
    return {
        format: 2,
        runId,
        prKey: pr.prKey,
        owner: pr.owner,
        repo: pr.repo,
        number: pr.number,
        prUrl: pr.prUrl,
        comments,
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

// Removes the viewer's rocket from every comment that still carries it (present decides); every removal is tried,
// and true means none failed.
async function removeRockets(
    deps: Deps,
    session: Session,
    comments: readonly RunComment[],
    present: (_nodeId: string) => boolean,
    progress: Progress
): Promise<boolean> {
    let removedAll = true;
    for (const comment of comments) {
        if (present(comment.nodeId)) {
            const removed = await react(deps, sessionGh(session), 'remove', comment.nodeId, 'ROCKET');
            if (removed.kind !== 'ok') {
                deps.log.warn(
                    `comment ${comment.dbId}: rocket removal failed, retrying next tick: ${reactFailure(removed)}`
                );
                removedAll = false;
                continue;
            }
        }
        progress.rocketless.add(comment.nodeId);
    }
    return removedAll;
}

// Step 5 for one comment: a stale +1 and a stale -1 of the viewer go, EYES comes; failures are logged and do not stop
// the dispatch.
async function markOneInProgress(deps: Deps, session: Session, comment: RunComment, entry: LookupEntry | undefined) {
    const gh = sessionGh(session);
    const stale = STALE_REACTIONS.filter((content) =>
        content === 'THUMBS_UP' ? entry?.plus1At !== undefined : entry?.minus1 === true
    );
    for (const content of stale) {
        const removed = await react(deps, gh, 'remove', comment.nodeId, content);
        if (removed.kind !== 'ok') {
            deps.log.warn(`comment ${comment.dbId}: ${content} removal failed: ${reactFailure(removed)}`);
        }
    }
    const added = await react(deps, gh, 'add', comment.nodeId, 'EYES');
    if (added.kind !== 'ok') {
        deps.log.warn(`comment ${comment.dbId}: EYES add failed: ${reactFailure(added)}`);
        return;
    }
    comment.eyesAdded = true;
}

// Every EYES that was added is recorded at once, so a crash right after leaves a record that names it.
async function markInProgress(
    deps: Deps,
    session: Session,
    record: RunRecord,
    entries: ReadonlyMap<string, LookupEntry>,
    progress: Progress
) {
    for (const comment of progress.comments) {
        await markOneInProgress(deps, session, comment, entries.get(comment.nodeId));
        if (comment.eyesAdded) {
            mergeRecord(session.stateDir, record.runId, { comments: progress.comments });
        }
    }
}

function failTargets(progress: Progress): FailTarget[] {
    return progress.comments
        .filter((comment) => progress.rocketless.has(comment.nodeId))
        .map((comment) => ({ nodeId: comment.nodeId, dbId: comment.dbId, eyesOn: comment.eyesAdded }));
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
        removeRun(stateDir, runId, deps.log);
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

// Frees a run whose worker could not be started. The rockets are not restored: every comment that lost its rocket
// is marked as failed instead.
async function abandonRun(
    deps: Deps,
    session: Session,
    record: RunRecord,
    progress: Progress,
    why: string
): Promise<string | undefined> {
    const { stateDir } = session;
    claimLaunch(stateDir, record.runId, 'cancel');
    await markFailed(deps, session, failTargets(progress));
    const kept = freeRun(deps, stateDir, record.worktreeKey, record.runId);
    const ids = idList(progress.comments);
    deps.log.warn(`comments ${ids}: ${why}, abandoned`);
    await announce(deps, session, `comments ${ids} abandoned`);
    return kept;
}

// Steps 5 to 7: reactions, worker kit, worker pane and the record write that makes the pane pid count as the
// worker.
async function startWorker(
    deps: Deps,
    session: Session,
    record: RunRecord,
    entries: ReadonlyMap<string, LookupEntry>,
    progress: Progress
): Promise<WorkerStart> {
    await markInProgress(deps, session, record, entries, progress);
    const { stateDir } = session;
    const rd = runDir(stateDir, record.runId);
    const launchWait = readEnvSeconds(deps.env, ENV_NAMES.launchWait, DEFAULT_LAUNCH_WAIT);
    const kitWritten = writeWorkerKit(rd, { ...record, comments: progress.comments }, launchWait);
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
// the run directory does not exist; the cancel also means no worker can start, so every comment that lost its rocket
// is marked as failed. Returns the run id when the run had to be kept.
async function failRun(
    deps: Deps,
    session: Session,
    ids: { wtKey: string; runId: string },
    error: unknown,
    progress: Progress
): Promise<string | undefined> {
    const { stateDir } = session;
    const { wtKey, runId } = ids;
    deps.log.error(`dispatch of run ${runId} failed: ${safeText(errorText(error))}`);
    claimLaunch(stateDir, runId, 'cancel');
    const kept = freeRun(deps, stateDir, wtKey, runId);
    try {
        await markFailed(deps, session, failTargets(progress));
    } catch (markError) {
        deps.log.warn(`run ${runId}: could not mark its comments as failed: ${safeText(errorText(markError))}`);
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
    await announce(deps, session, `PR ${record.number} comments ${idList(record.comments)} dispatched`);
}

function entryMap(entries: readonly LookupEntry[]): Map<string, LookupEntry> {
    return new Map(entries.map((entry) => [entry.nodeId, entry]));
}

// Writes the snapshot of every comment; false (after a logged warning) when a context fetch failed.
async function writeSnapshots(
    deps: Deps,
    session: Session,
    record: RunRecord,
    candidates: readonly Candidate[],
    poll: PollResult
): Promise<boolean> {
    const rd = runDir(session.stateDir, record.runId);
    for (const [index, candidate] of candidates.entries()) {
        const comment = record.comments[index];
        if (comment === undefined) {
            throw new Error('the record does not match the candidates');
        }
        const context = await fetchContext(deps, sessionGh(session), earlierCommentIds(poll, candidate.poll));
        if (context.kind !== 'ok') {
            deps.log.warn(`comment ${comment.dbId}: context fetch failed: ${safeText(context.message)}`);
            return false;
        }
        const snapshot = buildSnapshot(record, comment, candidate.entry, context.text);
        writeTextAtomic(commentFiles(rd, comment.dbId).snapshot, snapshot);
    }
    return true;
}

// Starts one run for the whole batch: candidates are in the order the worker resolves them.
export async function dispatch(
    deps: Deps,
    session: Session,
    candidates: readonly Candidate[],
    poll: PollResult,
    hooks?: DispatchHooks
): Promise<DispatchResult> {
    const { stateDir, worktreeKey: wtKey } = session;
    const first = candidates[0];
    if (first === undefined) {
        return result('abandoned');
    }
    const runId = runIdFor(deps.nowSeconds(), first.entry.dbId);
    const progress = newProgress();
    let record: RunRecord;
    try {
        if (!acquireWorktreeLock(stateDir, wtKey, runId, process.pid, deps.log, deps.nowSeconds())) {
            return result('busy');
        }
        const comments = candidates.map((candidate) => runComment(candidate)).filter((item) => item !== undefined);
        if (comments.length !== candidates.length) {
            throw new Error('a comment has no rocket time');
        }
        if (session.worktree !== undefined) {
            await syncIgnoredLinks(deps, session.tools.git, session.worktree.source, session.worktree.path);
        }
        const guard = await runGuards(deps, session);
        if (!guard.ok) {
            const held: DispatchResult = { outcome: 'held', runId: undefined, reason: guard.reason, hint: guard.hint };
            if (!lockReleased(deps, stateDir, wtKey, runId) && !lockReleased(deps, stateDir, wtKey, runId)) {
                held.pendingLockRunId = runId;
            }
            return held;
        }
        createRun(stateDir, runId);
        record = newRecord(session, comments, runId, guard.headSha);
        writeRecord(stateDir, record);
        progress.comments = record.comments.map((comment) => ({ ...comment }));
        if (!(await writeSnapshots(deps, session, record, candidates, poll))) {
            return result('contextFailed', freeRun(deps, stateDir, wtKey, runId));
        }
        if (!(await removeRockets(deps, session, record.comments, () => true, progress))) {
            return result('rocketRemovalFailed', runId);
        }
        const entries = entryMap(candidates.map((candidate) => candidate.entry));
        const start = await startWorker(deps, session, record, entries, progress);
        if (!start.started) {
            return result('abandoned', start.keptRunId);
        }
    } catch (error) {
        return result('abandoned', await failRun(deps, session, { wtKey, runId }, error, progress));
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
// the record already holds the head commit and the snapshots the approved text. rocketed holds the node ids that still
// carry the viewer's rocket; a comment without an entry is gone and leaves the batch, and a batch without any comment
// left is abandoned.
export async function resumeDispatch(
    deps: Deps,
    session: Session,
    runId: string,
    rocketed: ReadonlySet<string>,
    entries: readonly LookupEntry[]
): Promise<ResumeResult> {
    const { stateDir } = session;
    const progress = newProgress();
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
        const byId = entryMap(entries);
        const left = record.comments.filter((comment) => byId.has(comment.nodeId));
        const gone = record.comments.filter((comment) => !byId.has(comment.nodeId));
        if (gone.length > 0) {
            deps.log.info(`comments ${idList(gone)}: deleted before start, left out of run ${runId}`);
        }
        if (left.length === 0) {
            return { outcome: 'abandoned', runId: freeRun(deps, stateDir, wtKey, runId) };
        }
        if (gone.length > 0) {
            record = mergeRecord(stateDir, runId, { comments: left }) ?? record;
        }
        progress.comments = left.map((comment) => ({ ...comment }));
        if (!(await removeRockets(deps, session, left, (nodeId) => rocketed.has(nodeId), progress))) {
            return { outcome: 'rocketRemovalFailed', runId };
        }
        const start = await startWorker(deps, session, { ...record, comments: left }, byId, progress);
        if (!start.started) {
            return { outcome: 'abandoned', runId: start.keptRunId };
        }
    } catch (error) {
        return { outcome: 'abandoned', runId: await failRun(deps, session, { wtKey, runId }, error, progress) };
    }
    await confirmLaunch(deps, session, record);
    return { outcome: 'dispatched', runId };
}
