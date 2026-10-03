export type Env = Readonly<Record<string, string | undefined>>;

export interface CommandRequest {
    file: string;
    args: readonly string[];
    cwd?: string;
    env?: Env;
    input?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
}

// code is the exit status, 128 plus the signal number when killed by a signal, 127 when the file could not be
// spawned (then spawnError holds the error code text).
export interface CommandResult {
    code: number;
    stdout: string;
    stderr: string;
    spawnError?: string;
}

export interface CommandRunner {
    run(_request: CommandRequest): Promise<CommandResult>;
}

export interface Logger {
    info(_message: string): void;
    warn(_message: string): void;
    error(_message: string): void;
}

// sleep resolves early (without throwing) when the signal aborts.
export interface Deps {
    runner: CommandRunner;
    env: Env;
    log: Logger;
    out(_text: string): void;
    nowSeconds(): number;
    sleep(_ms: number, _signal?: AbortSignal): Promise<void>;
}

// owner and repo are lowercased; prUrl is https://github.com/OWNER/REPO/pull/N; prKey is OWNER+REPO+N.
export interface PrRef {
    owner: string;
    repo: string;
    number: number;
    prUrl: string;
    prKey: string;
}

export type CliMode = 'watch' | 'background' | 'list' | 'stop';

export interface CliOptions {
    mode: CliMode;
    pr: PrRef | undefined;
    dir: string;
    interval: number;
    claude: string | undefined;
    claudeArgs: string[];
    keepPanes: number;
    once: boolean;
}

// resetAt is in epoch seconds.
export interface RateInfo {
    remaining: number | undefined;
    resetAt: number | undefined;
}

// rate is set only by the multi-call fetchers: the rate of the last page that succeeded before the failure.
export type GhFailure =
    | { kind: 'auth'; message: string; rate?: RateInfo }
    | { kind: 'gone'; ids: string[]; message: string; rate?: RateInfo }
    | { kind: 'transient'; message: string; rate?: RateInfo };

export type GhResult = { kind: 'ok'; data: unknown } | GhFailure;

export type PrState = 'OPEN' | 'CLOSED' | 'MERGED';

export interface PrInfo {
    viewer: string;
    state: PrState;
    headRef: string;
    headOwner: string;
    headRepo: string;
    isCross: boolean;
    canPush: boolean;
}

export interface PollComment {
    threadId: string;
    position: number;
    nodeId: string;
    dbId: number;
    topDbId: number;
    rocket: boolean;
}

export interface PollResult {
    prState: PrState;
    viewer: string;
    headRef: string;
    rate: RateInfo;
    comments: PollComment[];
}

export interface LookupEntry {
    nodeId: string;
    dbId: number;
    rocketAt: number | undefined;
    plus1At: number | undefined;
    eyes: boolean;
    editedAt: number | undefined;
    url: string;
    author: string;
    path: string;
    line: number | undefined;
    body: string;
}

export interface LookupResult {
    rate: RateInfo;
    entries: LookupEntry[];
    gone: string[];
}

export interface Candidate {
    poll: PollComment;
    entry: LookupEntry;
}

export interface QueueResult {
    candidates: Candidate[];
    edited: LookupEntry[];
    skippedDbIds: number[];
}

// All paths are absolute.
export interface ToolPaths {
    node: string;
    git: string;
    gh: string;
    tmux: string;
    claude: string;
}

export interface TmuxContext {
    socket: string;
    pane: string;
    sessionId: string;
    windowId: string;
}

// ghEnv holds exactly two NAME=VALUE items in this order: GH_CONFIG_DIR=EFFECTIVE and GH_HOST=github.com.
// stateDir is the canonical state directory once initState accepted it.
export interface Session {
    pr: PrRef;
    viewer: string;
    headRef: string;
    headOwner: string;
    headRepo: string;
    remote: string;
    dirCanon: string;
    toplevel: string;
    worktreeKey: string;
    tools: ToolPaths;
    callerPath: string;
    ghEnv: string[];
    tmux: TmuxContext;
    stateDir: string;
    interval: number;
    keepPanes: number;
    claudeArgs: string[];
    once: boolean;
}

export type GuardResult = { ok: true; headSha: string } | { ok: false; reason: string; hint: string };

export type RunState = 'preparing' | 'running' | 'needs_attention' | 'completed' | 'failed' | 'exited' | 'abandoned';

export interface RunRecord {
    format: 1;
    runId: string;
    prKey: string;
    owner: string;
    repo: string;
    number: number;
    prUrl: string;
    commentNodeId: string;
    commentDbId: number;
    commentUrl: string;
    threadId: string;
    topDbId: number;
    rocketAt: number;
    headSha: string;
    remote: string;
    branch: string;
    dir: string;
    worktreeKey: string;
    claude: string;
    git: string;
    gh: string;
    callerPath: string;
    claudeArgs: string[];
    state: RunState;
    reason: string;
    eyesAdded: boolean;
    paneId: string;
    panePid: number | undefined;
    socket: string;
    startedAt: number | undefined;
    watcherPid: number;
}

export type RecordPatch = Partial<RunRecord>;

// tool comes from a PreToolUse hook: any tool activity.
export type EventKind = 'prompt' | 'stop' | 'permission' | 'tool';

export type LaunchDecision = 'none' | 'claimed' | 'go' | 'cancel';

export type WatcherState =
    | 'starting'
    | 'polling'
    | 'holding'
    | 'running'
    | 'needs_attention'
    | 'backing_off'
    | 'throttled'
    | 'exited'
    | 'fatal';

// Display only: --list reads it; background start never reads or deletes it.
export interface WatcherStatus {
    pid: number;
    state: WatcherState;
    reason: string;
    hint: string;
    runId: string;
    comment: string;
    since: number;
    updatedAt: number;
    lastError: string;
}

export interface LaunchResult {
    token: string;
    result: 'firstPoll' | 'fatal' | 'alreadyWatched';
    message: string;
    pid: number;
    windowId: string;
}

// pidStart is the watcher's own process start time from processStart.
export interface PrLockOwner {
    pid: number;
    pidStart: string;
    token: string;
    paneId: string;
    windowId: string;
    socket: string;
    dir: string;
    startedAt: number;
}

export interface WorktreeLockOwner {
    runId: string;
    watcherPid: number;
    token: string;
}

export type DispatchOutcome = 'dispatched' | 'busy' | 'held' | 'rocketRemovalFailed' | 'abandoned' | 'contextFailed';

export type ResumeOutcome = 'dispatched' | 'rocketRemovalFailed' | 'abandoned';

// Derived from one read of the events file (local epochs); kinds lists every counted line in order.
export interface EventsSnapshot {
    lastEvent: EventKind | 'none';
    lastEventAt: number | undefined;
    hasPrompt: boolean;
    count: number;
    kinds: (EventKind | 'unknown')[];
}

export type SignalOutcome = 'sent' | 'mismatch' | 'gone' | 'unverifiable' | 'vetoed';

export interface Capture {
    events: EventsSnapshot;
    alive: boolean;
}

export interface RunDecision {
    state: 'exited' | 'needs_attention' | 'completed' | 'failed' | 'running';
    reason: string;
}

export type EvaluateState = RunDecision['state'] | 'preparing' | 'deferred';

export type PaceMode = 'normal' | 'backoff' | 'throttled';
