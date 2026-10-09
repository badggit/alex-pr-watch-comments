import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { gridLayout } from '../../src/paneGrid.ts';
import {
    arrangeGrid,
    capDonePanes,
    formatLiteral,
    killDeadWatcherPane,
    killPane,
    markPaneDone,
    newWatcherSession,
    NOT_IN_TMUX,
    paneForRun,
    paneState,
    paneWatcherTag,
    parseTmuxEnv,
    serverSocket,
    splitWorker,
    tmuxArg,
    tmuxInit,
    tmuxLiteral,
    tmuxMessage,
    tmuxOn,
    type TmuxDeps,
    watcherSessionName,
} from '../../src/tmuxControl.ts';
import type { Env, TmuxContext } from '../../src/types.ts';
import { createFakeRunner, type FakeRunner, type RecordedCall } from '../support/fakeRunner.ts';
import { createTestEnv } from '../support/testEnv.ts';

const TMUX = '/opt/fake/bin/tmux';
const SOCKET = '/tmp/prwc-test-socket';
const WORKER_SOCKET = '/tmp/worker-socket';
const CONTEXT: TmuxContext = { socket: SOCKET, pane: '%1', sessionId: '$1', windowId: '@2' };
const SPLIT_FORMAT = '#{pane_id} #{pane_pid}';
const SESSION_FORMAT = '#{session_id} #{window_id} #{pane_id}';
const NO_SPACE = { code: 1, stderr: 'no space for new pane\n' };
const NO_SPACE_TMUX37 = { code: 1, stderr: 'size or position no space for a new pane\n' };
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

    await test('an argument ending in ; gets one backslash before it, so tmux does not read a separator', async () => {
        const fake = createFakeRunner();
        const args = ['new-window', '-e', 'X=y;', 'value;', String.raw`a\;`, ';', 'plain', 'mid;dle'];
        await tmuxOn(depsOf(fake), TMUX, SOCKET, args);
        assert.deepEqual(tmuxArgs(fake.calls()[0]), [
            'new-window',
            '-e',
            String.raw`X=y\;`,
            String.raw`value\;`,
            String.raw`a\\;`,
            String.raw`\;`,
            'plain',
            'mid;dle',
        ]);
    });
});

await describe('tmuxArg and formatLiteral', async () => {
    await test('tmuxArg changes only a trailing ;', () => {
        assert.equal(tmuxArg('a;'), String.raw`a\;`);
        assert.equal(tmuxArg('a;b'), 'a;b');
        assert.equal(tmuxArg(''), '');
    });

    await test('formatLiteral escapes #, , and }', () => {
        assert.equal(formatLiteral('a#b,c}d'), 'a##b#,c#}d');
        assert.equal(formatLiteral(PR_KEY), PR_KEY);
    });
});

await describe('killDeadWatcherPane', async () => {
    await test('one conditional command checks death and tag and kills on the given socket', async () => {
        const fake = createFakeRunner();
        assert.equal(await killDeadWatcherPane(depsOf(fake), TMUX, WORKER_SOCKET, '%7', 'o+r,x}'), true);
        const calls = fake.calls();
        assert.equal(calls.length, 1);
        assert.deepEqual(socketOf(calls[0]), ['-S', WORKER_SOCKET]);
        assert.deepEqual(tmuxArgs(calls[0]), [
            'if-shell',
            '-F',
            '-t',
            '%7',
            '#{&&:#{pane_dead},#{==:#{@prwc_watcher},o+r#,x#}}}',
            'kill-pane -t %7',
        ]);
    });

    await test('a failing command gives false and a malformed pane id makes no call', async () => {
        const fake = createFakeRunner();
        fake.respond('tmux', 'if-shell', { code: 1, stderr: "can't find pane: %7\n" });
        assert.equal(await killDeadWatcherPane(depsOf(fake), TMUX, SOCKET, '%7', PR_KEY), false);
        assert.equal(await killDeadWatcherPane(depsOf(fake), TMUX, SOCKET, '%7; kill-server', PR_KEY), false);
        assert.equal(fake.calls().length, 1);
    });
});

