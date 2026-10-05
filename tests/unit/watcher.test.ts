import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { getPath, isRecord, parseJson } from '../../src/json.ts';
import { markLaunchReady, readLaunchResult } from '../../src/launchChannel.ts';
import { acquirePrLock, acquireWorktreeLock, worktreeLockHolder } from '../../src/locks.ts';
import { createProcessRunner, pidAlive, processStart } from '../../src/proc.ts';
import { attentionHint } from '../../src/runState.ts';
import {
    claimLaunch,
    createRun,
    listRunIds,
    readRecord,
    readStatus,
    writeRecord,
    writeStatus,
} from '../../src/runStore.ts';
import { initState, runDir, watcherDir, worktreeDir, worktreeKey } from '../../src/stateStore.ts';
import type { CliOptions, Env, PrRef, RecordPatch, RunRecord, Session, WatcherStatus } from '../../src/types.ts';
import { applyPacing, createRuntime, runWatch, watchTick } from '../../src/watcher.ts';
import {
    createFakeRunner,
    type FakeResponse,
    type FakeRunner,
    type Passthrough,
    type RecordedCall,
} from '../support/fakeRunner.ts';
import { gitSync, makePrClone, offlineGitRunner } from '../support/gitRepo.ts';
import { createTestEnv, waitUntil, type TestDeps, type TestEnv } from '../support/testEnv.ts';

interface CommentSpec {
    dbId: number;
    rocket?: boolean;
    rocketAt?: number;
    editedAt?: number;
    plus1At?: number;
    // The viewer's rocket is only on a later reaction page, so the lookup needs a PrwcReactions follow-up.
    followUp?: boolean;
}

interface RateOptions {
    remaining?: number;
    resetAt?: number;
}

interface PollOptions extends RateOptions {
    state?: string;
}

interface SetupOptions {
    env?: Env;
    psPassthrough?: boolean;
    prime?: (_fake: FakeRunner) => void;
}

interface Setup {
    testEnv: TestEnv;
    stateDir: string;
    clone: string;
    session: Session;
    fake: FakeRunner;
    deps: TestDeps;
    now: number;
    panePid: number;
    // Runs before the test environment is removed, latest first (stops a tick or watcher still in progress).
    atCleanup(_action: () => Promise<unknown> | void): void;
}

interface SeedOptions {
    dbId: number;
    claudePid?: number;
    events?: readonly string[];
    watcherPid?: number;
    patch?: RecordPatch;
    decision?: 'go' | 'none';
    exitStatus?: boolean;
}

const FIXTURES = path.resolve(import.meta.dirname, '..', 'fixtures');
const TIMEOUT = 'timeout';
const PR_KEY = 'o+r+12';
const PR: PrRef = {
    host: 'github.com',
    owner: 'o',
    repo: 'r',
    number: 12,
    prUrl: 'https://github.com/o/r/pull/12',
    prKey: PR_KEY,
};
const TOKEN = '123-456';
const THREAD = 'PRRT_t1';
const VIEWER = 'reviewer';
const BRANCH = 'feature';
const NEVER = new AbortController().signal;
const NULL_JSON: unknown = JSON.parse('null');
const GH_FAIL: FakeResponse = { code: 1, stderr: 'HTTP 502: Bad Gateway' };
const AUTH_FAIL: FakeResponse = { code: 1, stderr: 'HTTP 401: Bad credentials (https://api.github.com/graphql)' };
const GONE_FAIL: FakeResponse = { code: 1, stderr: "gh: Could not resolve to a node with the global id of 'PRRT_t1'" };
const TMUX_FORMAT = '#{session_id} #{window_id}';
// Seeded events are this many seconds old, so the stop quiet period has elapsed.
const EVENT_AGE = 60;

function readFixture(...parts: readonly string[]): unknown {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(FIXTURES, ...parts), 'utf8'));
    return parsed;
}

function nodeTemplate(): Record<string, unknown> {
    const value = readFixture('watcher', 'lookupNode.json');
    assert.ok(isRecord(value), 'lookupNode.json is not an object');
    return value;
}

const NODE_TEMPLATE = nodeTemplate();
const PR_INFO = readFixture('preflight', 'prInfoOpen.json');
const CONTEXT = readFixture('dispatch', 'context.json');
const REMOVED = readFixture('dispatch', 'removeReaction.json');
const ADDED = readFixture('dispatch', 'addReaction.json');

function iso(epoch: number): string {
    return new Date(epoch * 1000).toISOString();
}

function nodeIdOf(dbId: number): string {
    return `PRRC_c${dbId}`;
}

function rateJson(now: number, options?: RateOptions): unknown {
    return { remaining: options?.remaining ?? 4000, resetAt: iso(options?.resetAt ?? now + 3600) };
}

function pollJson(now: number, comments: readonly CommentSpec[], options?: PollOptions): unknown {
    const nodes = comments.map((comment) => ({
        id: nodeIdOf(comment.dbId),
        databaseId: comment.dbId,
        reactionGroups: [{ content: 'ROCKET', viewerHasReacted: comment.rocket ?? false }],
    }));
    const page = { hasNextPage: false, endCursor: 'C1' };
    const threads = nodes.length === 0 ? [] : [{ id: THREAD, comments: { pageInfo: page, nodes } }];
    return {
        data: {
            viewer: { login: VIEWER },
            rateLimit: rateJson(now, options),
            repository: {
                pullRequest: {
                    state: options?.state ?? 'OPEN',
                    headRefName: BRANCH,
                    reviewThreads: { pageInfo: { hasNextPage: false, endCursor: 'T1' }, nodes: threads },
                },
            },
        },
    };
}

function reactionPage(viewerAt: number | undefined, followUp: boolean): unknown {
    if (followUp && viewerAt !== undefined) {
        const other = { createdAt: iso(viewerAt - 5), user: { login: 'other' } };
        return { pageInfo: { hasNextPage: true, endCursor: 'R1' }, nodes: [other] };
    }
    const nodes = viewerAt === undefined ? [] : [{ createdAt: iso(viewerAt), user: { login: VIEWER } }];
    return { pageInfo: { hasNextPage: false, endCursor: 'R1' }, nodes };
}

function lookupNode(comment: CommentSpec): unknown {
    return {
        ...NODE_TEMPLATE,
        id: nodeIdOf(comment.dbId),
        databaseId: comment.dbId,
        url: `https://github.com/o/r/pull/12#discussion_r${comment.dbId}`,
        lastEditedAt: comment.editedAt === undefined ? NULL_JSON : iso(comment.editedAt),
        rocket: reactionPage(comment.rocketAt, comment.followUp ?? false),
        plus: reactionPage(comment.plus1At, false),
        reactionGroups: [
            { content: 'ROCKET', viewerHasReacted: comment.rocketAt !== undefined },
            { content: 'THUMBS_UP', viewerHasReacted: comment.plus1At !== undefined },
            { content: 'EYES', viewerHasReacted: false },
        ],
    };
}

function lookupJson(now: number, comments: readonly CommentSpec[], options?: RateOptions): unknown {
    const nodes = comments.map((comment) => lookupNode(comment));
    return { data: { viewer: { login: VIEWER }, rateLimit: rateJson(now, options), nodes } };
}

// The PrwcReactions follow-up page that holds the viewer's reaction.
function reactionsJson(now: number, viewerAt: number, options?: RateOptions): unknown {
    const nodes = [{ createdAt: iso(viewerAt), user: { login: VIEWER } }];
    const reactions = { pageInfo: { hasNextPage: false, endCursor: 'R2' }, nodes };
    return { data: { rateLimit: rateJson(now, options), node: { reactions } } };
}

function rocketed(now: number, dbId: number, age: number, extra?: Partial<CommentSpec>): CommentSpec {
    return { dbId, rocket: true, rocketAt: now - age, ...extra };
}

function sessionFor(testEnv: TestEnv, clone: string, stateDir: string): Session {
    return {
        pr: PR,
        viewer: VIEWER,
        headRef: BRANCH,
        headOwner: 'o',
        headRepo: 'r',
        remote: 'origin',
        dirCanon: clone,
        toplevel: clone,
        worktreeKey: worktreeKey(clone),
        tools: {
            node: process.execPath,
            git: path.join(testEnv.toolsDir, 'git'),
            gh: path.join(testEnv.binDir, 'gh'),
            tmux: path.join(testEnv.binDir, 'tmux'),
            claude: path.join(testEnv.binDir, 'claude'),
        },
        callerPath: testEnv.env.PATH ?? '',
        ghEnv: [`GH_CONFIG_DIR=${testEnv.home}/.config/gh`, 'GH_HOST=github.com'],
        tmux: { socket: '/tmp/prwc-test-socket', pane: '%1', sessionId: '$1', windowId: '@1' },
        stateDir,
        interval: 15,
        keepPanes: 5,
        batchMax: 5,
        claudeArgs: [],
        once: false,
    };
}

function respondDefaults(fake: FakeRunner, panePid: number): void {
    fake.respond('gh', 'PrwcPrInfo', { json: PR_INFO });
    fake.respond('gh', 'PrwcContext', { json: CONTEXT });
    fake.respond('gh', 'PrwcRemoveReaction', { json: REMOVED });
    fake.respond('gh', 'PrwcAddReaction', { json: ADDED });
    fake.respond('tmux', 'split-window', { stdout: `%5 ${panePid}\n` });
    fake.respond('tmux', 'display-message', (call) => (call.args.includes(TMUX_FORMAT) ? { stdout: '$1 @1\n' } : {}));
}

// git goes to the real git through the offline transport and ps and the identity read (/bin/sh, tool other) to the real runner (unless psPassthrough is false);
// gh and tmux are answered by the fake runner. The clock is fixed at the setup time.
async function makeSetup(t: TestContext, options?: SetupOptions): Promise<Setup> {
    const testEnv = await createTestEnv();
    const cleanups: (() => Promise<unknown> | void)[] = [];
    t.after(async () => {
        try {
            for (const action of cleanups.toReversed()) {
                await action();
            }
        } finally {
            testEnv.cleanup();
        }
    });
    const init = initState(testEnv.stateDir);
    assert.ok(init.ok);
    const gitRoot = path.join(testEnv.root, 'git');
    const clone = makePrClone(gitRoot, BRANCH, 'o/r', testEnv.env);
    const real = createProcessRunner(testEnv.env);
    const passthrough: Passthrough = { git: offlineGitRunner(real, gitRoot) };
    if (options?.psPassthrough !== false) {
        passthrough.ps = real;
        passthrough.other = real;
    }
    const fake = createFakeRunner({ passthrough });
    const panePid = testEnv.spawnOrphan('sleep', ['300']);
    options?.prime?.(fake);
    respondDefaults(fake, panePid);
    const now = Math.floor(Date.now() / 1000);
    const deps: TestDeps = {
        ...testEnv.deps(fake.runner),
        env: { ...testEnv.env, ...options?.env },
        nowSeconds: () => now,
    };
    const session = sessionFor(testEnv, clone, init.stateDir);
    const atCleanup = (action: () => Promise<unknown> | void): void => {
        cleanups.push(action);
    };
    return { testEnv, stateDir: init.stateDir, clone, session, fake, deps, now, panePid, atCleanup };
}

