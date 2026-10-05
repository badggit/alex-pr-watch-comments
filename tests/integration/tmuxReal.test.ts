import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test, type TestContext } from 'node:test';

import { createProcessRunner } from '../../src/proc.ts';
import {
    arrangeGrid,
    killDeadWatcherPane,
    killPane,
    markPaneDone,
    newWatcherWindow,
    paneForRun,
    paneState,
    paneWatcherTag,
    splitWorker,
    tmuxInit,
    tmuxMessage,
    tmuxOn,
    type WorkerPane,
} from '../../src/tmuxControl.ts';
import type { CommandRequest, CommandResult, Deps, Env, TmuxContext } from '../../src/types.ts';
import { shQuote } from '../../src/validate.ts';
import { createTestEnv, waitUntil, type TestEnv } from '../support/testEnv.ts';
import { startTmuxServer, type TmuxServer } from '../support/tmuxServer.ts';

const WAIT_MS = 15_000;
const PR_KEY = 'o+r+12';

interface ServerSize {
    width: number;
    height: number;
}

interface Fixture {
    testEnv: TestEnv;
    server: TmuxServer;
    tmuxPath: string;
    deps: Pick<Deps, 'runner' | 'env'>;
    tmux: TmuxContext;
}

// Removes the temp root itself when the server cannot start, because no after hook owns it yet.
async function startServer(testEnv: TestEnv, serverExtra?: Env, size?: ServerSize): Promise<TmuxServer> {
    try {
        return await startTmuxServer({ ...testEnv.env, ...serverExtra }, size);
    } catch (error) {
        testEnv.cleanup();
        throw error;
    }
}

async function setUp(t: TestContext, serverExtra?: Env, size?: ServerSize): Promise<Fixture> {
    const testEnv = await createTestEnv({ realTmux: true });
    const server = await startServer(testEnv, serverExtra, size);
    // The server goes first, so no pane still writes into the temp root while it is removed.
    t.after(async () => {
        await server.kill();
        testEnv.cleanup();
    });
    const tmuxPath = testEnv.tools.tmux;
    assert.ok(tmuxPath !== undefined, 'tmux is required for this test');
    const env = server.envFor();
    const deps = { runner: createProcessRunner(env), env };
    const init = await tmuxInit(deps, tmuxPath);
    assert.ok(init.ok, init.ok ? '' : init.reason);
    return { testEnv, server, tmuxPath, deps, tmux: init.tmux };
}

// Waits until the file holds the expected number of complete lines and returns them.
async function readLines(file: string, count: number): Promise<string[]> {
    const read = (): string[] => {
        try {
            return fs.readFileSync(file, 'utf8').split('\n').slice(0, -1);
        } catch {
            return [];
        }
    };
    const ready = await waitUntil(WAIT_MS, () => read().length >= count);
    assert.ok(ready, `timed out waiting for ${file}`);
    return read();
}

async function windowOf(fixture: Fixture, pane: string): Promise<string> {
    const result = await tmuxOn(fixture.deps, fixture.tmuxPath, fixture.tmux.socket, [
        'display-message',
        '-p',
        '-t',
        pane,
        '#{window_id}',
    ]);
    assert.ok(result);
    assert.equal(result.code, 0);
    return result.stdout.trim();
}

async function paneOption(fixture: Fixture, pane: string, option: string): Promise<string> {
    const result = await tmuxOn(fixture.deps, fixture.tmuxPath, fixture.tmux.socket, [
        'display-message',
        '-p',
        '-t',
        pane,
        `#{${option}}`,
    ]);
    assert.ok(result);
    assert.equal(result.code, 0);
    return result.stdout.trim();
}

function sleeper(fixture: Fixture, runId: string) {
    return {
        runId,
        prKey: PR_KEY,
        dir: fixture.testEnv.root,
        envItems: [],
        command: ['/bin/sh', '-c', 'sleep 30'],
    };
}

