import { DEFAULT_RATE_RESERVE, DEFAULT_READY_WAIT, DEFAULT_RUN_CHECK, ENV_NAMES } from './constants.ts';
import { dispatch, resumeDispatch, retryLockRelease, type DispatchResult } from './dispatch.ts';
import { lookupComments, react } from './githubLookup.ts';
import { pollPr } from './githubPoll.ts';
import { launchReady, readLaunchResult, writeLaunchResult } from './launchChannel.ts';
import { acquirePrLock, releasePrLock } from './locks.ts';
import { nextDelay } from './pacing.ts';
import { preflight } from './preflight.ts';
import { processStart } from './proc.ts';
import { buildQueue, lookupIds } from './queue.ts';
import { reconcile } from './reconcile.ts';
import { attentionHint, captureRun, evaluateRun } from './runState.ts';
import { readRecord, readStatus, writeStatus } from './runStore.ts';
import { initState, resolveStateDir, type InitStateResult } from './stateStore.ts';
import type {
    Candidate,
    Capture,
    CliOptions,
    Deps,
    Env,
    GhFailure,
    LaunchResult,
    Logger,
    LookupEntry,
    LookupResult,
    PollResult,
    PrRef,
    RateInfo,
    Session,
    WatcherStatus,
} from './types.ts';
import { visibleText } from './untrustedText.ts';
import { readEnvSeconds, safeText } from './validate.ts';

type TickOutcome = 'ok' | 'transient' | 'fatal' | 'prClosed' | 'stopped';

type StatusFields = Pick<WatcherStatus, 'state' | 'reason' | 'hint'>;

// The watcher loop's only mutable state. lastTickAt (epoch seconds) and lastTickMono (monotonic milliseconds from
// monotonicMs) are taken together when a tick's delay is planned; lastPollAt (epoch seconds) is the last PR poll that
// succeeded; pendingLockRunId names a worktree lock a held dispatch could not release, retried on every tick;
// endMessage says why a terminal tick ended the loop; unpublishedFatal is the first fatal message whose write was not
// confirmed, so its retry keeps the reason.
interface WatcherRuntime {
    inflightRunId: string | undefined;
    lastPollAt: number | undefined;
    failures: number;
    rate: RateInfo;
    lastTickAt: number | undefined;
    lastTickMono: number | undefined;
    monotonicMs: () => number;
    published: boolean;
    launchToken: string;
    windowId: string;
    pendingLockRunId: string | undefined;
    endMessage: string;
    unpublishedFatal: string;
}

export interface TickHooks {
    beforePoll?(): void;
}

// A preparing run is resumed and never captured; any other in-flight run (an unreadable record too, without node
// ids) is evaluated on the capture taken before its lookup.
type Inflight =
    | { kind: 'preparing'; runId: string; nodeIds: string[] }
    | { kind: 'evaluate'; runId: string; nodeIds: string[]; capture: Capture };

// kept: the run still holds the slot; cleared: the slot is free and reason says why the run ended.
type InflightResult = { kind: 'kept' } | { kind: 'cleared'; reason: string };

// A check that could not finish ends the tick with outcome (a failed lookup or a stop).
type CheckResult = InflightResult | { kind: 'ended'; outcome: TickOutcome };

interface TickContext {
    stop: AbortSignal;
    suspended: boolean;
}

interface StartContext {
    deps: Deps;
    options: CliOptions;
    cwd: string;
    nodePath: string;
    stop: AbortSignal;
    stateDir: string;
    pr: PrRef;
    rt: WatcherRuntime;
}

type Prepared = { kind: 'done'; code: number } | { kind: 'locked'; session: Session };

const LAUNCH_TOKEN = /^[\d-]+$/u;
const WINDOW_ID = /^@\d+$/u;
const READY_POLL_MS = 200;
// Wall seconds beyond the monotonic seconds since the last tick that count as a host sleep.
const SUSPEND_MARGIN_SECONDS = 30;
const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
const NOT_CONFIRMED = 'launch not confirmed by the background start';
const STOPPED_EARLY = 'watcher stopped before its first poll';
const ENDED_EARLY = 'watcher ended before its first poll';
const LOCK_PENDING = 'worktree lock release pending';
const NO_RUN: Pick<WatcherStatus, 'runId' | 'comments'> = { runId: '', comments: '' };
const CLEARED_STATES: ReadonlySet<string> = new Set(['completed', 'failed', 'exited']);