function respondPoll(setup: Setup, comments: readonly CommentSpec[], options?: PollOptions): void {
    setup.fake.respond('gh', 'PrwcPoll', { json: pollJson(setup.now, comments, options) });
}

function respondLookup(setup: Setup, comments: readonly CommentSpec[], options?: RateOptions): void {
    setup.fake.respond('gh', 'PrwcLookup', { json: lookupJson(setup.now, comments, options) });
}

function eventLines(now: number, kinds: readonly string[]): string {
    return kinds.map((kind) => `${kind} ${now - EVENT_AGE}\n`).join('');
}

function runRecord(setup: Setup, runId: string, dbId: number, patch?: RecordPatch): RunRecord {
    const { session } = setup;
    return {
        format: 2,
        runId,
        prKey: PR_KEY,
        owner: 'o',
        repo: 'r',
        number: 12,
        prUrl: PR.prUrl,
        comments: [
            {
                nodeId: nodeIdOf(dbId),
                dbId: dbId,
                url: `https://github.com/o/r/pull/12#discussion_r${dbId}`,
                threadId: THREAD,
                topDbId: 101,
                rocketAt: setup.now - 600,
                eyesAdded: true,
            },
        ],
        headSha: 'a'.repeat(40),
        remote: 'origin',
        branch: BRANCH,
        dir: setup.clone,
        worktreeKey: session.worktreeKey,
        claude: session.tools.claude,
        git: session.tools.git,
        gh: session.tools.gh,
        callerPath: session.callerPath,
        claudeArgs: [],
        state: 'running',
        reason: '',
        paneId: '%5',
        panePid: setup.panePid,
        socket: session.tmux.socket,
        startedAt: setup.now - EVENT_AGE,
        watcherPid: process.pid,
        ...patch,
    };
}

// Writes claude.start (launcher format, with a newline) and claude.pid for a running fake claude.
async function recordClaude(setup: Setup, dir: string, pid: number): Promise<void> {
    const start = await processStart(createProcessRunner(setup.testEnv.env), pid);
    assert.ok(start !== undefined, 'no start time for the fake claude');
    fs.writeFileSync(path.join(dir, 'claude.start'), `${start}\n`);
    fs.writeFileSync(path.join(dir, 'claude.pid'), `${pid}\n`);
}

// A running run (unless the patch says otherwise) with decision go, the worktree lock and, when claudePid is given,
// a live claude.
async function seedRun(setup: Setup, options: SeedOptions): Promise<string> {
    const runId = `20261002120000-${options.dbId}`;
    const watcherPid = options.watcherPid ?? process.pid;
    createRun(setup.stateDir, runId);
    writeRecord(setup.stateDir, runRecord(setup, runId, options.dbId, { watcherPid, ...options.patch }));
    if ((options.decision ?? 'go') === 'go') {
        assert.ok(claimLaunch(setup.stateDir, runId, 'go'));
    }
    const dir = runDir(setup.stateDir, runId);
    if (options.events !== undefined) {
        fs.writeFileSync(path.join(dir, 'events'), eventLines(setup.now, options.events));
    }
    if (options.claudePid !== undefined) {
        await recordClaude(setup, dir, options.claudePid);
    }
    if (options.exitStatus === true) {
        fs.writeFileSync(path.join(dir, 'exit_status'), '0');
    }
    const wtKey = setup.session.worktreeKey;
    assert.ok(acquireWorktreeLock(setup.stateDir, wtKey, runId, watcherPid, setup.deps.log, setup.now));
    return runId;
}

function statusOf(setup: Setup): WatcherStatus {
    const status = readStatus(setup.stateDir, PR_KEY);
    assert.ok(status !== undefined, 'no watcher status');
    return status;
}

function stateOf(setup: Setup, runId: string | undefined): string {
    assert.ok(runId !== undefined, 'no run id');
    const read = readRecord(setup.stateDir, runId);
    assert.ok(read.kind === 'ok', 'the run record is unreadable');
    return read.record.state;
}

function variable(call: RecordedCall, name: string): unknown {
    return getPath(parseJson(call.input ?? ''), 'variables', name);
}

function mutations(fake: FakeRunner): RecordedCall[] {
    return fake.calls('gh').filter((call) => call.key === 'PrwcAddReaction' || call.key === 'PrwcRemoveReaction');
}

function rocketRemovals(fake: FakeRunner, dbId?: number): RecordedCall[] {
    return fake
        .calls('gh')
        .filter((call) => call.key === 'PrwcRemoveReaction' && variable(call, 'content') === 'ROCKET')
        .filter((call) => dbId === undefined || variable(call, 'id') === nodeIdOf(dbId));
}

function splits(fake: FakeRunner): number {
    return fake.callCount('tmux', 'split-window');
}

function prLockDir(setup: Setup): string {
    return path.join(watcherDir(setup.stateDir, PR_KEY), 'lock');
}

function worktreeLockDir(setup: Setup): string {
    return path.join(worktreeDir(setup.stateDir, setup.session.worktreeKey), 'lock');
}

function printed(setup: Setup): string {
    return `${setup.deps.outText()}\n${setup.deps.logLines.join('\n')}`;
}

function cliOptions(setup: Setup, once: boolean, inPlace = true): CliOptions {
    return {
        mode: 'watch',
        pr: PR,
        dir: setup.clone,
        interval: 300,
        claude: undefined,
        claudeArgs: [],
        keepPanes: 5,
        batchMax: 5,
        once,
        inPlace,
    };
}

function startWatch(setup: Setup, once: boolean, stop = NEVER, inPlace = true): Promise<number> {
    return runWatch(setup.deps, cliOptions(setup, once, inPlace), setup.testEnv.root, process.execPath, stop);
}

async function within<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
    const controller = new AbortController();
    const timer = delay<typeof TIMEOUT>(ms, TIMEOUT, { signal: controller.signal }).catch(
        (): typeof TIMEOUT => TIMEOUT
    );
    try {
        return await Promise.race([promise, timer]);
    } finally {
        controller.abort();
    }
}

function launchResultOf(setup: Setup): string | undefined {
    return readLaunchResult(setup.stateDir, PR_KEY, TOKEN)?.result;
}

function launchMessageOf(setup: Setup): string {
    return readLaunchResult(setup.stateDir, PR_KEY, TOKEN)?.message ?? '';
}

async function deadPid(setup: Setup): Promise<number> {
    const pid = setup.testEnv.spawnOrphan('true', []);
    assert.ok(await waitUntil(5000, () => !pidAlive(pid)), 'the short-lived orphan did not die');
    return pid;
}

// A fake claude that survives TERM and creates termFile once a TERM arrived; ready proves the trap is installed.
async function termReportingClaude(setup: Setup, termFile: string): Promise<number> {
    const ready = path.join(setup.testEnv.root, 'claude.ready');
    const script = `trap "echo term > ${termFile}" TERM; : > ${ready}; while :; do sleep 1; done`;
    const pid = setup.testEnv.spawnOrphan('/bin/sh', ['-c', script]);
    assert.ok(await waitUntil(5000, () => fs.existsSync(ready)), 'the fake claude did not start');
    return pid;
}

