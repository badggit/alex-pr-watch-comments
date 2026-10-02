import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
    capDonePanes,
    killPane,
    markPaneDone,
    newWatcherWindow,
    paneForRun,
    paneState,
    paneWatcherTag,
    parseTmuxEnv,
    splitWorker,
    tmuxInit,
    tmuxLiteral,
    tmuxMessage,
    tmuxOn,
    type TmuxDeps,
} from '../../src/tmuxControl.ts';
import type { Env, TmuxContext } from '../../src/types.ts';
import { createFakeRunner, type FakeRunner, type RecordedCall } from '../support/fakeRunner.ts';
import { createTestEnv } from '../support/testEnv.ts';

const TMUX = '/opt/fake/bin/tmux';
const SOCKET = '/tmp/prwc-test-socket';
const WORKER_SOCKET = '/tmp/worker-socket';
const CONTEXT: TmuxContext = { socket: SOCKET, pane: '%1', sessionId: '$1', windowId: '@2' };
const SPLIT_FORMAT = '#{pane_id} #{pane_pid}';
const WINDOW_FORMAT = '#{window_id} #{pane_id}';
const NO_SPACE = { code: 1, stderr: 'no space for new pane\n' };
const RUN_ID = '20260101000000-11';
const PR_KEY = 'o+r+12';
const ENV_ITEMS = ['PATH=/a:/b', 'GH_CONFIG_DIR=/cfg dir'];
const COMMAND = ['/bin/sh', '/tmp/run dir/launcher.sh'];
const BASE_ENV: Env = { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' };

function depsOf(fake: FakeRunner): TmuxDeps {
    return { runner: fake.runner, env: BASE_ENV };
}

// The tmux arguments after the leading -S SOCKET pair.
function tmuxArgs(call: RecordedCall | undefined): string[] {
    assert.ok(call);
    return call.args.slice(2);
}

function socketOf(call: RecordedCall | undefined): string[] {
    assert.ok(call);
    return call.args.slice(0, 2);
}

function splitOpts(dir: string) {
    return { runId: RUN_ID, prKey: PR_KEY, dir, envItems: ENV_ITEMS, command: COMMAND };
}

await describe('tmuxLiteral and parseTmuxEnv', async () => {
    await test('tmuxLiteral doubles every #', () => {
        assert.equal(tmuxLiteral('/a#b##c'), '/a##b####c');
        assert.equal(tmuxLiteral('/plain'), '/plain');
    });

    await test('parseTmuxEnv takes the socket before the first comma and the pane', () => {
        assert.deepEqual(parseTmuxEnv({ TMUX: '/tmp/s,1,0', TMUX_PANE: '%3' }), { socket: '/tmp/s', pane: '%3' });
    });

    await test('parseTmuxEnv is undefined when either variable is empty or missing', () => {
        assert.equal(parseTmuxEnv({ TMUX_PANE: '%3' }), undefined);
        assert.equal(parseTmuxEnv({ TMUX: '', TMUX_PANE: '%3' }), undefined);
        assert.equal(parseTmuxEnv({ TMUX: '/tmp/s,1,0', TMUX_PANE: '' }), undefined);
        assert.equal(parseTmuxEnv({ TMUX: '/tmp/s,1,0' }), undefined);
    });
});

await describe('tmuxOn', async () => {
    await test('a relative socket gives undefined with no call', async () => {
        const fake = createFakeRunner();
        const result = await tmuxOn(depsOf(fake), TMUX, 'relative/sock', ['list-sessions']);
        assert.equal(result, undefined);
        assert.equal(fake.calls().length, 0);
    });

    await test('an absolute socket is passed with -S before the arguments', async () => {
        const fake = createFakeRunner();
        fake.respond('tmux', 'list-sessions', { stdout: 'prwc\n' });
        const result = await tmuxOn(depsOf(fake), TMUX, '/tmp/tmux_dir/default', ['list-sessions']);
        assert.deepEqual(result, { code: 0, stdout: 'prwc\n', stderr: '' });
        const [call] = fake.calls();
        assert.ok(call);
        assert.equal(call.file, TMUX);
        assert.deepEqual(call.args, ['-S', '/tmp/tmux_dir/default', 'list-sessions']);
    });
});

await describe('tmuxInit', async () => {
    await test('without TMUX it refuses with no call', async () => {
        const fake = createFakeRunner();
        const result = await tmuxInit({ runner: fake.runner, env: { TMUX_PANE: '%1' } }, TMUX);
        assert.deepEqual(result, { ok: false, reason: 'must run inside tmux' });
        assert.equal(fake.calls().length, 0);
    });

    await test('with the harness env it resolves session and window on the explicit socket', async (t) => {
        const testEnv = await createTestEnv();
        t.after(() => {
            testEnv.cleanup();
        });
        const fake = createFakeRunner();
        fake.respond('tmux', 'display-message', { stdout: '$3 @7\n' });
        const result = await tmuxInit({ runner: fake.runner, env: testEnv.env }, TMUX);
        assert.deepEqual(result, {
            ok: true,
            tmux: { socket: SOCKET, pane: '%1', sessionId: '$3', windowId: '@7' },
        });
        const calls = fake.calls();
        assert.ok(calls.length > 0);
        for (const call of calls) {
            assert.deepEqual(socketOf(call), ['-S', SOCKET]);
        }
        assert.deepEqual(tmuxArgs(calls[0]), ['display-message', '-p', '-t', '%1', '#{session_id} #{window_id}']);
    });

    await test('an unreadable session gives a failure', async () => {
        const fake = createFakeRunner();
        fake.respond('tmux', 'display-message', { code: 1, stderr: 'no server running\n' });
        const env = { TMUX: `${SOCKET},1,0`, TMUX_PANE: '%1' };
        const result = await tmuxInit({ runner: fake.runner, env }, TMUX);
        assert.equal(result.ok, false);
    });
});

await describe('paneForRun', async () => {
    await test('returns the pane whose @prwc_run matches on the given socket', async () => {
        const fake = createFakeRunner();
        fake.respond('tmux', 'list-panes', { stdout: '%3 R0\n%4 \n%5 R1\n' });
        const pane = await paneForRun(depsOf(fake), TMUX, WORKER_SOCKET, 'R1');
        assert.equal(pane, '%5');
        const [call] = fake.calls();
        assert.deepEqual(socketOf(call), ['-S', WORKER_SOCKET]);
        assert.deepEqual(tmuxArgs(call), ['list-panes', '-a', '-F', '#{pane_id} #{@prwc_run}']);
    });

    await test('is undefined when no pane matches or the server is unreachable', async () => {
        const fake = createFakeRunner();
        fake.respond('tmux', 'list-panes', { stdout: '%3 R0\n' });
        assert.equal(await paneForRun(depsOf(fake), TMUX, WORKER_SOCKET, 'R1'), undefined);
        const failing = createFakeRunner();
        failing.respond('tmux', 'list-panes', { code: 1, stdout: '%5 R1\n', stderr: 'no server running\n' });
        assert.equal(await paneForRun(depsOf(failing), TMUX, WORKER_SOCKET, 'R1'), undefined);
    });
});

await describe('markPaneDone', async () => {
    await test('sets @prwc_done when the pane still carries the run id', async () => {
        const fake = createFakeRunner();
        fake.respond('tmux', 'display-message', { stdout: 'R1\n' });
        const done = await markPaneDone(depsOf(fake), TMUX, WORKER_SOCKET, '%7', 'R1', 100);
        assert.equal(done, true);
        const calls = fake.calls();
        assert.deepEqual(tmuxArgs(calls[0]), ['display-message', '-p', '-t', '%7', '#{@prwc_run}']);
        assert.deepEqual(socketOf(calls[1]), ['-S', WORKER_SOCKET]);
        assert.deepEqual(tmuxArgs(calls[1]), ['set-option', '-p', '-t', '%7', '@prwc_done', '100']);
    });

    await test('a pane of another run is left alone', async () => {
        const fake = createFakeRunner();
        fake.respond('tmux', 'display-message', { stdout: 'R2\n' });
        const done = await markPaneDone(depsOf(fake), TMUX, WORKER_SOCKET, '%7', 'R1', 100);
        assert.equal(done, false);
        assert.equal(fake.callCount('tmux', 'set-option'), 0);
    });

    await test('an unreadable pane gives false with no set-option', async () => {
        const fake = createFakeRunner();
        fake.respond('tmux', 'display-message', { code: 1, stdout: 'R1\n', stderr: "can't find pane: %7\n" });
        const done = await markPaneDone(depsOf(fake), TMUX, WORKER_SOCKET, '%7', 'R1', 100);
        assert.equal(done, false);
        assert.equal(fake.callCount('tmux', 'set-option'), 0);
    });
});

await describe('splitWorker', async () => {
    await test('happy path splits once with literal env items and command, then tags the pane', async () => {
        const fake = createFakeRunner();
        fake.respond('tmux', 'split-window', { stdout: '%5 4242\n' });
        const result = await splitWorker(depsOf(fake), TMUX, CONTEXT, splitOpts('/tmp/work'));
        assert.deepEqual(result, { paneId: '%5', panePid: 4242 });
        const calls = fake.calls();
        assert.deepEqual(
            calls.map((call) => call.key),
            ['split-window', 'set-option', 'set-option']
        );
        assert.equal(fake.callCount('tmux', 'split-window'), 1);
        assert.deepEqual(tmuxArgs(calls[0]), [
            'split-window',
            '-d',
            '-P',
            '-F',
            SPLIT_FORMAT,
            '-t',
            '%1',
            '-c',
            '/tmp/work',
            '-e',
            'PATH=/a:/b',
            '-e',
            'GH_CONFIG_DIR=/cfg dir',
            '/bin/sh',
            '/tmp/run dir/launcher.sh',
        ]);
        assert.deepEqual(calls[0]?.env, { ...BASE_ENV, PATH: '/a:/b' });
        assert.deepEqual(tmuxArgs(calls[1]), ['set-option', '-p', '-t', '%5', '@prwc_run', RUN_ID]);
        assert.deepEqual(tmuxArgs(calls[2]), ['set-option', '-p', '-t', '%5', '@prwc_pr', PR_KEY]);
        for (const call of calls) {
            assert.deepEqual(socketOf(call), ['-S', SOCKET]);
        }
    });

    await test('a # in the directory is escaped for format expansion', async () => {
        const fake = createFakeRunner();
        fake.respond('tmux', 'split-window', { stdout: '%5 4242\n' });
        await splitWorker(depsOf(fake), TMUX, CONTEXT, splitOpts('/tmp/a#b'));
        const args = tmuxArgs(fake.calls()[0]);
        assert.equal(args[args.indexOf('-c') + 1], '/tmp/a##b');
    });

    await test('a pid that is not an unsigned integer gives undefined', async () => {
        for (const stdout of ['%5 abc\n', '%5\n', '%5 -1\n', '']) {
            const fake = createFakeRunner();
            fake.respond('tmux', 'split-window', { stdout });
            const result = await splitWorker(depsOf(fake), TMUX, CONTEXT, splitOpts('/tmp/work'));
            assert.equal(result, undefined, stdout);
        }
    });

    await test('no space twice: tiled layout, one retry, then a tagged new window', async () => {
        const fake = createFakeRunner();
        fake.respond('tmux', 'split-window', NO_SPACE);
        fake.respond('tmux', 'new-window', { stdout: '%9 777\n' });
        const result = await splitWorker(depsOf(fake), TMUX, CONTEXT, splitOpts('/tmp/work'));
        assert.deepEqual(result, { paneId: '%9', panePid: 777 });
        const calls = fake.calls();
        assert.deepEqual(
            calls.map((call) => call.key),
            ['split-window', 'select-layout', 'split-window', 'new-window', 'set-option', 'set-option', 'set-option']
        );
        assert.deepEqual(tmuxArgs(calls[1]), ['select-layout', '-t', '@2', 'tiled']);
        assert.deepEqual(tmuxArgs(calls[2]), tmuxArgs(calls[0]));
        assert.deepEqual(tmuxArgs(calls[3]), [
            'new-window',
            '-d',
            '-P',
            '-F',
            SPLIT_FORMAT,
            '-t',
            '$1:',
            '-e',
            'PATH=/a:/b',
            '-e',
            'GH_CONFIG_DIR=/cfg dir',
            '/bin/sh',
            '/tmp/run dir/launcher.sh',
        ]);
        assert.deepEqual(calls[3]?.env, { ...BASE_ENV, PATH: '/a:/b' });
        assert.deepEqual(tmuxArgs(calls[4]), ['set-option', '-w', '-t', '%9', '@prwc_overflow', PR_KEY]);
        assert.deepEqual(tmuxArgs(calls[5]), ['set-option', '-p', '-t', '%9', '@prwc_run', RUN_ID]);
        assert.deepEqual(tmuxArgs(calls[6]), ['set-option', '-p', '-t', '%9', '@prwc_pr', PR_KEY]);
    });

    await test('no space once: the retry after the tiled layout succeeds', async () => {
        const fake = createFakeRunner();
        fake.respond('tmux', 'split-window', NO_SPACE);
        fake.respond('tmux', 'split-window', { stdout: '%6 555\n' });
        const result = await splitWorker(depsOf(fake), TMUX, CONTEXT, splitOpts('/tmp/work'));
        assert.deepEqual(result, { paneId: '%6', panePid: 555 });
        assert.equal(fake.callCount('tmux', 'new-window'), 0);
        assert.equal(fake.callCount('tmux', 'select-layout'), 1);
    });

    await test('every attempt failing gives undefined and tags nothing', async () => {
        const fake = createFakeRunner();
        fake.respond('tmux', 'split-window', NO_SPACE);
        fake.respond('tmux', 'new-window', { code: 1, stderr: 'create window failed\n' });
        const result = await splitWorker(depsOf(fake), TMUX, CONTEXT, splitOpts('/tmp/work'));
        assert.equal(result, undefined);
        assert.equal(fake.callCount('tmux', 'split-window'), 2);
        assert.equal(fake.callCount('tmux', 'new-window'), 1);
        assert.equal(fake.callCount('tmux', 'set-option'), 0);
    });

    await test('another split failure gives undefined without a fallback', async () => {
        const fake = createFakeRunner();
        fake.respond('tmux', 'split-window', { code: 1, stderr: "can't find pane: %1\n" });
        const result = await splitWorker(depsOf(fake), TMUX, CONTEXT, splitOpts('/tmp/work'));
        assert.equal(result, undefined);
        assert.deepEqual(
            fake.calls().map((call) => call.key),
            ['split-window']
        );
    });

    await test('without a PATH item the split runs with the runner base env', async () => {
        const fake = createFakeRunner();
        fake.respond('tmux', 'split-window', { stdout: '%5 4242\n' });
        const opts = { ...splitOpts('/tmp/work'), envItems: ['GH_CONFIG_DIR=/cfg'] };
        await splitWorker(depsOf(fake), TMUX, CONTEXT, opts);
        assert.equal(fake.calls()[0]?.env, undefined);
    });

    await test('a failing @prwc_run tag kills the new pane and gives undefined', async () => {
        const fake = createFakeRunner();
        fake.respond('tmux', 'split-window', { stdout: '%5 4242\n' });
        fake.respond('tmux', 'set-option', { code: 1, stderr: 'no such pane\n' });
        const result = await splitWorker(depsOf(fake), TMUX, CONTEXT, splitOpts('/tmp/work'));
        assert.equal(result, undefined);
        const calls = fake.calls();
        assert.deepEqual(
            calls.map((call) => call.key),
            ['split-window', 'set-option', 'kill-pane']
        );
        assert.deepEqual(tmuxArgs(calls[1]), ['set-option', '-p', '-t', '%5', '@prwc_run', RUN_ID]);
        assert.deepEqual(tmuxArgs(calls[2]), ['kill-pane', '-t', '%5']);
        assert.deepEqual(socketOf(calls[2]), ['-S', SOCKET]);
    });

    await test('a failing @prwc_pr tag kills the new pane and gives undefined', async () => {
        const fake = createFakeRunner();
        fake.respond('tmux', 'split-window', { stdout: '%5 4242\n' });
        fake.respond('tmux', 'set-option', { code: 0 });
        fake.respond('tmux', 'set-option', { code: 1, stderr: 'no such pane\n' });
        const result = await splitWorker(depsOf(fake), TMUX, CONTEXT, splitOpts('/tmp/work'));
        assert.equal(result, undefined);
        const calls = fake.calls();
        assert.deepEqual(
            calls.map((call) => call.key),
            ['split-window', 'set-option', 'set-option', 'kill-pane']
        );
        assert.deepEqual(tmuxArgs(calls[2]), ['set-option', '-p', '-t', '%5', '@prwc_pr', PR_KEY]);
        assert.deepEqual(tmuxArgs(calls[3]), ['kill-pane', '-t', '%5']);
    });

    await test('an unsafe socket gives undefined with no call', async () => {
        const fake = createFakeRunner();
        const unsafe = { ...CONTEXT, socket: 'relative/sock' };
        const result = await splitWorker(depsOf(fake), TMUX, unsafe, splitOpts('/tmp/work'));
        assert.equal(result, undefined);
        assert.equal(fake.calls().length, 0);
    });
});

await describe('tmuxMessage', async () => {
    await test('the message reaches display-message without #', async () => {
        const fake = createFakeRunner();
        await tmuxMessage(depsOf(fake), TMUX, CONTEXT, 'PR 12 done #{pane_id}');
        const [call] = fake.calls();
        assert.deepEqual(socketOf(call), ['-S', SOCKET]);
        const args = tmuxArgs(call);
        assert.deepEqual(args.slice(0, 4), ['display-message', '-t', '%1', '--']);
        assert.equal(args.length, 5);
        const text = args[4] ?? '';
        assert.ok(text.startsWith('PR 12 done '), text);
        assert.ok(!text.includes('#'), text);
    });

    await test('a message starting with - follows the end of options', async () => {
        const fake = createFakeRunner();
        await tmuxMessage(depsOf(fake), TMUX, CONTEXT, '-x not a flag');
        assert.deepEqual(tmuxArgs(fake.calls()[0]), ['display-message', '-t', '%1', '--', '-x not a flag']);
    });
});

await describe('capDonePanes', async () => {
    await test('kills the oldest done panes of the PR beyond keep, by @prwc_done only', async () => {
        const fake = createFakeRunner();
        fake.respond('tmux', 'list-panes', {
            stdout: [
                `%1 ${PR_KEY} `,
                `%2 ${PR_KEY} 400`,
                `%3 ${PR_KEY} 100`,
                '%4 other+r+1 50',
                `%5 ${PR_KEY} 300`,
                `%6 ${PR_KEY} 200`,
                '',
            ].join('\n'),
        });
        await capDonePanes(depsOf(fake), TMUX, WORKER_SOCKET, PR_KEY, 2);
        const listCalls = fake.calls().filter((call) => call.key === 'list-panes');
        assert.equal(listCalls.length, 1);
        assert.deepEqual(socketOf(listCalls[0]), ['-S', WORKER_SOCKET]);
        const kills = fake.calls().filter((call) => call.key === 'kill-pane');
        assert.deepEqual(
            kills.map((call) => tmuxArgs(call)),
            [
                ['kill-pane', '-t', '%3'],
                ['kill-pane', '-t', '%6'],
            ]
        );
        for (const call of kills) {
            assert.deepEqual(socketOf(call), ['-S', WORKER_SOCKET]);
        }
    });

    await test('nothing is killed within keep or when the listing fails', async () => {
        const fake = createFakeRunner();
        fake.respond('tmux', 'list-panes', { stdout: `%2 ${PR_KEY} 400\n%3 ${PR_KEY} 100\n` });
        await capDonePanes(depsOf(fake), TMUX, WORKER_SOCKET, PR_KEY, 2);
        assert.equal(fake.callCount('tmux', 'kill-pane'), 0);
        const failing = createFakeRunner();
        failing.respond('tmux', 'list-panes', { code: 1, stdout: `%3 ${PR_KEY} 100\n` });
        await capDonePanes(depsOf(failing), TMUX, WORKER_SOCKET, PR_KEY, 0);
        assert.equal(failing.callCount('tmux', 'kill-pane'), 0);
    });
});

await describe('newWatcherWindow', async () => {
    const watcherCommand = ['/opt/node/bin/node', '/opt/plugin/src/main.ts', '--background-child'];

    await test('passes each env item as one -e argument and sets both options', async () => {
        const fake = createFakeRunner();
        fake.respond('tmux', 'new-window', { stdout: '@4 %8\n' });
        const items = ['PATH=/a b', 'PRWC_STATE_DIR=/s'];
        const result = await newWatcherWindow(depsOf(fake), TMUX, CONTEXT, PR_KEY, items, watcherCommand);
        assert.deepEqual(result, { windowId: '@4', paneId: '%8' });
        const calls = fake.calls();
        assert.deepEqual(tmuxArgs(calls[0]), [
            'new-window',
            '-d',
            '-P',
            '-F',
            WINDOW_FORMAT,
            '-t',
            '$1:',
            '-e',
            'PATH=/a b',
            '-e',
            'PRWC_STATE_DIR=/s',
            ...watcherCommand,
        ]);
        assert.deepEqual(tmuxArgs(calls[1]), ['set-option', '-w', '-t', '@4', '@prwc_watcher', PR_KEY]);
        assert.deepEqual(tmuxArgs(calls[2]), ['set-option', '-p', '-t', '%8', 'remain-on-exit', 'on']);
        assert.deepEqual(calls[0]?.env, { ...BASE_ENV, PATH: '/a b' });
        assert.equal(calls.length, 3);
        for (const call of calls) {
            assert.deepEqual(socketOf(call), ['-S', SOCKET]);
        }
    });

    await test('with no env items it passes no -e', async () => {
        const fake = createFakeRunner();
        fake.respond('tmux', 'new-window', { stdout: '@4 %8\n' });
        await newWatcherWindow(depsOf(fake), TMUX, CONTEXT, PR_KEY, [], watcherCommand);
        const args = tmuxArgs(fake.calls()[0]);
        assert.ok(!args.includes('-e'));
        assert.equal(fake.calls()[0]?.env, undefined);
        assert.deepEqual(args, ['new-window', '-d', '-P', '-F', WINDOW_FORMAT, '-t', '$1:', ...watcherCommand]);
    });

    await test('a failing remain-on-exit kills the created window', async () => {
        const fake = createFakeRunner();
        fake.respond('tmux', 'new-window', { stdout: '@4 %8\n' });
        fake.respond('tmux', 'set-option', { code: 0 });
        fake.respond('tmux', 'set-option', { code: 1, stderr: 'invalid option\n' });
        const result = await newWatcherWindow(depsOf(fake), TMUX, CONTEXT, PR_KEY, [], watcherCommand);
        assert.equal(result, undefined);
        const kills = fake.calls().filter((call) => call.key === 'kill-window');
        assert.deepEqual(
            kills.map((call) => tmuxArgs(call)),
            [['kill-window', '-t', '@4']]
        );
    });

    await test('a failing @prwc_watcher option kills the window before remain-on-exit', async () => {
        const fake = createFakeRunner();
        fake.respond('tmux', 'new-window', { stdout: '@4 %8\n' });
        fake.respond('tmux', 'set-option', { code: 1 });
        const result = await newWatcherWindow(depsOf(fake), TMUX, CONTEXT, PR_KEY, [], watcherCommand);
        assert.equal(result, undefined);
        assert.equal(fake.callCount('tmux', 'set-option'), 1);
        assert.equal(fake.callCount('tmux', 'kill-window'), 1);
    });

    await test('a failing or unparsable new-window gives undefined and sets nothing', async () => {
        for (const response of [{ code: 1, stderr: 'failed\n' }, { stdout: 'garbage\n' }]) {
            const fake = createFakeRunner();
            fake.respond('tmux', 'new-window', response);
            const result = await newWatcherWindow(depsOf(fake), TMUX, CONTEXT, PR_KEY, [], watcherCommand);
            assert.equal(result, undefined);
            assert.equal(fake.callCount('tmux', 'set-option'), 0);
        }
    });
});

await describe('paneState and killPane', async () => {
    await test('maps alive, dead and missing panes', async () => {
        const cases: [string, string][] = [
            ['%3 1\n%4 0\n', 'alive'],
            ['%4 1\n', 'dead'],
            ['%3 0\n', 'missing'],
        ];
        for (const [stdout, expected] of cases) {
            const fake = createFakeRunner();
            fake.respond('tmux', 'list-panes', { stdout });
            const state = await paneState(depsOf(fake), TMUX, WORKER_SOCKET, '%4');
            assert.equal(state, expected, stdout);
            const [call] = fake.calls();
            assert.deepEqual(socketOf(call), ['-S', WORKER_SOCKET]);
            assert.deepEqual(tmuxArgs(call), ['list-panes', '-a', '-F', '#{pane_id} #{pane_dead}']);
        }
    });

    await test('an unreachable server reports the pane missing', async () => {
        const fake = createFakeRunner();
        fake.respond('tmux', 'list-panes', { code: 1, stdout: '%4 0\n', stderr: 'no server running\n' });
        assert.equal(await paneState(depsOf(fake), TMUX, WORKER_SOCKET, '%4'), 'missing');
    });

    await test('killPane kills the pane on the given socket', async () => {
        const fake = createFakeRunner();
        await killPane(depsOf(fake), TMUX, WORKER_SOCKET, '%4');
        const [call] = fake.calls();
        assert.deepEqual(call?.args, ['-S', WORKER_SOCKET, 'kill-pane', '-t', '%4']);
    });
});

await describe('paneWatcherTag', async () => {
    await test('returns the trimmed tag on the given socket', async () => {
        const fake = createFakeRunner();
        fake.respond('tmux', 'display-message', { stdout: 'o+r+12\n' });
        const tag = await paneWatcherTag(depsOf(fake), TMUX, WORKER_SOCKET, '%8');
        assert.equal(tag, 'o+r+12');
        const [call] = fake.calls();
        assert.deepEqual(socketOf(call), ['-S', WORKER_SOCKET]);
        assert.deepEqual(tmuxArgs(call), ['display-message', '-p', '-t', '%8', '#{@prwc_watcher}']);
    });

    await test('empty output and a failed call give undefined', async () => {
        const empty = createFakeRunner();
        empty.respond('tmux', 'display-message', { stdout: '\n' });
        assert.equal(await paneWatcherTag(depsOf(empty), TMUX, WORKER_SOCKET, '%8'), undefined);
        const failing = createFakeRunner();
        failing.respond('tmux', 'display-message', { code: 1, stdout: 'o+r+12\n' });
        assert.equal(await paneWatcherTag(depsOf(failing), TMUX, WORKER_SOCKET, '%8'), undefined);
    });
});