await describe('tmux control on a real isolated server', async () => {
    await test('splitWorker returns the command pid, tags the pane and passes PATH', async (t) => {
        const fixture = await setUp(t);
        const pidFile = path.join(fixture.testEnv.root, 'pid');
        const pathFile = path.join(fixture.testEnv.root, 'path');
        const customPath = `${fixture.testEnv.root}/custom-bin:/usr/bin:/bin`;
        const script = `echo $$ > ${shQuote(pidFile)}; echo "$PATH" > ${shQuote(pathFile)}; sleep 30`;
        const result = await splitWorker(fixture.deps, fixture.tmuxPath, fixture.tmux, {
            runId: 'R1',
            prKey: PR_KEY,
            dir: fixture.testEnv.root,
            envItems: [`PATH=${customPath}`],
            command: ['/bin/sh', '-c', script],
        });
        assert.ok(result);
        assert.match(result.paneId, /^%\d+$/u);
        const [pid] = await readLines(pidFile, 1);
        assert.equal(Number(pid), result.panePid);
        const [seenPath] = await readLines(pathFile, 1);
        assert.equal(seenPath, customPath);
        assert.equal(await paneForRun(fixture.deps, fixture.tmuxPath, fixture.tmux.socket, 'R1'), result.paneId);
        assert.equal(await paneOption(fixture, result.paneId, '@prwc_pr'), PR_KEY);
    });

    // tmux 3.4 keeps an unknown sequence such as #1 but expands #S, ## and #{...}; a start directory that does not
    // exist then silently becomes HOME, so only the second directory fails without tmuxLiteral.
    await test('a # in the directory and in an env item stays literal', async (t) => {
        const fixture = await setUp(t);
        for (const [index, name] of ['dir#1', 'dir#S#{pane_id}'].entries()) {
            const dir = path.join(fixture.testEnv.root, name);
            fs.mkdirSync(dir);
            const outFile = path.join(fixture.testEnv.root, `out${index}`);
            const script = `pwd > ${shQuote(outFile)}; echo "$PRWC_MARK" >> ${shQuote(outFile)}; sleep 30`;
            const result = await splitWorker(fixture.deps, fixture.tmuxPath, fixture.tmux, {
                runId: `R${index}`,
                prKey: PR_KEY,
                dir,
                envItems: ['PRWC_MARK=x#{pane_id}'],
                command: ['/bin/sh', '-c', script],
            });
            assert.ok(result, name);
            assert.deepEqual(await readLines(outFile, 2), [dir, 'x#{pane_id}']);
        }
    });

    await test('env items override a stale server environment', async (t) => {
        const fixture = await setUp(t, { GH_CONFIG_DIR: '/stale', GH_HOST: 'stale.example' });
        const outFile = path.join(fixture.testEnv.root, 'gh');
        const script = `echo "$GH_CONFIG_DIR $GH_HOST" > ${shQuote(outFile)}; sleep 30`;
        const result = await splitWorker(fixture.deps, fixture.tmuxPath, fixture.tmux, {
            runId: 'R1',
            prKey: PR_KEY,
            dir: fixture.testEnv.root,
            envItems: ['GH_CONFIG_DIR=/fresh', 'GH_HOST=github.com'],
            command: ['/bin/sh', '-c', script],
        });
        assert.ok(result);
        assert.deepEqual(await readLines(outFile, 1), ['/fresh github.com']);
    });

    await test('a full window falls back to a new window', async (t) => {
        const fixture = await setUp(t, undefined, { width: 20, height: 6 });
        let overflow: WorkerPane | undefined;
        let inWindow = 0;
        for (let index = 1; index <= 12 && overflow === undefined; index += 1) {
            const split = await splitWorker(
                fixture.deps,
                fixture.tmuxPath,
                fixture.tmux,
                sleeper(fixture, `R${index}`)
            );
            assert.ok(split, `R${index}`);
            if ((await windowOf(fixture, split.paneId)) === fixture.tmux.windowId) {
                inWindow += 1;
            } else {
                overflow = split;
            }
        }
        assert.ok(inWindow >= 2, `${inWindow} panes fit the window`);
        assert.ok(overflow);
        assert.equal(await paneOption(fixture, overflow.paneId, '@prwc_overflow'), PR_KEY);
        assert.equal(
            await paneForRun(fixture.deps, fixture.tmuxPath, fixture.tmux.socket, `R${inWindow + 1}`),
            overflow.paneId
        );
    });

    await test('worker panes fill the window as a grid in launch order', async (t) => {
        const fixture = await setUp(t, undefined, { width: 200, height: 50 });
        const geometry = async () => {
            const result = await tmuxOn(fixture.deps, fixture.tmuxPath, fixture.tmux.socket, [
                'list-panes',
                '-t',
                fixture.tmux.pane,
                '-F',
                '#{pane_id} #{pane_left} #{pane_top} #{pane_width}',
            ]);
            assert.equal(result?.code, 0);
            return (result?.stdout ?? '')
                .trim()
                .split('\n')
                .map((line) => line.split(' '));
        };
        const panes = [fixture.tmux.pane];
        for (const runId of ['R1', 'R2', 'R3']) {
            const split = await splitWorker(fixture.deps, fixture.tmuxPath, fixture.tmux, sleeper(fixture, runId));
            assert.ok(split, runId);
            panes.push(split.paneId);
        }
        const four = await geometry();
        assert.deepEqual(
            four.map(([id, left, top]) => [id, left, top]),
            [
                [panes[0], '0', '0'],
                [panes[1], '100', '0'],
                [panes[2], '0', '25'],
                [panes[3], '100', '25'],
            ]
        );
        await killPane(fixture.deps, fixture.tmuxPath, fixture.tmux.socket, panes[3] ?? '');
        await arrangeGrid(fixture.deps, fixture.tmuxPath, fixture.tmux.socket, fixture.tmux.pane);
        const three = await geometry();
        assert.deepEqual(three.at(-1), [panes[2], '0', '25', '200']);
    });

    await test('newWatcherWindow passes env items, keeps the pane and tags the window', async (t) => {
        const fixture = await setUp(t);
        const outFile = path.join(fixture.testEnv.root, 'foo');
        const customPath = `${fixture.testEnv.root}/custom-bin:/usr/bin:/bin`;
        const script = `echo "$FOO" > ${shQuote(outFile)}; echo "$PATH" >> ${shQuote(outFile)}; exec sleep 30`;
        const result = await newWatcherWindow(
            fixture.deps,
            fixture.tmuxPath,
            fixture.tmux,
            PR_KEY,
            ['FOO=bar', `PATH=${customPath}`],
            ['/bin/sh', '-c', script]
        );
        assert.ok(result);
        assert.notEqual(result.windowId, fixture.tmux.windowId);
        assert.deepEqual(await readLines(outFile, 2), ['bar', customPath]);
        const remain = await tmuxOn(fixture.deps, fixture.tmuxPath, fixture.tmux.socket, [
            'show-options',
            '-p',
            '-t',
            result.paneId,
            'remain-on-exit',
        ]);
        assert.ok(remain);
        assert.equal(remain.code, 0);
        assert.equal(remain.stdout.trim(), 'remain-on-exit on');
        const socket = fixture.tmux.socket;
        assert.equal(await paneWatcherTag(fixture.deps, fixture.tmuxPath, socket, result.paneId), PR_KEY);
        assert.equal(await paneWatcherTag(fixture.deps, fixture.tmuxPath, socket, fixture.tmux.pane), undefined);
    });

    await test('killDeadWatcherPane kills only a dead pane that carries the watcher tag', async (t) => {
        const fixture = await setUp(t);
        const { deps, tmuxPath } = fixture;
        const socket = fixture.tmux.socket;
        const open = async (prKey: string): Promise<string> => {
            const created = await newWatcherWindow(deps, tmuxPath, fixture.tmux, prKey, [], ['sleep', '30']);
            assert.ok(created);
            return created.paneId;
        };
        // Ends the pane's own process; remain-on-exit keeps the pane as dead.
        const end = async (pane: string): Promise<void> => {
            const pid = await tmuxOn(deps, tmuxPath, socket, ['display-message', '-p', '-t', pane, '#{pane_pid}']);
            assert.equal(pid?.code, 0);
            process.kill(Number.parseInt(pid.stdout, 10), 'SIGKILL');
            const died = await waitUntil(
                WAIT_MS,
                async () => (await paneState(deps, tmuxPath, socket, pane)) === 'dead'
            );
            assert.ok(died, `pane ${pane} never died`);
        };
        const deadTagged = await open(PR_KEY);
        const deadOther = await open('o+r+13');
        const alive = await open(PR_KEY);
        const respawned = await open(PR_KEY);
        for (const pane of [deadTagged, deadOther, respawned]) {
            await end(pane);
        }
        const revived = await tmuxOn(deps, tmuxPath, socket, ['respawn-pane', '-t', respawned, 'sleep 30']);
        assert.equal(revived?.code, 0);
        for (const pane of [deadTagged, deadOther, alive, respawned]) {
            assert.equal(await killDeadWatcherPane(deps, tmuxPath, socket, pane, PR_KEY), true, pane);
        }
        assert.equal(await paneState(deps, tmuxPath, socket, deadTagged), 'missing');
        assert.equal(await paneState(deps, tmuxPath, socket, deadOther), 'dead');
        assert.equal(await paneState(deps, tmuxPath, socket, alive), 'alive');
        assert.equal(await paneState(deps, tmuxPath, socket, respawned), 'alive');
    });

    await test('markPaneDone sets @prwc_done only for the pane of the same run', async (t) => {
        const fixture = await setUp(t);
        const split = await splitWorker(fixture.deps, fixture.tmuxPath, fixture.tmux, sleeper(fixture, 'R1'));
        assert.ok(split);
        const socket = fixture.tmux.socket;
        assert.equal(await markPaneDone(fixture.deps, fixture.tmuxPath, socket, split.paneId, 'R2', 100), false);
        assert.equal(await paneOption(fixture, split.paneId, '@prwc_done'), '');
        assert.equal(await markPaneDone(fixture.deps, fixture.tmuxPath, socket, split.paneId, 'R1', 100), true);
        assert.equal(await paneOption(fixture, split.paneId, '@prwc_done'), '100');
    });

    await test('tmuxMessage shows a message that starts with - as text', async (t) => {
        const fixture = await setUp(t);
        const results: CommandResult[] = [];
        const recording = {
            env: fixture.deps.env,
            runner: {
                run: async (request: CommandRequest) => {
                    const result = await fixture.deps.runner.run(request);
                    results.push(result);
                    return result;
                },
            },
        };
        await tmuxMessage(recording, fixture.tmuxPath, fixture.tmux, '-x not a flag');
        const [result] = results;
        assert.ok(result);
        assert.equal(result.code, 0, result.stderr);
        assert.doesNotMatch(result.stderr, /unknown flag/u);
    });

    await test('kill stops the isolated server', async (t) => {
        const fixture = await setUp(t);
        const sessions = await fixture.deps.runner.run({
            file: fixture.tmuxPath,
            args: ['-L', fixture.server.name, 'list-sessions'],
        });
        assert.equal(sessions.code, 0);
        await fixture.server.kill();
        const after = await fixture.deps.runner.run({
            file: fixture.tmuxPath,
            args: ['-L', fixture.server.name, 'list-sessions'],
        });
        assert.notEqual(after.code, 0);
    });
});
