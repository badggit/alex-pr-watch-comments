// Shared seeding for the run-state, reconcile and startup-race tests: a session, kit-valid run records, event lines,
// fake claude processes with launcher-format identity files and lookup results built from lookupEntry.json.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { TestContext } from 'node:test';

import { getBoolean, getNumber, getString, parseJson } from '../../../src/json.ts';
import { acquireWorktreeLock } from '../../../src/locks.ts';
import { createProcessRunner, pidAlive, processStart } from '../../../src/proc.ts';
import { claimLaunch, createRun, readRecord, writeRecord } from '../../../src/runStore.ts';
import { initState, readJsonFile, runDir, worktreeDir } from '../../../src/stateStore.ts';
import type {
    CommandRunner,
    Env,
    LookupEntry,
    LookupResult,
    RecordPatch,
    RunRecord,
    Session,
} from '../../../src/types.ts';
import { createFakeRunner, type FakeRunner, type Passthrough, type RecordedCall } from '../../support/fakeRunner.ts';
import { createTestEnv, waitUntil, type TestDeps, type TestEnv } from '../../support/testEnv.ts';

export const RUN_ID = '20261002120000-456';
export const PR_KEY = 'o+r+12';
export const NODE_ID = 'PRRC_kwDOAbc456';
export const SESSION_KEY = '0123456789abcdef';
export const OTHER_KEY = 'wtother';
export const SESSION_SOCKET = '/tmp/prwc-test-socket';
export const WORKER_SOCKET = '/tmp/worker-socket';
export const ROCKET_AT = 1_790_000_000;
export const FRESH_PLUS1 = ROCKET_AT + 60;
export const STALE_PLUS1 = ROCKET_AT - 60;
// Seeded events are this many seconds old, so the stop quiet period has elapsed.
export const SETTLED_AGE = 60;

export type ClaudeMode = 'cooperative' | 'ignoring';

export interface RunFixture {
    env: TestEnv;
    stateDir: string;
    fake: FakeRunner;
    deps: TestDeps;
    session: Session;
    realRunner: CommandRunner;
}

export interface FixtureOptions {
    psPassthrough?: boolean;
    env?: Env;
}

export interface SeedOptions {
    patch?: RecordPatch;
    decision?: 'go' | 'none';
    events?: readonly string[];
    lockWatcherPid?: number;
    lock?: boolean;
}

const ENTRY_FILE = path.join(import.meta.dirname, 'lookupEntry.json');

function nowSeconds(): number {
    return Math.floor(Date.now() / 1000);
}

export function projectDir(env: TestEnv): string {
    return path.join(env.root, 'project');
}

function buildSession(env: TestEnv, stateDir: string): Session {
    const project = projectDir(env);
    return {
        pr: { owner: 'o', repo: 'r', number: 12, prUrl: 'https://github.com/o/r/pull/12', prKey: PR_KEY },
        viewer: 'me',
        headRef: 'feature-x',
        headOwner: 'o',
        headRepo: 'r',
        remote: 'origin',
        dirCanon: project,
        toplevel: project,
        worktreeKey: SESSION_KEY,
        tools: {
            node: process.execPath,
            git: path.join(env.toolsDir, 'git'),
            gh: path.join(env.binDir, 'gh'),
            tmux: path.join(env.binDir, 'tmux'),
            claude: path.join(env.binDir, 'claude'),
        },
        callerPath: env.env.PATH ?? '',
        ghEnv: [`GH_CONFIG_DIR=${path.join(env.home, '.config', 'gh')}`, 'GH_HOST=github.com'],
        tmux: { socket: SESSION_SOCKET, pane: '%1', sessionId: '$1', windowId: '@1' },
        stateDir,
        interval: 15,
        keepPanes: 5,
        claudeArgs: [],
        once: false,
    };
}

// ps goes to the real runner unless psPassthrough is false; gh and tmux are always answered by the fake runner.
export async function newRunFixture(t: TestContext, options?: FixtureOptions): Promise<RunFixture> {
    const env = await createTestEnv();
    t.after(() => {
        env.cleanup();
    });
    const init = initState(env.stateDir);
    assert.ok(init.ok);
    fs.mkdirSync(projectDir(env), { recursive: true });
    const realRunner = createProcessRunner(env.env);
    const passthrough: Passthrough = options?.psPassthrough === false ? {} : { ps: realRunner };
    const fake = createFakeRunner({ passthrough });
    const deps: TestDeps = { ...env.deps(fake.runner), env: { ...env.env, ...options?.env } };
    return { env, stateDir: init.stateDir, fake, deps, session: buildSession(env, init.stateDir), realRunner };
}