export function createRuntime(launchToken: string, windowId: string): WatcherRuntime {
    return {
        inflightRunId: undefined,
        lastPollAt: undefined,
        failures: 0,
        rate: { remaining: undefined, resetAt: undefined },
        lastTickAt: undefined,
        lastTickMono: undefined,
        monotonicMs: () => performance.now(),
        published: false,
        launchToken,
        windowId,
        pendingLockRunId: undefined,
        endMessage: '',
        unpublishedFatal: '',
    };
}

export function installStopSignals(): AbortSignal {
    const controller = new AbortController();
    for (const name of STOP_SIGNALS) {
        process.on(name, () => {
            controller.abort();
        });
    }
    return controller.signal;
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : 'unknown error';
}

// Write-once per launch and never throws: a no-op in foreground mode (no launch token) and once a result of this
// launch exists. A write that is not confirmed leaves the result unpublished, so the next attempt retries it.
function publishLaunch(
    log: Logger,
    stateDir: string,
    prKey: string,
    rt: WatcherRuntime,
    result: LaunchResult['result'],
    message: string,
    holder?: { pid: number; windowId: string }
): void {
    if (rt.launchToken.length === 0 || rt.published) {
        return;
    }
    let written = false;
    try {
        written = writeLaunchResult(stateDir, prKey, {
            token: rt.launchToken,
            result,
            message,
            pid: holder?.pid ?? process.pid,
            windowId: holder?.windowId ?? rt.windowId,
        });
    } catch (error) {
        log.warn(`could not write the launch result: ${safeText(errorText(error))}`);
    }
    if (written || readLaunchResult(stateDir, prKey, rt.launchToken) !== undefined) {
        rt.published = true;
        return;
    }
    if (result === 'fatal' && rt.unpublishedFatal.length === 0) {
        rt.unpublishedFatal = message;
    }
    log.warn(`the launch result ${result} was not written; retrying later`);
}

// Merges the fields into the status; since moves only when the state changes.
function setStatus(deps: Deps, session: Session, patch: Partial<WatcherStatus>): void {
    const { stateDir, pr } = session;
    const now = deps.nowSeconds();
    const changed = patch.state !== undefined && readStatus(stateDir, pr.prKey)?.state !== patch.state;
    writeStatus(stateDir, pr.prKey, changed ? { ...patch, since: now } : patch, now);
}

function runFields(session: Session, runId: string | undefined): Pick<WatcherStatus, 'runId' | 'comments'> {
    if (runId === undefined) {
        return NO_RUN;
    }
    const read = readRecord(session.stateDir, runId);
    const comments = read.kind === 'ok' ? read.record.comments.map((comment) => comment.dbId).join(',') : '';
    return { runId: safeText(runId), comments };
}

// Pacing always uses whichever rate came last; a reading without a remaining budget (an all-gone lookup) is not one.
function storeRate(rt: WatcherRuntime, rate: RateInfo | undefined): void {
    if (rate?.remaining !== undefined) {
        rt.rate = rate;
    }
}

// On macOS and Linux the monotonic clock stands still while the host sleeps, so wall time beyond the monotonic time
// since the last tick means the host was suspended (failures right after a wake-up are not counted). A long command
// advances both clocks and is no jump; a wall-clock step reads as one, which only leaves one failure uncounted.
function hostSuspended(rt: WatcherRuntime, wallNow: number): boolean {
    if (rt.lastTickAt === undefined || rt.lastTickMono === undefined) {
        return false;
    }
    const monoSeconds = (rt.monotonicMs() - rt.lastTickMono) / 1000;
    return wallNow - rt.lastTickAt - monoSeconds > SUSPEND_MARGIN_SECONDS;
}

// An abort makes the in-flight command fail, so the abort is checked first: nothing is counted or written then.
function failedFetch(
    deps: Deps,
    session: Session,
    rt: WatcherRuntime,
    stop: AbortSignal,
    failure: GhFailure,
    suspended: boolean
): TickOutcome {
    if (stop.aborted) {
        return 'stopped';
    }
    const message = safeText(failure.message);
    if (failure.kind === 'auth') {
        deps.log.error(`GitHub authentication failed: ${message}`);
        setStatus(deps, session, { state: 'fatal', lastError: message });
        rt.endMessage = message;
        return 'fatal';
    }
    storeRate(rt, failure.rate);
    if (!suspended) {
        rt.failures += 1;
    }
    deps.log.warn(`GitHub request failed, backing off: ${message}`);
    setStatus(deps, session, { state: 'backing_off', lastError: message });
    return 'transient';
}

