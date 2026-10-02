import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test, type TestContext } from 'node:test';

import { createProcessRunner, pidAlive } from '../../src/proc.ts';
import type { CommandResult } from '../../src/types.ts';
import { stubCallCount, stubCalls, stubRespond } from '../support/stubQueue.ts';
import { createTestEnv, waitUntil, type TestEnv } from '../support/testEnv.ts';

const FIXTURES = path.join(import.meta.dirname, '..', 'fixtures', 'harness');
const GRAPHQL_ARGS = ['api', 'graphql', '--hostname', 'github.com', '--input', '-'];

function readFixture(name: string): unknown {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
    return parsed;
}

function parseStdout(result: CommandResult): unknown {
    const parsed: unknown = JSON.parse(result.stdout);
    return parsed;
}

function pollBody(): string {
    return JSON.stringify({ query: 'query PrwcPoll($owner: String!) { x }', variables: { owner: 'o' } });
}

function stubFile(env: TestEnv, name: string): string {
    return path.join(env.stubDir, name);
}

function filesUnder(dir: string): string[] {
    return fs
        .readdirSync(dir, { recursive: true, encoding: 'utf8' })
        .map((name) => path.join(dir, name))
        .filter((file) => fs.statSync(file).isFile());
}

// Reports whether the promise has settled yet without awaiting it.
function trackSettled<T>(promise: Promise<T>): { promise: Promise<T>; settled: () => boolean } {
    let done = false;
    const tracked = (async () => {
        const value = await promise;
        done = true;
        return value;
    })();
    return { promise: tracked, settled: () => done };
}

async function newEnv(t: TestContext, realTmux = false): Promise<TestEnv> {
    const env = await createTestEnv({ realTmux });
    t.after(() => {
        env.cleanup();
    });
    return env;
}