// A record that also passes the worker kit checks, so the startup-race test can generate a real launcher from it.
export function baseRecord(fixture: RunFixture, patch?: RecordPatch): RunRecord {
    const { env } = fixture;
    return {
        format: 1,
        runId: RUN_ID,
        prKey: PR_KEY,
        owner: 'o',
        repo: 'r',
        number: 12,
        prUrl: 'https://github.com/o/r/pull/12',
        commentNodeId: NODE_ID,
        commentDbId: 456,
        commentUrl: 'https://github.com/o/r/pull/12#discussion_r456',
        threadId: 'PRRT_kwDOThread9',
        topDbId: 400,
        rocketAt: ROCKET_AT,
        headSha: 'a'.repeat(40),
        remote: 'origin',
        branch: 'feature-x',
        dir: projectDir(env),
        worktreeKey: SESSION_KEY,
        claude: path.join(env.binDir, 'claude'),
        git: path.join(env.toolsDir, 'git'),
        gh: path.join(env.binDir, 'gh'),
        callerPath: env.env.PATH ?? '',
        claudeArgs: [],
        state: 'running',
        reason: '',
        eyesAdded: true,
        paneId: '%5',
        panePid: undefined,
        socket: SESSION_SOCKET,
        startedAt: nowSeconds() - SETTLED_AGE,
        watcherPid: process.pid,
        ...patch,
    };
}

export async function deadPid(env: TestEnv): Promise<number> {
    const pid = env.spawnOrphan('true', []);
    assert.ok(await waitUntil(5000, () => !pidAlive(pid)), 'the short-lived orphan did not die');
    return pid;
}

export function eventsFile(fixture: RunFixture): string {
    return path.join(runDir(fixture.stateDir, RUN_ID), 'events');
}

// One KIND EPOCH line per kind, all ageSeconds old.
export function eventLines(kinds: readonly string[], ageSeconds = SETTLED_AGE): string {
    const epoch = nowSeconds() - ageSeconds;
    return kinds.map((kind) => `${kind} ${epoch}\n`).join('');
}

export function appendEvents(fixture: RunFixture, kinds: readonly string[], ageSeconds = SETTLED_AGE): void {
    fs.appendFileSync(eventsFile(fixture), eventLines(kinds, ageSeconds));
}

// Creates the run with its record (a dead orphan as panePid unless the patch says otherwise), the decision go, the
// given events and the worktree lock held by the run for this process (or lockWatcherPid).
export async function seedRun(fixture: RunFixture, options?: SeedOptions): Promise<RunRecord> {
    const panePid = await deadPid(fixture.env);
    const record = baseRecord(fixture, { panePid, ...options?.patch });
    createRun(fixture.stateDir, RUN_ID);
    writeRecord(fixture.stateDir, record);
    if ((options?.decision ?? 'go') === 'go') {
        assert.ok(claimLaunch(fixture.stateDir, RUN_ID, 'go'));
    }
    if (options?.events !== undefined) {
        fs.writeFileSync(eventsFile(fixture), eventLines(options.events));
    }
    if (options?.lock ?? true) {
        const watcherPid = options?.lockWatcherPid ?? process.pid;
        const now = nowSeconds();
        assert.ok(acquireWorktreeLock(fixture.stateDir, record.worktreeKey, RUN_ID, watcherPid, fixture.deps.log, now));
    }
    return record;
}

// Writes claude.start (ending with a newline, as the launcher writes it) and claude.pid for a running fake claude.
async function recordClaude(fixture: RunFixture, pid: number): Promise<void> {
    const start = await processStart(fixture.realRunner, pid);
    assert.ok(start !== undefined, 'no start time for the fake claude');
    const dir = runDir(fixture.stateDir, RUN_ID);
    fs.writeFileSync(path.join(dir, 'claude.start'), `${start}\n`);
    fs.writeFileSync(path.join(dir, 'claude.pid'), `${pid}\n`);
}