function noteInflight(session: Session, runId: string): Inflight {
    const read = readRecord(session.stateDir, runId);
    const record = read.kind === 'ok' ? read.record : undefined;
    const nodeIds = record?.comments.map((comment) => comment.nodeId) ?? [];
    if (record?.state === 'preparing') {
        return { kind: 'preparing', runId, nodeIds };
    }
    return { kind: 'evaluate', runId, nodeIds, capture: captureRun(session.stateDir, runId) };
}

function retryPendingLock(deps: Deps, session: Session, rt: WatcherRuntime): void {
    if (rt.pendingLockRunId !== undefined && retryLockRelease(deps, session, rt.pendingLockRunId)) {
        deps.log.info(`released the worktree lock of run ${safeText(rt.pendingLockRunId)}`);
        rt.pendingLockRunId = undefined;
    }
}

async function refuseEdited(deps: Deps, session: Session, entry: LookupEntry): Promise<void> {
    const removed = await react(deps, session.tools.gh, 'remove', entry.nodeId, 'ROCKET');
    if (removed.kind === 'ok') {
        deps.log.info(`comment ${entry.dbId} was edited after approval; add the rocket again to approve the new text`);
        return;
    }
    const detail = removed.kind === 'invalid' ? 'invalid comment node id' : safeText(removed.message);
    deps.log.warn(`comment ${entry.dbId} was edited after approval; its rocket removal failed: ${detail}`);
}

async function resumeInflight(
    deps: Deps,
    session: Session,
    rt: WatcherRuntime,
    inflight: Extract<Inflight, { kind: 'preparing' }>,
    lists: { poll: PollResult; lookup: LookupResult },
    stop: AbortSignal
): Promise<void> {
    const ids = new Set(inflight.nodeIds);
    const rocketed = new Set(
        lists.poll.comments.filter((item) => item.rocket && ids.has(item.nodeId)).map((item) => item.nodeId)
    );
    const entries = lists.lookup.entries.filter((item) => ids.has(item.nodeId));
    const resumed = await resumeDispatch(deps, session, inflight.runId, rocketed, entries);
    rt.inflightRunId = resumed.runId;
    if (stop.aborted) {
        return;
    }
    const fields = runFields(session, resumed.runId);
    switch (resumed.outcome) {
        case 'dispatched': {
            setStatus(deps, session, { state: 'running', reason: '', hint: '', ...fields });
            break;
        }
        case 'rocketRemovalFailed': {
            setStatus(deps, session, { state: 'running', reason: 'preparing', hint: '', ...fields });
            break;
        }
        case 'abandoned': {
            setStatus(deps, session, { state: 'polling', reason: '', hint: '', ...fields });
            break;
        }
    }
}

// Evaluates the run on the capture taken before the poll. Every result that keeps the run is shown in the status
// with its reason, so no run stays in flight silently; a cleared run frees the slot and its reason is kept for the
// status written next.
async function evaluateInflight(
    deps: Deps,
    session: Session,
    rt: WatcherRuntime,
    inflight: Extract<Inflight, { kind: 'evaluate' }>,
    lookup: LookupResult,
    stop: AbortSignal
): Promise<InflightResult> {
    const { runId } = inflight;
    const result = await evaluateRun(deps, session, runId, inflight.capture, lookup, stop);
    const reason = safeText(result.reason.length > 0 ? result.reason : result.state);
    if (CLEARED_STATES.has(result.state)) {
        rt.inflightRunId = undefined;
        return { kind: 'cleared', reason };
    }
    if (stop.aborted) {
        return { kind: 'kept' };
    }
    const previous = readStatus(session.stateDir, session.pr.prKey);
    if (result.state === 'deferred' && previous?.reason !== reason) {
        deps.log.info(`run ${safeText(runId)} deferred: ${reason}`);
    }
    const state = result.state === 'needs_attention' ? 'needs_attention' : 'running';
    const hint = state === 'needs_attention' ? attentionHint(result.reason) : '';
    setStatus(deps, session, { state, reason, hint, ...runFields(session, runId) });
    return { kind: 'kept' };
}

