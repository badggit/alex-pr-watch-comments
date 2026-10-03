import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { pidAlive } from '../../src/proc.ts';
import { readStatus, writeStatus } from '../../src/runStore.ts';
import { initState, watcherDir } from '../../src/stateStore.ts';
import type { WatcherStatus } from '../../src/types.ts';
import type { FakeResponse } from '../support/fakeRunner.ts';
import { makePrClone } from '../support/gitRepo.ts';
import { stubCallCount, stubCalls, stubRespond } from '../support/stubQueue.ts';
import {
    createTestEnv,
    waitUntil,
    type ObservedProcess,
    type ObservedResult,
    type TestEnv,
} from '../support/testEnv.ts';

interface Setup {
    testEnv: TestEnv;
    stateDir: string;
    clone: string;
    watchers: ObservedProcess[];
}

const FIXTURES = path.resolve(import.meta.dirname, '..', 'fixtures');
const TIMEOUT = 'timeout';
const DRIVER = path.join(FIXTURES, 'watcher', 'runWatch.ts');
const PR_URL = 'https://github.com/o/r/pull/12';
const PR_KEY = 'o+r+12';
const BRANCH = 'feature';
const GH_FAIL: FakeResponse = { code: 1, stderr: 'HTTP 502: Bad Gateway' };
const AUTH_FAIL: FakeResponse = { code: 1, stderr: 'HTTP 401: Bad credentials (https://api.github.com/graphql)' };

function readFixture(...parts: readonly string[]): unknown {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(FIXTURES, ...parts), 'utf8'));
    return parsed;
}

const POLL_OPEN = readFixture('watcher', 'pollOpen.json');
const POLL_CLOSED = readFixture('watcher', 'pollClosed.json');
const PR_INFO = readFixture('preflight', 'prInfoOpen.json');

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

function signalQuietly(pid: number, signal: NodeJS.Signals): void {
    try {
        process.kill(pid, signal);
    } catch {
        return;
    }
}

// Every watcher still running is asked to stop (SIGTERM, so it frees its PR lock) and awaited; the process group of
// any stub gh call still alive is killed; only then is the test environment removed.
async function shutDown(setup: Setup): Promise<void> {
    try {
        for (const watcher of setup.watchers) {
            if ((await within(watcher.result, 50)) === TIMEOUT) {
                signalQuietly(watcher.pid, 'SIGTERM');
                await within(watcher.result, 10_000);
            }
        }
    } finally {
        for (const call of stubCalls(setup.testEnv.stubDir, 'gh')) {
            if (pidAlive(call.pid)) {
                signalQuietly(-call.pid, 'SIGKILL');
            }
        }
    }
}

// Stub gh and stub tmux answer preflight; git is real on a local clone that is never fetched (no rocket is ever
// offered to a spawned watcher).
async function makeSetup(t: TestContext): Promise<Setup> {
    const testEnv = await createTestEnv();
    const watchers: ObservedProcess[] = [];
    const init = initState(testEnv.stateDir);
    assert.ok(init.ok);
    const clone = makePrClone(path.join(testEnv.root, 'git'), BRANCH, 'o/r', testEnv.env);
    stubRespond(testEnv.stubDir, 'tmux', 'display-message', { stdout: '$1 @1\n' });
    stubRespond(testEnv.stubDir, 'gh', 'PrwcPrInfo', { json: PR_INFO });
    const setup: Setup = { testEnv, stateDir: init.stateDir, clone, watchers };
    t.after(async () => {
        try {
            await shutDown(setup);
        } finally {
            testEnv.cleanup();
        }
    });
    return setup;
}

function respondPoll(setup: Setup, response: FakeResponse): void {
    stubRespond(setup.testEnv.stubDir, 'gh', 'PrwcPoll', response);
}

function startWatcher(setup: Setup, args: readonly string[], url = PR_URL, clone = setup.clone): ObservedProcess {
    const watcher = setup.testEnv.spawnObserved(process.execPath, [DRIVER, url, '--dir', clone, ...args], {
        cwd: setup.testEnv.root,
    });
    setup.watchers.push(watcher);
    return watcher;
}

async function exitWithin(observed: ObservedProcess, ms: number): Promise<ObservedResult> {
    const result = await within(observed.result, ms);
    assert.ok(result !== TIMEOUT, `the watcher did not exit within ${ms} ms`);
    return result;
}

function statusOf(setup: Setup): WatcherStatus | undefined {
    return readStatus(setup.stateDir, PR_KEY);
}

function prLockExists(setup: Setup): boolean {
    return fs.existsSync(path.join(watcherDir(setup.stateDir, PR_KEY), 'lock'));
}

function pollCount(setup: Setup): number {
    return stubCallCount(setup.testEnv.stubDir, 'gh', 'PrwcPoll');
}

async function waitForPolling(setup: Setup): Promise<void> {
    assert.ok(await waitUntil(30_000, () => statusOf(setup)?.state === 'polling'), 'the watcher never polled');
}

