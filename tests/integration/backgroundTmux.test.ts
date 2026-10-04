import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { GH_STRIP_VARS, PS_PATH } from '../../src/constants.ts';
import { acquireWorktreeLock, readPrLockOwner } from '../../src/locks.ts';
import { createProcessRunner, pidAlive, processStart } from '../../src/proc.ts';
import { claimLaunch, createRun, readRecord, writeRecord } from '../../src/runStore.ts';
import { initState, runDir, watcherDir, worktreeDir, worktreeKey } from '../../src/stateStore.ts';
import { paneState, tmuxOn } from '../../src/tmuxControl.ts';
import type { Env, PrLockOwner, RunRecord } from '../../src/types.ts';
import type { FakeResponse } from '../support/fakeRunner.ts';
import { makePrClone } from '../support/gitRepo.ts';
import { stubCalls, stubRespond } from '../support/stubQueue.ts';
import { createTestEnv, waitUntil, type ObservedResult, type TestEnv } from '../support/testEnv.ts';
import { startTmuxServer, type TmuxServer } from '../support/tmuxServer.ts';

interface Fixture {
    testEnv: TestEnv;
    server: TmuxServer;
    tmuxPath: string;
    stateDir: string;
    clone: string;
}

interface WatcherWindow {
    windowId: string;
    paneDead: string;
}

interface Worker {
    paneId: string;
    panePid: number;
    claudePid: number;
    wtKey: string;
}

interface Identity {
    pid: number;
    start: string | undefined;
}

const ROOT = fs.realpathSync.native(path.resolve(import.meta.dirname, '..', '..'));
const LAUNCHER = path.join(ROOT, 'bin', 'alex-pr-watch-comments');
const FIXTURES = path.join(ROOT, 'tests', 'fixtures');
const TIMEOUT = 'timeout';
const PR_URL = 'https://github.com/o/r/pull/12';
const PR_KEY = 'o+r+12';
const BRANCH = 'feature';
const RUN_ID = '20261002120000-101';
const EXIT_MS = 60_000;
const PS_ENV = { LC_ALL: 'C', TZ: 'UTC', PATH: '/usr/bin:/bin' };
// The starttime field of /proc/PID/stat, counted after the closing parenthesis of the command name.
const PROC_STAT_START_INDEX = 19;
const AUTH_FAIL: FakeResponse = { code: 1, stderr: 'HTTP 401: Bad credentials (https://api.github.com/graphql)' };
const STOP_HOOK_SETTINGS = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'true' }] }] } };

function readFixture(...parts: readonly string[]): unknown {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(FIXTURES, ...parts), 'utf8'));
    return parsed;
}

const PR_INFO = readFixture('preflight', 'prInfoOpen.json');
const POLL_OPEN = readFixture('watcher', 'pollOpen.json');

function iso(epoch: number): string {
    return new Date(epoch * 1000).toISOString();
}

// One review thread whose comment 101 carries the viewer rocket.
function rocketPoll(now: number): unknown {
    const comment = {
        id: 'PRRC_c101',
        databaseId: 101,
        reactionGroups: [{ content: 'ROCKET', viewerHasReacted: true }],
    };
    const thread = { id: 'PRRT_t1', comments: { pageInfo: { hasNextPage: false, endCursor: 'C1' }, nodes: [comment] } };
    return {
        data: {
            viewer: { login: 'reviewer' },
            rateLimit: { remaining: 4000, resetAt: iso(now + 3600) },
            repository: {
                pullRequest: {
                    state: 'OPEN',
                    headRefName: BRANCH,
                    reviewThreads: { pageInfo: { hasNextPage: false, endCursor: 'T1' }, nodes: [thread] },
                },
            },
        },
    };
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

// Tolerates a process that is already gone (ESRCH).
function signalQuietly(pid: number, signal: NodeJS.Signals): void {
    try {
        process.kill(pid, signal);
    } catch {
        return;
    }
}

function psField(pid: number, field: string): string {
    const ps = spawnSync(PS_PATH, ['-ww', '-o', `${field}=`, '-p', String(pid)], { env: PS_ENV, encoding: 'utf8' });
    return ps.status === 0 ? ps.stdout.trim() : '';
}

// A start token that stays equal for the whole life of a process: the boot-relative start tick on Linux (ps lstart
// moves there whenever the wall clock steps), ps lstart elsewhere.
function startToken(pid: number): string | undefined {
    if (process.platform !== 'linux') {
        const start = psField(pid, 'lstart');
        return start.length > 0 ? start : undefined;
    }
    try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        return stat.slice(stat.lastIndexOf(')') + 2).split(' ', PROC_STAT_START_INDEX + 1)[PROC_STAT_START_INDEX];
    } catch {
        return;
    }
}