await describe('stub executables', async () => {
    await test('gh answers a graphql call from a queued fixture and records it', async (t) => {
        const env = await newEnv(t);
        const runner = createProcessRunner(env.env);
        const fixture = readFixture('pollFirst.json');
        stubRespond(env.stubDir, 'gh', 'PrwcPoll', { json: fixture });
        const result = await runner.run({ file: 'gh', args: GRAPHQL_ARGS, input: pollBody() });
        assert.equal(result.code, 0);
        assert.deepEqual(parseStdout(result), fixture);
        const calls = stubCalls(env.stubDir, 'gh');
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0]?.args, GRAPHQL_ARGS);
        assert.equal(calls[0]?.input, pollBody());
        assert.equal(stubCallCount(env.stubDir, 'gh', 'PrwcPoll'), 1);
        assert.ok(fs.existsSync(stubFile(env, 'gh.calls.jsonl')));
    });

    await test('gh prints a queued failure and exits with its code', async (t) => {
        const env = await newEnv(t);
        const runner = createProcessRunner(env.env);
        const body = readFixture('errorBody.json');
        stubRespond(env.stubDir, 'gh', 'PrwcPoll', { code: 1, json: body, stderr: 'gh: Could not resolve\n' });
        const result = await runner.run({ file: 'gh', args: GRAPHQL_ARGS, input: pollBody() });
        assert.equal(result.code, 1);
        assert.equal(result.stderr, 'gh: Could not resolve\n');
        assert.deepEqual(parseStdout(result), body);
    });

    await test('two processes consume one queue in order', async (t) => {
        const env = await newEnv(t);
        const runner = createProcessRunner(env.env);
        const first = readFixture('pollFirst.json');
        const second = readFixture('pollSecond.json');
        stubRespond(env.stubDir, 'gh', 'PrwcPoll', { json: first });
        stubRespond(env.stubDir, 'gh', 'PrwcPoll', { json: second });
        const one = await runner.run({ file: 'gh', args: GRAPHQL_ARGS, input: pollBody() });
        const two = await runner.run({ file: 'gh', args: GRAPHQL_ARGS, input: pollBody() });
        const three = await runner.run({ file: 'gh', args: GRAPHQL_ARGS, input: pollBody() });
        assert.deepEqual(parseStdout(one), first);
        assert.deepEqual(parseStdout(two), second);
        assert.deepEqual(parseStdout(three), second);
        assert.equal(stubCallCount(env.stubDir, 'gh', 'PrwcPoll'), 3);
    });

    await test('concurrent processes consume each queued response exactly once', async (t) => {
        const env = await newEnv(t);
        const runner = createProcessRunner(env.env);
        const count = 12;
        for (let index = 0; index < count; index += 1) {
            stubRespond(env.stubDir, 'gh', 'PrwcPoll', { json: { seq: index } });
        }
        const calls = Array.from({ length: count }, () =>
            runner.run({ file: 'gh', args: GRAPHQL_ARGS, input: pollBody() })
        );
        const results = await Promise.all(calls);
        const answers = results.map((result) => {
            assert.equal(result.code, 0);
            return result.stdout;
        });
        const expected = Array.from({ length: count }, (_value, index) => JSON.stringify({ seq: index }));
        assert.deepEqual(answers.toSorted(), expected.toSorted());
        const after = await runner.run({ file: 'gh', args: GRAPHQL_ARGS, input: pollBody() });
        assert.equal(after.stdout, JSON.stringify({ seq: count - 1 }));
        assert.equal(stubCallCount(env.stubDir, 'gh', 'PrwcPoll'), count + 1);
    });

    await test('tmux records an argument with spaces as one argument', async (t) => {
        const env = await newEnv(t);
        const runner = createProcessRunner(env.env);
        stubRespond(env.stubDir, 'tmux', 'split-window', { stdout: '%5 123\n' });
        const result = await runner.run({ file: 'tmux', args: ['-S', '/x', 'split-window', 'a b  c'] });
        assert.equal(result.stdout, '%5 123\n');
        assert.deepEqual(stubCalls(env.stubDir, 'tmux')[0]?.args, ['-S', '/x', 'split-window', 'a b  c']);
        assert.equal(stubCallCount(env.stubDir, 'tmux', 'split-window'), 1);
    });

    await test('claude records its argv byte-exact, its PATH and its own pid', async (t) => {
        const env = await newEnv(t);
        const tricky = `it's a $(echo x) "test"\nsecond line`;
        const observed = env.spawnObserved(path.join(env.binDir, 'claude'), ['--settings', tricky]);
        const result = await observed.result;
        assert.equal(result.code, 0);
        assert.equal(fs.readFileSync(stubFile(env, 'claude.argv'), 'utf8'), ['--settings', tricky].join('\0'));
        assert.equal(fs.readFileSync(stubFile(env, 'claude.path'), 'utf8'), env.env.PATH);
        assert.equal(fs.readFileSync(stubFile(env, 'claude.selfpid'), 'utf8').trim(), String(observed.pid));
        assert.equal(fs.readFileSync(stubFile(env, 'claude.ghenv'), 'utf8'), '');
    });

    await test('claude exits with STUB_CLAUDE_EXIT', async (t) => {
        const env = await newEnv(t);
        const observed = env.spawnObserved(path.join(env.binDir, 'claude'), [], {
            env: { ...env.env, STUB_CLAUDE_EXIT: '7' },
        });
        const result = await observed.result;
        assert.equal(result.code, 7);
    });

    await test('claude runs claude.script with its argv', async (t) => {
        const env = await newEnv(t);
        fs.writeFileSync(stubFile(env, 'claude.script'), 'printf "%s|" "$@" > "$STUB_DIR/script.out"\n');
        const observed = env.spawnObserved(path.join(env.binDir, 'claude'), ['a b', 'c']);
        const result = await observed.result;
        assert.equal(result.code, 0);
        assert.equal(fs.readFileSync(stubFile(env, 'script.out'), 'utf8'), 'a b|c|');
    });

    await test('claude with STUB_CLAUDE_WAIT=1 stays alive until SIGTERM and exits 143', async (t) => {
        const env = await newEnv(t);
        const observed = env.spawnObserved(path.join(env.binDir, 'claude'), [], {
            env: { ...env.env, STUB_CLAUDE_WAIT: '1' },
        });
        assert.ok(await waitUntil(5000, () => fs.existsSync(stubFile(env, 'claude.selfpid'))));
        assert.equal(await waitUntil(1000, () => !pidAlive(observed.pid)), false);
        process.kill(observed.pid, 'SIGTERM');
        const result = await observed.result;
        assert.equal(result.code, 143);
        assert.ok(await waitUntil(3000, () => !pidAlive(observed.pid)));
    });

    await test('spawnOrphan gives a live pid that is gone after SIGKILL', async (t) => {
        const env = await newEnv(t);
        const pid = env.spawnOrphan('sleep', ['30']);
        assert.equal(pidAlive(pid), true);
        process.kill(pid, 'SIGKILL');
        assert.ok(await waitUntil(3000, () => !pidAlive(pid)));
    });

    await test('a delayed gh response keeps the stub alive and then answers', async (t) => {
        const env = await newEnv(t);
        const runner = createProcessRunner(env.env);
        const delayMs = 4000;
        stubRespond(env.stubDir, 'gh', 'auth_status', { stdout: 'late\n', delayMs });
        const started = Date.now();
        const pending = trackSettled(runner.run({ file: 'gh', args: ['auth', 'status'] }));
        // The stub records the call before its delay starts, so from the moment the record appears it stays alive
        // for nearly the whole delay, far longer than the one second checked here.
        assert.ok(await waitUntil(3000, () => stubCalls(env.stubDir, 'gh').length === 1));
        const pid = stubCalls(env.stubDir, 'gh')[0]?.pid ?? 0;
        assert.ok(pid > 1);
        assert.equal(await waitUntil(1000, () => !pidAlive(pid) || pending.settled()), false);
        const result = await pending.promise;
        assert.equal(result.code, 0);
        assert.equal(result.stdout, 'late\n');
        assert.ok(Date.now() - started >= delayMs - 100);
    });

    await test('gh records the caller GH_CONFIG_DIR and GH_HOST', async (t) => {
        const env = await newEnv(t);
        const runner = createProcessRunner(env.env);
        await runner.run({
            file: 'gh',
            args: ['auth', 'status'],
            env: { ...env.env, GH_CONFIG_DIR: '/cfg', GH_HOST: 'github.com' },
        });
        await runner.run({ file: 'gh', args: ['auth', 'status'] });
        const calls = stubCalls(env.stubDir, 'gh');
        assert.equal(calls[0]?.ghConfigDir, '/cfg');
        assert.equal(calls[0]?.ghHost, 'github.com');
        assert.equal(calls[1]?.ghConfigDir, '');
        assert.equal(calls[1]?.ghHost, '');
    });

    await test('gh records token variable names but never their values', async (t) => {
        const env = await newEnv(t);
        const observed = env.spawnObserved(path.join(env.binDir, 'gh'), ['auth', 'status'], {
            env: { ...env.env, GH_TOKEN: 'tok-value' },
        });
        const result = await observed.result;
        assert.equal(result.code, 0);
        assert.deepEqual(stubCalls(env.stubDir, 'gh')[0]?.tokenVars, ['GH_TOKEN']);
        for (const file of filesUnder(env.stubDir)) {
            assert.ok(!fs.readFileSync(file, 'utf8').includes('tok-value'), `${file} holds the token`);
        }
    });

    await test('claude writes claude.ghenv with names for token variables', async (t) => {
        const env = await newEnv(t);
        const observed = env.spawnObserved(path.join(env.binDir, 'claude'), [], {
            env: { ...env.env, GH_TOKEN: 'tok-value', GH_HOST: 'h.example' },
        });
        await observed.result;
        const ghenv = fs.readFileSync(stubFile(env, 'claude.ghenv'), 'utf8');
        assert.deepEqual(ghenv.split('\n'), ['GH_HOST=h.example', 'GH_TOKEN=set', '']);
        for (const file of filesUnder(env.stubDir)) {
            assert.ok(!fs.readFileSync(file, 'utf8').includes('tok-value'), `${file} holds the token`);
        }
    });

    await test('spawnObserved keeps the exit code and output', async (t) => {
        const env = await newEnv(t);
        const observed = env.spawnObserved('/bin/sh', ['-c', 'echo hi; echo err 1>&2; exit 3']);
        const result = await observed.result;
        assert.equal(result.code, 3);
        assert.equal(result.signal, undefined);
        assert.equal(result.stdout, 'hi\n');
        assert.equal(result.stderr, 'err\n');
        assert.ok(await waitUntil(3000, () => !pidAlive(observed.pid)));
    });
});