function dispatchStatus(result: DispatchResult, lockPending: boolean): StatusFields {
    switch (result.outcome) {
        case 'dispatched': {
            return { state: 'running', reason: '', hint: '' };
        }
        case 'busy': {
            return { state: 'holding', reason: lockPending ? LOCK_PENDING : 'clone busy', hint: '' };
        }
        case 'held': {
            return { state: 'holding', reason: result.reason, hint: result.hint };
        }
        case 'rocketRemovalFailed': {
            return { state: 'running', reason: 'preparing', hint: '' };
        }
        case 'abandoned': {
            return { state: 'polling', reason: '', hint: '' };
        }
        case 'contextFailed': {
            return { state: 'holding', reason: 'context fetch failed', hint: '' };
        }
    }
}

// A kept run (abandoned or contextFailed with a run id) stays in flight, so its evaluation finishes it. Without
// candidates the status is polling with idleReason (why a run was just cleared, or empty).
async function dispatchNext(
    deps: Deps,
    session: Session,
    rt: WatcherRuntime,
    next: { candidates: Candidate[]; poll: PollResult; idleReason: string },
    stop: AbortSignal
): Promise<void> {
    if (next.candidates.length === 0) {
        setStatus(deps, session, { state: 'polling', reason: next.idleReason, hint: '', ...NO_RUN });
        return;
    }
    const result = await dispatch(deps, session, next.candidates, next.poll);
    if (result.pendingLockRunId !== undefined) {
        rt.pendingLockRunId = result.pendingLockRunId;
    }
    rt.inflightRunId = result.runId;
    if (stop.aborted) {
        return;
    }
    const lockPending = rt.pendingLockRunId !== undefined;
    setStatus(deps, session, { ...dispatchStatus(result, lockPending), ...runFields(session, result.runId) });
}

function emptyLookup(): LookupResult {
    return { rate: { remaining: undefined, resetAt: undefined }, entries: [], gone: [] };
}

function pollDue(deps: Deps, session: Session, rt: WatcherRuntime): boolean {
    return rt.lastPollAt === undefined || deps.nowSeconds() - rt.lastPollAt >= session.interval;
}

// Looks up the comments of the run in flight and evaluates it on the capture taken before the lookup. A lookup that
// succeeded already counts as the startup checkpoint: ending a finished run can wait for claude to exit, and the
// background start must not wait for that.
async function checkInflight(
    deps: Deps,
    session: Session,
    rt: WatcherRuntime,
    inflight: Extract<Inflight, { kind: 'evaluate' }>,
    ctx: TickContext
): Promise<CheckResult> {
    let lookup = emptyLookup();
    if (inflight.nodeIds.length > 0) {
        const looked = await lookupComments(deps, session.tools.gh, inflight.nodeIds);
        if (looked.kind !== 'ok') {
            return { kind: 'ended', outcome: failedFetch(deps, session, rt, ctx.stop, looked, ctx.suspended) };
        }
        lookup = looked.result;
        storeRate(rt, lookup.rate);
        publishLaunch(deps.log, session.stateDir, session.pr.prKey, rt, 'firstPoll', 'first poll succeeded');
    }
    if (ctx.stop.aborted) {
        return { kind: 'ended', outcome: 'stopped' };
    }
    const evaluated = await evaluateInflight(deps, session, rt, inflight, lookup, ctx.stop);
    return ctx.stop.aborted ? { kind: 'ended', outcome: 'stopped' } : evaluated;
}