await describe('watchTick', async () => {
    await test('one poll and one batched lookup for every rocketed comment', async (t) => {
        const setup = await makeSetup(t);
        const comments = [rocketed(setup.now, 101, 300), rocketed(setup.now, 102, 200), rocketed(setup.now, 103, 100)];
        respondPoll(setup, comments);
        respondLookup(setup, comments);
        const outcome = await watchTick(setup.deps, setup.session, createRuntime('', '@1'), NEVER);
        assert.equal(outcome, 'ok');
        assert.equal(setup.fake.callCount('gh', 'PrwcPoll'), 1);
        const lookups = setup.fake.calls('gh').filter((call) => call.key === 'PrwcLookup');
        assert.equal(lookups.length, 1);
        const [lookup] = lookups;
        assert.ok(lookup !== undefined);
        assert.deepEqual(variable(lookup, 'ids'), [nodeIdOf(101), nodeIdOf(102), nodeIdOf(103)]);
    });

    await test('no rockets and no run in flight: no lookup and status polling', async (t) => {
        const setup = await makeSetup(t);
        respondPoll(setup, [{ dbId: 101 }, { dbId: 102 }]);
        const outcome = await watchTick(setup.deps, setup.session, createRuntime('', '@1'), NEVER);
        assert.equal(outcome, 'ok');
        assert.equal(setup.fake.callCount('gh', 'PrwcLookup'), 0);
        assert.equal(statusOf(setup).state, 'polling');
    });

    await test('dispatches the oldest-approved candidate', async (t) => {
        const setup = await makeSetup(t);
        const comments = [rocketed(setup.now, 101, 100), rocketed(setup.now, 102, 300), rocketed(setup.now, 103, 200)];
        respondPoll(setup, comments);
        respondLookup(setup, comments);
        const rt = createRuntime('', '@1');
        assert.equal(await watchTick(setup.deps, setup.session, rt, NEVER), 'ok');
        assert.equal(splits(setup.fake), 1);
        assert.ok(rt.inflightRunId?.endsWith('-102'), `dispatched ${rt.inflightRunId}`);
        assert.equal(stateOf(setup, rt.inflightRunId), 'running');
        assert.equal(statusOf(setup).state, 'running');
    });

    await test('an edited candidate loses its rocket and the next-oldest is dispatched', async (t) => {
        const setup = await makeSetup(t);
        const edited = rocketed(setup.now, 102, 300, { editedAt: setup.now - 250 });
        const comments = [rocketed(setup.now, 101, 100), edited, rocketed(setup.now, 103, 200)];
        respondPoll(setup, comments);
        respondLookup(setup, comments);
        const rt = createRuntime('', '@1');
        assert.equal(await watchTick(setup.deps, setup.session, rt, NEVER), 'ok');
        assert.equal(rocketRemovals(setup.fake, 102).length, 1);
        assert.ok(setup.deps.logLines.some((line) => line.includes('comment 102 was edited after approval')));
        assert.equal(splits(setup.fake), 1);
        assert.ok(rt.inflightRunId?.endsWith('-103'), `dispatched ${rt.inflightRunId}`);
        assert.ok(listRunIds(setup.stateDir).every((runId) => !runId.endsWith('-102')));
    });

    await test('an edited comment alone gets the removal and the log line but no dispatch', async (t) => {
        const setup = await makeSetup(t);
        const comments = [rocketed(setup.now, 102, 300, { editedAt: setup.now - 100 })];
        respondPoll(setup, comments);
        respondLookup(setup, comments);
        const rt = createRuntime('', '@1');
        assert.equal(await watchTick(setup.deps, setup.session, rt, NEVER), 'ok');
        assert.equal(rocketRemovals(setup.fake, 102).length, 1);
        assert.ok(setup.deps.logLines.some((line) => line.includes('add the rocket again to approve the new text')));
        assert.equal(splits(setup.fake), 0);
        assert.equal(rt.inflightRunId, undefined);
        assert.deepEqual(listRunIds(setup.stateDir), []);
    });

    await test('a guard hold leaves no lock and no reaction change', async (t) => {
        const setup = await makeSetup(t);
        fs.appendFileSync(path.join(setup.clone, 'README.md'), 'dirty\n');
        const comments = [rocketed(setup.now, 103, 100)];
        respondPoll(setup, comments);
        respondLookup(setup, comments);
        assert.equal(await watchTick(setup.deps, setup.session, createRuntime('', '@1'), NEVER), 'ok');
        const status = statusOf(setup);
        assert.equal(status.state, 'holding');
        assert.equal(status.reason, 'uncommitted changes to tracked files');
        assert.equal(status.hint, 'commit or stash them');
        assert.deepEqual(mutations(setup.fake), []);
        assert.equal(fs.existsSync(worktreeLockDir(setup)), false);
    });

    await test('a context failure holds without a reaction change', async (t) => {
        const setup = await makeSetup(t, {
            prime: (fake) => {
                fake.respond('gh', 'PrwcContext', GH_FAIL);
            },
        });
        const approved = rocketed(setup.now, 103, 100);
        respondPoll(setup, [{ dbId: 101 }, { dbId: 102 }, approved]);
        respondLookup(setup, [approved]);
        assert.equal(await watchTick(setup.deps, setup.session, createRuntime('', '@1'), NEVER), 'ok');
        assert.equal(setup.fake.callCount('gh', 'PrwcContext'), 1);
        const status = statusOf(setup);
        assert.equal(status.state, 'holding');
        assert.equal(status.reason, 'context fetch failed');
        assert.deepEqual(mutations(setup.fake), []);
    });

    await test('the capture is taken before the poll and the lookup', async (t) => {
        const setup = await makeSetup(t);
        const claudePid = setup.testEnv.spawnOrphan('sleep', ['300']);
        const runId = await seedRun(setup, { dbId: 101, claudePid });
        respondPoll(setup, [{ dbId: 101 }]);
        respondLookup(setup, [{ dbId: 101, rocketAt: setup.now - 600 }]);
        const rt = createRuntime('', '@1');
        rt.inflightRunId = runId;
        const seen: number[] = [];
        const outcome = await watchTick(setup.deps, setup.session, rt, NEVER, {
            beforePoll: () => {
                seen.push(setup.fake.callCount('gh', 'PrwcPoll'), setup.fake.callCount('gh', 'PrwcLookup'));
                fs.appendFileSync(path.join(runDir(setup.stateDir, runId), 'events'), eventLines(setup.now, ['tool']));
            },
        });
        assert.equal(outcome, 'ok');
        assert.deepEqual(seen, [0, 0]);
        assert.equal(setup.fake.callCount('gh', 'PrwcPoll'), 1);
        assert.equal(setup.fake.callCount('gh', 'PrwcLookup'), 1);
        const status = statusOf(setup);
        assert.equal(status.state, 'running');
        assert.equal(status.reason, 'events-changed');
        assert.equal(rt.inflightRunId, runId);
    });

    await test('a stop observed after the poll ends the tick before the lookup', async (t) => {
        const setup = await makeSetup(t);
        const comments = [rocketed(setup.now, 103, 100)];
        respondPoll(setup, comments);
        respondLookup(setup, comments);
        const controller = new AbortController();
        const outcome = await watchTick(setup.deps, setup.session, createRuntime('', '@1'), controller.signal, {
            beforePoll: () => {
                controller.abort();
            },
        });
        assert.equal(outcome, 'stopped');
        assert.equal(setup.fake.callCount('gh', 'PrwcLookup'), 0);
        assert.equal(splits(setup.fake), 0);
        assert.deepEqual(mutations(setup.fake), []);
    });

    await test('a preparing run is resumed into a worker when the rocket is already gone', async (t) => {
        const setup = await makeSetup(t, {
            prime: (fake) => {
                fake.respond('gh', 'PrwcRemoveReaction', GH_FAIL);
            },
        });
        const approved = rocketed(setup.now, 103, 100);
        respondPoll(setup, [{ dbId: 101 }, { dbId: 102 }, approved]);
        respondPoll(setup, [{ dbId: 101 }, { dbId: 102 }, { dbId: 103 }]);
        respondLookup(setup, [approved]);
        const rt = createRuntime('', '@1');
        assert.equal(await watchTick(setup.deps, setup.session, rt, NEVER), 'ok');
        const runId = rt.inflightRunId;
        assert.ok(runId !== undefined);
        assert.equal(stateOf(setup, runId), 'preparing');
        assert.deepEqual(listRunIds(setup.stateDir), [runId]);
        assert.equal(splits(setup.fake), 0);
        assert.equal(await watchTick(setup.deps, setup.session, rt, NEVER), 'ok');
        assert.equal(rt.inflightRunId, runId);
        assert.equal(stateOf(setup, runId), 'running');
        assert.equal(splits(setup.fake), 1);
        assert.deepEqual(listRunIds(setup.stateDir), [runId]);
        assert.equal(rocketRemovals(setup.fake).length, 1);
        assert.equal(statusOf(setup).state, 'running');
    });

    await test('a preparing run whose rocket removal fails again stays preparing', async (t) => {
        const setup = await makeSetup(t, {
            prime: (fake) => {
                fake.respond('gh', 'PrwcRemoveReaction', GH_FAIL);
                fake.respond('gh', 'PrwcRemoveReaction', GH_FAIL);
            },
        });
        const approved = rocketed(setup.now, 103, 100);
        respondPoll(setup, [{ dbId: 101 }, { dbId: 102 }, approved]);
        respondLookup(setup, [approved]);
        const rt = createRuntime('', '@1');
        assert.equal(await watchTick(setup.deps, setup.session, rt, NEVER), 'ok');
        const runId = rt.inflightRunId;
        assert.ok(runId !== undefined);
        assert.equal(await watchTick(setup.deps, setup.session, rt, NEVER), 'ok');
        assert.equal(rocketRemovals(setup.fake, 103).length, 2);
        assert.equal(rt.inflightRunId, runId);
        assert.equal(stateOf(setup, runId), 'preparing');
        assert.equal(splits(setup.fake), 0);
        assert.deepEqual(listRunIds(setup.stateDir), [runId]);
        const status = statusOf(setup);
        assert.equal(status.state, 'running');
        assert.equal(status.reason, 'preparing');
    });

    await test('a running run in flight blocks a new dispatch', async (t) => {
        const setup = await makeSetup(t);
        const claudePid = setup.testEnv.spawnOrphan('sleep', ['300']);
        const runId = await seedRun(setup, { dbId: 101, claudePid });
        const comments = [rocketed(setup.now, 102, 300), rocketed(setup.now, 103, 200)];
        respondPoll(setup, [{ dbId: 101 }, ...comments]);
        respondLookup(setup, [{ dbId: 101, rocketAt: setup.now - 600 }, ...comments]);
        const rt = createRuntime('', '@1');
        rt.inflightRunId = runId;
        assert.equal(await watchTick(setup.deps, setup.session, rt, NEVER), 'ok');
        assert.equal(splits(setup.fake), 0);
        assert.deepEqual(listRunIds(setup.stateDir), [runId]);
        assert.equal(rt.inflightRunId, runId);
        assert.equal(statusOf(setup).state, 'running');
    });

    await test('a closed pull request ends the watcher', async (t) => {
        const setup = await makeSetup(t);
        respondPoll(setup, [], { state: 'CLOSED' });
        assert.equal(await watchTick(setup.deps, setup.session, createRuntime('', '@1'), NEVER), 'prClosed');
        assert.ok(setup.deps.logLines.some((line) => line.includes('pull request is CLOSED, stopping')));
        assert.equal(statusOf(setup).state, 'exited');
    });

    await test('an authentication failure of the poll is fatal', async (t) => {
        const setup = await makeSetup(t);
        setup.fake.respond('gh', 'PrwcPoll', AUTH_FAIL);
        assert.equal(await watchTick(setup.deps, setup.session, createRuntime('', '@1'), NEVER), 'fatal');
        const status = statusOf(setup);
        assert.equal(status.state, 'fatal');
        assert.ok(status.lastError.includes('401'));
    });

    await test('a transient poll failure backs off until a tick fully succeeds', async (t) => {
        const setup = await makeSetup(t);
        setup.fake.respond('gh', 'PrwcPoll', GH_FAIL);
        respondPoll(setup, []);
        const rt = createRuntime('', '@1');
        assert.equal(await watchTick(setup.deps, setup.session, rt, NEVER), 'transient');
        const status = statusOf(setup);
        assert.equal(status.state, 'backing_off');
        assert.ok(status.lastError.includes('502'));
        assert.equal(rt.failures, 1);
        assert.equal(await watchTick(setup.deps, setup.session, rt, NEVER), 'ok');
        assert.equal(rt.failures, 0);
    });

    await test('a gone poll failure backs off without a lookup', async (t) => {
        const setup = await makeSetup(t);
        setup.fake.respond('gh', 'PrwcPoll', GONE_FAIL);
        const rt = createRuntime('', '@1');
        assert.equal(await watchTick(setup.deps, setup.session, rt, NEVER), 'transient');
        assert.equal(statusOf(setup).state, 'backing_off');
        assert.equal(rt.failures, 1);
        assert.equal(setup.fake.callCount('gh', 'PrwcLookup'), 0);
    });

    await test('a failing lookup keeps growing the backoff although every poll succeeds', async (t) => {
        const setup = await makeSetup(t);
        respondPoll(setup, [rocketed(setup.now, 103, 100)]);
        setup.fake.respond('gh', 'PrwcLookup', GH_FAIL);
        setup.fake.respond('gh', 'PrwcLookup', GH_FAIL);
        respondLookup(setup, [{ dbId: 103 }]);
        const rt = createRuntime('', '@1');
        assert.equal(await watchTick(setup.deps, setup.session, rt, NEVER), 'transient');
        assert.equal(await watchTick(setup.deps, setup.session, rt, NEVER), 'transient');
        assert.equal(rt.failures, 2);
        assert.equal(await watchTick(setup.deps, setup.session, rt, NEVER), 'ok');
        assert.equal(rt.failures, 0);
    });

    await test('an abort during the TERM wait ends the tick as stopped', async (t) => {
        const termFile = 'term.flag';
        const setup = await makeSetup(t, { env: { PRWC_TERM_WAIT: '30' } });
        const termPath = path.join(setup.testEnv.root, termFile);
        const claudePid = await termReportingClaude(setup, termPath);
        const runId = await seedRun(setup, { dbId: 101, claudePid, events: ['prompt', 'stop'] });
        respondPoll(setup, [{ dbId: 101 }]);
        respondLookup(setup, [{ dbId: 101, rocketAt: setup.now - 600, plus1At: setup.now - 30 }]);
        const rt = createRuntime('', '@1');
        rt.inflightRunId = runId;
        const controller = new AbortController();
        const tick = watchTick(setup.deps, setup.session, rt, controller.signal);
        setup.atCleanup(async () => {
            controller.abort();
            await tick;
        });
        assert.ok(await waitUntil(15_000, () => fs.existsSync(termPath)), 'the TERM did not arrive');
        controller.abort();
        assert.equal(await within(tick, 3000), 'stopped');
        assert.equal(stateOf(setup, runId), 'running');
        assert.ok(fs.existsSync(worktreeLockDir(setup)));
        assert.equal(splits(setup.fake), 0);
    });
});

