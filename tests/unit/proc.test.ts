import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';

import { GH_STRIP_VARS, KILL_GRACE_MS, PS_PATH } from '../../src/constants.ts';
import { createProcessRunner, pidAlive, processStart, signalIfSame } from '../../src/proc.ts';
import type { CommandResult, CommandRunner } from '../../src/types.ts';
import { createFakeRunner } from '../support/fakeRunner.ts';
import { createTestEnv, waitUntil, type TestEnv } from '../support/testEnv.ts';

const BASE_ENV = { PATH: '/usr/bin:/bin' };
const STRIPPED = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_REPO'];
const GH_CONTEXT = { GH_CONFIG_DIR: '/cfg', GH_HOST: 'github.com' };
const EMPTY_TOKEN_ENV = Object.fromEntries(GH_STRIP_VARS.map((name) => [name, '']));
const TOKEN_ENV = {
    GH_TOKEN: 'a',
    GITHUB_TOKEN: 'b',
    GH_ENTERPRISE_TOKEN: 'c',
    GITHUB_ENTERPRISE_TOKEN: 'd',
    GH_REPO: 'o/r',
    ...GH_CONTEXT,
};

function envLines(result: CommandResult): string[] {
    return result.stdout
        .split('\n')
        .filter((line) => line.length > 0)
        .toSorted();
}

function envNames(result: CommandResult): string[] {
    return envLines(result).map((line) => line.split('=', 1)[0] ?? '');
}

function firstPid(result: CommandResult): number {
    return Number.parseInt(result.stdout.trim().split('\n', 1)[0] ?? '', 10);
}

function killQuietly(pid: number): void {
    try {
        process.kill(pid, 'SIGKILL');
    } catch {
        return;
    }
}

function errnoError(code: string): Error {
    return Object.assign(new Error(`kill ${code}`), { code });
}

// Waits until FILE holds two pids (written atomically by the script under test) and returns them.
async function readPidPair(file: string): Promise<[number, number]> {
    assert.ok(await waitUntil(3000, () => fs.existsSync(file)));
    const [first = '', second = ''] = fs.readFileSync(file, 'utf8').trim().split(' ');
    return [Number.parseInt(first, 10), Number.parseInt(second, 10)];
}

async function deadPid(env: TestEnv): Promise<number> {
    const pid = env.spawnOrphan('true', []);
    assert.ok(await waitUntil(3000, () => !pidAlive(pid)));
    return pid;
}

function canonicalTempDir(): string {
    return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'prwc-proc-')));
}

