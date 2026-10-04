import fs from 'node:fs';
import path from 'node:path';

import { DEFAULT_START_TIMEOUT, DEFAULT_STOP_QUIET, DEFAULT_TERM_WAIT, ENV_NAMES } from './constants.ts';
import { releaseWorktreeLock, worktreeLockHolder } from './locks.ts';
import { pidAlive, processStart, signalIfSame } from './proc.ts';
import { markFailed, type FailTarget } from './reactions.ts';
import {
    claimLaunch,
    clearRun,
    launchDecision,
    mergeRecord,
    readEvents,
    readLoggedCursor,
    readRecord,
    workerAlive,
    writeLoggedCursor,
} from './runStore.ts';
import { readTextFile, runDir } from './stateStore.ts';
import { capDonePanes, tmuxMessage, tmuxOn } from './tmuxControl.ts';
import type {
    Capture,
    Deps,
    EvaluateState,
    EventKind,
    EventsSnapshot,
    LookupEntry,
    LookupResult,
    RunComment,
    RunDecision,
    RunRecord,
    Session,
    SignalOutcome,
} from './types.ts';
import { isUintString, readEnvSeconds } from './validate.ts';

// done: a +1 newer than the rocket; failed: the watcher's EYES is gone without such a +1 (the worker's failure path);
// gone: the comment was deleted; open: none of these yet.
export type CommentOutcome = 'done' | 'failed' | 'open' | 'gone';

export interface DecideInput {
    alive: boolean;
    comments: readonly CommentOutcome[];
    events: EventsSnapshot;
    startedAt: number | undefined;
    now: number;
    startTimeout: number;
    stopQuiet: number;
}

// One comment of the run with what the lookup says about it.
interface CommentState {
    comment: RunComment;
    entry: LookupEntry | undefined;
    outcome: CommentOutcome;
}

export interface EvaluateResult {
    state: EvaluateState;
    reason: string;
}

interface RunContext {
    deps: Deps;
    session: Session;
    record: RunRecord;
    capture: Capture;
    stop: AbortSignal;
}

type TermOutcome = SignalOutcome | 'noStart' | 'pidUnreadable';

type WaitOutcome = 'gone' | 'alive' | 'aborted';

type ClaudeFate = 'gone' | 'never' | 'alive' | 'mismatch' | 'unknown';

const TERM_POLL_MS = 1000;
// The reason of the last owner notice per unreadable run of this process, so an unreadable or missing record is
// announced once and not on every tick.
const unreadableNotices = new Map<string, string>();
// What the owner can do about a needs_attention reason; a reason without an entry has no hint. A hint uses only
// characters safeText keeps and stays short, so the tmux notice (cut at 200 characters) still shows all of it.
const ATTENTION_HINTS: ReadonlyMap<string, string> = new Map([
    ['claude-did-not-start', 'see the worker pane: claude may wait at a dialog like folder trust - trust the dir'],
]);
const LOGGED_KINDS: ReadonlySet<EventKind | 'unknown'> = new Set<EventKind | 'unknown'>([
    'prompt',
    'stop',
    'permission',
]);

// Settled means claude stopped after a prompt and nothing happened for the quiet period: one of the owner's own
// Stop hooks may block a stop, and the work that follows shows up as a newer event before the period ends.
function settled(input: DecideInput): boolean {
    const { events } = input;
    return (
        events.lastEvent === 'stop' &&
        events.hasPrompt &&
        events.lastEventAt !== undefined &&
        input.now - events.lastEventAt >= input.stopQuiet
    );
}

export function commentOutcome(comment: RunComment, entry: LookupEntry | undefined, gone: boolean): CommentOutcome {
    if (entry === undefined || gone) {
        return 'gone';
    }
    if (entry.plus1At !== undefined && entry.plus1At > comment.rocketAt) {
        return 'done';
    }
    return comment.eyesAdded && !entry.eyes ? 'failed' : 'open';
}