await describe('watch loop', async () => {
    await test('a start resets the last error of an earlier status', async (t) => {
        const setup = await makeSetup(t);
        writeStatus(setup.stateDir, PR_KEY, { state: 'polling', lastError: 'old' }, Math.floor(Date.now() / 1000));
        respondPoll(setup, GH_FAIL);
        const result = await exitWithin(startWatcher(setup, ['--once']), 60_000);
        assert.equal(result.code, 1, result.stderr);
        const status = statusOf(setup);
        assert.equal(status?.state, 'backing_off');
        assert.ok(status.lastError.includes('502'), status.lastError);
        assert.equal(prLockExists(setup), false);
    });

    await test('a successful start clears the last error, reason and hint of an earlier status', async (t) => {
        const setup = await makeSetup(t);
        const old = { state: 'holding', lastError: 'old', reason: 'old', hint: 'old' } as const;
        writeStatus(setup.stateDir, PR_KEY, old, Math.floor(Date.now() / 1000));
        respondPoll(setup, { json: POLL_OPEN });
        const result = await exitWithin(startWatcher(setup, ['--once']), 60_000);
        assert.equal(result.code, 0, result.stderr);
        const status = statusOf(setup);
        assert.equal(status?.state, 'polling');
        assert.equal(status.lastError, '');
        assert.equal(status.reason, '');
        assert.equal(status.hint, '');
    });

    await test('a closed pull request ends the loop after one poll', async (t) => {
        const setup = await makeSetup(t);
        respondPoll(setup, { json: POLL_CLOSED });
        const watcher = startWatcher(setup, ['--interval', '1']);
        assert.ok(await waitUntil(30_000, () => pollCount(setup) > 0), 'the watcher never polled');
        const result = await exitWithin(watcher, 10_000);
        assert.equal(result.code, 0, result.stderr);
        assert.equal(pollCount(setup), 1);
        assert.equal(prLockExists(setup), false);
        assert.equal(statusOf(setup)?.state, 'exited');
    });

    await test('an authentication failure ends the loop after one poll', async (t) => {
        const setup = await makeSetup(t);
        respondPoll(setup, AUTH_FAIL);
        const watcher = startWatcher(setup, ['--interval', '1']);
        assert.ok(await waitUntil(30_000, () => pollCount(setup) > 0), 'the watcher never polled');
        const result = await exitWithin(watcher, 10_000);
        assert.equal(result.code, 1, result.stderr);
        assert.ok(result.stderr.includes('401'), result.stderr);
        assert.equal(pollCount(setup), 1);
        assert.equal(prLockExists(setup), false);
        assert.equal(statusOf(setup)?.state, 'fatal');
    });

    await test('a second watcher for the same PR from another clone is refused', async (t) => {
        const setup = await makeSetup(t);
        respondPoll(setup, { json: POLL_OPEN });
        const first = startWatcher(setup, ['--interval', '300']);
        await waitForPolling(setup);
        const otherClone = makePrClone(path.join(setup.testEnv.root, 'git2'), BRANCH, 'o/r', setup.testEnv.env);
        const second = startWatcher(setup, ['--interval', '300'], 'https://github.com/O/R/pull/12', otherClone);
        const refused = await exitWithin(second, 60_000);
        assert.equal(refused.code, 0, refused.stderr);
        const output = `${refused.stdout}${refused.stderr}`;
        assert.ok(output.includes(`already watched by pid ${first.pid} (window @1)`), output);
        assert.equal(pollCount(setup), 1);
        process.kill(first.pid, 'SIGTERM');
        const stopped = await exitWithin(first, 10_000);
        assert.equal(stopped.code, 0, stopped.stderr);
    });

    await test('a stop request interrupts the sleep and frees the PR lock', async (t) => {
        const setup = await makeSetup(t);
        respondPoll(setup, { json: POLL_OPEN });
        const watcher = startWatcher(setup, ['--interval', '300']);
        await waitForPolling(setup);
        assert.ok(prLockExists(setup));
        process.kill(watcher.pid, 'SIGTERM');
        const result = await exitWithin(watcher, 6000);
        assert.equal(result.code, 0, result.stderr);
        assert.equal(prLockExists(setup), false);
    });

    await test('a stop request aborts an in-flight gh command', async (t) => {
        const setup = await makeSetup(t);
        respondPoll(setup, { json: POLL_OPEN });
        respondPoll(setup, { json: POLL_OPEN, delayMs: 60_000 });
        const watcher = startWatcher(setup, ['--interval', '1']);
        assert.ok(await waitUntil(30_000, () => pollCount(setup) >= 2), 'the second poll never started');
        const hung = stubCalls(setup.testEnv.stubDir, 'gh').filter((call) => call.input.includes('PrwcPoll'))[1];
        assert.ok(hung !== undefined);
        process.kill(watcher.pid, 'SIGTERM');
        const result = await exitWithin(watcher, 10_000);
        assert.equal(result.code, 0, result.stderr);
        assert.ok(await waitUntil(10_000, () => !pidAlive(hung.pid)), 'the hung gh call survived the stop');
        assert.equal(prLockExists(setup), false);
        assert.equal(stubCallCount(setup.testEnv.stubDir, 'tmux', 'split-window'), 0);
    });
});
