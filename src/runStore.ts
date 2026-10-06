import fs from 'node:fs';
import path from 'node:path';

import { RECORD_FORMAT } from './constants.ts';
import { getArray, getPath, getString } from './json.ts';
import { pidAlive } from './proc.ts';
import {
    createFieldReader,
    readJsonFile,
    readTextFile,
    runDir,
    watcherDir,
    writeJsonAtomic,
    writeTextAtomic,
} from './stateStore.ts';
import type {
    EventKind,
    EventsSnapshot,
    LaunchDecision,
    RecordPatch,
    RunComment,
    RunFailureTarget,
    RunRecord,
    RunState,
    WatcherState,
    WatcherStatus,
} from './types.ts';
import { isUintString } from './validate.ts';

export type RecordRead = { kind: 'ok'; record: RunRecord } | { kind: 'unreadable'; format: string };

const RECORD_FILE = 'record.json';
const EVENTS_FILE = 'events';
const LOGGED_FILE = 'logged';
const CLAUDE_PID_FILE = 'claude.pid';
const EXIT_STATUS_FILE = 'exit_status';
const DECISION_DIR = 'decision.d';
const DECISION_VALUE = 'value';
const STATUS_FILE = 'status.json';
const EVENT_LINE = /^(?<kind>\S+) (?<epoch>\d+)$/u;

const RUN_STATES: ReadonlySet<string> = new Set<RunState>([
    'preparing',
    'running',
    'needs_attention',
    'completed',
    'failed',
    'exited',
    'abandoned',
]);
const WATCHER_STATES: ReadonlySet<string> = new Set<WatcherState>([
    'starting',
    'polling',
    'holding',
    'running',
    'needs_attention',
    'backing_off',
    'throttled',
    'exited',
    'fatal',
]);
const EVENT_KINDS: ReadonlySet<string> = new Set<EventKind>(['prompt', 'stop', 'permission', 'tool']);

function isRunState(value: string | undefined): value is RunState {
    return value !== undefined && RUN_STATES.has(value);
}

function isWatcherState(value: string | undefined): value is WatcherState {
    return value !== undefined && WATCHER_STATES.has(value);
}

function isEventKind(value: string | undefined): value is EventKind {
    return value !== undefined && EVENT_KINDS.has(value);
}

function recordPath(stateDir: string, runId: string): string {
    return path.join(runDir(stateDir, runId), RECORD_FILE);
}

function formatText(value: unknown): string {
    const format = getPath(value, 'format');
    return typeof format === 'number' || typeof format === 'string' ? String(format) : 'unknown';
}

function narrowComment(value: unknown): RunComment | undefined {
    const read = createFieldReader(value);
    const comment: RunComment = {
        nodeId: read.text('nodeId'),
        dbId: read.integer('dbId'),
        url: read.text('url'),
        threadId: read.text('threadId'),
        topDbId: read.integer('topDbId'),
        rocketAt: read.integer('rocketAt'),
        eyesAdded: read.flag('eyesAdded'),
    };
    return read.failed() ? undefined : comment;
}

// A run holds at least one comment, and every comment must be readable.
function narrowComments(value: unknown): RunComment[] | undefined {
    const items = getArray(value, 'comments');
    const comments = items?.map((item) => narrowComment(item)).filter((item) => item !== undefined) ?? [];
    return comments.length > 0 && comments.length === items?.length ? comments : undefined;
}

function narrowFailureTarget(value: unknown): RunFailureTarget | undefined {
    const read = createFieldReader(value);
    const target: RunFailureTarget = {
        nodeId: read.text('nodeId'),
        dbId: read.integer('dbId'),
        eyesOn: read.flag('eyesOn'),
    };
    return read.failed() ? undefined : target;
}

type PendingFailuresRead = { valid: true; targets?: RunFailureTarget[] } | { valid: false };

function narrowPendingFailures(value: unknown, comments: readonly RunComment[]): PendingFailuresRead {
    const raw = getPath(value, 'pendingFailures');
    if (raw === undefined) {
        return { valid: true };
    }
    const items = getArray(value, 'pendingFailures');
    if (items === undefined) {
        return { valid: false };
    }
    const targets = items.map((item) => narrowFailureTarget(item)).filter((item) => item !== undefined);
    const keys = targets.map((target) => `${target.nodeId}\n${target.dbId}`);
    const known = targets.every((target) =>
        comments.some((comment) => comment.nodeId === target.nodeId && comment.dbId === target.dbId)
    );
    if (targets.length !== items.length || new Set(keys).size !== keys.length || !known) {
        return { valid: false };
    }
    return { valid: true, targets };
}

