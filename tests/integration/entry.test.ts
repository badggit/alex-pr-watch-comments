import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { makePrClone } from '../support/gitRepo.ts';
import { stubCallCount, stubRespond } from '../support/stubQueue.ts';
import { createTestEnv, type ObservedResult, type TestEnv } from '../support/testEnv.ts';

const ROOT = fs.realpathSync.native(path.resolve(import.meta.dirname, '..', '..'));
const LAUNCHER = path.join(ROOT, 'bin', 'alex-pr-watch-comments');
const MAIN_TS = path.join(ROOT, 'src', 'main.ts');
const FIXTURES = path.join(ROOT, 'tests', 'fixtures');
const TIMEOUT = 'timeout';
const EXIT_MS = 60_000;
const PR_URL = 'https://github.com/o/r/pull/12';

function readFixture(...parts: readonly string[]): unknown {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(FIXTURES, ...parts), 'utf8'));
    return parsed;
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

async function makeEnv(t: TestContext): Promise<TestEnv> {
    const testEnv = await createTestEnv();
    t.after(() => {
        testEnv.cleanup();
    });
    return testEnv;
}

async function runEntry(testEnv: TestEnv, args: readonly string[]): Promise<ObservedResult> {
    const observed = testEnv.spawnObserved('/bin/sh', [LAUNCHER, ...args], { cwd: testEnv.root });
    const result = await within(observed.result, EXIT_MS);
    assert.ok(result !== TIMEOUT, `${args.join(' ')} did not exit within ${EXIT_MS} ms`);
    return result;
}

await describe('entry wiring', async () => {
    await test('a foreground --once run polls once and exits 0', async (t) => {
        const testEnv = await makeEnv(t);
        const clone = makePrClone(path.join(testEnv.root, 'git'), 'feature', 'o/r', testEnv.env);
        stubRespond(testEnv.stubDir, 'tmux', 'display-message', { stdout: '$1 @1\n' });
        stubRespond(testEnv.stubDir, 'gh', 'PrwcPrInfo', { json: readFixture('preflight', 'prInfoOpen.json') });
        stubRespond(testEnv.stubDir, 'gh', 'PrwcPoll', { json: readFixture('watcher', 'pollOpen.json') });
        const result = await runEntry(testEnv, [PR_URL, '--once', '--in-place', '--dir', clone]);
        assert.equal(result.code, 0, `${result.stdout}${result.stderr}`);
        assert.equal(stubCallCount(testEnv.stubDir, 'gh', 'PrwcPoll'), 1);
    });

    await test('--once with --background is a usage error', async (t) => {
        const testEnv = await makeEnv(t);
        const result = await runEntry(testEnv, [PR_URL, '--background', '--once']);
        assert.equal(result.code, 2);
        assert.ok(result.stderr.includes('--once cannot be combined with --background'), result.stderr);
    });

    await test('--list on an empty state directory prints no watchers', async (t) => {
        const testEnv = await makeEnv(t);
        const result = await runEntry(testEnv, ['--list']);
        assert.equal(result.code, 0, result.stderr);
        assert.equal(result.stdout, 'no watchers\n');
    });

    await test('main.ts loads the watcher and the control module statically', () => {
        const imports = fs
            .readFileSync(MAIN_TS, 'utf8')
            .split('\n')
            .filter((line) => line.startsWith('import {'));
        for (const imported of ['./watcher.ts', './control.ts']) {
            assert.ok(
                imports.some((line) => line.endsWith(` from '${imported}';`)),
                imported
            );
        }
    });
});