// The run-state table, first match wins. A stop without a recorded prompt is never completion or failure evidence.
// A deleted comment counts as resolved; only a batch whose comments are all gone needs the owner.
export function decideRun(input: DecideInput): RunDecision {
    const { events, comments } = input;
    if (!input.alive) {
        return { state: 'exited', reason: 'claude-exited' };
    }
    if (comments.every((outcome) => outcome === 'gone')) {
        return { state: 'needs_attention', reason: 'comment-deleted' };
    }
    if (events.lastEvent === 'permission') {
        return { state: 'needs_attention', reason: 'waiting-for-permission' };
    }
    if (settled(input)) {
        if (comments.every((outcome) => outcome === 'done' || outcome === 'gone')) {
            return { state: 'completed', reason: 'done' };
        }
        if (comments.every((outcome) => outcome !== 'open')) {
            return { state: 'failed', reason: 'claude-took-failure-path' };
        }
        return { state: 'needs_attention', reason: 'idle-without-done-marker' };
    }
    if (!events.hasPrompt && input.startedAt !== undefined && input.now - input.startedAt > input.startTimeout) {
        return { state: 'needs_attention', reason: 'claude-did-not-start' };
    }
    if (events.lastEvent === 'stop') {
        return { state: 'running', reason: 'settling' };
    }
    return { state: 'running', reason: 'working' };
}

// Taken before the tick's poll and lookup; the events come from one read, so every field describes the same content.
export function captureRun(stateDir: string, runId: string): Capture {
    const events = readEvents(stateDir, runId);
    return { events, alive: workerAlive(stateDir, runId) };
}

function deferred(reason: string): EvaluateResult {
    return { state: 'deferred', reason };
}

// Logs every event from the stored cursor on, a tool event only when it is the run's first tool use, then moves the
// cursor, so nothing is logged twice, also across watcher restarts.
function logNewEvents(deps: Deps, stateDir: string, runId: string, events: EventsSnapshot): void {
    const cursor = readLoggedCursor(stateDir, runId);
    const firstTool = events.kinds.indexOf('tool');
    for (const [offset, kind] of events.kinds.slice(cursor).entries()) {
        const index = cursor + offset;
        if (LOGGED_KINDS.has(kind) || (kind === 'tool' && index === firstTool)) {
            deps.log.info(`run ${runId} event ${kind}`);
        }
    }
    if (cursor !== events.count) {
        writeLoggedCursor(stateDir, runId, events.count);
    }
}

export async function notifyOwner(deps: Deps, session: Session, text: string): Promise<void> {
    await tmuxMessage(deps, session.tools.tmux, session.tmux, `pr-watch-comments: ${text}`);
}

// A comment to mark as failed: neither done nor deleted, and not approved again (a new rocket of the viewer puts it
// into the next batch, which would remove the -1 at once). Its EYES is removed when the lookup still shows it.
export function failTarget(
    comment: RunComment,
    entry: LookupEntry | undefined,
    outcome: CommentOutcome
): FailTarget | undefined {
    if ((outcome !== 'open' && outcome !== 'failed') || entry?.rocketAt !== undefined) {
        return;
    }
    return { nodeId: comment.nodeId, dbId: comment.dbId, eyesOn: entry?.eyes ?? false };
}

function failTargets(states: readonly CommentState[]): FailTarget[] {
    return states
        .map((state) => failTarget(state.comment, state.entry, state.outcome))
        .filter((target) => target !== undefined);
}

function idList(targets: readonly FailTarget[]): string {
    return targets.map((target) => target.dbId).join(',');
}

export function attentionHint(reason: string): string {
    return ATTENTION_HINTS.get(reason) ?? '';
}

async function recordAttention(ctx: RunContext, reason: string): Promise<EvaluateResult> {
    const { record, session } = ctx;
    mergeRecord(session.stateDir, record.runId, { state: 'needs_attention', reason });
    if (record.state !== 'needs_attention' || record.reason !== reason) {
        const hint = attentionHint(reason);
        const suffix = hint.length > 0 ? `, ${hint}` : '';
        await notifyOwner(ctx.deps, session, `run ${record.runId} needs attention: ${reason}${suffix}`);
    }
    return { state: 'needs_attention', reason };
}

// False only while the lock still names runId after a failed release (for example a full disk while building the
// claim): the caller then keeps the record, so the next tick retries. A lock that names another run is not ours.
export function releaseRunLock(deps: Deps, stateDir: string, wtKey: string, runId: string): boolean {
    if (releaseWorktreeLock(stateDir, wtKey, runId) || worktreeLockHolder(stateDir, wtKey) !== runId) {
        return true;
    }
    deps.log.warn(`could not release the worktree lock of run ${runId}; retrying later`);
    return false;
}