await describe('createProcessRunner', async () => {
    const runner = createProcessRunner(BASE_ENV);

    await test('collects exit code, stdout and stderr', async () => {
        const result = await runner.run({ file: '/bin/sh', args: ['-c', 'printf out; printf err 1>&2; exit 3'] });
        assert.equal(result.code, 3);
        assert.equal(result.stdout, 'out');
        assert.equal(result.stderr, 'err');
        assert.equal(result.spawnError, undefined);
    });

    await test('writes input to stdin', async () => {
        const result = await runner.run({ file: '/bin/cat', args: [], input: 'hello\nworld' });
        assert.equal(result.code, 0);
        assert.equal(result.stdout, 'hello\nworld');
    });

    await test('gives the child exactly the request env', async (t) => {
        process.env.PRWC_LEAK_CHECK = '1';
        t.after(() => {
            delete process.env.PRWC_LEAK_CHECK;
        });
        const baseRunner = createProcessRunner({ ...BASE_ENV, PRWC_BASE_ONLY: 'base' });
        const result = await baseRunner.run({
            file: '/usr/bin/env',
            args: [],
            env: { PATH: '/usr/bin:/bin', PRWC_A: 'x y', PRWC_UNSET: undefined },
        });
        assert.deepEqual(envLines(result), ['PATH=/usr/bin:/bin', 'PRWC_A=x y']);
    });

    await test('gives the child exactly the base env when the request has none', async (t) => {
        process.env.PRWC_LEAK_CHECK = '1';
        t.after(() => {
            delete process.env.PRWC_LEAK_CHECK;
        });
        const baseRunner = createProcessRunner({ PATH: '/usr/bin:/bin', PRWC_BASE: '1', PRWC_NONE: undefined });
        const result = await baseRunner.run({ file: '/usr/bin/env', args: [] });
        assert.deepEqual(envLines(result), ['PATH=/usr/bin:/bin', 'PRWC_BASE=1']);
    });

    await test('strips gh token variables and GH_REPO from the request env', async () => {
        const result = await runner.run({ file: '/usr/bin/env', args: [], env: { ...BASE_ENV, ...TOKEN_ENV } });
        const names = envNames(result);
        for (const name of STRIPPED) {
            assert.ok(!names.includes(name), `${name} reached the child`);
        }
        assert.ok(envLines(result).includes('GH_CONFIG_DIR=/cfg'));
        assert.ok(envLines(result).includes('GH_HOST=github.com'));
    });

    await test('strips gh token variables and GH_REPO from the base env', async () => {
        const baseRunner = createProcessRunner({ ...BASE_ENV, ...TOKEN_ENV });
        const result = await baseRunner.run({ file: '/usr/bin/env', args: [] });
        const names = envNames(result);
        for (const name of STRIPPED) {
            assert.ok(!names.includes(name), `${name} reached the child`);
        }
        assert.ok(envLines(result).includes('GH_CONFIG_DIR=/cfg'));
        assert.ok(envLines(result).includes('GH_HOST=github.com'));
    });

    await test('strips gh token variables and GH_REPO with empty values from the request env', async () => {
        const result = await runner.run({ file: '/usr/bin/env', args: [], env: { ...BASE_ENV, ...EMPTY_TOKEN_ENV } });
        assert.ok(GH_STRIP_VARS.length > 0);
        assert.deepEqual(envLines(result), ['PATH=/usr/bin:/bin']);
    });

    await test('strips gh token variables and GH_REPO with empty values from the base env', async () => {
        const baseRunner = createProcessRunner({ ...BASE_ENV, ...EMPTY_TOKEN_ENV });
        const result = await baseRunner.run({ file: '/usr/bin/env', args: [] });
        assert.deepEqual(envLines(result), ['PATH=/usr/bin:/bin']);
    });

    await test('honors cwd', async (t) => {
        const dir = canonicalTempDir();
        t.after(() => {
            fs.rmSync(dir, { recursive: true, force: true });
        });
        const result = await runner.run({ file: '/bin/pwd', args: [], cwd: dir });
        assert.equal(result.stdout.trim(), dir);
    });

    await test('reports a missing executable as code 127 with spawnError', async () => {
        const result = await runner.run({ file: '/nonexistent-prwc/missing-tool', args: [] });
        assert.equal(result.code, 127);
        assert.equal(result.spawnError, 'ENOENT');
    });

    await test('ends the child when the request signal aborts', async () => {
        const started = performance.now();
        const result = await runner.run({ file: '/bin/sleep', args: ['30'], signal: AbortSignal.timeout(200) });
        assert.equal(result.code, 143);
        assert.ok(performance.now() - started < 3000);
    });

    await test('applies the default signal to a request without its own signal', async () => {
        const started = performance.now();
        const defaultRunner = createProcessRunner(BASE_ENV, { signal: AbortSignal.timeout(200) });
        const result = await defaultRunner.run({ file: '/bin/sleep', args: ['30'] });
        assert.equal(result.code, 143);
        assert.ok(performance.now() - started < 3000);
    });

    await test('kills a TERM-ignoring child after the grace', async () => {
        const started = performance.now();
        const result = await runner.run({
            file: '/bin/sh',
            args: ['-c', 'trap "" TERM; sleep 30'],
            timeoutMs: 500,
        });
        assert.equal(result.code, 137);
        assert.ok(performance.now() - started < 7000);
    });

    await test('kills a TERM-ignoring descendant that holds the pipes', async () => {
        const started = performance.now();
        const result = await runner.run({
            file: '/bin/sh',
            args: ['-c', 'trap "" TERM; sleep 30 & echo $!; wait'],
            timeoutMs: 500,
        });
        assert.equal(result.code, 137);
        assert.ok(performance.now() - started < 7000);
        const pid = firstPid(result);
        assert.ok(pid > 1);
        assert.ok(await waitUntil(3000, () => !pidAlive(pid)));
    });

    await test('kills the group when the leader accepts TERM and a descendant holding the pipes ignores it', async () => {
        const started = performance.now();
        const result = await runner.run({
            file: '/bin/sh',
            args: ['-c', `/bin/sh -c 'trap "" TERM; exec sleep 30' & echo $!; wait`],
            timeoutMs: 500,
        });
        assert.equal(result.code, 143);
        assert.ok(performance.now() - started < 7000);
        const pid = firstPid(result);
        assert.ok(pid > 1);
        assert.ok(await waitUntil(3000, () => !pidAlive(pid)));
    });

    await test('kills a TERM-ignoring descendant after an early close', async (t) => {
        const dir = canonicalTempDir();
        t.after(() => {
            fs.rmSync(dir, { recursive: true, force: true });
        });
        const pidsFile = path.join(dir, 'pids');
        const script = [
            `/bin/sh -c 'trap "" TERM; exec sleep 30' </dev/null >/dev/null 2>&1 &`,
            `printf '%s %s' $$ $! > "${pidsFile}.tmp" && mv "${pidsFile}.tmp" "${pidsFile}";`,
            'echo $!; wait',
        ].join(' ');
        const started = performance.now();
        const pending = runner.run({ file: '/bin/sh', args: ['-c', script], timeoutMs: 500 });
        const [leader, descendant] = await readPidPair(pidsFile);
        t.after(() => {
            killQuietly(descendant);
        });
        // The leader dies on the group SIGTERM at the timeout and its close arrives at once (the descendant holds
        // no pipe); the TERM-ignoring descendant must still be alive then, before the grace expires.
        assert.ok(await waitUntil(KILL_GRACE_MS, () => !pidAlive(leader)));
        assert.equal(pidAlive(descendant), true);
        assert.ok(performance.now() - started < 500 + KILL_GRACE_MS);
        const result = await pending;
        const elapsed = performance.now() - started;
        assert.equal(result.code, 143);
        assert.equal(firstPid(result), descendant);
        assert.ok(elapsed < 500 + 2 * KILL_GRACE_MS + 1500, `took ${elapsed} ms`);
        assert.ok(await waitUntil(3000, () => !pidAlive(descendant)));
    });

    await test('resolves at the shutdown deadline when an escaped descendant keeps the pipes open', async (t) => {
        // The descendant leaves the group (its own session through detached), so no group signal reaches it and
        // close never arrives: only the unconditional deadline of two graces can end the call.
        const script = [
            "const { spawn } = require('node:child_process');",
            "const child = spawn('/bin/sleep', ['30'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });",
            'console.log(child.pid);',
            'child.unref();',
            'setInterval(() => {}, 1000);',
        ].join(' ');
        const started = performance.now();
        const result = await runner.run({ file: process.execPath, args: ['-e', script], timeoutMs: 300 });
        const elapsed = performance.now() - started;
        const descendant = firstPid(result);
        assert.ok(descendant > 1);
        t.after(() => {
            killQuietly(descendant);
        });
        assert.equal(result.code, 143);
        assert.ok(elapsed < 300 + 2 * KILL_GRACE_MS + 1500, `took ${elapsed} ms`);
        assert.equal(pidAlive(descendant), true);
        killQuietly(descendant);
        assert.ok(await waitUntil(3000, () => !pidAlive(descendant)));
    });

    await test('removes its abort listener from the default signal when calls settle', async () => {
        const controller = new AbortController();
        const defaultRunner = createProcessRunner(BASE_ENV, { signal: controller.signal });
        const calls = Array.from({ length: 50 }, () => defaultRunner.run({ file: '/bin/sh', args: ['-c', 'exit 0'] }));
        const results = await Promise.all(calls);
        assert.ok(results.every((result) => result.code === 0));
        assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    });

    await test('ends the child at the request timeout', async () => {
        const started = performance.now();
        const result = await runner.run({ file: '/bin/sleep', args: ['30'], timeoutMs: 500 });
        assert.equal(result.code, 143);
        assert.ok(performance.now() - started < 3000);
    });

    await test('spawns nothing for an already aborted signal', async (t) => {
        const dir = canonicalTempDir();
        t.after(() => {
            fs.rmSync(dir, { recursive: true, force: true });
        });
        const file = path.join(dir, 'touched');
        const result = await runner.run({
            file: '/bin/sh',
            args: ['-c', `touch '${file}'`],
            signal: AbortSignal.abort(),
        });
        assert.equal(result.code, 143);
        assert.equal(await waitUntil(500, () => fs.existsSync(file)), false);
    });
});

