import fs from 'node:fs';
import path from 'node:path';

import {
    DEFAULT_BG_TIMEOUT,
    DEFAULT_LAUNCH_WAIT,
    DEFAULT_RATE_RESERVE,
    DEFAULT_READY_WAIT,
    DEFAULT_RUN_CHECK,
    DEFAULT_START_TIMEOUT,
    DEFAULT_STOP_QUIET,
    DEFAULT_STOP_WAIT,
    ENV_NAMES,
    GH_STRIP_VARS,
    PS_PATH,
} from './constants.ts';
import { clearLaunch, markLaunchReady, readLaunchResult } from './launchChannel.ts';
import { newLockToken, readPrLockOwner } from './locks.ts';
import { normalizeCallerPath, preflight, resolveExecutable } from './preflight.ts';
import { pidAlive, signalIfSame } from './proc.ts';
import { listRunIds, readRecord, readStatus, type RecordRead } from './runStore.ts';
import { initState, resolveStateDir, runDir, watcherDir, type InitStateResult } from './stateStore.ts';
import {
    killDeadWatcherPane,
    newWatcherWindow,
    paneState,
    tmuxOn,
    type PaneState,
    type TmuxDeps,
    watcherWindowName,
    type WatcherWindow,
} from './tmuxControl.ts';
import type { CliOptions, CommandRunner, Deps, Env, LaunchResult, PrLockOwner, Session } from './types.ts';
import { visibleText } from './untrustedText.ts';
import { isSafeSocketPath, isUintString, isValidHost, isValidName, readEnvSeconds, safeText } from './validate.ts';

export interface BackgroundEntry {
    node: string;
    mainTs: string;
}

interface RunEntry {
    runId: string;
    read: RecordRead;
}

export interface ListHooks {
    afterListing?: (_runIds: readonly string[]) => void;
}

type WatcherEnd = 'gone' | 'exited' | 'failed';

// exited: the watcher pane died before any result of this launch was written.
type LaunchOutcome = LaunchResult | 'exited' | undefined;

// Every override the background watcher reads, forwarded with its effective value so a stale value in a tmux server
// environment never survives; the state directory and the launch token are set separately.
const FORWARDED_OVERRIDES: readonly (readonly [string, number])[] = [
    [ENV_NAMES.startTimeout, DEFAULT_START_TIMEOUT],
    [ENV_NAMES.launchWait, DEFAULT_LAUNCH_WAIT],
    [ENV_NAMES.rateReserve, DEFAULT_RATE_RESERVE],
    [ENV_NAMES.stopQuiet, DEFAULT_STOP_QUIET],
    [ENV_NAMES.readyWait, DEFAULT_READY_WAIT],
    [ENV_NAMES.bgTimeout, DEFAULT_BG_TIMEOUT],
    [ENV_NAMES.runCheck, DEFAULT_RUN_CHECK],
];
const WINDOW_ID = /^@\d+$/u;
const PANE_ID = /^%\d+$/u;
const RESULT_POLL_MS = 1000;
const EXIT_POLL_MS = 100;
// After a signalled watcher exits, tmux may need a moment to mark its kept pane dead.
const PANE_SETTLE_MS = 1000;
// tmux queries of stop and of the result wait must not hang on an unresponsive server for the default command timeout.
const TMUX_QUERY_TIMEOUT_MS = 10_000;
const PS_TIMEOUT_MS = 10_000;
const PS_ENV: Env = { LC_ALL: 'C', PATH: '/usr/bin:/bin' };
const LOCK_NAME = 'lock';
const RECORD_FILE = 'record.json';