// Marks the pane done only while it still carries this run's tag (pane ids are reused); a stop observed during the
// tag read leaves the pane unchanged.
async function markDone(ctx: RunContext): Promise<boolean> {
    const { deps, session, record, stop } = ctx;
    const tmuxPath = session.tools.tmux;
    const tag = await tmuxOn(deps, tmuxPath, record.socket, [
        'display-message',
        '-p',
        '-t',
        record.paneId,
        '#{@prwc_run}',
    ]);
    if (stop.aborted || tag?.code !== 0 || tag.stdout.trim() !== record.runId) {
        return false;
    }
    const epoch = String(deps.nowSeconds());
    const result = await tmuxOn(deps, tmuxPath, record.socket, [
        'set-option',
        '-p',
        '-t',
        record.paneId,
        '@prwc_done',
        epoch,
    ]);
    return result?.code === 0;
}

// Frees a run whose worker is confirmed gone; the pane and lock operations use the record's socket and worktree key.
// A stop request observed after any await, or a lock that could not be released, leaves record and lock in place and
// gives a deferred result; undefined means the run was cleared.
async function finishRun(ctx: RunContext): Promise<EvaluateResult | undefined> {
    const { deps, session, record, stop } = ctx;
    if (record.paneId.length > 0) {
        const marked = await markDone(ctx);
        if (!marked && !stop.aborted) {
            deps.log.warn(`could not mark the pane of run ${record.runId} as done`);
        }
        if (stop.aborted) {
            return deferred('stop-requested');
        }
    }
    await capDonePanes(deps, session.tools.tmux, record.socket, record.prKey, session.keepPanes);
    if (stop.aborted) {
        return deferred('stop-requested');
    }
    if (!releaseRunLock(deps, session.stateDir, record.worktreeKey, record.runId)) {
        return deferred('lock-release-failed');
    }
    clearRun(session.stateDir, record.runId);
}