// The PR poll, one batched lookup of the rocketed comments (and of a preparing run's comments), the startup
// checkpoint, the refusals of edited comments, then the resume of a preparing run or, with the slot free, one
// dispatch of up to batchMax comments. inflight is the run that still holds the slot after its check.
async function pollTick(
    deps: Deps,
    session: Session,
    rt: WatcherRuntime,
    next: { inflight: Inflight | undefined; idleReason: string },
    ctx: TickContext
): Promise<TickOutcome> {
    const { stateDir, pr, tools } = session;
    const { inflight } = next;
    const { stop } = ctx;
    const polled = await pollPr(deps, tools.gh, pr);
    if (polled.kind !== 'ok') {
        return failedFetch(deps, session, rt, stop, polled, ctx.suspended);
    }
    const poll = polled.result;
    storeRate(rt, poll.rate);
    if (stop.aborted) {
        return 'stopped';
    }
    if (poll.prState !== 'OPEN') {
        deps.log.info(`pull request is ${poll.prState}, stopping`);
        setStatus(deps, session, { state: 'exited', reason: `pull request is ${poll.prState}`, hint: '' });
        rt.endMessage = `pull request is ${poll.prState}`;
        return 'prClosed';
    }
    const inflightIds = inflight?.nodeIds ?? [];
    const ids = lookupIds(poll, inflight?.kind === 'preparing' ? inflightIds : []);
    let lookup = emptyLookup();
    if (ids.length > 0) {
        const looked = await lookupComments(deps, tools.gh, ids);
        if (looked.kind !== 'ok') {
            return failedFetch(deps, session, rt, stop, looked, ctx.suspended);
        }
        lookup = looked.result;
        storeRate(rt, lookup.rate);
    }
    rt.failures = 0;
    rt.lastPollAt = deps.nowSeconds();
    if (stop.aborted) {
        return 'stopped';
    }
    publishLaunch(deps.log, stateDir, pr.prKey, rt, 'firstPoll', 'first poll succeeded');
    const queue = buildQueue(poll, lookup, inflightIds, deps.log);
    for (const entry of queue.edited) {
        if (stop.aborted) {
            return 'stopped';
        }
        await refuseEdited(deps, session, entry);
    }
    if (stop.aborted) {
        return 'stopped';
    }
    if (inflight?.kind === 'preparing') {
        await resumeInflight(deps, session, rt, inflight, { poll, lookup }, stop);
        return stop.aborted ? 'stopped' : 'ok';
    }
    if (inflight !== undefined) {
        return 'ok';
    }
    const candidates = queue.candidates.slice(0, session.batchMax);
    await dispatchNext(deps, session, rt, { candidates, poll, idleReason: next.idleReason }, stop);
    return stop.aborted ? 'stopped' : 'ok';
}

// One tick. A run in flight is checked first, on a capture taken before its lookup; the PR is polled only when no
// run holds the slot, when a preparing run needs its resume, when the run just ended (so the next batch starts at
// once), or when --interval has passed since the last poll. The backoff counter is reset only by a tick whose every
// GitHub request succeeded, so a failing poll keeps backing off while the run checks succeed. The stop signal is
// checked before the first effect and after every awaited step; an observed abort always ends the tick as stopped.
export async function watchTick(
    deps: Deps,
    session: Session,
    rt: WatcherRuntime,
    stop: AbortSignal,
    hooks?: TickHooks
): Promise<TickOutcome> {
    if (stop.aborted) {
        return 'stopped';
    }
    const ctx: TickContext = { stop, suspended: hostSuspended(rt, deps.nowSeconds()) };
    retryPendingLock(deps, session, rt);
    const inflight = rt.inflightRunId === undefined ? undefined : noteInflight(session, rt.inflightRunId);
    hooks?.beforePoll?.();
    if (inflight?.kind !== 'evaluate') {
        return await pollTick(deps, session, rt, { inflight, idleReason: '' }, ctx);
    }
    const checked = await checkInflight(deps, session, rt, inflight, ctx);
    switch (checked.kind) {
        case 'ended': {
            return checked.outcome;
        }
        case 'kept': {
            if (pollDue(deps, session, rt)) {
                return await pollTick(deps, session, rt, { inflight, idleReason: '' }, ctx);
            }
            rt.failures = 0;
            return 'ok';
        }
        case 'cleared': {
            return await pollTick(deps, session, rt, { inflight: undefined, idleReason: checked.reason }, ctx);
        }
    }
}

function resetLabel(resetAt: number | undefined): string {
    return resetAt === undefined ? 'unknown' : new Date(resetAt * 1000).toISOString();
}

// Runs only after an ok or transient tick, so throttled never overwrites fatal or exited; a throttled status keeps the
// tick's reason and hint. While a run is in flight the next tick comes after PRWC_RUN_CHECK seconds (or --interval,
// when that is shorter), so its end is seen soon without polling the PR more often.
export function applyPacing(deps: Deps, session: Session, rt: WatcherRuntime): number {
    const now = deps.nowSeconds();
    const reserve = readEnvSeconds(deps.env, ENV_NAMES.rateReserve, DEFAULT_RATE_RESERVE);
    const runCheck = readEnvSeconds(deps.env, ENV_NAMES.runCheck, DEFAULT_RUN_CHECK);
    const base = rt.inflightRunId === undefined ? session.interval : Math.min(session.interval, runCheck);
    const step = nextDelay(base, rt.failures, rt.rate, now, reserve);
    if (step.mode === 'throttled') {
        deps.log.warn(`throttled until ${resetLabel(rt.rate.resetAt)}`);
        setStatus(deps, session, { state: 'throttled' });
    }
    rt.lastTickAt = now;
    rt.lastTickMono = rt.monotonicMs();
    return step.delaySeconds;
}