await describe('applyPacing', async () => {
    await test('throttles an idle tick', async (t) => {
        const setup = await makeSetup(t);
        respondPoll(setup, [], { remaining: 100, resetAt: setup.now + 900 });
        const rt = createRuntime('', '@1');
        assert.equal(await watchTick(setup.deps, setup.session, rt, NEVER), 'ok');
        assert.equal(applyPacing(setup.deps, setup.session, rt), 900);
        assert.equal(statusOf(setup).state, 'throttled');
    });

    await test('throttles while a run holds the slot, using the lookup rate', async (t) => {
        const setup = await makeSetup(t);
        const claudePid = setup.testEnv.spawnOrphan('sleep', ['300']);
        const runId = await seedRun(setup, { dbId: 101, claudePid });
        respondPoll(setup, [{ dbId: 101 }], { remaining: 4000 });
        respondLookup(setup, [{ dbId: 101, rocketAt: setup.now - 600 }], {
            remaining: 100,
            resetAt: setup.now + 900,
        });
        const rt = createRuntime('', '@1');
        rt.inflightRunId = runId;
        rt.lastPollAt = setup.deps.nowSeconds();
        assert.equal(await watchTick(setup.deps, setup.session, rt, NEVER), 'ok');
        assert.equal(setup.fake.callCount('gh', 'PrwcPoll'), 0);
        assert.equal(applyPacing(setup.deps, setup.session, rt), 900);
        assert.equal(statusOf(setup).state, 'throttled');
    });

    await test('throttles while a guard holds and keeps its reason and hint', async (t) => {
        const setup = await makeSetup(t);
        fs.appendFileSync(path.join(setup.clone, 'README.md'), 'dirty\n');
        const comments = [rocketed(setup.now, 103, 100)];
        respondPoll(setup, comments, { remaining: 4000 });
        respondLookup(setup, comments, { remaining: 100, resetAt: setup.now + 900 });
        const rt = createRuntime('', '@1');
        assert.equal(await watchTick(setup.deps, setup.session, rt, NEVER), 'ok');
        assert.equal(applyPacing(setup.deps, setup.session, rt), 900);
        const status = statusOf(setup);
        assert.equal(status.state, 'throttled');
        assert.equal(status.reason, 'uncommitted changes to tracked files');
        assert.equal(status.hint, 'commit or stash them');
    });

    await test('throttles on the rate of a reactions follow-up', async (t) => {
        const setup = await makeSetup(t);
        const comment = rocketed(setup.now, 103, 100, { followUp: true });
        respondPoll(setup, [comment], { remaining: 4000 });
        respondLookup(setup, [comment], { remaining: 4000 });
        setup.fake.respond('gh', 'PrwcReactions', {
            json: reactionsJson(setup.now, setup.now - 100, { remaining: 100, resetAt: setup.now + 900 }),
        });
        const rt = createRuntime('', '@1');
        assert.equal(await watchTick(setup.deps, setup.session, rt, NEVER), 'ok');
        assert.equal(setup.fake.callCount('gh', 'PrwcReactions'), 1);
        assert.equal(applyPacing(setup.deps, setup.session, rt), 900);
        assert.equal(statusOf(setup).state, 'throttled');
    });

    await test('throttles on the rate of a lookup that failed after its first page', async (t) => {
        const setup = await makeSetup(t);
        const comment = rocketed(setup.now, 103, 100, { followUp: true });
        respondPoll(setup, [comment], { remaining: 4000 });
        respondLookup(setup, [comment], { remaining: 100, resetAt: setup.now + 900 });
        setup.fake.respond('gh', 'PrwcReactions', GH_FAIL);
        const rt = createRuntime('', '@1');
        assert.equal(await watchTick(setup.deps, setup.session, rt, NEVER), 'transient');
        assert.equal(rt.failures, 1);
        assert.equal(applyPacing(setup.deps, setup.session, rt), 900);
        assert.equal(statusOf(setup).state, 'throttled');
    });
});