async function spawnReady(fixture: RunFixture, script: string, args: readonly string[]): Promise<number> {
    const { env } = fixture;
    const ready = path.join(env.root, `claude.${Date.now()}.${args.length}.ready`);
    const pid = env.spawnOrphan('/bin/sh', ['-c', script, ready, ...args]);
    assert.ok(await waitUntil(5000, () => fs.existsSync(ready)), 'the fake claude did not start');
    return pid;
}

// Starts a fake claude and records its identity files.
export async function startClaude(fixture: RunFixture, mode: ClaudeMode): Promise<number> {
    const pid =
        mode === 'cooperative'
            ? fixture.env.spawnOrphan('sleep', ['300'])
            : await spawnReady(fixture, 'trap "" TERM; : > "$0"; exec sleep 300', []);
    await recordClaude(fixture, pid);
    return pid;
}

// A fake claude that survives TERM and creates termFile when one arrives (the trap runs once the current one-second
// sleep ends), so a test can wait for the proof that the TERM was sent.
export async function startTermReportingClaude(fixture: RunFixture, termFile: string): Promise<number> {
    const script = 'trap \': > "$1"\' TERM; : > "$0"; while :; do sleep 1; done';
    const pid = await spawnReady(fixture, script, [termFile]);
    await recordClaude(fixture, pid);
    return pid;
}

function readEntry(): LookupEntry {
    const value = parseJson(fs.readFileSync(ENTRY_FILE, 'utf8'));
    const nodeId = getString(value, 'nodeId');
    const dbId = getNumber(value, 'dbId');
    assert.ok(nodeId !== undefined && dbId !== undefined, 'lookupEntry.json is malformed');
    return {
        nodeId,
        dbId,
        rocketAt: getNumber(value, 'rocketAt'),
        plus1At: getNumber(value, 'plus1At'),
        eyes: getBoolean(value, 'eyes') ?? false,
        editedAt: getNumber(value, 'editedAt'),
        url: getString(value, 'url') ?? '',
        author: getString(value, 'author') ?? '',
        path: getString(value, 'path') ?? '',
        line: getNumber(value, 'line'),
        body: getString(value, 'body') ?? '',
    };
}

export function lookupWith(patch?: Partial<LookupEntry>): LookupResult {
    return {
        rate: { remaining: 4000, resetAt: ROCKET_AT + 3600 },
        entries: [{ ...readEntry(), ...patch }],
        gone: [],
    };
}

export function lockWatcherPid(fixture: RunFixture, wtKey: string): number | undefined {
    return getNumber(readJsonFile(path.join(worktreeDir(fixture.stateDir, wtKey), 'lock', 'owner.json')), 'watcherPid');
}

export function lockExists(fixture: RunFixture, wtKey: string): boolean {
    return fs.existsSync(path.join(worktreeDir(fixture.stateDir, wtKey), 'lock'));
}

export function runExists(fixture: RunFixture): boolean {
    return fs.existsSync(runDir(fixture.stateDir, RUN_ID));
}

export function recordOf(fixture: RunFixture): RunRecord {
    const read = readRecord(fixture.stateDir, RUN_ID);
    assert.ok(read.kind === 'ok', 'the run record is unreadable');
    return read.record;
}

// display-message -p reads the pane tag (answered with the run id); without -p it is a tmux message to the owner.
export function answerPaneTag(fixture: RunFixture, runId = RUN_ID): void {
    fixture.fake.respond('tmux', 'display-message', (call) =>
        call.args.includes('-p') ? { stdout: `${runId}\n` } : {}
    );
}

export function tmuxMessages(fixture: RunFixture): RecordedCall[] {
    return fixture.fake.calls('tmux').filter((call) => call.key === 'display-message' && !call.args.includes('-p'));
}

export function doneMarks(fixture: RunFixture): RecordedCall[] {
    return fixture.fake.calls('tmux').filter((call) => call.key === 'set-option' && call.args.includes('@prwc_done'));
}

export function socketOf(call: RecordedCall | undefined): string | undefined {
    return call?.args[0] === '-S' ? call.args[1] : undefined;
}

export function eyesRemovals(fixture: RunFixture): RecordedCall[] {
    return fixture.fake
        .calls('gh')
        .filter((call) => call.key === 'PrwcRemoveReaction' && (call.input ?? '').includes('"EYES"'));
}