function launchTokenOf(env: Env): string {
    const token = env[ENV_NAMES.launchToken] ?? '';
    return LAUNCH_TOKEN.test(token) ? token : '';
}

function shownWindow(windowId: string): string {
    return WINDOW_ID.test(windowId) ? windowId : safeText(windowId);
}

// The reason may hold a path from the environment, so every control character is shown escaped.
function stateRefusal(result: Exclude<InitStateResult, { ok: true }>): string {
    return visibleText(result.kind === 'format' ? `unsupported state format ${result.found}` : result.reason);
}

function endedMessage(rt: WatcherRuntime, stop: AbortSignal): string {
    if (rt.unpublishedFatal.length > 0) {
        return rt.unpublishedFatal;
    }
    if (stop.aborted) {
        return STOPPED_EARLY;
    }
    return rt.endMessage.length > 0 ? rt.endMessage : ENDED_EARLY;
}

// The background parent writes the ready marker only after tagging the window and setting remain-on-exit, so even
// an immediate fatal exit stays readable in the window. Not ready means timeout or stop.
async function waitLaunchReady(
    deps: Deps,
    stateDir: string,
    prKey: string,
    token: string,
    stop: AbortSignal
): Promise<boolean> {
    const attempts = (readEnvSeconds(deps.env, ENV_NAMES.readyWait, DEFAULT_READY_WAIT) * 1000) / READY_POLL_MS;
    for (let attempt = 0; ; attempt += 1) {
        if (stop.aborted) {
            return false;
        }
        if (launchReady(stateDir, prKey, token)) {
            return true;
        }
        if (attempt >= attempts) {
            return false;
        }
        await deps.sleep(READY_POLL_MS, stop);
    }
}

async function watchLoop(deps: Deps, session: Session, rt: WatcherRuntime, stop: AbortSignal): Promise<number> {
    const { stateDir, pr } = session;
    for (;;) {
        const outcome = await watchTick(deps, session, rt, stop);
        switch (outcome) {
            case 'fatal': {
                publishLaunch(deps.log, stateDir, pr.prKey, rt, 'fatal', rt.endMessage);
                return 1;
            }
            case 'prClosed': {
                publishLaunch(deps.log, stateDir, pr.prKey, rt, 'fatal', rt.endMessage);
                return 0;
            }
            case 'stopped': {
                publishLaunch(deps.log, stateDir, pr.prKey, rt, 'fatal', STOPPED_EARLY);
                return 0;
            }
            case 'ok':
            case 'transient': {
                break;
            }
        }
        const delaySeconds = applyPacing(deps, session, rt);
        if (session.once) {
            return outcome === 'ok' ? 0 : 1;
        }
        await deps.sleep(delaySeconds * 1000, stop);
        if (stop.aborted) {
            return 0;
        }
    }
}

function reportUnexpected(deps: Deps, stateDir: string, prKey: string, rt: WatcherRuntime, error: unknown): void {
    const message = `unexpected error: ${safeText(errorText(error))}`;
    deps.log.error(message);
    publishLaunch(deps.log, stateDir, prKey, rt, 'fatal', message);
}

function releaseOwnLock(deps: Deps, session: Session): void {
    const { stateDir, pr } = session;
    if (!releasePrLock(stateDir, pr.prKey, process.pid) && !releasePrLock(stateDir, pr.prKey, process.pid)) {
        deps.log.warn(`could not release the PR lock of ${pr.prKey}`);
    }
}

// Everything after the PR lock was acquired: the lock is released on every exit path, whatever the last launch
// publication does; a running worker and its worktree lock are always left alone.
async function watchLocked(deps: Deps, session: Session, rt: WatcherRuntime, stop: AbortSignal): Promise<number> {
    const { stateDir, pr } = session;
    try {
        const now = deps.nowSeconds();
        const reset: Partial<WatcherStatus> = {
            state: 'starting',
            pid: process.pid,
            lastError: '',
            reason: '',
            hint: '',
        };
        writeStatus(stateDir, pr.prKey, { ...reset, ...NO_RUN, since: now }, now);
        const reconciled = await reconcile(deps, session, stop);
        rt.inflightRunId = reconciled.inflightRunId;
        if (stop.aborted) {
            return 0;
        }
        return await watchLoop(deps, session, rt, stop);
    } catch (error) {
        reportUnexpected(deps, stateDir, pr.prKey, rt, error);
        throw error;
    } finally {
        try {
            publishLaunch(deps.log, stateDir, pr.prKey, rt, 'fatal', endedMessage(rt, stop));
        } finally {
            releaseOwnLock(deps, session);
        }
    }
}