await describe('runWatch', async () => {
    await test('once: a lookup authentication failure stays fatal and frees the PR lock', async (t) => {
        const setup = await makeSetup(t);
        respondPoll(setup, [rocketed(setup.now, 103, 100)], { remaining: 100, resetAt: setup.now + 900 });
        setup.fake.respond('gh', 'PrwcLookup', AUTH_FAIL);
        assert.equal(await startWatch(setup, true), 1);
        assert.equal(statusOf(setup).state, 'fatal');
        assert.equal(fs.existsSync(prLockDir(setup)), false);
    });

    await test('once: a closed pull request exits 0 and frees the PR lock', async (t) => {
        const setup = await makeSetup(t);
        respondPoll(setup, [], { state: 'CLOSED', remaining: 100, resetAt: setup.now + 900 });
        assert.equal(await startWatch(setup, true), 0);
        assert.equal(statusOf(setup).state, 'exited');
        assert.equal(fs.existsSync(prLockDir(setup)), false);
    });

    await test('once: a merged pull request removes the clean watch worktree', async (t) => {
        const setup = await makeSetup(t);
        const clone = fs.realpathSync.native(setup.clone);
        gitSync(setup.testEnv.env, ['-C', clone, 'checkout', '--quiet', 'main']);
        respondPoll(setup, [], { state: 'MERGED', remaining: 100, resetAt: setup.now + 900 });
        assert.equal(await startWatch(setup, true, NEVER, false), 0, printed(setup));
        const worktree = path.join(path.dirname(clone), 'alex-pr-watch-comments-pr-12');
        assert.ok(printed(setup).includes(`created the watch worktree ${worktree}`), printed(setup));
        assert.ok(printed(setup).includes(`removed the watch worktree ${worktree}`), printed(setup));
        assert.equal(fs.existsSync(worktree), false);
    });

    await test('a launch that is never confirmed is fatal without any gh call', async (t) => {
        const setup = await makeSetup(t, { env: { PRWC_LAUNCH_TOKEN: TOKEN, PRWC_READY_WAIT: '1' } });
        const started = performance.now();
        assert.equal(await within(startWatch(setup, true), 5000), 1);
        assert.ok(performance.now() - started < 5000);
        assert.equal(setup.fake.calls('gh').length, 0);
        assert.equal(fs.existsSync(prLockDir(setup)), false);
        assert.equal(launchResultOf(setup), 'fatal');
        assert.ok(launchMessageOf(setup).includes('launch not confirmed'));
    });

    await test('the ready wait leaves at once on a stop', async (t) => {
        const setup = await makeSetup(t, { env: { PRWC_LAUNCH_TOKEN: TOKEN, PRWC_READY_WAIT: '15' } });
        const controller = new AbortController();
        controller.abort();
        let sleeps = 0;
        const base = { ...setup.deps };
        setup.deps.sleep = (ms, signal) => {
            sleeps += 1;
            return base.sleep(ms, signal);
        };
        assert.equal(await within(startWatch(setup, true, controller.signal), 2000), 1);
        assert.equal(sleeps, 0);
        assert.equal(setup.fake.calls('gh').length, 0);
        assert.equal(launchResultOf(setup), 'fatal');
    });

    await test('a confirmed launch publishes its first poll', async (t) => {
        const setup = await makeSetup(t, { env: { PRWC_LAUNCH_TOKEN: TOKEN } });
        markLaunchReady(setup.stateDir, PR_KEY, TOKEN);
        respondPoll(setup, []);
        assert.equal(await startWatch(setup, true), 0);
        assert.equal(launchResultOf(setup), 'firstPoll');
        assert.equal(fs.existsSync(prLockDir(setup)), false);
    });

    await test('a PR lock held by a live process gives already watched', async (t) => {
        const setup = await makeSetup(t, { env: { PRWC_LAUNCH_TOKEN: TOKEN } });
        markLaunchReady(setup.stateDir, PR_KEY, TOKEN);
        const holder = setup.testEnv.spawnOrphan('sleep', ['300']);
        const fields = {
            pidStart: 'start',
            paneId: '%9',
            windowId: '@7',
            socket: '/tmp/prwc-test-socket',
            dir: setup.clone,
            startedAt: setup.now,
        };
        assert.equal(acquirePrLock(setup.stateDir, PR_KEY, fields, holder, setup.now).kind, 'acquired');
        respondPoll(setup, []);
        assert.equal(await startWatch(setup, true), 0);
        assert.ok(printed(setup).includes(`already watched by pid ${holder} (window @7)`), printed(setup));
        assert.equal(setup.fake.callCount('gh', 'PrwcPoll'), 0);
        const result = readLaunchResult(setup.stateDir, PR_KEY, TOKEN);
        assert.ok(result !== undefined, 'no launch result');
        assert.equal(result.result, 'alreadyWatched');
        assert.equal(result.pid, holder);
        assert.equal(result.windowId, '@7');
    });

    await test('a lookup authentication failure after a good poll publishes fatal', async (t) => {
        const setup = await makeSetup(t, { env: { PRWC_LAUNCH_TOKEN: TOKEN } });
        markLaunchReady(setup.stateDir, PR_KEY, TOKEN);
        respondPoll(setup, [rocketed(setup.now, 103, 100)]);
        setup.fake.respond('gh', 'PrwcLookup', AUTH_FAIL);
        assert.equal(await startWatch(setup, true), 1);
        assert.equal(launchResultOf(setup), 'fatal');
    });

    await test('a closed pull request at the first poll publishes fatal', async (t) => {
        const setup = await makeSetup(t, { env: { PRWC_LAUNCH_TOKEN: TOKEN } });
        markLaunchReady(setup.stateDir, PR_KEY, TOKEN);
        respondPoll(setup, [], { state: 'CLOSED' });
        assert.equal(await startWatch(setup, true), 0);
        assert.equal(launchResultOf(setup), 'fatal');
        assert.ok(launchMessageOf(setup).includes('CLOSED'));
    });

    await test('a transient lookup failure ends a single pass before its first poll', async (t) => {
        const setup = await makeSetup(t, { env: { PRWC_LAUNCH_TOKEN: TOKEN } });
        markLaunchReady(setup.stateDir, PR_KEY, TOKEN);
        respondPoll(setup, [rocketed(setup.now, 103, 100)]);
        setup.fake.respond('gh', 'PrwcLookup', GH_FAIL);
        assert.equal(await startWatch(setup, true), 1);
        assert.equal(launchResultOf(setup), 'fatal');
        assert.ok(launchMessageOf(setup).includes('before its first poll'));
    });

    await test('the first poll is published by the first fully successful tick', async (t) => {
        const setup = await makeSetup(t);
        const comment = rocketed(setup.now, 103, 100, { editedAt: setup.now });
        respondPoll(setup, [comment]);
        setup.fake.respond('gh', 'PrwcLookup', GH_FAIL);
        respondLookup(setup, [comment]);
        const rt = createRuntime(TOKEN, '@1');
        assert.equal(await watchTick(setup.deps, setup.session, rt, NEVER), 'transient');
        assert.equal(launchResultOf(setup), undefined);
        assert.equal(await watchTick(setup.deps, setup.session, rt, NEVER), 'ok');
        assert.equal(launchResultOf(setup), 'firstPoll');
    });

    await test('the first poll is published before the first dispatch', async (t) => {
        const seen: (string | undefined)[] = [];
        const holder: { setup?: Setup } = {};
        const setup = await makeSetup(t, {
            env: { PRWC_LAUNCH_TOKEN: TOKEN },
            prime: (fake) => {
                fake.respond('tmux', 'split-window', () => {
                    seen.push(holder.setup === undefined ? 'no setup' : launchResultOf(holder.setup));
                    return { stdout: `%5 ${holder.setup?.panePid ?? 0}\n` };
                });
            },
        });
        holder.setup = setup;
        markLaunchReady(setup.stateDir, PR_KEY, TOKEN);
        const comments = [rocketed(setup.now, 103, 100)];
        respondPoll(setup, comments);
        respondLookup(setup, comments);
        assert.equal(await startWatch(setup, true), 0);
        assert.deepEqual(seen, ['firstPoll']);
    });

    await test('an abort right before the publication is never published as a first poll', async (t) => {
        const controller = new AbortController();
        const holder: { now: number } = { now: Math.floor(Date.now() / 1000) };
        const setup = await makeSetup(t, {
            env: { PRWC_LAUNCH_TOKEN: TOKEN },
            prime: (fake) => {
                fake.respond('gh', 'PrwcLookup', () => {
                    controller.abort();
                    return { json: lookupJson(holder.now, [rocketed(holder.now, 103, 100)]) };
                });
            },
        });
        holder.now = setup.now;
        markLaunchReady(setup.stateDir, PR_KEY, TOKEN);
        respondPoll(setup, [rocketed(setup.now, 103, 100)]);
        assert.equal(await within(startWatch(setup, false, controller.signal), 3000), 0);
        assert.equal(launchResultOf(setup), 'fatal');
        assert.ok(launchMessageOf(setup).includes('stopped before its first poll'));
        assert.equal(splits(setup.fake), 0);
        assert.deepEqual(mutations(setup.fake), []);
        assert.equal(setup.fake.callCount('gh', 'PrwcPoll'), 1);
        assert.equal(fs.existsSync(prLockDir(setup)), false);
    });

    await test('an abort during the first TERM wait stops promptly after the first GitHub check', async (t) => {
        const setup = await makeSetup(t, { env: { PRWC_LAUNCH_TOKEN: TOKEN, PRWC_TERM_WAIT: '30' } });
        markLaunchReady(setup.stateDir, PR_KEY, TOKEN);
        const termPath = path.join(setup.testEnv.root, 'term.flag');
        const claudePid = await termReportingClaude(setup, termPath);
        const deadWatcher = await deadPid(setup);
        const runId = await seedRun(setup, {
            dbId: 101,
            claudePid,
            events: ['prompt', 'stop'],
            watcherPid: deadWatcher,
        });
        setup.fake.respond('tmux', 'list-panes', { stdout: `%5 ${runId}\n` });
        respondPoll(setup, [{ dbId: 101 }]);
        respondLookup(setup, [{ dbId: 101, rocketAt: setup.now - 600, plus1At: setup.now - 30 }]);
        const controller = new AbortController();
        const watching = startWatch(setup, false, controller.signal);
        setup.atCleanup(async () => {
            controller.abort();
            await watching;
        });
        const reached = await waitUntil(15_000, () => launchResultOf(setup) === 'firstPoll' && fs.existsSync(termPath));
        assert.ok(reached, 'the first poll was not published or the TERM did not arrive');
        controller.abort();
        assert.equal(await within(watching, 3000), 0);
        assert.equal(setup.fake.callCount('gh', 'PrwcLookup'), 1);
        assert.equal(setup.fake.callCount('gh', 'PrwcPoll'), 0);
        assert.equal(launchResultOf(setup), 'firstPoll');
        assert.equal(fs.existsSync(prLockDir(setup)), false);
        assert.equal(stateOf(setup, runId), 'running');
    });

    await test('an unreadable own start time is fatal without a PR lock', async (t) => {
        const setup = await makeSetup(t, {
            env: { PRWC_LAUNCH_TOKEN: TOKEN },
            psPassthrough: false,
            prime: (fake) => {
                fake.respond('other', 'other', { code: 1, stdout: '' });
            },
        });
        markLaunchReady(setup.stateDir, PR_KEY, TOKEN);
        respondPoll(setup, []);
        assert.equal(await startWatch(setup, true), 1);
        assert.ok(printed(setup).includes("could not read the watcher's own start time"));
        assert.equal(fs.existsSync(prLockDir(setup)), false);
        assert.equal(setup.fake.callCount('gh', 'PrwcPoll'), 0);
        assert.equal(launchResultOf(setup), 'fatal');
    });

    await test('an unsafe state directory refuses before anything else', async (t) => {
        const setup = await makeSetup(t);
        const unsafe = path.join(setup.testEnv.root, 'unsafe');
        fs.mkdirSync(unsafe);
        fs.chmodSync(unsafe, 0o755);
        setup.deps.env = { ...setup.deps.env, PRWC_STATE_DIR: unsafe };
        assert.equal(await startWatch(setup, true), 1);
        assert.ok(printed(setup).includes('unsafe state directory'));
        assert.equal(fs.existsSync(path.join(unsafe, 'watchers', PR_KEY, 'lock')), false);
        assert.equal(setup.fake.calls('gh').length, 0);
    });

    await test('an unsafe state directory with a launch token is never waited on or written', async (t) => {
        const setup = await makeSetup(t);
        const unsafe = path.join(setup.testEnv.root, 'unsafe');
        fs.mkdirSync(unsafe);
        fs.chmodSync(unsafe, 0o755);
        setup.deps.env = { ...setup.deps.env, PRWC_STATE_DIR: unsafe, PRWC_LAUNCH_TOKEN: TOKEN };
        assert.equal(await within(startWatch(setup, true), 2000), 1);
        assert.ok(printed(setup).includes('unsafe state directory'));
        assert.equal(fs.existsSync(path.join(unsafe, 'watchers')), false);
    });

    await test('another state format is refused without touching the launch channel', async (t) => {
        const setup = await makeSetup(t);
        const other = path.join(setup.testEnv.root, 'other-state');
        fs.mkdirSync(other, { mode: 0o700 });
        fs.writeFileSync(path.join(other, 'format'), '2\n');
        setup.deps.env = { ...setup.deps.env, PRWC_STATE_DIR: other, PRWC_LAUNCH_TOKEN: TOKEN };
        assert.equal(await within(startWatch(setup, true), 2000), 1);
        assert.ok(printed(setup).includes('unsupported state format 2'));
        assert.equal(fs.existsSync(path.join(other, 'watchers', PR_KEY, 'launch')), false);
    });
});

// Lets every release rename of a worktree lock fail like a full disk, so the lock stays held for its run.
function failWorktreeReleases(t: TestContext) {
    const original = fs.renameSync;
    const marker = `${path.sep}worktrees${path.sep}`;
    return t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
        if (String(to).includes(marker) && String(to).includes('.released.')) {
            throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
        }
        original(from, to);
    });
}

function cleanClone(setup: Setup): void {
    gitSync(setup.testEnv.env, ['-C', setup.clone, 'checkout', '--quiet', '--', 'README.md']);
}

function launchDirOf(setup: Setup): string {
    return path.join(watcherDir(setup.stateDir, PR_KEY), 'launch');
}