// absent: claude.pid does not exist, claude never started; unreadable: the file exists but holds no pid.
function isMissingFile(error: unknown): boolean {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

// Only ENOENT means absent: any other read error (EIO, EACCES) leaves the claude process unknown.
function readClaudePid(dir: string): number | 'absent' | 'unreadable' {
    let text: string;
    try {
        text = fs.readFileSync(path.join(dir, 'claude.pid'), 'utf8').trim();
    } catch (error) {
        return isMissingFile(error) ? 'absent' : 'unreadable';
    }
    return isUintString(text) ? Number.parseInt(text, 10) : 'unreadable';
}

// Without claude.pid there is no claude process to signal; the TERM wait then decides on the worker alone. A pid that
// is this watcher or the pane process can never be claude (claude runs in a child of the launcher), so it is refused.
async function terminateClaude(ctx: RunContext): Promise<TermOutcome> {
    const { deps, session, record, capture, stop } = ctx;
    const dir = runDir(session.stateDir, record.runId);
    const pid = readClaudePid(dir);
    if (pid === 'absent') {
        return 'gone';
    }
    if (pid === 'unreadable') {
        return 'pidUnreadable';
    }
    if (pid === process.pid || pid === record.panePid) {
        return 'mismatch';
    }
    const start = readTextFile(path.join(dir, 'claude.start'))?.trim() ?? '';
    if (start.length === 0) {
        return 'noStart';
    }
    const guard = (): boolean =>
        !stop.aborted && readEvents(session.stateDir, record.runId).count === capture.events.count;
    return await signalIfSame(deps.runner, pid, start, 'SIGTERM', guard);
}

async function waitWorkerGone(ctx: RunContext): Promise<WaitOutcome> {
    const { deps, session, record, stop } = ctx;
    const seconds = readEnvSeconds(deps.env, ENV_NAMES.termWait, DEFAULT_TERM_WAIT);
    for (let waited = 0; ; waited += 1) {
        if (stop.aborted) {
            return 'aborted';
        }
        if (!workerAlive(session.stateDir, record.runId)) {
            return 'gone';
        }
        if (waited >= seconds) {
            return 'alive';
        }
        await deps.sleep(TERM_POLL_MS, stop);
    }
}

// claude is ended first; only once it is gone are the comments it did not finish marked as failed.
async function endRun(ctx: RunContext, decision: RunDecision, targets: readonly FailTarget[]): Promise<EvaluateResult> {
    const { deps, session, record } = ctx;
    const outcome = await terminateClaude(ctx);
    switch (outcome) {
        case 'vetoed': {
            return deferred('events-changed');
        }
        case 'unverifiable': {
            if (ctx.stop.aborted) {
                return deferred('stop-requested');
            }
            deps.log.warn(`could not verify claude pid for run ${record.runId}`);
            return deferred('claude-pid-unverifiable');
        }
        case 'mismatch':
        case 'noStart': {
            return await recordAttention(ctx, 'claude-pid-reused');
        }
        case 'pidUnreadable': {
            return await recordAttention(ctx, 'claude-pid-unreadable');
        }
        case 'sent':
        case 'gone': {
            break;
        }
    }
    const waited = await waitWorkerGone(ctx);
    if (waited === 'aborted') {
        return deferred('stop-requested');
    }
    if (waited === 'alive') {
        return await recordAttention(ctx, 'claude-did-not-exit');
    }
    await markFailed(deps, session, targets, ctx.stop);
    if (ctx.stop.aborted) {
        return deferred('stop-requested');
    }
    const interrupted = await finishRun(ctx);
    if (interrupted !== undefined) {
        return interrupted;
    }
    deps.log.info(`run ${record.runId} ${decision.state}: ${decision.reason}`);
    if (decision.state === 'failed') {
        await notifyOwner(deps, session, `run ${record.runId} failed: ${decision.reason}, comments ${idList(targets)}`);
    }
    return decision;
}

async function endExited(
    ctx: RunContext,
    targets: readonly FailTarget[],
    decision: RunDecision
): Promise<EvaluateResult> {
    const { deps, session, record } = ctx;
    await markFailed(deps, session, targets, ctx.stop);
    if (ctx.stop.aborted) {
        return deferred('stop-requested');
    }
    const interrupted = await finishRun(ctx);
    if (interrupted !== undefined) {
        return interrupted;
    }
    deps.log.info(`run ${record.runId} exited: ${decision.reason}`);
    return decision;
}

function recordRunning(ctx: RunContext, decision: RunDecision): EvaluateResult {
    const { record, session } = ctx;
    if (record.state !== 'running' || record.reason !== decision.reason) {
        mergeRecord(session.stateDir, record.runId, { state: 'running', reason: decision.reason });
    }
    return decision;
}

// An abandoned run never got its launch (the decision is cancel) and was kept only because its worktree lock could
// not be released: once its worker is gone the release is retried, and the run is cleared only when the lock is no
// longer held for it.
function finishAbandoned(deps: Deps, session: Session, record: RunRecord, stop: AbortSignal): EvaluateResult {
    if (stop.aborted) {
        return deferred('stop-requested');
    }
    if (workerAlive(session.stateDir, record.runId)) {
        return deferred('abandoned-worker-alive');
    }
    if (!releaseRunLock(deps, session.stateDir, record.worktreeKey, record.runId)) {
        return deferred('lock-release-failed');
    }
    clearRun(session.stateDir, record.runId);
    deps.log.info(`run ${record.runId} cleared: abandoned`);
    return { state: 'exited', reason: 'abandoned' };
}

// claude.pid is written only once claude.start holds the start time, right before claude is executed, so without it
// claude has not started; it never will once the launch decision is cancel (claimed here when still open), or once
// exit_status shows that the launcher finished.
async function claudeFate(deps: Deps, stateDir: string, runId: string): Promise<ClaudeFate> {
    const dir = runDir(stateDir, runId);
    const pid = readClaudePid(dir);
    if (pid === 'absent') {
        if (launchDecision(stateDir, runId) !== 'go') {
            claimLaunch(stateDir, runId, 'cancel');
        }
        const decision = launchDecision(stateDir, runId);
        const finished = decision === 'go' && fs.existsSync(path.join(dir, 'exit_status'));
        return decision === 'cancel' || finished ? 'never' : 'unknown';
    }
    if (pid === 'unreadable') {
        return 'unknown';
    }
    if (!pidAlive(pid)) {
        return 'gone';
    }
    const expected = readTextFile(path.join(dir, 'claude.start'))?.trim() ?? '';
    const actual = await processStart(deps.runner, pid);
    if (actual === undefined) {
        return pidAlive(pid) ? 'unknown' : 'gone';
    }
    if (expected.length === 0) {
        return 'unknown';
    }
    return actual === expected ? 'alive' : 'mismatch';
}

// present, absent, or undefined when the listing failed.
async function taggedPane(deps: Deps, session: Session, runId: string): Promise<'present' | 'absent' | undefined> {
    const args = ['list-panes', '-a', '-F', '#{pane_id} #{@prwc_run}'];
    const result = await tmuxOn(deps, session.tools.tmux, session.tmux.socket, args);
    if (result?.code !== 0) {
        return;
    }
    const tags = result.stdout.split('\n').map((line) => line.split(' ', 2)[1]);
    return tags.includes(runId) ? 'present' : 'absent';
}

// A run with an unreadable record is finished like an exited one when no pane on this watcher's tmux server carries
// its tag and its claude is verifiably gone (no such process) or never started. The comment ids are in the lost
// record, so no EYES reaction can be removed and no comment marked. Otherwise the result is the reason the run keeps its slot: a live pid whose
// start time differs is not proof of exit (the start time can shift after a host sleep), so it stays with the owner.
async function recoverUnreadable(
    deps: Deps,
    session: Session,
    runId: string,
    stop: AbortSignal
): Promise<EvaluateResult | string> {
    const pane = await taggedPane(deps, session, runId);
    if (stop.aborted) {
        return deferred('stop-requested');
    }
    if (pane !== 'absent') {
        return 'record-unreadable';
    }
    const fate = await claudeFate(deps, session.stateDir, runId);
    if (stop.aborted) {
        return deferred('stop-requested');
    }
    if (fate === 'mismatch') {
        return 'claude-pid-mismatch';
    }
    if (fate !== 'gone' && fate !== 'never') {
        return 'record-unreadable';
    }
    if (!releaseRunLock(deps, session.stateDir, session.worktreeKey, runId)) {
        return deferred('lock-release-failed');
    }
    clearRun(session.stateDir, runId);
    deps.log.warn(`run ${runId} with an unreadable record has exited; EYES reactions on its comments may remain`);
    return { state: 'exited', reason: 'record-unreadable' };
}

// Without its record a run keeps its slot and its worktree lock unless recoverUnreadable can prove that its worker
// is gone; the owner is told once per reason. run-missing means the run directory itself is gone: nothing can be
// verified.
async function unreadableRun(deps: Deps, session: Session, runId: string, stop: AbortSignal): Promise<EvaluateResult> {
    const key = `${session.stateDir}\n${runId}`;
    if (stop.aborted) {
        return deferred('stop-requested');
    }
    const recovered = fs.existsSync(runDir(session.stateDir, runId))
        ? await recoverUnreadable(deps, session, runId, stop)
        : 'run-missing';
    if (typeof recovered !== 'string') {
        if (recovered.state === 'exited') {
            unreadableNotices.delete(key);
        }
        return recovered;
    }
    if (unreadableNotices.get(key) !== recovered) {
        unreadableNotices.set(key, recovered);
        deps.log.warn(`run ${runId} needs attention: ${recovered}`);
        await notifyOwner(deps, session, `run ${runId} needs attention: ${recovered}`);
    }
    return { state: 'needs_attention', reason: recovered };
}

// Decides on the capture taken before the lookup and applies the effects. Nothing acts on hook evidence that changed
// since the capture, and nothing runs once stop is aborted.
export async function evaluateRun(
    deps: Deps,
    session: Session,
    runId: string,
    capture: Capture,
    lookup: LookupResult,
    stop: AbortSignal
): Promise<EvaluateResult> {
    const read = readRecord(session.stateDir, runId);
    if (read.kind !== 'ok') {
        return await unreadableRun(deps, session, runId, stop);
    }
    unreadableNotices.delete(`${session.stateDir}\n${runId}`);
    const { record } = read;
    if (record.state === 'preparing') {
        return { state: 'preparing', reason: record.reason };
    }
    if (record.state === 'abandoned') {
        return finishAbandoned(deps, session, record, stop);
    }
    if (readEvents(session.stateDir, runId).count !== capture.events.count) {
        return deferred('events-changed');
    }
    const states = record.comments.map((comment): CommentState => {
        const entry = lookup.entries.find((item) => item.nodeId === comment.nodeId);
        return { comment, entry, outcome: commentOutcome(comment, entry, lookup.gone.includes(comment.nodeId)) };
    });
    const decision = decideRun({
        alive: capture.alive,
        comments: states.map((state) => state.outcome),
        events: capture.events,
        startedAt: record.startedAt,
        now: deps.nowSeconds(),
        startTimeout: readEnvSeconds(deps.env, ENV_NAMES.startTimeout, DEFAULT_START_TIMEOUT),
        stopQuiet: readEnvSeconds(deps.env, ENV_NAMES.stopQuiet, DEFAULT_STOP_QUIET),
    });
    logNewEvents(deps, session.stateDir, runId, capture.events);
    if (stop.aborted) {
        return deferred('stop-requested');
    }
    const ctx: RunContext = { deps, session, record, capture, stop };
    switch (decision.state) {
        case 'running': {
            return recordRunning(ctx, decision);
        }
        case 'needs_attention': {
            return await recordAttention(ctx, decision.reason);
        }
        case 'exited': {
            return await endExited(ctx, failTargets(states), decision);
        }
        case 'completed':
        case 'failed': {
            return await endRun(ctx, decision, failTargets(states));
        }
    }
}