await describe('pidAlive', async () => {
    await test('is true for this process and false for invalid pids', () => {
        assert.equal(pidAlive(process.pid), true);
        assert.equal(pidAlive(1), false);
        assert.equal(pidAlive(0), false);
        assert.equal(pidAlive(-5), false);
        assert.equal(pidAlive(Number.NaN), false);
    });

    await test('turns false once an orphan was killed', async (t) => {
        const env = await createTestEnv();
        t.after(() => {
            env.cleanup();
        });
        const pid = env.spawnOrphan('sleep', ['30']);
        assert.equal(pidAlive(pid), true);
        process.kill(pid, 'SIGKILL');
        assert.ok(await waitUntil(3000, () => !pidAlive(pid)));
    });
});

await describe('processStart and signalIfSame', async () => {
    const runner = createProcessRunner(BASE_ENV);

    await test('reads a stable start time for a live pid and undefined for a dead one', async (t) => {
        const env = await createTestEnv();
        t.after(() => {
            env.cleanup();
        });
        const pid = env.spawnOrphan('sleep', ['30']);
        const first = await processStart(runner, pid);
        const second = await processStart(runner, pid);
        assert.ok(first !== undefined && first.length > 0);
        assert.equal(second, first);
        assert.equal(await processStart(runner, await deadPid(env)), undefined);
    });

    await test('runs ps with the pinned path, arguments and environment', async () => {
        const fake = createFakeRunner();
        fake.respond('ps', 'ps', { stdout: ' Thu Oct  1 10:00:00 2026\n' });
        assert.equal(await processStart(fake.runner, 4242), 'Thu Oct  1 10:00:00 2026');
        const calls = fake.calls('ps');
        assert.equal(calls.length, 1);
        assert.equal(calls[0]?.file, PS_PATH);
        assert.deepEqual(calls[0]?.args, ['-o', 'lstart=', '-p', '4242']);
        assert.deepEqual(calls[0]?.env, { LC_ALL: 'C', TZ: 'UTC', PATH: '/usr/bin:/bin' });
        assert.equal(calls[0]?.input, undefined);
    });

    await test('treats a failed or empty ps answer as unknown', async () => {
        const failed = createFakeRunner();
        failed.respond('ps', 'ps', { code: 1, stdout: 'Thu Oct  1 10:00:00 2026\n' });
        assert.equal(await processStart(failed.runner, 4242), undefined);
        const empty = createFakeRunner();
        empty.respond('ps', 'ps', { stdout: ' \n' });
        assert.equal(await processStart(empty.runner, 4242), undefined);
    });

    await test('sends the signal when the start time matches', async (t) => {
        const env = await createTestEnv();
        t.after(() => {
            env.cleanup();
        });
        const pid = env.spawnOrphan('sleep', ['30']);
        const start = await processStart(runner, pid);
        assert.ok(start !== undefined);
        assert.equal(await signalIfSame(runner, pid, start, 'SIGTERM'), 'sent');
        assert.ok(await waitUntil(3000, () => !pidAlive(pid)));
    });

    await test('accepts a recorded start time with a trailing newline', async (t) => {
        const env = await createTestEnv();
        t.after(() => {
            env.cleanup();
        });
        const pid = env.spawnOrphan('sleep', ['30']);
        const start = await processStart(runner, pid);
        assert.ok(start !== undefined);
        assert.equal(await signalIfSame(runner, pid, `${start}\n`, 'SIGTERM'), 'sent');
        assert.ok(await waitUntil(3000, () => !pidAlive(pid)));
    });

    await test('reports a mismatch and sends nothing for another start time', async (t) => {
        const env = await createTestEnv();
        t.after(() => {
            env.cleanup();
        });
        const pid = env.spawnOrphan('sleep', ['30']);
        assert.equal(await signalIfSame(runner, pid, 'Mon Jan  1 00:00:00 2001', 'SIGTERM'), 'mismatch');
        assert.equal(await waitUntil(1000, () => !pidAlive(pid)), false);
    });

    await test('reports gone for a dead pid', async (t) => {
        const env = await createTestEnv();
        t.after(() => {
            env.cleanup();
        });
        const pid = await deadPid(env);
        assert.equal(await signalIfSame(runner, pid, 'Mon Jan  1 00:00:00 2001', 'SIGTERM'), 'gone');
    });

    await test('calls the guard once after the ps result and sends nothing on a veto', async (t) => {
        const env = await createTestEnv();
        t.after(() => {
            env.cleanup();
        });
        const pid = env.spawnOrphan('sleep', ['30']);
        const start = await processStart(runner, pid);
        assert.ok(start !== undefined);
        const fake = createFakeRunner();
        fake.respond('ps', 'ps', { stdout: `${start}\n`, delayMs: 300 });
        const guardRuns: { at: number; psCalls: number }[] = [];
        const started = performance.now();
        const outcome = await signalIfSame(fake.runner, pid, start, 'SIGTERM', () => {
            guardRuns.push({ at: performance.now(), psCalls: fake.calls('ps').length });
            return false;
        });
        assert.equal(outcome, 'vetoed');
        assert.equal(guardRuns.length, 1);
        assert.equal(guardRuns[0]?.psCalls, 1);
        assert.ok((guardRuns[0]?.at ?? 0) - started >= 290);
        assert.equal(await waitUntil(1000, () => !pidAlive(pid)), false);
    });

    await test('reports unverifiable for a live pid whose start time cannot be read', async (t) => {
        const env = await createTestEnv();
        t.after(() => {
            env.cleanup();
        });
        const pid = env.spawnOrphan('sleep', ['30']);
        const fake = createFakeRunner();
        fake.respond('ps', 'ps', { code: 1, stdout: '' });
        assert.equal(await signalIfSame(fake.runner, pid, 'Mon Jan  1 00:00:00 2001', 'SIGTERM'), 'unverifiable');
        assert.equal(await waitUntil(1000, () => !pidAlive(pid)), false);
    });

    await test('reports gone when ps fails for a dead pid', async (t) => {
        const env = await createTestEnv();
        t.after(() => {
            env.cleanup();
        });
        const pid = await deadPid(env);
        const fake = createFakeRunner();
        fake.respond('ps', 'ps', { code: 1, stdout: '' });
        assert.equal(await signalIfSame(fake.runner, pid, 'Mon Jan  1 00:00:00 2001', 'SIGTERM'), 'gone');
    });

    await test('reports gone when the pid dies while ps runs and ps fails', async (t) => {
        const env = await createTestEnv();
        t.after(() => {
            env.cleanup();
        });
        const pid = env.spawnOrphan('sleep', ['30']);
        let psCalls = 0;
        // ps kills the live orphan and answers only once it is confirmed dead, so only the check after ps can
        // tell the confirmed exit from an unverifiable live pid.
        const dyingRunner: CommandRunner = {
            run: async () => {
                psCalls += 1;
                process.kill(pid, 'SIGKILL');
                assert.ok(await waitUntil(3000, () => !pidAlive(pid)));
                return { code: 1, stdout: '', stderr: '' };
            },
        };
        assert.equal(pidAlive(pid), true);
        assert.equal(await signalIfSame(dyingRunner, pid, 'Mon Jan  1 00:00:00 2001', 'SIGTERM'), 'gone');
        assert.equal(psCalls, 1);
    });

    await test('reports a mismatch when the kill fails with EPERM and rethrows other kill errors', async (t) => {
        const env = await createTestEnv();
        t.after(() => {
            env.cleanup();
        });
        const pid = env.spawnOrphan('sleep', ['30']);
        const start = 'Thu Oct  1 10:00:00 2026';
        const fake = createFakeRunner();
        fake.respond('ps', 'ps', { stdout: `${start}\n` });
        const realKill = process.kill.bind(process);
        let failure = 'EPERM';
        const sent: (string | number | undefined)[] = [];
        // Only liveness probes reach the real kill; the signal itself fails as if the pid belonged to another user.
        t.mock.method(process, 'kill', (target: number, signal?: string | number): true => {
            if (signal === 0) {
                return realKill(target, signal);
            }
            sent.push(signal);
            throw errnoError(failure);
        });
        assert.equal(await signalIfSame(fake.runner, pid, start, 'SIGTERM'), 'mismatch');
        failure = 'EINVAL';
        await assert.rejects(signalIfSame(fake.runner, pid, start, 'SIGTERM'), { message: 'kill EINVAL' });
        t.mock.restoreAll();
        assert.deepEqual(sent, ['SIGTERM', 'SIGTERM']);
        assert.equal(pidAlive(pid), true);
    });
});