function narrowRecord(value: unknown): RunRecord | undefined {
    const state = getString(value, 'state');
    const comments = narrowComments(value);
    if (getPath(value, 'format') !== RECORD_FORMAT || !isRunState(state) || comments === undefined) {
        return;
    }
    const pending = narrowPendingFailures(value, comments);
    if (!pending.valid || (pending.targets !== undefined && state !== 'failed')) {
        return;
    }
    const read = createFieldReader(value);
    const record: RunRecord = {
        format: RECORD_FORMAT,
        runId: read.text('runId'),
        prKey: read.text('prKey'),
        owner: read.text('owner'),
        repo: read.text('repo'),
        number: read.integer('number'),
        prUrl: read.text('prUrl'),
        comments,
        ...(pending.targets === undefined ? {} : { pendingFailures: pending.targets }),
        headSha: read.text('headSha'),
        remote: read.text('remote'),
        branch: read.text('branch'),
        dir: read.text('dir'),
        worktreeKey: read.text('worktreeKey'),
        claude: read.text('claude'),
        git: read.text('git'),
        gh: read.text('gh'),
        callerPath: read.text('callerPath'),
        claudeArgs: read.texts('claudeArgs'),
        state,
        reason: read.text('reason'),
        paneId: read.text('paneId'),
        panePid: read.optionalNumber('panePid'),
        socket: read.text('socket'),
        startedAt: read.optionalNumber('startedAt'),
        watcherPid: read.integer('watcherPid'),
    };
    return read.failed() ? undefined : record;
}

export function createRun(stateDir: string, runId: string): string {
    const dir = runDir(stateDir, runId);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
}

export function readRecord(stateDir: string, runId: string): RecordRead {
    const value = readJsonFile(recordPath(stateDir, runId));
    const record = narrowRecord(value);
    return record === undefined ? { kind: 'unreadable', format: formatText(value) } : { kind: 'ok', record };
}

export function writeRecord(stateDir: string, record: RunRecord): void {
    writeJsonAtomic(recordPath(stateDir, record.runId), record);
}

export function mergeRecord(stateDir: string, runId: string, patch: RecordPatch): RunRecord | undefined {
    const read = readRecord(stateDir, runId);
    if (read.kind !== 'ok') {
        return;
    }
    const merged: RunRecord = { ...read.record, ...patch };
    writeJsonAtomic(recordPath(stateDir, runId), merged);
    return merged;
}