// Signals only a process that still has the start token recorded earlier, so a reused pid is never hit.
function killIfSame(identity: Identity): void {
    if (identity.start !== undefined && pidAlive(identity.pid) && startToken(identity.pid) === identity.start) {
        signalQuietly(identity.pid, 'SIGKILL');
    }
}

// A zombie has exited; tmux can leave a pane process unreaped for a long time after it missed its SIGCHLD.
function processGone(pid: number): boolean {
    return !pidAlive(pid) || psField(pid, 'stat').startsWith('Z');
}

function processArgs(pid: number): string[] {
    if (process.platform === 'linux') {
        return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').slice(0, -1);
    }
    return psField(pid, 'args').split(' ');
}

// The environment a process started with (Linux), or its ps rendering elsewhere.
function processEnvironment(pid: number): string[] {
    if (process.platform === 'linux') {
        return fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
    }
    const ps = spawnSync(PS_PATH, ['-E', '-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
    return ps.stdout.split(' ');
}

// Removes the temp root itself when the server cannot start, because no after hook owns it yet.
async function startServer(testEnv: TestEnv, serverExtra?: Env): Promise<TmuxServer> {
    try {
        return await startTmuxServer({ ...testEnv.env, ...serverExtra });
    } catch (error) {
        testEnv.cleanup();
        throw error;
    }
}

// The pane processes of the server (the watchers among them) with their start tokens; empty when it does not answer.
async function paneProcesses(server: TmuxServer, tmuxPath: string): Promise<Identity[]> {
    const env = server.envFor();
    const deps = { runner: createProcessRunner(env), env };
    const result = await tmuxOn(deps, tmuxPath, server.socket, ['list-panes', '-a', '-F', '#{pane_pid}']);
    if (result?.code !== 0) {
        return [];
    }
    return result.stdout
        .split('\n')
        .map((line) => Number.parseInt(line, 10))
        .filter((pid) => Number.isInteger(pid))
        .map((pid) => ({ pid, start: startToken(pid) }));
}

function isStubProcess(pid: number): boolean {
    return psField(pid, 'args').includes('fakeTool.ts');
}

// The server goes first and its pane processes (watchers end on SIGHUP and still write state while they exit) are
// awaited; a survivor is killed only while its start token is unchanged. Then stub gh process groups that are still
// stub processes are killed, and the temp root goes. serverExtra adds variables to the server environment only.
async function setUp(t: TestContext, serverExtra?: (_testEnv: TestEnv) => Env): Promise<Fixture> {
    const testEnv = await createTestEnv({ realTmux: true });
    const server = await startServer(testEnv, serverExtra?.(testEnv));
    const tmuxPath = testEnv.tools.tmux ?? 'tmux';
    t.after(async () => {
        try {
            const panes = await paneProcesses(server, tmuxPath);
            await server.kill();
            await waitUntil(10_000, () => panes.every((pane) => processGone(pane.pid)));
            for (const pane of panes) {
                killIfSame(pane);
            }
        } finally {
            for (const call of stubCalls(testEnv.stubDir, 'gh')) {
                if (pidAlive(call.pid) && isStubProcess(call.pid)) {
                    signalQuietly(-call.pid, 'SIGKILL');
                }
            }
            testEnv.cleanup();
        }
    });
    const init = initState(testEnv.stateDir);
    assert.ok(init.ok);
    const clone = makePrClone(path.join(testEnv.root, 'git'), BRANCH, 'o/r', testEnv.env);
    stubRespond(testEnv.stubDir, 'gh', 'auth_status', {});
    stubRespond(testEnv.stubDir, 'gh', 'PrwcPrInfo', { json: PR_INFO });
    return { testEnv, server, tmuxPath, stateDir: init.stateDir, clone };
}

// The caller environment inside the isolated server, built from the test env rather than the server env, so a stale
// value the server holds never reaches the caller.
function callerEnv(fixture: Fixture, extra?: Env): Env {
    return { ...fixture.testEnv.env, TMUX: `${fixture.server.socket},0,0`, TMUX_PANE: fixture.server.pane, ...extra };
}

async function runEntry(fixture: Fixture, args: readonly string[], env: Env): Promise<ObservedResult> {
    const observed = fixture.testEnv.spawnObserved('/bin/sh', [LAUNCHER, ...args], {
        env,
        cwd: fixture.testEnv.root,
    });
    const result = await within(observed.result, EXIT_MS);
    assert.ok(result !== TIMEOUT, `${args.join(' ')} did not exit within ${EXIT_MS} ms`);
    return result;
}

function startArgs(fixture: Fixture, url = PR_URL): string[] {
    return [url, '--background', '--dir', fixture.clone, '--interval', '300'];
}

function both(result: ObservedResult): string {
    return `${result.stdout}${result.stderr}`;
}

function tmuxDeps(fixture: Fixture) {
    const env = fixture.server.envFor();
    return { runner: createProcessRunner(env), env };
}

async function tmuxText(fixture: Fixture, args: readonly string[]): Promise<string> {
    const result = await tmuxOn(tmuxDeps(fixture), fixture.tmuxPath, fixture.server.socket, args);
    assert.ok(result?.code === 0, `tmux ${args.join(' ')} failed`);
    return result.stdout;
}

async function watcherWindows(fixture: Fixture): Promise<WatcherWindow[]> {
    const listing = await tmuxText(fixture, ['list-panes', '-a', '-F', '#{window_id} #{pane_dead} #{@prwc_watcher}']);
    return listing
        .split('\n')
        .map((line) => line.split(' '))
        .filter((fields) => fields[2] === PR_KEY)
        .map(([windowId = '', paneDead = '']) => ({ windowId, paneDead }));
}

async function onlyWatcherWindow(fixture: Fixture): Promise<WatcherWindow> {
    const windows = await watcherWindows(fixture);
    assert.equal(windows.length, 1, JSON.stringify(windows));
    const [window] = windows;
    assert.ok(window !== undefined);
    return window;
}

async function waitDeadPane(fixture: Fixture): Promise<WatcherWindow> {
    let found: WatcherWindow | undefined;
    const dead = await waitUntil(20_000, async () => {
        const windows = await watcherWindows(fixture);
        found = windows.find((window) => window.paneDead === '1');
        return found !== undefined;
    });
    assert.ok(dead && found !== undefined, 'the watcher pane never died');
    return found;
}

async function paneText(fixture: Fixture, windowId: string): Promise<string> {
    return await tmuxText(fixture, ['capture-pane', '-p', '-J', '-S', '-', '-t', windowId]);
}

function pollCalls(fixture: Fixture) {
    return stubCalls(fixture.testEnv.stubDir, 'gh').filter((call) => call.input.includes('PrwcPoll'));
}

function filesUnder(dir: string): string[] {
    return fs.readdirSync(dir, { recursive: true, encoding: 'utf8' }).map((name) => path.join(dir, name));
}

async function liveStart(fixture: Fixture, pid: number): Promise<string> {
    const start = await processStart(createProcessRunner(fixture.testEnv.env), pid);
    assert.ok(start !== undefined, `no start time for pid ${pid}`);
    return start;
}

function lockOwner(fixture: Fixture): PrLockOwner {
    const owner = readPrLockOwner(fixture.stateDir, PR_KEY);
    assert.ok(owner !== undefined, 'no PR lock owner');
    return owner;
}

// A worker pane split from the watcher's pane, as a dispatch makes it, running a long sleep.
async function splitWorkerPane(fixture: Fixture, watcherPane: string): Promise<{ paneId: string; panePid: number }> {
    const created = await tmuxText(fixture, [
        'split-window',
        '-d',
        '-P',
        '-F',
        '#{pane_id} #{pane_pid}',
        '-t',
        watcherPane,
        'sleep',
        '300',
    ]);
    const [paneId = '', pid = ''] = created.trim().split(' ');
    return { paneId, panePid: Number.parseInt(pid, 10) };
}

// A running run for comment 101 in a real worker pane with a live claude, holding the clone's worktree lock.
async function seedRunningRun(fixture: Fixture, watcherPane: string): Promise<Worker> {
    const { testEnv, stateDir, clone } = fixture;
    const now = Math.floor(Date.now() / 1000);
    const { paneId, panePid } = await splitWorkerPane(fixture, watcherPane);
    const claudePid = testEnv.spawnOrphan('sleep', ['300']);
    const wtKey = worktreeKey(clone);
    const record: RunRecord = {
        format: 2,
        runId: RUN_ID,
        prKey: PR_KEY,
        owner: 'o',
        repo: 'r',
        number: 12,
        prUrl: PR_URL,
        comments: [
            {
                nodeId: 'PRRC_c101',
                dbId: 101,
                url: `${PR_URL}#discussion_r101`,
                threadId: 'PRRT_t1',
                topDbId: 101,
                rocketAt: now - 600,
                eyesAdded: true,
            },
        ],
        headSha: 'a'.repeat(40),
        remote: 'origin',
        branch: BRANCH,
        dir: clone,
        worktreeKey: wtKey,
        claude: path.join(testEnv.binDir, 'claude'),
        git: path.join(testEnv.toolsDir, 'git'),
        gh: path.join(testEnv.binDir, 'gh'),
        callerPath: testEnv.env.PATH ?? '',
        claudeArgs: [],
        state: 'running',
        reason: '',
        paneId,
        panePid,
        socket: fixture.server.socket,
        startedAt: now - 60,
        watcherPid: process.pid,
    };
    const dir = createRun(stateDir, RUN_ID);
    writeRecord(stateDir, record);
    assert.ok(claimLaunch(stateDir, RUN_ID, 'go'));
    fs.writeFileSync(path.join(dir, 'claude.start'), `${await liveStart(fixture, claudePid)}\n`);
    fs.writeFileSync(path.join(dir, 'claude.pid'), `${claudePid}\n`);
    const { log } = testEnv.deps(createProcessRunner(testEnv.env));
    assert.ok(acquireWorktreeLock(stateDir, wtKey, RUN_ID, process.pid, log, now));
    return { paneId, panePid, claudePid, wtKey };
}

function lookupJson(): unknown {
    const node = readFixture('watcher', 'lookupNode.json');
    const now = Math.floor(Date.now() / 1000);
    return {
        data: {
            viewer: { login: 'reviewer' },
            rateLimit: { remaining: 4000, resetAt: iso(now + 3600) },
            nodes: [node],
        },
    };
}

await describe('background start on a real isolated tmux server', async () => {
    await test('start, already watched, list and stop with a worker left running', async (t) => {
        const fixture = await setUp(t);
        const { testEnv, stateDir } = fixture;
        stubRespond(testEnv.stubDir, 'gh', 'PrwcPoll', { json: POLL_OPEN });
        stubRespond(testEnv.stubDir, 'gh', 'PrwcLookup', { json: lookupJson() });
        const started = await runEntry(fixture, startArgs(fixture), callerEnv(fixture));
        assert.equal(started.code, 0, both(started));
        assert.ok(started.stdout.includes(`watching ${PR_URL} in window @`), both(started));
        const window = await onlyWatcherWindow(fixture);
        assert.equal(window.paneDead, '0');
        const again = await runEntry(fixture, startArgs(fixture), callerEnv(fixture));
        assert.equal(again.code, 0, both(again));
        assert.ok(again.stdout.includes('already watched'), both(again));
        const listed = await runEntry(fixture, ['--list'], { ...testEnv.env, TMUX: undefined, TMUX_PANE: undefined });
        assert.equal(listed.code, 0, both(listed));
        assert.ok(listed.stdout.includes('state=polling'), both(listed));
        const owner = lockOwner(fixture);
        const worker = await seedRunningRun(fixture, owner.paneId);
        const stopEnv = callerEnv(fixture, { TMUX: '/tmp/prwc-other-socket,1,0' });
        const stopped = await runEntry(fixture, ['--stop', PR_URL], stopEnv);
        assert.equal(stopped.code, 0, both(stopped));
        assert.ok(stopped.stdout.includes(`stopped watcher for ${PR_URL}`), both(stopped));
        assert.ok(stopped.stdout.includes(`left in place: run ${RUN_ID} state=running`), both(stopped));
        assert.ok(await waitUntil(10_000, () => processGone(owner.pid)), 'the watcher survived the stop');
        assert.equal(fs.existsSync(path.join(watcherDir(stateDir, PR_KEY), 'lock')), false);
        const deps = tmuxDeps(fixture);
        const socket = fixture.server.socket;
        assert.equal(await paneState(deps, fixture.tmuxPath, socket, owner.paneId), 'missing');
        assert.equal(await paneState(deps, fixture.tmuxPath, socket, worker.paneId), 'alive');
        assert.ok(pidAlive(worker.panePid), 'the worker pane process was ended');
        assert.ok(pidAlive(worker.claudePid), 'the worker claude was ended');
        assert.ok(fs.existsSync(path.join(worktreeDir(stateDir, worker.wtKey), 'lock', 'owner.json')));
        const read = readRecord(stateDir, RUN_ID);
        assert.ok(read.kind === 'ok' && read.record.state === 'running');
        assert.ok(fs.existsSync(runDir(stateDir, RUN_ID)));
    });

    await test('a stop removes the dead watcher window when no worker shares it', async (t) => {
        const fixture = await setUp(t);
        stubRespond(fixture.testEnv.stubDir, 'gh', 'PrwcPoll', { json: POLL_OPEN });
        const started = await runEntry(fixture, startArgs(fixture), callerEnv(fixture));
        assert.equal(started.code, 0, both(started));
        const owner = lockOwner(fixture);
        const stopped = await runEntry(fixture, ['--stop', PR_URL], callerEnv(fixture));
        assert.equal(stopped.code, 0, both(stopped));
        assert.ok(await waitUntil(10_000, () => processGone(owner.pid)), 'the watcher survived the stop');
        assert.deepEqual(await watcherWindows(fixture), []);
    });

    await test('arguments ending in ; reach the watcher exactly', async (t) => {
        const fixture = await setUp(t);
        const dir = `${fixture.clone};`;
        fs.renameSync(fixture.clone, dir);
        stubRespond(fixture.testEnv.stubDir, 'gh', 'PrwcPoll', { json: POLL_OPEN });
        const claudeArgs = ['value;', String.raw`a\;`, ';', 'value;'];
        const args = [PR_URL, '--background', '--dir', dir, '--interval', '300'];
        const started = await runEntry(
            fixture,
            [...args, ...claudeArgs.flatMap((arg) => ['--claude-arg', arg])],
            callerEnv(fixture)
        );
        assert.equal(started.code, 0, both(started));
        const argv = processArgs(lockOwner(fixture).pid);
        const dirIndex = argv.indexOf('--dir');
        assert.equal(argv[dirIndex + 1], dir, argv.join(' '));
        const passed = argv.filter((_arg, index) => argv[index - 1] === '--claude-arg');
        assert.deepEqual(passed, claudeArgs, argv.join(' '));
    });

    await test('a fatal first poll stays readable in the dead watcher pane', async (t) => {
        const fixture = await setUp(t);
        stubRespond(fixture.testEnv.stubDir, 'gh', 'PrwcPoll', AUTH_FAIL);
        const started = await runEntry(fixture, startArgs(fixture), callerEnv(fixture));
        assert.equal(started.code, 1, both(started));
        assert.ok(started.stdout.includes('watcher failed:'), both(started));
        const window = await waitDeadPane(fixture);
        const text = await paneText(fixture, window.windowId);
        assert.ok(text.includes('401'), text);
    });

    await test('a fatal lookup after a successful poll is a failed start', async (t) => {
        const fixture = await setUp(t);
        const now = Math.floor(Date.now() / 1000);
        stubRespond(fixture.testEnv.stubDir, 'gh', 'PrwcPoll', { json: rocketPoll(now) });
        stubRespond(fixture.testEnv.stubDir, 'gh', 'PrwcLookup', AUTH_FAIL);
        const started = await runEntry(fixture, startArgs(fixture), callerEnv(fixture));
        assert.equal(started.code, 1, both(started));
        assert.ok(started.stdout.includes('watcher failed:'), both(started));
        assert.ok(!started.stdout.includes('watching'), both(started));
    });

    await test("the caller's gh config directory reaches the watcher", async (t) => {
        const fixture = await setUp(t);
        const configDir = path.join(fixture.testEnv.root, 'ghcfg');
        stubRespond(fixture.testEnv.stubDir, 'gh', 'PrwcPoll', { json: POLL_OPEN });
        const started = await runEntry(fixture, startArgs(fixture), callerEnv(fixture, { GH_CONFIG_DIR: configDir }));
        assert.equal(started.code, 0, both(started));
        const polls = pollCalls(fixture);
        assert.ok(polls.length > 0, 'the watcher never polled');
        for (const call of polls) {
            assert.equal(call.ghConfigDir, configDir);
        }
    });

    await test('stale authentication in the server environment never reaches the watcher', async (t) => {
        const fixture = await setUp(t, (testEnv) => ({
            GH_TOKEN: 'stale-token',
            GITHUB_TOKEN: 'stale-token',
            GH_REPO: 'stale/repo',
            GH_CONFIG_DIR: path.join(testEnv.root, 'stale'),
            GH_HOST: 'stale.example',
        }));
        const { root, stubDir } = fixture.testEnv;
        stubRespond(stubDir, 'gh', 'PrwcPoll', { json: POLL_OPEN });
        const env = callerEnv(fixture, { XDG_CONFIG_HOME: path.join(root, 'xdg') });
        const started = await runEntry(fixture, startArgs(fixture), env);
        assert.equal(started.code, 0, both(started));
        assert.ok(started.stdout.includes('watching'), both(started));
        const polls = pollCalls(fixture);
        assert.ok(polls.length > 0, 'the watcher never polled');
        for (const call of polls) {
            assert.equal(call.ghConfigDir, path.join(root, 'xdg', 'gh'));
            assert.equal(call.ghHost, 'github.com');
            assert.deepEqual(call.tokenVars, []);
            const host = call.args.indexOf('--hostname');
            assert.ok(host !== -1 && call.args[host + 1] === 'github.com', call.args.join(' '));
        }
        for (const file of filesUnder(stubDir)) {
            if (fs.statSync(file).isFile()) {
                assert.ok(!fs.readFileSync(file, 'utf8').includes('stale-token'), file);
            }
        }
        const environment = processEnvironment(lockOwner(fixture).pid);
        assert.ok(!environment.join('\n').includes('stale'), environment.join('\n'));
        for (const name of GH_STRIP_VARS) {
            const items = environment.filter((item) => item.startsWith(`${name}=`));
            assert.ok(
                items.every((item) => item === `${name}=`),
                items.join(' ')
            );
        }
        const window = await onlyWatcherWindow(fixture);
        const text = await paneText(fixture, window.windowId);
        assert.ok(!text.includes('is set'), text);
    });

    await test('a stale override in the server environment is replaced by the effective value', async (t) => {
        const fixture = await setUp(t, () => ({ PRWC_STOP_QUIET: '99' }));
        const settings = path.join(fixture.testEnv.home, '.claude', 'settings.json');
        fs.mkdirSync(path.dirname(settings), { recursive: true });
        fs.writeFileSync(settings, JSON.stringify(STOP_HOOK_SETTINGS));
        stubRespond(fixture.testEnv.stubDir, 'gh', 'PrwcPoll', { json: POLL_OPEN });
        const started = await runEntry(fixture, startArgs(fixture), callerEnv(fixture));
        assert.equal(started.code, 0, both(started));
        assert.ok(started.stdout.includes('watching'), both(started));
        const window = await onlyWatcherWindow(fixture);
        const text = await paneText(fixture, window.windowId);
        assert.ok(text.includes('PRWC_STOP_QUIET (10 s)'), text);
        assert.ok(!text.includes('(99 s)'), text);
    });

    await test('of two concurrent starts exactly one watcher remains', async (t) => {
        const fixture = await setUp(t);
        stubRespond(fixture.testEnv.stubDir, 'gh', 'PrwcPoll', { json: POLL_OPEN });
        const results = await Promise.all([
            runEntry(fixture, startArgs(fixture), callerEnv(fixture)),
            runEntry(fixture, startArgs(fixture), callerEnv(fixture)),
        ]);
        for (const result of results) {
            assert.equal(result.code, 0, both(result));
        }
        const watching = results.filter((result) => result.stdout.includes('watching'));
        const refused = results.filter((result) => result.stdout.includes('already watched'));
        assert.equal(watching.length, 1, results.map((result) => both(result)).join('\n---\n'));
        assert.equal(refused.length, 1, results.map((result) => both(result)).join('\n---\n'));
        const window = await onlyWatcherWindow(fixture);
        assert.equal(window.paneDead, '0');
    });
});