await describe('abort priority', async () => {
    await test('an abort wins over an authentication failure', async (t) => {
        const setup = await makeSetup(t);
        setup.fake.respond('gh', 'PrwcPoll', AUTH_FAIL);
        const controller = new AbortController();
        const rt = createRuntime('', '@1');
        const outcome = await watchTick(setup.deps, setup.session, rt, controller.signal, {
            beforePoll: () => {
                controller.abort();
            },
        });
        assert.equal(outcome, 'stopped');
        assert.equal(readStatus(setup.stateDir, PR_KEY), undefined);
        assert.equal(rt.failures, 0);
    });

    await test('an abort during preflight acquires, writes and polls nothing', async (t) => {
        const controller = new AbortController();
        const setup = await makeSetup(t, {
            env: { PRWC_LAUNCH_TOKEN: TOKEN },
            prime: (fake) => {
                fake.respond('tmux', 'display-message', () => {
                    controller.abort();
                    return { stdout: '$1 @1\n' };
                });
            },
        });
        markLaunchReady(setup.stateDir, PR_KEY, TOKEN);
        respondPoll(setup, []);
        assert.equal(await startWatch(setup, true, controller.signal), 0);
        assert.equal(fs.existsSync(prLockDir(setup)), false);
        assert.equal(readStatus(setup.stateDir, PR_KEY), undefined);
        assert.equal(setup.fake.callCount('gh', 'PrwcPoll'), 0);
        assert.equal(launchResultOf(setup), 'fatal');
        assert.ok(launchMessageOf(setup).includes('stopped before its first poll'));
    });

    await test('an abort while the own start time is read acquires nothing', async (t) => {
        const controller = new AbortController();
        const setup = await makeSetup(t, {
            psPassthrough: false,
            prime: (fake) => {
                fake.respond('other', 'other', () => {
                    controller.abort();
                    return { stdout: 'Thu Oct  1 12:00:00 2026\n' };
                });
            },
        });
        respondPoll(setup, []);
        assert.equal(await startWatch(setup, true, controller.signal), 0);
        assert.equal(fs.existsSync(prLockDir(setup)), false);
        assert.equal(readStatus(setup.stateDir, PR_KEY), undefined);
        assert.equal(setup.fake.callCount('gh', 'PrwcPoll'), 0);
    });

    await test('an aborted tick never retries a worktree lock release', async (t) => {
        const setup = await makeSetup(t);
        const pending = '20261002120000-999';
        const wtKey = setup.session.worktreeKey;
        assert.ok(acquireWorktreeLock(setup.stateDir, wtKey, pending, process.pid, setup.deps.log, setup.now));
        const rt = createRuntime('', '@1');
        rt.pendingLockRunId = pending;
        const controller = new AbortController();
        controller.abort();
        assert.equal(await watchTick(setup.deps, setup.session, rt, controller.signal), 'stopped');
        assert.equal(worktreeLockHolder(setup.stateDir, wtKey), pending);
        assert.equal(rt.pendingLockRunId, pending);
        assert.equal(setup.fake.callCount('gh', 'PrwcPoll'), 0);
    });

    await test('an abort during the edited-comment reactions ends the tick before any dispatch', async (t) => {
        const controller = new AbortController();
        const setup = await makeSetup(t, {
            prime: (fake) => {
                fake.respond('gh', 'PrwcRemoveReaction', () => {
                    controller.abort();
                    return { json: REMOVED };
                });
            },
        });
        const comments = [rocketed(setup.now, 102, 300, { editedAt: setup.now - 250 }), rocketed(setup.now, 103, 200)];
        respondPoll(setup, comments);
        respondLookup(setup, comments);
        const outcome = await watchTick(setup.deps, setup.session, createRuntime('', '@1'), controller.signal);
        assert.equal(outcome, 'stopped');
        assert.equal(rocketRemovals(setup.fake).length, 1);
        assert.equal(splits(setup.fake), 0);
        assert.equal(setup.fake.callCount('gh', 'PrwcContext'), 0);
    });

    await test('an abort during a dispatch writes no status', async (t) => {
        const controller = new AbortController();
        const holder: { panePid: number } = { panePid: 0 };
        const setup = await makeSetup(t, {
            prime: (fake) => {
                fake.respond('tmux', 'split-window', () => {
                    controller.abort();
                    return { stdout: `%5 ${holder.panePid}\n` };
                });
            },
        });
        holder.panePid = setup.panePid;
        const comments = [rocketed(setup.now, 103, 100)];
        respondPoll(setup, comments);
        respondLookup(setup, comments);
        const rt = createRuntime('', '@1');
        assert.equal(await watchTick(setup.deps, setup.session, rt, controller.signal), 'stopped');
        assert.equal(splits(setup.fake), 1);
        assert.ok(rt.inflightRunId?.endsWith('-103'));
        assert.equal(readStatus(setup.stateDir, PR_KEY), undefined);
    });

    await test('an abort during a resume writes no status', async (t) => {
        const controller = new AbortController();
        const setup = await makeSetup(t, {
            prime: (fake) => {
                fake.respond('gh', 'PrwcRemoveReaction', GH_FAIL);
                fake.respond('gh', 'PrwcAddReaction', () => {
                    controller.abort();
                    return { json: ADDED };
                });
            },
        });
        const approved = rocketed(setup.now, 103, 100);
        respondPoll(setup, [{ dbId: 101 }, { dbId: 102 }, approved]);
        respondPoll(setup, [{ dbId: 101 }, { dbId: 102 }, { dbId: 103 }]);
        respondLookup(setup, [approved]);
        const rt = createRuntime('', '@1');
        assert.equal(await watchTick(setup.deps, setup.session, rt, controller.signal), 'ok');
        assert.equal(statusOf(setup).reason, 'preparing');
        assert.equal(await watchTick(setup.deps, setup.session, rt, controller.signal), 'stopped');
        assert.equal(statusOf(setup).reason, 'preparing');
    });
});

await describe('launch publication', async () => {
    await test('a launch result that cannot be written never keeps the PR lock', async (t) => {
        const holder: { setup?: Setup } = {};
        const setup = await makeSetup(t, {
            env: { PRWC_LAUNCH_TOKEN: TOKEN },
            prime: (fake) => {
                fake.respond('gh', 'PrwcPoll', () => {
                    if (holder.setup !== undefined) {
                        const launchDir = launchDirOf(holder.setup);
                        fs.rmSync(launchDir, { recursive: true, force: true });
                        fs.writeFileSync(launchDir, 'not a directory');
                    }
                    return GH_FAIL;
                });
            },
        });
        holder.setup = setup;
        markLaunchReady(setup.stateDir, PR_KEY, TOKEN);
        assert.equal(await startWatch(setup, true), 1);
        assert.equal(fs.existsSync(prLockDir(setup)), false);
        assert.ok(setup.deps.logLines.some((line) => line.includes('could not write the launch result')));
    });

    await test('an unconfirmed first-poll write is retried on the next tick', async (t) => {
        const setup = await makeSetup(t);
        respondPoll(setup, []);
        const blocker = path.join(launchDirOf(setup), `${TOKEN}.json`);
        fs.mkdirSync(blocker, { recursive: true });
        const rt = createRuntime(TOKEN, '@1');
        assert.equal(await watchTick(setup.deps, setup.session, rt, NEVER), 'ok');
        assert.equal(rt.published, false);
        fs.rmSync(blocker, { recursive: true });
        assert.equal(await watchTick(setup.deps, setup.session, rt, NEVER), 'ok');
        assert.equal(rt.published, true);
        assert.equal(launchResultOf(setup), 'firstPoll');
    });

    await test('a fatal result whose write failed is retried with its own message', async (t) => {
        const setup = await makeSetup(t, { env: { PRWC_LAUNCH_TOKEN: TOKEN } });
        markLaunchReady(setup.stateDir, PR_KEY, TOKEN);
        setup.fake.respond('gh', 'PrwcPoll', () => {
            throw new Error('poll exploded');
        });
        const original = fs.linkSync;
        let failures = 1;
        t.mock.method(fs, 'linkSync', (existing: fs.PathLike, target: fs.PathLike) => {
            if (failures > 0 && String(target).includes(`${path.sep}launch${path.sep}`)) {
                failures -= 1;
                throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
            }
            original(existing, target);
        });
        await assert.rejects(startWatch(setup, true), /poll exploded/u);
        assert.equal(failures, 0);
        assert.equal(launchResultOf(setup), 'fatal');
        assert.equal(launchMessageOf(setup), 'unexpected error: poll exploded');
        assert.equal(fs.existsSync(prLockDir(setup)), false);
    });

    await test('an exception before the PR lock is published as fatal', async (t) => {
        const setup = await makeSetup(t, {
            env: { PRWC_LAUNCH_TOKEN: TOKEN },
            psPassthrough: false,
            prime: (fake) => {
                fake.respond('other', 'other', () => {
                    throw new Error('ps exploded');
                });
            },
        });
        markLaunchReady(setup.stateDir, PR_KEY, TOKEN);
        await assert.rejects(startWatch(setup, true), /ps exploded/u);
        assert.equal(launchResultOf(setup), 'fatal');
        assert.ok(launchMessageOf(setup).includes('unexpected error: ps exploded'));
        assert.equal(fs.existsSync(prLockDir(setup)), false);
    });

    await test('a PR lock with an unreadable owner is reported as such', async (t) => {
        const setup = await makeSetup(t);
        fs.mkdirSync(prLockDir(setup), { recursive: true });
        fs.writeFileSync(path.join(prLockDir(setup), 'owner.json'), '{}');
        respondPoll(setup, []);
        assert.equal(await startWatch(setup, true), 1);
        assert.ok(printed(setup).includes('the PR lock is held by an unreadable owner'));
        assert.equal(setup.fake.callCount('gh', 'PrwcPoll'), 0);
    });

    await test('an unsafe state path is printed with its control characters escaped', async (t) => {
        const setup = await makeSetup(t);
        setup.deps.env = { ...setup.deps.env, PRWC_STATE_DIR: path.join(setup.testEnv.root, 'bad\u001B[31m\nname') };
        assert.equal(await startWatch(setup, true), 1);
        const out = setup.deps.outText();
        assert.ok(out.includes('unsafe state directory'), out);
        assert.ok(!out.includes('\u001B'), out);
        assert.equal(out.indexOf('\n'), out.length - 1);
        assert.ok(out.includes(String.raw`\u001B`), out);
    });

    await test('a start resets the last error, reason and hint of an earlier status', async (t) => {
        const setup = await makeSetup(t);
        const old = { state: 'holding', lastError: 'old', reason: 'old', hint: 'old' } as const;
        writeStatus(setup.stateDir, PR_KEY, old, setup.now);
        respondPoll(setup, []);
        assert.equal(await startWatch(setup, true), 0);
        const status = statusOf(setup);
        assert.equal(status.state, 'polling');
        assert.equal(status.lastError, '');
        assert.equal(status.reason, '');
        assert.equal(status.hint, '');
        assert.equal(status.pid, process.pid);
    });
});