await describe('createTestEnv', async () => {
    await test('canonicalizes a root under a symlinked TMPDIR', async (t) => {
        const outer = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'prwc-tmpdir-')));
        const target = path.join(outer, 'target');
        const link = path.join(outer, 'link');
        fs.mkdirSync(target);
        fs.symlinkSync(target, link);
        const previous = process.env.TMPDIR;
        t.after(() => {
            fs.rmSync(outer, { recursive: true, force: true });
        });
        process.env.TMPDIR = link;
        let env: TestEnv;
        try {
            env = await createTestEnv();
        } finally {
            if (previous === undefined) {
                delete process.env.TMPDIR;
            } else {
                process.env.TMPDIR = previous;
            }
        }
        t.after(() => {
            env.cleanup();
        });
        assert.equal(env.root, fs.realpathSync.native(env.root));
        assert.ok(env.root.startsWith(`${target}${path.sep}`));
        assert.equal(env.stateDir, path.join(env.root, 'state'));
        assert.equal(fs.existsSync(env.stateDir), false);
    });

    await test('builds PATH from scratch with the stubs first', async (t) => {
        const env = await newEnv(t);
        assert.deepEqual(env.env.PATH?.split(':'), [env.binDir, env.toolsDir, '/usr/bin', '/bin']);
        const runner = createProcessRunner(env.env);
        const result = await runner.run({ file: '/bin/sh', args: ['-c', 'command -v claude; command -v gh'] });
        assert.equal(result.stdout, `${path.join(env.binDir, 'claude')}\n${path.join(env.binDir, 'gh')}\n`);
        assert.equal(env.env.GIT_ALLOW_PROTOCOL, 'file');
        assert.equal(env.env.PRWC_TEST_NODE, process.execPath);
        assert.equal(env.env.PRWC_STATE_DIR, env.stateDir);
        assert.equal(env.env.STUB_DIR, env.stubDir);
        assert.equal(env.env.HOME, env.home);
        assert.equal(fs.readlinkSync(path.join(env.toolsDir, 'git')), env.tools.git);
        assert.equal(fs.readlinkSync(path.join(env.toolsDir, 'node')), env.tools.node);
    });

    await test('uses the real tmux from the tools directory with realTmux', async (t) => {
        const env = await newEnv(t, true);
        assert.ok(env.tools.tmux !== undefined);
        const runner = createProcessRunner(env.env);
        const result = await runner.run({ file: '/bin/sh', args: ['-c', 'command -v tmux'] });
        assert.equal(result.stdout, `${path.join(env.toolsDir, 'tmux')}\n`);
        assert.equal(fs.existsSync(path.join(env.binDir, 'tmux')), false);
    });

    await test('stubs tmux by default', async (t) => {
        const env = await newEnv(t);
        const runner = createProcessRunner(env.env);
        const result = await runner.run({ file: '/bin/sh', args: ['-c', 'command -v tmux'] });
        assert.equal(result.stdout, `${path.join(env.binDir, 'tmux')}\n`);
    });

    await test('deps captures log lines and output', async (t) => {
        const env = await newEnv(t);
        const deps = env.deps(createProcessRunner(env.env));
        deps.log.info('one');
        deps.log.warn('two');
        deps.log.error('three');
        deps.out('a');
        deps.out('b\n');
        assert.deepEqual(deps.logLines, ['info one', 'warn two', 'error three']);
        assert.equal(deps.outText(), 'ab\n');
        assert.equal(deps.env, env.env);
        const controller = new AbortController();
        controller.abort();
        const started = Date.now();
        await deps.sleep(5000, controller.signal);
        assert.ok(Date.now() - started < 1000);
    });
});