function errorCode(error: unknown): string | undefined {
    return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

function shownWindow(windowId: string): string {
    return WINDOW_ID.test(windowId) ? windowId : safeText(windowId);
}

function alreadyWatched(pid: number, windowId: string): string {
    return `already watched by pid ${pid} (window ${shownWindow(windowId)})\n`;
}

// The reason may hold a path from the environment, so every control character is shown escaped.
function stateRefusal(result: Exclude<InitStateResult, { ok: true }>): string {
    return `${visibleText(result.kind === 'format' ? `unsupported state format ${result.found}` : result.reason)}\n`;
}

// Only a missing entry is absent; an entry that cannot be checked counts as present.
function entryPresent(file: string): boolean {
    try {
        fs.lstatSync(file);
        return true;
    } catch (error) {
        return errorCode(error) !== 'ENOENT';
    }
}

function withoutStripped(env: Env): Env {
    return Object.fromEntries(Object.entries(env).filter(([name]) => !GH_STRIP_VARS.includes(name)));
}

// Milliseconds left until a performance.now() deadline, never below zero.
function remainingMs(deadline: number): number {
    return Math.max(deadline - performance.now(), 0);
}

// Each command gets the short query timeout, and never more than what is left of the deadline when one is given.
function boundedRunner(runner: CommandRunner, deadline?: number): CommandRunner {
    return {
        run: (request) => {
            const budget = deadline === undefined ? TMUX_QUERY_TIMEOUT_MS : remainingMs(deadline);
            const timeoutMs = Math.max(Math.min(request.timeoutMs ?? TMUX_QUERY_TIMEOUT_MS, budget), 1);
            return runner.run({ ...request, timeoutMs });
        },
    };
}

// Pane queries with a short command timeout; the client env never holds a token variable.
function queryDeps(deps: Deps, deadline?: number): TmuxDeps {
    return { runner: boundedRunner(deps.runner, deadline), env: withoutStripped(deps.env) };
}

function windowEnvItems(env: Env, session: Session, token: string): string[] {
    return [
        `PATH=${session.callerPath}`,
        `${ENV_NAMES.stateDir}=${session.stateDir}`,
        `${ENV_NAMES.launchToken}=${token}`,
        ...session.ghEnv,
        // tmux cannot unset a variable of its server environment for a new window, so each one is emptied and the
        // watcher entry removes empty ones before anything else runs.
        ...GH_STRIP_VARS.map((name) => `${name}=`),
        ...FORWARDED_OVERRIDES.map(([name, fallback]) => `${name}=${readEnvSeconds(env, name, fallback)}`),
    ];
}

function watcherCommand(session: Session, entry: BackgroundEntry): string[] {
    return [
        entry.node,
        entry.mainTs,
        session.pr.prUrl,
        '--dir',
        session.worktree?.source ?? session.dirCanon,
        session.worktree === undefined ? '--in-place' : '--worktree',
        '--interval',
        String(session.interval),
        '--keep-panes',
        String(session.keepPanes),
        '--batch-max',
        String(session.batchMax),
        '--claude',
        session.tools.claude,
        ...session.claudeArgs.flatMap((arg) => ['--claude-arg', arg]),
    ];
}

// Polls this launch's own result file once per second until the monotonic deadline, every tmux query bounded by
// what is left of it; a watcher pane that died without a result
// ends the wait at once instead of after the whole timeout.
async function awaitLaunchResult(
    deps: Deps,
    session: Session,
    token: string,
    window: WatcherWindow
): Promise<LaunchOutcome> {
    const { stateDir, pr, tools, tmux } = session;
    const seconds = readEnvSeconds(deps.env, ENV_NAMES.bgTimeout, DEFAULT_BG_TIMEOUT);
    const deadline = performance.now() + seconds * 1000;
    for (;;) {
        const result = readLaunchResult(stateDir, pr.prKey, token);
        if (result !== undefined || remainingMs(deadline) === 0) {
            return result;
        }
        const pane = await paneState(queryDeps(deps, deadline), tools.tmux, tmux.socket, window.paneId);
        if (pane === 'dead') {
            return readLaunchResult(stateDir, pr.prKey, token) ?? 'exited';
        }
        const pause = Math.min(RESULT_POLL_MS, remainingMs(deadline));
        if (pause > 0) {
            await deps.sleep(pause);
        }
    }
}

// The window index and name are what the tmux status line shows; the id is what --list and the lock record use.
function windowLabel(session: Session, window: WatcherWindow): string {
    return `tmux window ${window.index} (${watcherWindowName(session.pr.number)}, ${window.windowId})`;
}

async function reportLaunch(
    deps: Deps,
    session: Session,
    window: WatcherWindow,
    result: LaunchOutcome
): Promise<number> {
    if (result === undefined) {
        deps.out(`watcher did not report its first poll; check ${windowLabel(session, window)}\n`);
        return 1;
    }
    if (result === 'exited') {
        deps.out(`watcher exited before its first poll; check ${windowLabel(session, window)}\n`);
        return 1;
    }
    switch (result.result) {
        case 'firstPoll': {
            deps.out(`watching ${session.pr.prUrl} in ${windowLabel(session, window)}\n`);
            return 0;
        }
        case 'fatal': {
            deps.out(`watcher failed: ${safeText(result.message)}\n`);
            return 1;
        }
        case 'alreadyWatched': {
            deps.out(alreadyWatched(result.pid, result.windowId));
            const killed = await tmuxOn(queryDeps(deps), session.tools.tmux, session.tmux.socket, [
                'kill-window',
                '-t',
                window.windowId,
            ]);
            if (killed?.code !== 0) {
                deps.log.warn(`could not kill the unused watcher window ${window.windowId}`);
            }
            return 0;
        }
    }
}

// The watcher waits for the ready marker, which is written only once the window is tagged and kept on exit, so even
// an immediate fatal exit stays readable in the window. The tmux client never sees a token variable.
async function launchWatcher(deps: Deps, session: Session, token: string, entry: BackgroundEntry): Promise<number> {
    const { stateDir, pr, tools, tmux } = session;
    const tmuxDeps: TmuxDeps = { runner: deps.runner, env: withoutStripped(deps.env) };
    const items = windowEnvItems(deps.env, session, token);
    const target = { prKey: pr.prKey, name: watcherWindowName(pr.number) };
    const window = await newWatcherWindow(tmuxDeps, tools.tmux, tmux, target, items, watcherCommand(session, entry));
    if (window === undefined) {
        deps.out('could not create the watcher window\n');
        return 1;
    }
    markLaunchReady(stateDir, pr.prKey, token);
    const result = await awaitLaunchResult(deps, session, token, window);
    return await reportLaunch(deps, session, window, result);
}

function clearOwnLaunch(deps: Deps, session: Session, token: string): void {
    try {
        clearLaunch(session.stateDir, session.pr.prKey, token);
    } catch (error) {
        deps.log.warn(`could not remove the launch files of ${token}: ${safeText(errorCode(error) ?? 'unknown')}`);
    }
}

// Starts the watcher in a detached tmux window of the caller's session and reports its first poll. Each start talks
// to its own watcher only through its own launch token's files and removes only those.
export async function runBackground(
    deps: Deps,
    options: CliOptions,
    cwd: string,
    entry: BackgroundEntry
): Promise<number> {
    const checked = await preflight(deps, options, cwd, entry.node);
    if (!checked.ok) {
        deps.out(`${checked.reason}\n`);
        return 1;
    }
    const state = initState(resolveStateDir(deps.env, cwd));
    if (!state.ok) {
        deps.out(stateRefusal(state));
        return 1;
    }
    const session: Session = { ...checked.session, stateDir: state.stateDir };
    const holder = readPrLockOwner(session.stateDir, session.pr.prKey);
    if (holder !== undefined && pidAlive(holder.pid)) {
        deps.out(alreadyWatched(holder.pid, holder.windowId));
        return 0;
    }
    const token = newLockToken(deps.nowSeconds());
    try {
        return await launchWatcher(deps, session, token, entry);
    } finally {
        clearOwnLaunch(deps, session, token);
    }
}

function lockPresent(stateDir: string, prKey: string): boolean {
    return entryPresent(path.join(watcherDir(stateDir, prKey), LOCK_NAME));
}

// A github.com key has three parts; a key of any other host starts with the host.
function prLabel(prKey: string): string {
    const parts = prKey.split('+');
    const host = parts.length === 4 ? parts.shift() : undefined;
    const [owner = '', repo = '', number = '', ...rest] = parts;
    const hostValid = host === undefined || isValidHost(host);
    if (rest.length === 0 && hostValid && isValidName(owner) && isValidName(repo) && isUintString(number)) {
        return `${host === undefined ? '' : `${host}/`}${owner}/${repo} pull ${number}`;
    }
    return `watcher ${safeText(prKey)}`;
}

function ageText(now: number, since: number | undefined): string {
    return since === undefined ? '-' : `${Math.max(now - since, 0)}s`;
}

// A watcher without a live lock owner is dead; a lock whose owner cannot be read is shown as such.
function livenessSuffix(stateDir: string, prKey: string): string {
    const owner = readPrLockOwner(stateDir, prKey);
    if (owner !== undefined) {
        return pidAlive(owner.pid) ? '' : ' dead';
    }
    return lockPresent(stateDir, prKey) ? ' lock=unreadable' : ' dead';
}

// dir is the working tree the watcher works in: the watch worktree, or the clone in --in-place mode.
function watcherLine(stateDir: string, prKey: string, now: number): string {
    const label = prLabel(prKey);
    const suffix = livenessSuffix(stateDir, prKey);
    const status = readStatus(stateDir, prKey);
    if (status === undefined) {
        return `${label} state=unknown${suffix}\n`;
    }
    const dir = readPrLockOwner(stateDir, prKey)?.dir;
    const fields = [
        `state=${status.state}`,
        `age=${ageText(now, status.since)}`,
        `reason=${safeText(status.reason)}`,
        `hint=${safeText(status.hint)}`,
        `comments=${safeText(status.comments)}`,
        `last_error=${safeText(status.lastError)}`,
        ...(dir === undefined ? [] : [`dir=${safeText(dir)}`]),
    ];
    return `${label} ${fields.join(' ')}${suffix}\n`;
}

function unreadableLine(stateDir: string, run: RunEntry, format: string): string {
    const file = path.join(runDir(stateDir, run.runId), RECORD_FILE);
    return `unreadable record ${visibleText(file)} (format ${safeText(format)})\n`;
}

function runLine(stateDir: string, run: RunEntry, now: number): string {
    if (run.read.kind === 'unreadable') {
        return unreadableLine(stateDir, run, run.read.format);
    }
    const { record } = run.read;
    const comments = record.comments.map((comment) => comment.dbId).join(',');
    const fields = [
        `state=${record.state}`,
        ...(record.state === 'retained' && record.outcome !== undefined ? [`outcome=${record.outcome}`] : []),
        `comments=${comments}`,
        `age=${ageText(now, record.startedAt)}`,
    ];
    return `run ${safeText(run.runId)} ${fields.join(' ')}\n`;
}

function readRuns(stateDir: string): RunEntry[] {
    return listRunIds(stateDir).map((runId) => ({ runId, read: readRecord(stateDir, runId) }));
}

// A run removed between the listing and the read (a cleanup finishing meanwhile) is skipped instead of being shown
// as an unreadable record.
function readListedRuns(stateDir: string, hooks: ListHooks): RunEntry[] {
    const runIds = listRunIds(stateDir);
    hooks.afterListing?.(runIds);
    return runIds.flatMap((runId) => {
        const read = readRecord(stateDir, runId);
        return read.kind === 'unreadable' && !entryPresent(runDir(stateDir, runId)) ? [] : [{ runId, read }];
    });
}

function watcherKeys(stateDir: string): string[] {
    return fs
        .readdirSync(path.join(stateDir, 'watchers'), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .toSorted();
}

function runOf(run: RunEntry, prKey: string): boolean {
    return run.read.kind === 'ok' && run.read.record.prKey === prKey;
}

function listState(deps: Deps, stateDir: string, hooks: ListHooks): number {
    const state = initState(stateDir);
    if (!state.ok) {
        deps.out(stateRefusal(state));
        return state.kind === 'format' ? 0 : 1;
    }
    const dir = state.stateDir;
    const now = deps.nowSeconds();
    const prKeys = watcherKeys(dir);
    const runs = readListedRuns(dir, hooks);
    if (prKeys.length === 0) {
        deps.out('no watchers\n');
    }
    for (const prKey of prKeys) {
        deps.out(watcherLine(dir, prKey, now));
        for (const run of runs.filter((item) => runOf(item, prKey))) {
            deps.out(runLine(dir, run, now));
        }
    }
    for (const run of runs.filter((item) => !prKeys.some((prKey) => runOf(item, prKey)))) {
        deps.out(runLine(dir, run, now));
    }
    return 0;
}

// Lists every watcher with its status and runs, plus runs of no listed watcher and unreadable records. A throw while
// listing becomes a rejection.
export function runList(deps: Deps, stateDir: string, hooks: ListHooks = {}): Promise<number> {
    return new Promise((resolve) => {
        resolve(listState(deps, stateDir, hooks));
    });
}

// A zombie has exited too: its parent (the tmux server for a background watcher) has only not reaped it yet, and
// tmux can miss the SIGCHLD of a pane process for a long time.
async function processEnded(runner: CommandRunner, pid: number, deadline: number): Promise<boolean> {
    if (!pidAlive(pid)) {
        return true;
    }
    const budget = remainingMs(deadline);
    if (budget === 0) {
        return false;
    }
    const args = ['-o', 'stat=', '-p', String(pid)];
    const timeoutMs = Math.max(Math.min(PS_TIMEOUT_MS, budget), 1);
    const result = await runner.run({ file: PS_PATH, args, env: PS_ENV, timeoutMs });
    return result.code === 0 && result.stdout.trim().startsWith('Z');
}

// Bounded by a monotonic deadline: the time spent in ps calls counts, not only the pauses.
async function waitForExit(deps: Deps, pid: number, seconds: number): Promise<boolean> {
    const deadline = performance.now() + seconds * 1000;
    for (;;) {
        if (await processEnded(deps.runner, pid, deadline)) {
            return true;
        }
        const pause = Math.min(EXIT_POLL_MS, remainingMs(deadline));
        if (pause === 0) {
            return false;
        }
        await deps.sleep(pause);
    }
}

// Signals the lock owner only while its recorded start time still matches; exited means it died after the signal.
async function endWatcher(deps: Deps, owner: PrLockOwner): Promise<WatcherEnd> {
    const outcome = await signalIfSame(deps.runner, owner.pid, owner.pidStart, 'SIGTERM');
    switch (outcome) {
        case 'gone': {
            deps.out(`watcher pid ${owner.pid} was not running\n`);
            return 'gone';
        }
        case 'sent': {
            const seconds = readEnvSeconds(deps.env, ENV_NAMES.stopWait, DEFAULT_STOP_WAIT);
            if (await waitForExit(deps, owner.pid, seconds)) {
                return 'exited';
            }
            deps.out(`watcher pid ${owner.pid} did not exit within ${seconds} seconds\n`);
            return 'failed';
        }
        case 'mismatch': {
            deps.out(`watcher pid ${owner.pid} belongs to another process; not signalled\n`);
            return 'failed';
        }
        case 'unverifiable':
        case 'vetoed': {
            deps.out(`could not verify watcher pid ${owner.pid}; not signalled\n`);
            return 'failed';
        }
    }
}

async function settledPaneState(
    deps: Deps,
    tmuxPath: string,
    owner: PrLockOwner,
    justExited: boolean
): Promise<PaneState> {
    let state = await paneState(queryDeps(deps), tmuxPath, owner.socket, owner.paneId);
    const deadline = performance.now() + PANE_SETTLE_MS;
    while (justExited && state === 'alive' && remainingMs(deadline) > 0) {
        await deps.sleep(Math.min(EXIT_POLL_MS, remainingMs(deadline)));
        state = await paneState(queryDeps(deps, deadline), tmuxPath, owner.socket, owner.paneId);
    }
    return state;
}

// Talks only to the tmux server recorded in the lock, because pane ids repeat across servers. The kill itself is one
// conditional tmux command, so only a pane that is still dead (a background window kept by remain-on-exit) and still
// carries this PR's watcher tag when tmux runs it is killed.
async function removeDeadPane(deps: Deps, owner: PrLockOwner, prKey: string, justExited: boolean): Promise<void> {
    const tmuxPath = resolveExecutable('tmux', normalizeCallerPath(deps.env.PATH ?? ''));
    if (tmuxPath === undefined) {
        deps.log.warn('tmux was not found on PATH; the watcher pane was left as it is');
        return;
    }
    const pane = PANE_ID.test(owner.paneId) ? owner.paneId : safeText(owner.paneId);
    const state = await settledPaneState(deps, tmuxPath, owner, justExited);
    if (state !== 'dead') {
        return;
    }
    const query = queryDeps(deps);
    if (!(await killDeadWatcherPane(query, tmuxPath, owner.socket, owner.paneId, prKey))) {
        deps.log.warn(`could not remove the dead watcher pane ${pane}`);
        return;
    }
    if ((await paneState(query, tmuxPath, owner.socket, owner.paneId)) !== 'missing') {
        deps.log.info(`left the pane ${pane} alone: it is no longer the dead watcher pane of ${prKey}`);
    }
}

function reportRuns(deps: Deps, stateDir: string, prKey: string): void {
    for (const run of readRuns(stateDir)) {
        if (run.read.kind === 'unreadable') {
            deps.out(unreadableLine(stateDir, run, run.read.format));
        } else if (run.read.record.prKey === prKey) {
            deps.out(`left in place: run ${safeText(run.runId)} state=${run.read.record.state}\n`);
        }
    }
}

// Stops the watcher of one PR without tmux context of its own (TMUX is never read). Worker panes, the worktree lock
// and run records are always left in place.
export async function runStop(deps: Deps, options: CliOptions, stateDir: string): Promise<number> {
    const state = initState(stateDir);
    if (!state.ok) {
        deps.out(stateRefusal(state));
        return 1;
    }
    const { pr } = options;
    if (pr === undefined) {
        deps.out('missing PR URL\n');
        return 1;
    }
    const dir = state.stateDir;
    const owner = readPrLockOwner(dir, pr.prKey);
    if (owner === undefined) {
        const held = lockPresent(dir, pr.prKey);
        deps.out(
            held ? `the PR lock of ${pr.prUrl} has an unreadable owner; not signalled\n` : `not watched: ${pr.prUrl}\n`
        );
        return 1;
    }
    if (!isSafeSocketPath(owner.socket)) {
        deps.out('invalid lock socket\n');
        return 1;
    }
    const ended = await endWatcher(deps, owner);
    if (ended === 'failed') {
        return 1;
    }
    await removeDeadPane(deps, owner, pr.prKey, ended === 'exited');
    reportRuns(deps, dir, pr.prKey);
    deps.out(`stopped watcher for ${pr.prUrl}\n`);
    return 0;
}