await describe('host sleep', async () => {
    await test('wall time that passed without monotonic time is not counted as a failure', async (t) => {
        const setup = await makeSetup(t);
        setup.fake.respond('gh', 'PrwcPoll', GH_FAIL);
        const rt = createRuntime('', '@1');
        rt.monotonicMs = () => 5_000_000;
        rt.lastTickAt = setup.now - 1000;
        rt.lastTickMono = 5_000_000 - 1000;
        assert.equal(await watchTick(setup.deps, setup.session, rt, NEVER), 'transient');
        assert.equal(rt.failures, 0);
    });

    await test('a long wait seen by both clocks still counts the failure', async (t) => {
        const setup = await makeSetup(t);
        setup.fake.respond('gh', 'PrwcPoll', GH_FAIL);
        const rt = createRuntime('', '@1');
        rt.monotonicMs = () => 5_000_000;
        rt.lastTickAt = setup.now - 1000;
        rt.lastTickMono = 5_000_000 - 1_000_000;
        assert.equal(await watchTick(setup.deps, setup.session, rt, NEVER), 'transient');
        assert.equal(rt.failures, 1);
    });

    await test('pacing records both clocks', async (t) => {
        const setup = await makeSetup(t);
        const rt = createRuntime('', '@1');
        rt.monotonicMs = () => 42_000;
        applyPacing(setup.deps, setup.session, rt);
        assert.equal(rt.lastTickAt, setup.now);
        assert.equal(rt.lastTickMono, 42_000);
    });
});

await describe('runs in flight across ticks', async () => {
    await test('an all-gone lookup keeps the poll rate', async (t) => {
        const setup = await makeSetup(t);
        respondPoll(setup, [rocketed(setup.now, 103, 100)], { remaining: 100, resetAt: setup.now + 900 });
        setup.fake.respond('gh', 'PrwcLookup', {
            code: 1,
            stderr: "gh: Could not resolve to a node with the global id of 'PRRC_c103'",
        });
        const rt = createRuntime('', '@1');
        assert.equal(await watchTick(setup.deps, setup.session, rt, NEVER), 'ok');
        assert.equal(rt.rate.remaining, 100);
        assert.equal(applyPacing(setup.deps, setup.session, rt), 900);
    });

    await test('an unreadable in-flight record needs attention and keeps the slot', async (t) => {
        const setup = await makeSetup(t);
        const claudePid = setup.testEnv.spawnOrphan('sleep', ['300']);
        const runId = await seedRun(setup, { dbId: 101, claudePid });
        fs.writeFileSync(path.join(runDir(setup.stateDir, runId), 'record.json'), '{broken');
        setup.fake.respond('tmux', 'list-panes', { stdout: `%5 ${runId}\n` });
        const comments = [rocketed(setup.now, 102, 100)];
        respondPoll(setup, comments);
        respondLookup(setup, comments);
        const rt = createRuntime('', '@1');
        rt.inflightRunId = runId;
        assert.equal(await watchTick(setup.deps, setup.session, rt, NEVER), 'ok');
        const status = statusOf(setup);
        assert.equal(status.state, 'needs_attention');
        assert.equal(status.reason, 'record-unreadable');
        assert.equal(rt.inflightRunId, runId);
        assert.equal(splits(setup.fake), 0);
    });

    await test('a missing run directory needs attention and keeps the slot', async (t) => {
        const setup = await makeSetup(t);
        const comments = [rocketed(setup.now, 102, 100)];
        respondPoll(setup, comments);
        respondLookup(setup, comments);
        const rt = createRuntime('', '@1');
        rt.inflightRunId = '20261002120000-777';
        assert.equal(await watchTick(setup.deps, setup.session, rt, NEVER), 'ok');
        const status = statusOf(setup);
        assert.equal(status.state, 'needs_attention');
        assert.equal(status.reason, 'run-missing');
        assert.equal(rt.inflightRunId, '20261002120000-777');
        assert.equal(splits(setup.fake), 0);
    });

    await test('a claude that never submitted its prompt shows the did-not-start hint in the status', async (t) => {
        const setup = await makeSetup(t);
        const claudePid = setup.testEnv.spawnOrphan('sleep', ['300']);
        const runId = await seedRun(setup, { dbId: 101, claudePid, events: [], patch: { startedAt: setup.now - 200 } });
        const comments = [rocketed(setup.now, 101, 300), rocketed(setup.now, 102, 100)];
        respondPoll(setup, comments);
        respondLookup(setup, comments);
        const rt = createRuntime('', '@1');
        rt.inflightRunId = runId;
        assert.equal(await watchTick(setup.deps, setup.session, rt, NEVER), 'ok');
        const status = statusOf(setup);
        assert.equal(status.state, 'needs_attention');
        assert.equal(status.reason, 'claude-did-not-start');
        assert.equal(status.hint, attentionHint('claude-did-not-start'));
        assert.ok(status.hint.length > 0);
        assert.equal(rt.inflightRunId, runId);
    });

    await test('a claude pid that belongs to another process needs attention and keeps the slot', async (t) => {
        const setup = await makeSetup(t);
        const claudePid = setup.testEnv.spawnOrphan('sleep', ['300']);
        const runId = await seedRun(setup, { dbId: 101, claudePid, exitStatus: true });
        const dir = runDir(setup.stateDir, runId);
        fs.writeFileSync(path.join(dir, 'claude.start'), 'Mon Jan  1 00:00:00 2001\n');
        fs.writeFileSync(path.join(dir, 'record.json'), '{broken');
        setup.fake.respond('tmux', 'list-panes', { stdout: '' });
        const comments = [rocketed(setup.now, 102, 100)];
        respondPoll(setup, comments);
        respondLookup(setup, comments);
        const rt = createRuntime('', '@1');
        rt.inflightRunId = runId;
        assert.equal(await watchTick(setup.deps, setup.session, rt, NEVER), 'ok');
        const status = statusOf(setup);
        assert.equal(status.state, 'needs_attention');
        assert.equal(status.reason, 'claude-pid-mismatch');
        assert.equal(rt.inflightRunId, runId);
        assert.ok(fs.existsSync(worktreeLockDir(setup)));
        assert.equal(splits(setup.fake), 0);
    });

    await test('an abandoned run with a live worker keeps the slot with its reason', async (t) => {
        const setup = await makeSetup(t);
        const runId = await seedRun(setup, { dbId: 101, patch: { state: 'abandoned' }, decision: 'none' });
        respondPoll(setup, [{ dbId: 101 }, rocketed(setup.now, 102, 100)]);
        respondLookup(setup, [{ dbId: 101 }, rocketed(setup.now, 102, 100)]);
        const rt = createRuntime('', '@1');
        rt.inflightRunId = runId;
        assert.equal(await watchTick(setup.deps, setup.session, rt, NEVER), 'ok');
        const status = statusOf(setup);
        assert.equal(status.state, 'running');
        assert.equal(status.reason, 'abandoned-worker-alive');
        assert.equal(rt.inflightRunId, runId);
        assert.equal(splits(setup.fake), 0);
    });

    await test('a cleared abandoned run keeps its reason in the status', async (t) => {
        const setup = await makeSetup(t);
        const panePid = await deadPid(setup);
        const runId = await seedRun(setup, { dbId: 101, patch: { state: 'abandoned', panePid }, decision: 'none' });
        respondPoll(setup, [{ dbId: 101 }]);
        respondLookup(setup, [{ dbId: 101 }]);
        const rt = createRuntime('', '@1');
        rt.inflightRunId = runId;
        assert.equal(await watchTick(setup.deps, setup.session, rt, NEVER), 'ok');
        assert.equal(rt.inflightRunId, undefined);
        assert.deepEqual(listRunIds(setup.stateDir), []);
        const status = statusOf(setup);
        assert.equal(status.state, 'polling');
        assert.equal(status.reason, 'abandoned');
    });

    await test('a cleared run with an unreadable record keeps its reason in the status', async (t) => {
        const setup = await makeSetup(t);
        const runId = await seedRun(setup, { dbId: 101, exitStatus: true });
        fs.writeFileSync(path.join(runDir(setup.stateDir, runId), 'record.json'), '{broken');
        setup.fake.respond('tmux', 'list-panes', { stdout: '' });
        respondPoll(setup, [{ dbId: 101 }]);
        const rt = createRuntime('', '@1');
        rt.inflightRunId = runId;
        assert.equal(await watchTick(setup.deps, setup.session, rt, NEVER), 'ok');
        assert.equal(rt.inflightRunId, undefined);
        assert.deepEqual(listRunIds(setup.stateDir), []);
        const status = statusOf(setup);
        assert.equal(status.state, 'polling');
        assert.equal(status.reason, 'record-unreadable');
    });

    await test('a promoted resume is evaluated and never resumed again', async (t) => {
        const setup = await makeSetup(t);
        const runId = await seedRun(setup, {
            dbId: 103,
            patch: { state: 'preparing', paneId: '%5' },
            decision: 'none',
        });
        respondPoll(setup, [{ dbId: 101 }, { dbId: 102 }, { dbId: 103 }]);
        respondLookup(setup, [{ dbId: 103 }]);
        const rt = createRuntime('', '@1');
        rt.inflightRunId = runId;
        assert.equal(await watchTick(setup.deps, setup.session, rt, NEVER), 'ok');
        assert.equal(rt.inflightRunId, runId);
        assert.equal(stateOf(setup, runId), 'running');
        assert.equal(statusOf(setup).state, 'running');
        assert.equal(await watchTick(setup.deps, setup.session, rt, NEVER), 'ok');
        assert.equal(rt.inflightRunId, runId);
        const refusals = setup.deps.logLines.filter((line) => line.includes('is not resumable'));
        assert.equal(refusals.length, 1);
        assert.equal(statusOf(setup).reason, 'working');
        assert.equal(splits(setup.fake), 0);
        assert.deepEqual(mutations(setup.fake), []);
    });

    await test('a preparing run that cannot be resumed is kept until evaluation clears it', async (t) => {
        const setup = await makeSetup(t);
        const runId = await seedRun(setup, {
            dbId: 103,
            patch: { state: 'preparing', paneId: '', panePid: undefined },
            decision: 'none',
        });
        assert.ok(claimLaunch(setup.stateDir, runId, 'cancel'));
        respondPoll(setup, [{ dbId: 101 }, { dbId: 102 }, { dbId: 103 }]);
        respondLookup(setup, [{ dbId: 103 }]);
        const rt = createRuntime('', '@1');
        rt.inflightRunId = runId;
        assert.equal(await watchTick(setup.deps, setup.session, rt, NEVER), 'ok');
        assert.equal(rt.inflightRunId, runId);
        assert.equal(stateOf(setup, runId), 'abandoned');
        assert.equal(await watchTick(setup.deps, setup.session, rt, NEVER), 'ok');
        assert.equal(rt.inflightRunId, undefined);
        assert.deepEqual(listRunIds(setup.stateDir), []);
        assert.equal(statusOf(setup).reason, 'abandoned');
        assert.equal(splits(setup.fake), 0);
    });

    await test('a worktree lock a held dispatch could not release is retried until it is gone', async (t) => {
        const setup = await makeSetup(t);
        fs.appendFileSync(path.join(setup.clone, 'README.md'), 'dirty\n');
        const comments = [rocketed(setup.now, 103, 100)];
        respondPoll(setup, comments);
        respondLookup(setup, comments);
        const failing = failWorktreeReleases(t);
        const rt = createRuntime('', '@1');
        assert.equal(await watchTick(setup.deps, setup.session, rt, NEVER), 'ok');
        const pending = rt.pendingLockRunId;
        assert.ok(pending?.endsWith('-103'), `pending ${pending}`);
        assert.equal(worktreeLockHolder(setup.stateDir, setup.session.worktreeKey), pending);
        assert.equal(statusOf(setup).reason, 'uncommitted changes to tracked files');
        assert.equal(await watchTick(setup.deps, setup.session, rt, NEVER), 'ok');
        assert.equal(rt.pendingLockRunId, pending);
        const busy = statusOf(setup);
        assert.equal(busy.state, 'holding');
        assert.equal(busy.reason, 'worktree lock release pending');
        failing.mock.restore();
        cleanClone(setup);
        assert.equal(await watchTick(setup.deps, setup.session, rt, NEVER), 'ok');
        assert.equal(rt.pendingLockRunId, undefined);
        assert.equal(splits(setup.fake), 1);
        assert.equal(statusOf(setup).state, 'running');
    });

    await test('a kept context-failed run stays in flight until its lock is released', async (t) => {
        const setup = await makeSetup(t, {
            prime: (fake) => {
                fake.respond('gh', 'PrwcContext', GH_FAIL);
            },
        });
        const approved = rocketed(setup.now, 103, 100);
        respondPoll(setup, [{ dbId: 101 }, { dbId: 102 }, approved]);
        respondLookup(setup, [approved]);
        const failing = failWorktreeReleases(t);
        const rt = createRuntime('', '@1');
        assert.equal(await watchTick(setup.deps, setup.session, rt, NEVER), 'ok');
        const kept = rt.inflightRunId;
        assert.ok(kept?.endsWith('-103'), `kept ${kept}`);
        assert.equal(stateOf(setup, kept), 'abandoned');
        assert.equal(statusOf(setup).reason, 'context fetch failed');
        assert.equal(await watchTick(setup.deps, setup.session, rt, NEVER), 'ok');
        assert.equal(rt.inflightRunId, kept);
        const deferred = statusOf(setup);
        assert.equal(deferred.state, 'running');
        assert.equal(deferred.reason, 'lock-release-failed');
        assert.equal(splits(setup.fake), 0);
        failing.mock.restore();
        assert.equal(await watchTick(setup.deps, setup.session, rt, NEVER), 'ok');
        assert.ok(rt.inflightRunId !== undefined, 'the comment is dispatched again');
        assert.equal(splits(setup.fake), 1);
        assert.equal(stateOf(setup, rt.inflightRunId), 'running');
    });

    await test('a kept abandoned dispatch stays in flight until its lock is released', async (t) => {
        const setup = await makeSetup(t, {
            prime: (fake) => {
                fake.respond('tmux', 'split-window', { code: 1, stderr: 'server exploded' });
            },
        });
        const comments = [rocketed(setup.now, 103, 100)];
        respondPoll(setup, comments);
        respondPoll(setup, [{ dbId: 103 }]);
        respondLookup(setup, comments);
        const failing = failWorktreeReleases(t);
        const rt = createRuntime('', '@1');
        assert.equal(await watchTick(setup.deps, setup.session, rt, NEVER), 'ok');
        const kept = rt.inflightRunId;
        assert.ok(kept?.endsWith('-103'), `kept ${kept}`);
        assert.equal(stateOf(setup, kept), 'abandoned');
        assert.equal(statusOf(setup).state, 'polling');
        assert.equal(await watchTick(setup.deps, setup.session, rt, NEVER), 'ok');
        assert.equal(rt.inflightRunId, kept);
        assert.equal(statusOf(setup).reason, 'lock-release-failed');
        failing.mock.restore();
        assert.equal(await watchTick(setup.deps, setup.session, rt, NEVER), 'ok');
        assert.equal(rt.inflightRunId, undefined);
        assert.deepEqual(listRunIds(setup.stateDir), []);
        assert.equal(statusOf(setup).reason, 'abandoned');
    });
});

