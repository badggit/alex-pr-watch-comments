import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test, type TestContext } from 'node:test';

import {
    clearLaunch,
    launchReady,
    markLaunchReady,
    readLaunchResult,
    writeLaunchResult,
} from '../../src/launchChannel.ts';
import { writeStatus } from '../../src/runStore.ts';
import { initState, watcherDir } from '../../src/stateStore.ts';
import type { LaunchResult } from '../../src/types.ts';
import { createTestEnv } from '../support/testEnv.ts';

const PR_KEY = 'o+r+12';
const TOKEN_A = '111-1790942400';
const TOKEN_B = '222-1790942400';

async function newStateDir(t: TestContext): Promise<string> {
    const env = await createTestEnv();
    t.after(() => {
        env.cleanup();
    });
    const result = initState(env.stateDir);
    assert.ok(result.ok);
    return result.stateDir;
}

function launchResult(token: string, kind: LaunchResult['result'], message: string): LaunchResult {
    return { token, result: kind, message, pid: 42, windowId: '@3' };
}

function launchDir(stateDir: string): string {
    return path.join(watcherDir(stateDir, PR_KEY), 'launch');
}

function launchFiles(stateDir: string): string[] {
    const dir = launchDir(stateDir);
    return fs.existsSync(dir) ? fs.readdirSync(dir).toSorted() : [];
}

await describe('launch channel', async () => {
    await test('the first result for a token wins', async (t) => {
        const stateDir = await newStateDir(t);
        assert.equal(writeLaunchResult(stateDir, PR_KEY, launchResult(TOKEN_A, 'firstPoll', 'one')), true);
        assert.equal(writeLaunchResult(stateDir, PR_KEY, launchResult(TOKEN_A, 'fatal', 'two')), false);
        assert.deepEqual(readLaunchResult(stateDir, PR_KEY, TOKEN_A), launchResult(TOKEN_A, 'firstPoll', 'one'));
        assert.deepEqual(launchFiles(stateDir), [`${TOKEN_A}.json`]);
    });

    await test('two tokens never see each other results', async (t) => {
        const stateDir = await newStateDir(t);
        writeLaunchResult(stateDir, PR_KEY, launchResult(TOKEN_A, 'fatal', 'a'));
        assert.equal(readLaunchResult(stateDir, PR_KEY, TOKEN_B), undefined);
        writeLaunchResult(stateDir, PR_KEY, launchResult(TOKEN_B, 'alreadyWatched', 'b'));
        assert.equal(readLaunchResult(stateDir, PR_KEY, TOKEN_A)?.message, 'a');
        assert.equal(readLaunchResult(stateDir, PR_KEY, TOKEN_B)?.message, 'b');
    });

    await test('clearLaunch removes only the files of its own token', async (t) => {
        const stateDir = await newStateDir(t);
        writeStatus(stateDir, PR_KEY, { state: 'starting' }, 1);
        for (const token of [TOKEN_A, TOKEN_B]) {
            markLaunchReady(stateDir, PR_KEY, token);
            writeLaunchResult(stateDir, PR_KEY, launchResult(token, 'firstPoll', token));
        }
        clearLaunch(stateDir, PR_KEY, TOKEN_A);
        assert.deepEqual(launchFiles(stateDir), [`${TOKEN_B}.json`, `${TOKEN_B}.ready`]);
        assert.ok(fs.existsSync(path.join(watcherDir(stateDir, PR_KEY), 'status.json')));
    });

    await test('launchReady is false before and true after markLaunchReady', async (t) => {
        const stateDir = await newStateDir(t);
        assert.equal(launchReady(stateDir, PR_KEY, TOKEN_A), false);
        markLaunchReady(stateDir, PR_KEY, TOKEN_A);
        assert.equal(launchReady(stateDir, PR_KEY, TOKEN_A), true);
        assert.equal(launchReady(stateDir, PR_KEY, TOKEN_B), false);
    });

    await test('an invalid token writes and reads nothing', async (t) => {
        const stateDir = await newStateDir(t);
        const bad = '1;x';
        markLaunchReady(stateDir, PR_KEY, bad);
        assert.equal(writeLaunchResult(stateDir, PR_KEY, launchResult(bad, 'fatal', 'x')), false);
        assert.equal(launchReady(stateDir, PR_KEY, bad), false);
        assert.equal(readLaunchResult(stateDir, PR_KEY, bad), undefined);
        clearLaunch(stateDir, PR_KEY, bad);
        assert.deepEqual(launchFiles(stateDir), []);
    });
});