export function listRunIds(stateDir: string): string[] {
    try {
        return fs
            .readdirSync(path.join(stateDir, 'runs'), { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
            .toSorted();
    } catch {
        return [];
    }
}

export function runIdsForPr(stateDir: string, prKey: string): string[] {
    return listRunIds(stateDir).filter((runId) => {
        const read = readRecord(stateDir, runId);
        return read.kind === 'ok' && read.record.prKey === prKey;
    });
}

export function clearRun(stateDir: string, runId: string): void {
    fs.rmSync(runDir(stateDir, runId), { recursive: true, force: true });
}

// Only newline-terminated lines count; a line that is not KIND EPOCH with a known kind is listed as unknown.
function parseEvents(text: string): EventsSnapshot {
    const lines = text.split('\n').slice(0, -1);
    const kinds: (EventKind | 'unknown')[] = [];
    let lastEvent: EventKind | 'none' = 'none';
    let lastEventAt: number | undefined;
    let hasPrompt = false;
    for (const line of lines) {
        const groups = EVENT_LINE.exec(line)?.groups;
        const kind = groups?.kind;
        if (isEventKind(kind)) {
            kinds.push(kind);
            lastEvent = kind;
            lastEventAt = Number.parseInt(groups?.epoch ?? '', 10);
            hasPrompt ||= kind === 'prompt';
        } else {
            kinds.push('unknown');
        }
    }
    return { lastEvent, lastEventAt, hasPrompt, count: lines.length, kinds };
}

// One readFileSync of the events file; every field of the snapshot comes from that single buffer.
export function readEvents(stateDir: string, runId: string): EventsSnapshot {
    return parseEvents(readTextFile(path.join(runDir(stateDir, runId), EVENTS_FILE)) ?? '');
}

function readUint(file: string): number | undefined {
    const text = readTextFile(file)?.trim();
    return text !== undefined && isUintString(text) ? Number.parseInt(text, 10) : undefined;
}

export function readLoggedCursor(stateDir: string, runId: string): number {
    return readUint(path.join(runDir(stateDir, runId), LOGGED_FILE)) ?? 0;
}

export function writeLoggedCursor(stateDir: string, runId: string, count: number): void {
    writeTextAtomic(path.join(runDir(stateDir, runId), LOGGED_FILE), `${count}\n`);
}

// A claude.pid that exists but cannot be read (EIO, EACCES) may name a running claude, so it reads as unverifiable;
// only a missing file (ENOENT) is absent.
function readClaudePid(dir: string): number | 'absent' | 'unverifiable' {
    let text: string;
    try {
        text = fs.readFileSync(path.join(dir, CLAUDE_PID_FILE), 'utf8').trim();
    } catch (error) {
        return error instanceof Error && 'code' in error && error.code === 'ENOENT' ? 'absent' : 'unverifiable';
    }
    return isUintString(text) ? Number.parseInt(text, 10) : 'absent';
}

// The only liveness predicate for a run: a live claude.pid, or a live panePid until exit_status exists (from then on
// the launcher pane is the owner's fallback shell). An unreadable claude.pid counts as alive: fail closed.
export function workerAlive(stateDir: string, runId: string): boolean {
    const dir = runDir(stateDir, runId);
    if (!fs.existsSync(dir)) {
        return false;
    }
    const claudePid = readClaudePid(dir);
    if (claudePid === 'unverifiable' || (claudePid !== 'absent' && pidAlive(claudePid))) {
        return true;
    }
    if (fs.existsSync(path.join(dir, EXIT_STATUS_FILE))) {
        return false;
    }
    const read = readRecord(stateDir, runId);
    const panePid = read.kind === 'ok' ? read.record.panePid : undefined;
    return panePid !== undefined && pidAlive(panePid);
}

// Whoever creates decision.d owns the decision; the value is written once and never changes.
export function claimLaunch(stateDir: string, runId: string, value: 'go' | 'cancel'): boolean {
    const decisionDir = path.join(runDir(stateDir, runId), DECISION_DIR);
    try {
        fs.mkdirSync(decisionDir, { mode: 0o700 });
        writeTextAtomic(path.join(decisionDir, DECISION_VALUE), value);
    } catch {
        return false;
    }
    return true;
}

export function launchDecision(stateDir: string, runId: string): LaunchDecision {
    const decisionDir = path.join(runDir(stateDir, runId), DECISION_DIR);
    if (!fs.existsSync(decisionDir)) {
        return 'none';
    }
    const value = readTextFile(path.join(decisionDir, DECISION_VALUE))?.trim();
    return value === 'go' || value === 'cancel' ? value : 'claimed';
}

function statusPath(stateDir: string, prKey: string): string {
    return path.join(watcherDir(stateDir, prKey), STATUS_FILE);
}

export function readStatus(stateDir: string, prKey: string): WatcherStatus | undefined {
    const value = readJsonFile(statusPath(stateDir, prKey));
    const state = getString(value, 'state');
    if (!isWatcherState(state)) {
        return;
    }
    const read = createFieldReader(value);
    const status: WatcherStatus = {
        pid: read.integer('pid'),
        state,
        reason: read.text('reason'),
        hint: read.text('hint'),
        runId: read.text('runId'),
        comments: read.text('comments'),
        since: read.integer('since'),
        updatedAt: read.integer('updatedAt'),
        lastError: read.text('lastError'),
    };
    return read.failed() ? undefined : status;
}

export function writeStatus(stateDir: string, prKey: string, patch: Partial<WatcherStatus>, nowSeconds: number): void {
    fs.mkdirSync(watcherDir(stateDir, prKey), { recursive: true, mode: 0o700 });
    const base: WatcherStatus = readStatus(stateDir, prKey) ?? {
        pid: 0,
        state: 'starting',
        reason: '',
        hint: '',
        runId: '',
        comments: '',
        since: nowSeconds,
        updatedAt: nowSeconds,
        lastError: '',
    };
    writeJsonAtomic(statusPath(stateDir, prKey), { ...base, ...patch, updatedAt: nowSeconds });
}