await describe('batches and run checks', async () => {
    await test('one run takes the oldest approved comments up to batchMax', async (t) => {
        const setup = await makeSetup(t);
        const session = { ...setup.session, batchMax: 2 };
        const comments = [rocketed(setup.now, 101, 100), rocketed(setup.now, 102, 300), rocketed(setup.now, 103, 200)];
        respondPoll(setup, comments);
        respondLookup(setup, comments);
        const rt = createRuntime('', '@1');
        assert.equal(await watchTick(setup.deps, session, rt, NEVER), 'ok');
        assert.equal(splits(setup.fake), 1);
        assert.ok(rt.inflightRunId?.endsWith('-102'), `dispatched ${rt.inflightRunId}`);
        const read = readRecord(setup.stateDir, rt.inflightRunId ?? '');
        assert.ok(read.kind === 'ok');
        assert.deepEqual(
            read.record.comments.map((comment) => comment.dbId),
            [102, 103]
        );
        assert.equal(rocketRemovals(setup.fake, 101).length, 0);
        assert.equal(rocketRemovals(setup.fake, 102).length, 1);
        assert.equal(rocketRemovals(setup.fake, 103).length, 1);
        assert.equal(statusOf(setup).comments, '102,103');
    });

    await test('a run in flight is checked without a poll until the interval has passed', async (t) => {
        const setup = await makeSetup(t);
        const claudePid = setup.testEnv.spawnOrphan('sleep', ['300']);
        const runId = await seedRun(setup, { dbId: 101, claudePid, events: ['prompt', 'tool'] });
        respondLookup(setup, [{ dbId: 101 }]);
        const rt = createRuntime('', '@1');
        rt.inflightRunId = runId;
        rt.lastPollAt = setup.deps.nowSeconds();
        assert.equal(await watchTick(setup.deps, setup.session, rt, NEVER), 'ok');
        assert.equal(setup.fake.callCount('gh', 'PrwcPoll'), 0);
        assert.equal(setup.fake.callCount('gh', 'PrwcLookup'), 1);
        assert.equal(rt.inflightRunId, runId);
        assert.equal(statusOf(setup).reason, 'working');
    });

    await test('a run that ends starts the next batch in the same tick and its comment gets a -1', async (t) => {
        const setup = await makeSetup(t);
        const runId = await seedRun(setup, { dbId: 101, events: ['prompt'], exitStatus: true });
        const comments = [rocketed(setup.now, 102, 300), rocketed(setup.now, 103, 200)];
        respondLookup(setup, [{ dbId: 101 }]);
        respondLookup(setup, comments);
        respondPoll(setup, [{ dbId: 101 }, ...comments]);
        const rt = createRuntime('', '@1');
        rt.inflightRunId = runId;
        rt.lastPollAt = setup.deps.nowSeconds();
        assert.equal(await watchTick(setup.deps, setup.session, rt, NEVER), 'ok');
        const thumbsDown = setup.fake
            .calls('gh')
            .filter((call) => call.key === 'PrwcAddReaction' && variable(call, 'content') === 'THUMBS_DOWN');
        assert.deepEqual(
            thumbsDown.map((call) => variable(call, 'id')),
            [nodeIdOf(101)]
        );
        assert.equal(setup.fake.callCount('gh', 'PrwcPoll'), 1);
        assert.equal(splits(setup.fake), 1);
        assert.ok(rt.inflightRunId?.endsWith('-102'), `dispatched ${rt.inflightRunId}`);
        assert.equal(stateOf(setup, rt.inflightRunId), 'running');
    });

    await test('the next tick comes after the run check while a run is in flight', async (t) => {
        const setup = await makeSetup(t);
        const session = { ...setup.session, interval: 300 };
        const rt = createRuntime('', '@1');
        assert.equal(applyPacing(setup.deps, session, rt), 300);
        rt.inflightRunId = '20261002120000-101';
        assert.equal(applyPacing(setup.deps, session, rt), 15);
        const custom = await makeSetup(t, { env: { PRWC_RUN_CHECK: '7' } });
        assert.equal(applyPacing(custom.deps, session, rt), 7);
        assert.equal(applyPacing(custom.deps, { ...session, interval: 5 }, rt), 5);
    });

    await test('a failing poll keeps backing off while the run checks succeed', async (t) => {
        const setup = await makeSetup(t);
        const claudePid = setup.testEnv.spawnOrphan('sleep', ['300']);
        const runId = await seedRun(setup, { dbId: 101, claudePid, events: ['prompt', 'tool'] });
        respondLookup(setup, [{ dbId: 101 }]);
        setup.fake.respond('gh', 'PrwcPoll', { code: 1, stderr: 'HTTP 502: Bad Gateway' });
        const rt = createRuntime('', '@1');
        rt.inflightRunId = runId;
        for (let tick = 1; tick <= 3; tick += 1) {
            assert.equal(await watchTick(setup.deps, setup.session, rt, NEVER), 'transient');
            assert.equal(rt.failures, tick);
        }
        rt.lastPollAt = setup.deps.nowSeconds();
        assert.equal(await watchTick(setup.deps, setup.session, rt, NEVER), 'ok');
        assert.equal(rt.failures, 0);
    });
});