await describe('tmuxInit', async () => {
    await test('without TMUX it refuses with no call', async () => {
        const fake = createFakeRunner();
        const result = await tmuxInit({ runner: fake.runner, env: { TMUX_PANE: '%1' } }, TMUX);
        assert.deepEqual(result, { ok: false, reason: NOT_IN_TMUX });
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
            ['list-panes', 'split-window', 'set-option', 'set-option', 'list-panes']
        );
        assert.equal(fake.callCount('tmux', 'split-window'), 1);
        assert.deepEqual(tmuxArgs(calls[0]), [
            'list-panes',
            '-t',
            '%1',
            '-F',
            '#{pane_id} #{pane_width} #{pane_height}',
        ]);
        assert.deepEqual(tmuxArgs(calls[1]), [
            'split-window',
            '-d',
            '-h',
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
        assert.deepEqual(calls[1]?.env, { ...BASE_ENV, PATH: '/a:/b' });
        assert.deepEqual(tmuxArgs(calls[2]), ['set-option', '-p', '-t', '%5', '@prwc_run', RUN_ID]);
        assert.deepEqual(tmuxArgs(calls[3]), ['set-option', '-p', '-t', '%5', '@prwc_pr', PR_KEY]);
        assert.deepEqual(tmuxArgs(calls[4]), ['list-panes', '-t', '%5', '-F', '#{window_width} #{window_height}']);
        for (const call of calls) {
            assert.deepEqual(socketOf(call), ['-S', SOCKET]);
        }
    });

    await test('a # in the directory is escaped for format expansion', async () => {
        const fake = createFakeRunner();
        fake.respond('tmux', 'split-window', { stdout: '%5 4242\n' });
        await splitWorker(depsOf(fake), TMUX, CONTEXT, splitOpts('/tmp/a#b'));
        const args = tmuxArgs(fake.calls('tmux').find((call) => call.key === 'split-window'));
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
            [
                'list-panes',
                'split-window',
                'select-layout',
                'split-window',
                'new-window',
                'set-option',
                'set-option',
                'set-option',
                'list-panes',
            ]
        );
        assert.deepEqual(tmuxArgs(calls[2]), ['select-layout', '-t', '@2', 'tiled']);
        assert.deepEqual(tmuxArgs(calls[3]), tmuxArgs(calls[1]));
        assert.deepEqual(tmuxArgs(calls[4]), [
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
        assert.deepEqual(calls[4]?.env, { ...BASE_ENV, PATH: '/a:/b' });
        assert.deepEqual(tmuxArgs(calls[5]), ['set-option', '-w', '-t', '%9', '@prwc_overflow', PR_KEY]);
        assert.deepEqual(tmuxArgs(calls[6]), ['set-option', '-p', '-t', '%9', '@prwc_run', RUN_ID]);
        assert.deepEqual(tmuxArgs(calls[7]), ['set-option', '-p', '-t', '%9', '@prwc_pr', PR_KEY]);
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

    await test('the tmux 3.7 no-space message also triggers the tiled retry', async () => {
        const fake = createFakeRunner();
        fake.respond('tmux', 'split-window', NO_SPACE_TMUX37);
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
            ['list-panes', 'split-window']
        );
    });

    await test('without a PATH item the split runs with the runner base env', async () => {
        const fake = createFakeRunner();
        fake.respond('tmux', 'split-window', { stdout: '%5 4242\n' });
        const opts = { ...splitOpts('/tmp/work'), envItems: ['GH_CONFIG_DIR=/cfg'] };
        await splitWorker(depsOf(fake), TMUX, CONTEXT, opts);
        assert.equal(fake.calls('tmux').find((call) => call.key === 'split-window')?.env, undefined);
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
            ['list-panes', 'split-window', 'set-option', 'kill-pane']
        );
        assert.deepEqual(tmuxArgs(calls[2]), ['set-option', '-p', '-t', '%5', '@prwc_run', RUN_ID]);
        assert.deepEqual(tmuxArgs(calls[3]), ['kill-pane', '-t', '%5']);
        assert.deepEqual(socketOf(calls[3]), ['-S', SOCKET]);
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
            ['list-panes', 'split-window', 'set-option', 'set-option', 'kill-pane']
        );
        assert.deepEqual(tmuxArgs(calls[3]), ['set-option', '-p', '-t', '%5', '@prwc_pr', PR_KEY]);
        assert.deepEqual(tmuxArgs(calls[4]), ['kill-pane', '-t', '%5']);
    });

    await test('splits the last pane of the window, across a tall pane, then lays the window out as a grid', async () => {
        const fake = createFakeRunner();
        fake.respond('tmux', 'list-panes', { stdout: '%1 100 50\n%4 80 50\n' });
        fake.respond('tmux', 'list-panes', { stdout: '200 50\n200 50\n200 50\n' });
        fake.respond('tmux', 'split-window', { stdout: '%5 4242\n' });
        await splitWorker(depsOf(fake), TMUX, CONTEXT, splitOpts('/tmp/work'));
        const split = tmuxArgs(fake.calls('tmux').find((call) => call.key === 'split-window'));
        assert.deepEqual(split.slice(0, 8), ['split-window', '-d', '-v', '-P', '-F', SPLIT_FORMAT, '-t', '%4']);
        const layouts = fake.calls('tmux').filter((call) => call.key === 'select-layout');
        assert.deepEqual(
            layouts.map((call) => tmuxArgs(call)),
            [['select-layout', '-t', '%5', gridLayout(3, 200, 50)]]
        );
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

    await test('resolves to true when tmux exits 0', async () => {
        const fake = createFakeRunner();
        fake.respond('tmux', 'display-message', { code: 0 });
        assert.equal(await tmuxMessage(depsOf(fake), TMUX, CONTEXT, 'shown'), true);
    });

    await test('resolves to false when tmux exits nonzero', async () => {
        const fake = createFakeRunner();
        fake.respond('tmux', 'display-message', { code: 1, stderr: 'no current client' });
        assert.equal(await tmuxMessage(depsOf(fake), TMUX, CONTEXT, 'not shown'), false);
        assert.equal(fake.calls().length, 1);
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

    await test('lays each window that lost a pane out as a grid again', async () => {
        const fake = createFakeRunner();
        fake.respond('tmux', 'list-panes', {
            stdout: [
                `%2 ${PR_KEY} 400 @3`,
                `%3 ${PR_KEY} 100 @3`,
                `%5 ${PR_KEY} 300 @7`,
                `%6 ${PR_KEY} 200 @7`,
                '',
            ].join('\n'),
        });
        fake.respond('tmux', 'list-panes', { stdout: '200 50\n200 50\n' });
        await capDonePanes(depsOf(fake), TMUX, WORKER_SOCKET, PR_KEY, 1);
        const layouts = fake.calls().filter((call) => call.key === 'select-layout');
        assert.deepEqual(
            layouts.map((call) => tmuxArgs(call)),
            [
                ['select-layout', '-t', '@3', gridLayout(2, 200, 50)],
                ['select-layout', '-t', '@7', gridLayout(2, 200, 50)],
            ]
        );
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

await describe('arrangeGrid', async () => {
    await test('applies the grid of the listed panes to the window', async () => {
        const fake = createFakeRunner();
        fake.respond('tmux', 'list-panes', { stdout: '120 40\n120 40\n' });
        await arrangeGrid(depsOf(fake), TMUX, SOCKET, '@2');
        assert.deepEqual(tmuxArgs(fake.calls()[0]), [
            'list-panes',
            '-t',
            '@2',
            '-F',
            '#{window_width} #{window_height}',
        ]);
        assert.deepEqual(tmuxArgs(fake.calls()[1]), ['select-layout', '-t', '@2', gridLayout(2, 120, 40)]);
    });

    await test('a failed listing, a single pane or a tiny window keeps the layout', async () => {
        for (const response of [
            { code: 1, stdout: '120 40\n120 40\n' },
            { stdout: '120 40\n' },
            { stdout: '4 2\n4 2\n' },
        ]) {
            const fake = createFakeRunner();
            fake.respond('tmux', 'list-panes', response);
            await arrangeGrid(depsOf(fake), TMUX, SOCKET, '@2');
            assert.equal(fake.callCount('tmux', 'select-layout'), 0);
        }
    });
});

await describe('newWatcherSession', async () => {
    const watcherCommand = ['/opt/node/bin/node', '/opt/plugin/src/main.ts', '--background-child'];
    const target = { prKey: PR_KEY, name: 'prwc-r-12' };
    const sessionArgs = (name: string): string[] => [
        'new-session',
        '-d',
        '-P',
        '-F',
        SESSION_FORMAT,
        '-s',
        name,
        '-x',
        '200',
        '-y',
        '50',
    ];

    await test('creates a named detached session, passes each env item as one -e argument and sets both options', async () => {
        const fake = createFakeRunner();
        fake.respond('tmux', 'new-session', { stdout: '$5 @4 %8\n' });
        const items = ['PATH=/a b', 'PRWC_STATE_DIR=/s'];
        const result = await newWatcherSession(depsOf(fake), TMUX, SOCKET, target, items, watcherCommand);
        assert.deepEqual(result, { sessionId: '$5', sessionName: 'prwc-r-12', windowId: '@4', paneId: '%8' });
        const calls = fake.calls();
        assert.deepEqual(tmuxArgs(calls[0]), [
            ...sessionArgs('prwc-r-12'),
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

    await test('a taken name is retried once after the dead watcher pane of the PR in it was killed', async () => {
        const fake = createFakeRunner();
        fake.respond('tmux', 'new-session', { code: 1, stderr: 'duplicate session: prwc-r-12\n' });
        fake.respond('tmux', 'list-panes', { stdout: '%3\n' });
        fake.respond('tmux', 'new-session', { stdout: '$6 @4 %8\n' });
        const result = await newWatcherSession(depsOf(fake), TMUX, SOCKET, target, [], watcherCommand);
        assert.equal(result?.sessionName, 'prwc-r-12');
        const listed = fake.calls().find((call) => call.key === 'list-panes');
        assert.deepEqual(tmuxArgs(listed), ['list-panes', '-s', '-t', '=prwc-r-12', '-F', '#{pane_id}']);
        const killed = fake.calls().find((call) => call.key === 'if-shell');
        assert.deepEqual(tmuxArgs(killed).slice(-2), [
            `#{&&:#{pane_dead},#{==:#{@prwc_watcher},${PR_KEY}}}`,
            'kill-pane -t %3',
        ]);
    });

    await test('a name still taken after the reclaim gets a numeric suffix', async () => {
        const fake = createFakeRunner();
        const duplicate = { code: 1, stderr: 'duplicate session: prwc-r-12\n' };
        fake.respond('tmux', 'new-session', duplicate);
        fake.respond('tmux', 'new-session', duplicate);
        fake.respond('tmux', 'new-session', { stdout: '$6 @4 %8\n' });
        const result = await newWatcherSession(depsOf(fake), TMUX, SOCKET, target, [], watcherCommand);
        assert.equal(result?.sessionName, 'prwc-r-12-2');
        const created = fake.calls().filter((call) => call.key === 'new-session');
        assert.deepEqual(tmuxArgs(created[2]), [...sessionArgs('prwc-r-12-2'), ...watcherCommand]);
        assert.equal(fake.callCount('tmux', 'list-panes'), 1);
    });

    await test('a failing remain-on-exit kills the created session', async () => {
        const fake = createFakeRunner();
        fake.respond('tmux', 'new-session', { stdout: '$5 @4 %8\n' });
        fake.respond('tmux', 'set-option', { code: 0 });
        fake.respond('tmux', 'set-option', { code: 1, stderr: 'invalid option\n' });
        const result = await newWatcherSession(depsOf(fake), TMUX, SOCKET, target, [], watcherCommand);
        assert.equal(result, undefined);
        const kills = fake.calls().filter((call) => call.key === 'kill-session');
        assert.deepEqual(
            kills.map((call) => tmuxArgs(call)),
            [['kill-session', '-t', '$5']]
        );
    });

    await test('a failing @prwc_watcher option kills the session before remain-on-exit', async () => {
        const fake = createFakeRunner();
        fake.respond('tmux', 'new-session', { stdout: '$5 @4 %8\n' });
        fake.respond('tmux', 'set-option', { code: 1 });
        const result = await newWatcherSession(depsOf(fake), TMUX, SOCKET, target, [], watcherCommand);
        assert.equal(result, undefined);
        assert.equal(fake.callCount('tmux', 'set-option'), 1);
        assert.equal(fake.callCount('tmux', 'kill-session'), 1);
    });

    await test('a failing or unparsable new-session gives undefined and sets nothing', async () => {
        const responses = [{ code: 1, stderr: 'failed\n' }, { stdout: 'garbage\n' }, { stdout: '$5 @4\n' }];
        for (const response of responses) {
            const fake = createFakeRunner();
            fake.respond('tmux', 'new-session', response);
            const result = await newWatcherSession(depsOf(fake), TMUX, SOCKET, target, [], watcherCommand);
            assert.equal(result, undefined);
            assert.equal(fake.callCount('tmux', 'set-option'), 0);
            assert.equal(fake.callCount('tmux', 'new-session'), 1);
        }
    });
});

await describe('watcherSessionName and serverSocket', async () => {
    await test('the session name keeps only word characters and hyphens of the repository', () => {
        assert.equal(watcherSessionName('my.repo', 12), 'prwc-my_repo-12');
        assert.equal(watcherSessionName('repo-x_y', 3), 'prwc-repo-x_y-3');
    });

    await test('the socket is the caller server one inside tmux, else the default one', () => {
        assert.equal(serverSocket({ TMUX: '/tmp/s,1,0', TMUX_PANE: '%3' }, 501), '/tmp/s');
        assert.equal(serverSocket({}, 501), '/tmp/tmux-501/default');
        assert.equal(serverSocket({ TMUX_TMPDIR: '/var/t' }, 501), '/var/t/tmux-501/default');
        assert.equal(serverSocket({ TMUX_TMPDIR: '' }, 501), '/tmp/tmux-501/default');
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
