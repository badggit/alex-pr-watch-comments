import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
    formatDuration,
    noteOffline,
    noteOnline,
    probeGitHub,
    type ConnectivityContext,
    type OfflineRuntime,
} from '../../src/connectivity.ts';
import { plainText } from '../../src/logParts.ts';
import type { CommandRequest, CommandResult, WatcherStatus } from '../../src/types.ts';

const GH = { path: '/opt/fake/bin/gh', host: 'ghe.example' };
const OFFLINE_TEXT = 'error connecting to ghe.example\ncheck your internet connection or https://githubstatus.com';

async function probeWith(result: CommandResult): Promise<{ answer: string; request: CommandRequest | undefined }> {
    let seen: CommandRequest | undefined;
    const runner = {
        run: (request: CommandRequest): Promise<CommandResult> => {
            seen = request;
            return Promise.resolve(result);
        },
    };
    const answer = await probeGitHub({ runner }, GH);
    return { answer, request: seen };
}

interface Recorded {
    ctx: ConnectivityContext;
    lines: string[];
    patches: Partial<WatcherStatus>[];
}

function recordedContext(nowSeconds: number, env: Record<string, string> = {}): Recorded {
    const lines: string[] = [];
    const patches: Partial<WatcherStatus>[] = [];
    const ctx: ConnectivityContext = {
        log: {
            info: (message) => lines.push(`info ${plainText(message)}`),
            warn: (message) => lines.push(`warn ${plainText(message)}`),
            error: (message) => lines.push(`error ${plainText(message)}`),
        },
        env,
        nowSeconds,
        setStatus: (patch) => {
            patches.push(patch);
        },
    };
    return { ctx, lines, patches };
}

await describe('probeGitHub', async () => {
    await test('reads the rate limit of the PR host with a short timeout', async () => {
        const probed = await probeWith({ code: 0, stdout: '{}', stderr: '' });
        assert.equal(probed.answer, 'online');
        assert.equal(probed.request?.file, GH.path);
        assert.deepEqual(probed.request?.args, ['api', 'rate_limit', '--hostname', 'ghe.example']);
        assert.equal(probed.request?.timeoutMs, 15_000);
    });

    await test('an offline error or a timeout is offline', async () => {
        const failed = await probeWith({ code: 1, stdout: '', stderr: OFFLINE_TEXT });
        assert.equal(failed.answer, 'offline');
        const timedOut = await probeWith({ code: 143, stdout: '', stderr: '', timedOut: true });
        assert.equal(timedOut.answer, 'offline');
    });

    await test('an HTTP error is online: the network works', async () => {
        const notFound = await probeWith({ code: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' });
        assert.equal(notFound.answer, 'online');
        const unauthorized = await probeWith({ code: 1, stdout: '', stderr: 'HTTP 401: Bad credentials' });
        assert.equal(unauthorized.answer, 'online');
    });
});

await describe('formatDuration', async () => {
    await test('formats seconds, minutes and hours', () => {
        assert.equal(formatDuration(0), '0s');
        assert.equal(formatDuration(45), '45s');
        assert.equal(formatDuration(60), '1m');
        assert.equal(formatDuration(270), '4m 30s');
        assert.equal(formatDuration(3720), '1h 2m');
        assert.equal(formatDuration(-5), '0s');
    });
});

await describe('offline notes', async () => {
    await test('only the first offline failure is logged and shown', () => {
        const rt: OfflineRuntime = { offlineSince: undefined, failures: 0 };
        const first = recordedContext(1000, { PRWC_OFFLINE_CHECK: '7' });
        noteOffline(first.ctx, rt, OFFLINE_TEXT);
        assert.equal(rt.offlineSince, 1000);
        assert.deepEqual(first.lines, [
            'warn lost the connection to GitHub (error connecting to ghe.example?check your internet connection or ' +
                'https://githubstatus.com); checking every 7 s and staying quiet until it is back',
        ]);
        assert.equal(first.patches[0]?.state, 'offline');
        const later = recordedContext(1030);
        noteOffline(later.ctx, rt, OFFLINE_TEXT);
        assert.equal(rt.offlineSince, 1000);
        assert.deepEqual(later.lines, []);
        assert.deepEqual(later.patches, []);
        assert.equal(rt.failures, 0);
    });

    await test('coming back logs the outage once and clears the error', () => {
        const rt: OfflineRuntime = { offlineSince: 1000, failures: 3 };
        const back = recordedContext(1270);
        noteOnline(back.ctx, rt);
        assert.deepEqual(back.lines, ['info connection to GitHub is back after 4m 30s; watching resumed']);
        assert.deepEqual(back.patches, [{ lastError: '' }]);
        assert.equal(rt.offlineSince, undefined);
        assert.equal(rt.failures, 0);
        const again = recordedContext(1300);
        noteOnline(again.ctx, rt);
        assert.deepEqual(again.lines, []);
    });
});