function stoppedEarly(ctx: StartContext): Prepared {
    ctx.deps.log.info(STOPPED_EARLY);
    publishLaunch(ctx.deps.log, ctx.stateDir, ctx.pr.prKey, ctx.rt, 'fatal', STOPPED_EARLY);
    return { kind: 'done', code: 0 };
}

function failEarly(ctx: StartContext, message: string): Prepared {
    ctx.deps.out(`${message}\n`);
    publishLaunch(ctx.deps.log, ctx.stateDir, ctx.pr.prKey, ctx.rt, 'fatal', message);
    return { kind: 'done', code: 1 };
}

// Launch confirmation, preflight, the own start time and the PR lock; a stop observed after any await ends the start
// before anything is acquired, written or polled.
async function prepareWatch(ctx: StartContext): Promise<Prepared> {
    const { deps, stop, stateDir, pr, rt } = ctx;
    if (rt.launchToken.length > 0 && !(await waitLaunchReady(deps, stateDir, pr.prKey, rt.launchToken, stop))) {
        deps.log.error(NOT_CONFIRMED);
        publishLaunch(deps.log, stateDir, pr.prKey, rt, 'fatal', NOT_CONFIRMED);
        return { kind: 'done', code: 1 };
    }
    const checked = await preflight(deps, ctx.options, ctx.cwd, ctx.nodePath);
    if (stop.aborted) {
        return stoppedEarly(ctx);
    }
    if (!checked.ok) {
        return failEarly(ctx, checked.reason);
    }
    const session: Session = { ...checked.session, stateDir };
    rt.windowId = session.tmux.windowId;
    const pidStart = await processStart(deps.runner, process.pid);
    if (stop.aborted) {
        return stoppedEarly(ctx);
    }
    if (pidStart === undefined) {
        return failEarly(ctx, "could not read the watcher's own start time");
    }
    const now = deps.nowSeconds();
    const { tmux } = session;
    const fields = { pidStart, paneId: tmux.pane, windowId: tmux.windowId, socket: tmux.socket, dir: session.dirCanon };
    const acquired = acquirePrLock(stateDir, pr.prKey, { ...fields, startedAt: now }, process.pid, now);
    if (acquired.kind === 'acquired') {
        return { kind: 'locked', session };
    }
    if (acquired.pid <= 0) {
        return failEarly(ctx, 'the PR lock is held by an unreadable owner');
    }
    deps.out(`already watched by pid ${acquired.pid} (window ${shownWindow(acquired.windowId)})\n`);
    const holder = { pid: acquired.pid, windowId: acquired.windowId };
    publishLaunch(deps.log, stateDir, pr.prKey, rt, 'alreadyWatched', 'already watched', holder);
    return { kind: 'done', code: 0 };
}

// The state directory is validated before anything else, the launch channel included: a refused directory is never
// read or written. An unexpected exception is published as fatal and rethrown. Returns the exit code.
export async function runWatch(
    deps: Deps,
    options: CliOptions,
    cwd: string,
    nodePath: string,
    stop: AbortSignal
): Promise<number> {
    const state = initState(resolveStateDir(deps.env, cwd));
    if (!state.ok) {
        deps.out(`${stateRefusal(state)}\n`);
        return 1;
    }
    const { pr } = options;
    if (pr === undefined) {
        deps.out('missing PR URL\n');
        return 1;
    }
    const { stateDir } = state;
    const rt = createRuntime(launchTokenOf(deps.env), '');
    let prepared: Prepared;
    try {
        prepared = await prepareWatch({ deps, options, cwd, nodePath, stop, stateDir, pr, rt });
    } catch (error) {
        reportUnexpected(deps, stateDir, pr.prKey, rt, error);
        throw error;
    }
    if (prepared.kind === 'done') {
        return prepared.code;
    }
    return await watchLocked(deps, prepared.session, rt, stop);
}
