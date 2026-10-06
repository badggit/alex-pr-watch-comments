import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { GH_STRIP_VARS, GH_TOKEN_VARS } from '../../src/constants.ts';
import { runBackground, runList, runStop } from '../../src/control.ts';
import { getString, isRecord } from '../../src/json.ts';
import { launchReady, writeLaunchResult } from '../../src/launchChannel.ts';
import { acquirePrLock, type PrLockFields } from '../../src/locks.ts';
import { createProcessRunner, pidAlive, processStart } from '../../src/proc.ts';
import { initState, runDir, watcherDir } from '../../src/stateStore.ts';
import type { CliOptions, CommandRequest, CommandRunner, Env, LaunchResult, PrRef } from '../../src/types.ts';
import {
    createFakeRunner,
    type FakeResponder,
    type FakeRunner,
    type Passthrough,
    type RecordedCall,
} from '../support/fakeRunner.ts';
import { gitSync, makePrClone, offlineGitRunner } from '../support/gitRepo.ts';
import { createTestEnv, waitUntil, type TestDeps, type TestEnv } from '../support/testEnv.ts';

interface SetupOptions {
    env?: Env;
    psPassthrough?: boolean;
    prime?: (_fake: FakeRunner) => void;
}

interface Setup {
    testEnv: TestEnv;
    stateDir: string;
    clone: string;
    fake: FakeRunner;
    deps: TestDeps;
    now: number;
}

interface LockSpec {
    pid: number;
    pidStart: string;
    socket?: string;
}

const FIXTURES = path.resolve(import.meta.dirname, '..', 'fixtures');
const MAIN_TS = path.resolve(import.meta.dirname, '..', '..', 'src', 'main.ts');
const ENTRY = { node: process.execPath, mainTs: MAIN_TS };
const PR_KEY = 'o+r+12';
const PR: PrRef = {
    host: 'github.com',
    owner: 'o',
    repo: 'r',
    number: 12,
    prUrl: 'https://github.com/o/r/pull/12',
    prKey: PR_KEY,
};
const BRANCH = 'feature';
const TMUX_FORMAT = '#{session_id} #{window_id}';
const LOCK_SOCKET = '/tmp/tmux_dir/default';
const OTHER_TMUX = '/tmp/other-socket,1,0';
const OLD_START = 'Mon Jan  1 00:00:00 2001';
const TOKEN_ITEM = 'PRWC_LAUNCH_TOKEN=';
const FORWARDED = [
    'PRWC_START_TIMEOUT',
    'PRWC_LAUNCH_WAIT',
    'PRWC_RATE_RESERVE',
    'PRWC_STOP_QUIET',
    'PRWC_READY_WAIT',
    'PRWC_BG_TIMEOUT',
];
// Installs a SIGTERM handler that ignores the signal, then creates the ready file named by its argument.
const TERM_IGNORER = [
    "process.on('SIGTERM', () => { return; });",
    "require('node:fs').writeFileSync(process.argv[1], '');",
    'setInterval(() => { return; }, 1000);',
].join(' ');

function readFixture(name: string): Record<string, unknown> {
    const value: unknown = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'control', name), 'utf8'));
    assert.ok(isRecord(value), `${name} is not an object`);
    return value;
}

const PR_INFO: unknown = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'preflight', 'prInfoOpen.json'), 'utf8'));
const STATUS = readFixture('status.json');
const RECORD = readFixture('record.json');
const RECORD_FORMAT_9 = readFixture('recordFormat9.json');
const LOCK_OWNER = readFixture('lockOwner.json');

function writeJson(file: string, value: unknown): void {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

function respondDefaults(fake: FakeRunner): void {
    fake.respond('gh', 'PrwcPrInfo', { json: PR_INFO });
    fake.respond('tmux', 'display-message', (call) => (call.args.includes(TMUX_FORMAT) ? { stdout: '$1 @1\n' } : {}));
}

// git goes to the real git through the offline transport and ps and the identity read (/bin/sh, tool other) to the real runner (unless psPassthrough is false);
// gh and tmux are answered by the fake runner. The clock is fixed at the setup time.
async function makeSetup(t: TestContext, options?: SetupOptions): Promise<Setup> {
    const testEnv = await createTestEnv();
    t.after(() => {
        testEnv.cleanup();
    });
    const init = initState(testEnv.stateDir);
    assert.ok(init.ok);
    const gitRoot = path.join(testEnv.root, 'git');
    const clone = makePrClone(gitRoot, BRANCH, 'o/r', testEnv.env);
    const real = createProcessRunner(testEnv.env);
    const passthrough: Passthrough = { git: offlineGitRunner(real, gitRoot) };
    if (options?.psPassthrough !== false) {
        passthrough.ps = real;
        passthrough.other = real;
    }
    const fake = createFakeRunner({ passthrough });
    options?.prime?.(fake);
    respondDefaults(fake);
    const now = Math.floor(Date.now() / 1000);
    const deps: TestDeps = {
        ...testEnv.deps(fake.runner),
        env: { ...testEnv.env, PRWC_BG_TIMEOUT: '10', ...options?.env },
        nowSeconds: () => now,
    };
    return { testEnv, stateDir: init.stateDir, clone, fake, deps, now };
}

// Every call that matches takes delayMs unless its timeoutMs ends it first, as with the real runner; the timeouts the
// calls carried are recorded.
function slowCalls(
    inner: CommandRunner,
    matches: (_request: CommandRequest) => boolean,
    delayMs: number,
    timeouts: (number | undefined)[]
): CommandRunner {
    return {
        run: async (request) => {
            if (!matches(request)) {
                return await inner.run(request);
            }
            timeouts.push(request.timeoutMs);
            const wait = Math.min(delayMs, request.timeoutMs ?? delayMs);
            await delay(wait);
            return wait < delayMs ? { code: 143, stdout: '', stderr: '' } : await inner.run(request);
        },
    };
}

function bgOptions(setup: Setup, claudeArgs: string[] = [], inPlace = true): CliOptions {
    return {
        mode: 'background',
        pr: PR,
        dir: setup.clone,
        interval: 300,
        claude: undefined,
        claudeArgs,
        keepPanes: 5,
        batchMax: 5,
        once: false,
        inPlace,
    };
}

function stopOptions(pr = PR): CliOptions {
    return {
        mode: 'stop',
        pr,
        dir: '/',
        interval: 15,
        claude: undefined,
        claudeArgs: [],
        keepPanes: 5,
        batchMax: 5,
        once: false,
        inPlace: true,
    };
}

function startBackground(setup: Setup, claudeArgs?: string[], inPlace = true): Promise<number> {
    return runBackground(setup.deps, bgOptions(setup, claudeArgs, inPlace), setup.testEnv.root, ENTRY);
}

function envItems(call: RecordedCall): string[] {
    return call.args.filter((_arg, index) => call.args[index - 1] === '-e');
}

function tokenOf(call: RecordedCall): string {
    const item = envItems(call).find((entry) => entry.startsWith(TOKEN_ITEM));
    assert.ok(item !== undefined, 'no launch token item');
    return item.slice(TOKEN_ITEM.length);
}

// Every GH_STRIP_VARS name is forwarded exactly once and only emptied, never with a value.
function assertStripVarsEmptied(items: readonly string[]): void {
    for (const name of GH_STRIP_VARS) {
        assert.deepEqual(
            items.filter((item) => item.startsWith(`${name}=`)),
            [`${name}=`],
            name
        );
    }
}

function newWindows(setup: Setup): RecordedCall[] {
    return setup.fake.calls('tmux').filter((call) => call.key === 'new-window');
}

function onlyWindow(setup: Setup): RecordedCall {
    const calls = newWindows(setup);
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.ok(call !== undefined);
    return call;
}

function launchResult(token: string, result: LaunchResult['result'], message = ''): LaunchResult {
    return { token, result, message, pid: 4242, windowId: '@2' };
}

// The new-window responder: report is called with the launch token before the window is created.
function windowResponder(report: (_token: string) => void, windowId = '@2', paneId = '%2'): FakeResponder {
    return (call) => {
        report(tokenOf(call));
        return { stdout: `${windowId} ${paneId}\n` };
    };
}

function answerAtOnce(setup: Setup, result: LaunchResult['result'], message = ''): void {
    setup.fake.respond(
        'tmux',
        'new-window',
        windowResponder((token) => {
            assert.ok(writeLaunchResult(setup.stateDir, PR_KEY, launchResult(token, result, message)));
        })
    );
}

function printed(setup: Setup): string {
    return `${setup.deps.outText()}\n${setup.deps.logLines.join('\n')}`;
}

function launchFiles(setup: Setup): string[] {
    try {
        return fs.readdirSync(path.join(watcherDir(setup.stateDir, PR_KEY), 'launch'));
    } catch {
        return [];
    }
}

function lockFields(spec: LockSpec): PrLockFields {
    return {
        pidStart: spec.pidStart,
        paneId: getString(LOCK_OWNER, 'paneId') ?? '',
        windowId: getString(LOCK_OWNER, 'windowId') ?? '',
        socket: spec.socket ?? getString(LOCK_OWNER, 'socket') ?? '',
        dir: getString(LOCK_OWNER, 'dir') ?? '',
        startedAt: 0,
    };
}

function seedLock(setup: Setup, spec: LockSpec): void {
    const acquired = acquirePrLock(setup.stateDir, PR_KEY, lockFields(spec), spec.pid, setup.now);
    assert.equal(acquired.kind, 'acquired');
}

async function startOf(setup: Setup, pid: number): Promise<string> {
    const start = await processStart(createProcessRunner(setup.testEnv.env), pid);
    assert.ok(start !== undefined, `no start time for pid ${pid}`);
    return start;
}

// A live sleep orphan that owns the PR lock with its real start time.
async function seedLiveOwner(setup: Setup, socket?: string): Promise<number> {
    const pid = setup.testEnv.spawnOrphan('sleep', ['300']);
    seedLock(setup, { pid, pidStart: await startOf(setup, pid), socket });
    return pid;
}

async function deadPid(setup: Setup): Promise<number> {
    const pid = setup.testEnv.spawnOrphan('true', []);
    assert.ok(await waitUntil(10_000, () => !pidAlive(pid)), 'the short-lived orphan did not exit');
    return pid;
}

function seedRecord(setup: Setup, runId: string, patch?: Record<string, unknown>): void {
    writeJson(path.join(runDir(setup.stateDir, runId), 'record.json'), { ...RECORD, runId, ...patch });
}

function seedUnreadableRecord(setup: Setup): string {
    const runId = getString(RECORD_FORMAT_9, 'runId') ?? '';
    writeJson(path.join(runDir(setup.stateDir, runId), 'record.json'), RECORD_FORMAT_9);
    return runId;
}

function seedStatus(setup: Setup, patch?: Record<string, unknown>): string {
    const file = path.join(watcherDir(setup.stateDir, PR_KEY), 'status.json');
    writeJson(file, { ...STATUS, since: setup.now - 30, updatedAt: setup.now, ...patch });
    return file;
}

function setFormat(setup: Setup, format: string): void {
    fs.writeFileSync(path.join(setup.stateDir, 'format'), `${format}\n`);
}

function tmuxCalls(setup: Setup, key: string): RecordedCall[] {
    return setup.fake.calls('tmux').filter((call) => call.key === key);
}

// list-panes reports before until the conditional kill ran, then after (the same listing when after is not given).
function respondPanes(setup: Setup, before: string, after?: string): void {
    setup.fake.respond('tmux', 'list-panes', () => ({
        stdout: setup.fake.callCount('tmux', 'if-shell') > 0 ? (after ?? before) : before,
    }));
}

function conditionalKills(setup: Setup): RecordedCall[] {
    return setup.fake.calls('tmux').filter((call) => call.key === 'if-shell');
}

function assertConditionalKill(setup: Setup): void {
    const calls = conditionalKills(setup);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.args, [
        '-S',
        LOCK_SOCKET,
        'if-shell',
        '-F',
        '-t',
        '%1',
        `#{&&:#{pane_dead},#{==:#{@prwc_watcher},${PR_KEY}}}`,
        'kill-pane -t %1',
    ]);
    assert.equal(tmuxCalls(setup, 'kill-pane').length, 0);
    assert.equal(tmuxCalls(setup, 'kill-window').length, 0);
}

// No raw control character (newline aside) and no bidi control reaches the output.
function assertNoControl(text: string): void {
    for (const character of text) {
        const code = character.codePointAt(0) ?? 0;
        const control = (code < 32 && character !== '\n') || code === 127 || (code >= 0x20_2a && code <= 0x20_2e);
        assert.ok(!control, `control character ${code} in ${JSON.stringify(text)}`);
    }
}

// A zombie: sh starts a short child and replaces itself with sleep, which never reaps that child.
async function spawnZombie(setup: Setup): Promise<number> {
    const pidFile = path.join(setup.testEnv.root, 'zombie.pid');
    const script = `sleep 0 & echo $! > ${pidFile}; exec sleep 300`;
    setup.testEnv.spawnOrphan('/bin/sh', ['-c', script]);
    let zombie = 0;
    const ready = await waitUntil(10_000, async () => {
        zombie = Number.parseInt(fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8') : '', 10);
        if (!Number.isInteger(zombie)) {
            return false;
        }
        const state = await createProcessRunner(setup.testEnv.env).run({
            file: '/bin/ps',
            args: ['-o', 'stat=', '-p', String(zombie)],
        });
        return state.stdout.trim().startsWith('Z');
    });
    assert.ok(ready, 'no zombie appeared');
    return zombie;
}

function stop(setup: Setup, pr = PR): Promise<number> {
    return runStop(setup.deps, stopOptions(pr), setup.stateDir);
}

await describe('background start', async () => {
    await test('without TMUX it exits 1 and creates no window', async (t) => {
        const setup = await makeSetup(t, { env: { TMUX: undefined } });
        assert.equal(await startBackground(setup), 1);
        assert.ok(setup.deps.outText().includes('must run inside tmux'), printed(setup));
        assert.equal(newWindows(setup).length, 0);
    });

    await test('a live lock owner is reported as already watched and no window is created', async (t) => {
        const setup = await makeSetup(t);
        const owner = await seedLiveOwner(setup);
        assert.equal(await startBackground(setup), 0);
        assert.ok(setup.deps.outText().includes(`already watched by pid ${owner} (window @3)`), printed(setup));
        assert.equal(newWindows(setup).length, 0);
    });

    await test('success reports watching only after the ready marker, with the full window command', async (t) => {
        const setup = await makeSetup(t);
        const readyAt: Record<string, boolean> = {};
        let token = '';
        setup.fake.respond(
            'tmux',
            'new-window',
            windowResponder((value) => {
                token = value;
                readyAt.newWindow = launchReady(setup.stateDir, PR_KEY, value);
            })
        );
        setup.fake.respond('tmux', 'set-option', (call) => {
            if (call.args.includes('remain-on-exit')) {
                readyAt.remainOnExit = launchReady(setup.stateDir, PR_KEY, token);
            }
            return {};
        });
        const poller = async (): Promise<void> => {
            const ready = await waitUntil(15_000, () => token.length > 0 && launchReady(setup.stateDir, PR_KEY, token));
            if (ready) {
                assert.ok(writeLaunchResult(setup.stateDir, PR_KEY, launchResult(token, 'firstPoll')));
            }
        };
        const [code] = await Promise.all([startBackground(setup, ['--model', 'two words']), poller()]);
        assert.equal(code, 0, printed(setup));
        assert.ok(setup.deps.outText().includes(`watching ${PR.prUrl} in window @2`), printed(setup));
        assert.deepEqual(readyAt, { newWindow: false, remainOnExit: false });
        const call = onlyWindow(setup);
        assert.ok(call.args.includes('-d'));
        const items = envItems(call);
        assert.ok(items.some((item) => item.startsWith('PATH=')));
        const stateItem = items.find((item) => item.startsWith('PRWC_STATE_DIR='));
        assert.ok(stateItem !== undefined);
        const forwarded = stateItem.slice('PRWC_STATE_DIR='.length);
        assert.ok(path.isAbsolute(forwarded));
        assert.equal(fs.realpathSync.native(forwarded), fs.realpathSync.native(setup.testEnv.stateDir));
        assert.match(tokenOf(call), /^\d[\d-]*$/u);
        const nodeIndex = call.args.indexOf(process.execPath);
        assert.ok(nodeIndex !== -1);
        assert.equal(call.args[nodeIndex + 1], MAIN_TS);
        assert.equal(call.args[nodeIndex + 2], PR.prUrl);
        const argIndex = call.args.indexOf('two words');
        assert.equal(call.args[argIndex - 1], '--claude-arg');
        assert.equal(call.args[call.args.indexOf('--model') - 1], '--claude-arg');
        assert.equal(call.args[call.args.indexOf('--dir') + 1], fs.realpathSync.native(setup.clone));
        assert.ok(call.args.includes('--in-place'));
        assert.deepEqual(launchFiles(setup), []);
    });

    await test('a worktree start passes the clone and explicit --worktree', async (t) => {
        const setup = await makeSetup(t);
        gitSync(setup.testEnv.env, ['-C', setup.clone, 'checkout', '--quiet', 'main']);
        answerAtOnce(setup, 'firstPoll');
        assert.equal(await startBackground(setup, [], false), 0, printed(setup));
        const call = onlyWindow(setup);
        const clone = fs.realpathSync.native(setup.clone);
        assert.equal(call.args[call.args.indexOf('--dir') + 1], clone);
        assert.ok(!call.args.includes('--in-place'));
        assert.ok(call.args.includes('--worktree'));
        const worktree = path.join(path.dirname(clone), 'alex-pr-watch-comments-pr-12');
        assert.equal(gitSync(setup.testEnv.env, ['-C', worktree, 'branch', '--show-current']).trim(), BRANCH);
        assert.ok(printed(setup).includes(`created the watch worktree ${worktree}`), printed(setup));
    });

    await test('a failing remain-on-exit option exits 1 without a ready marker', async (t) => {
        const setup = await makeSetup(t);
        let token = '';
        const readyAtKill: boolean[] = [];
        setup.fake.respond(
            'tmux',
            'new-window',
            windowResponder((value) => {
                token = value;
            })
        );
        setup.fake.respond('tmux', 'set-option', (call) => (call.args.includes('remain-on-exit') ? { code: 1 } : {}));
        setup.fake.respond('tmux', 'kill-window', () => {
            readyAtKill.push(launchReady(setup.stateDir, PR_KEY, token));
            return {};
        });
        assert.equal(await startBackground(setup), 1);
        assert.ok(setup.deps.outText().includes('could not create the watcher window'), printed(setup));
        assert.deepEqual(readyAtKill, [false]);
        assert.equal(launchReady(setup.stateDir, PR_KEY, token), false);
        assert.deepEqual(
            launchFiles(setup).filter((name) => name.endsWith('.ready')),
            []
        );
    });

    await test('the watcher status and other launches are never read or deleted', async (t) => {
        const setup = await makeSetup(t);
        const statusFile = seedStatus(setup, { state: 'fatal', lastError: 'old failure' });
        const before = fs.readFileSync(statusFile, 'utf8');
        answerAtOnce(setup, 'firstPoll');
        assert.equal(await startBackground(setup), 0, printed(setup));
        assert.equal(fs.readFileSync(statusFile, 'utf8'), before);
        const other = '999-1-1';
        setup.deps.env = { ...setup.deps.env, PRWC_BG_TIMEOUT: '2' };
        setup.fake.respond(
            'tmux',
            'new-window',
            windowResponder(() => {
                assert.ok(writeLaunchResult(setup.stateDir, PR_KEY, launchResult(other, 'firstPoll')));
            })
        );
        assert.equal(await startBackground(setup), 1);
        assert.ok(setup.deps.outText().includes('did not report its first poll; check window @2'), printed(setup));
        assert.equal(fs.readFileSync(statusFile, 'utf8'), before);
        assert.deepEqual(launchFiles(setup), [`${other}.json`]);
    });

    await test('set overrides are forwarded with their values', async (t) => {
        const setup = await makeSetup(t, { env: { PRWC_LAUNCH_WAIT: '7', PRWC_STOP_QUIET: '3' } });
        answerAtOnce(setup, 'firstPoll');
        assert.equal(await startBackground(setup), 0, printed(setup));
        const items = envItems(onlyWindow(setup));
        assert.ok(items.includes('PRWC_LAUNCH_WAIT=7'), items.join(' '));
        assert.ok(items.includes('PRWC_STOP_QUIET=3'), items.join(' '));
    });

    await test('every override is forwarded with its effective value, defaults included', async (t) => {
        const setup = await makeSetup(t);
        answerAtOnce(setup, 'firstPoll');
        assert.equal(await startBackground(setup), 0, printed(setup));
        const items = envItems(onlyWindow(setup));
        for (const expected of ['PRWC_LAUNCH_WAIT=60', 'PRWC_STOP_QUIET=10']) {
            assert.ok(items.includes(expected), `${expected} missing from ${items.join(' ')}`);
        }
        assert.ok(!items.some((item) => item.startsWith('PRWC_TERM_WAIT=')), items.join(' '));
        for (const name of FORWARDED) {
            assert.equal(items.filter((item) => item.startsWith(`${name}=`)).length, 1, name);
        }
    });

    await test('the gh context is forwarded exactly and GH_REPO never', async (t) => {
        const setup = await makeSetup(t, { env: { GH_CONFIG_DIR: '/cfg dir', GH_REPO: 'x/y' } });
        answerAtOnce(setup, 'firstPoll');
        assert.equal(await startBackground(setup), 0, printed(setup));
        const items = envItems(onlyWindow(setup));
        assert.deepEqual(
            items.filter((item) => item.startsWith('GH_') && !item.endsWith('=')),
            ['GH_CONFIG_DIR=/cfg dir', 'GH_HOST=github.com']
        );
        assertStripVarsEmptied(items);
    });

    await test('an absent gh config directory is forwarded as the XDG or HOME default', async (t) => {
        const xdg = await makeSetup(t, { env: { XDG_CONFIG_HOME: '/xdg' } });
        answerAtOnce(xdg, 'firstPoll');
        assert.equal(await startBackground(xdg), 0, printed(xdg));
        assert.ok(envItems(onlyWindow(xdg)).includes('GH_CONFIG_DIR=/xdg/gh'));
        const home = await makeSetup(t);
        answerAtOnce(home, 'firstPoll');
        assert.equal(await startBackground(home), 0, printed(home));
        assert.ok(envItems(onlyWindow(home)).includes(`GH_CONFIG_DIR=${home.testEnv.home}/.config/gh`));
    });

    await test('another GH_HOST is refused before any gh call', async (t) => {
        const setup = await makeSetup(t, { env: { GH_HOST: 'ghe.example.invalid' } });
        assert.equal(await startBackground(setup), 1);
        assert.ok(setup.deps.outText().includes('another host than the PR host github.com'), printed(setup));
        assert.equal(newWindows(setup).length, 0);
        assert.equal(setup.fake.calls('gh').length, 0);
    });

    for (const name of ['GH_TOKEN', 'GITHUB_TOKEN']) {
        await test(`${name} only warns and never reaches the window`, async (t) => {
            const setup = await makeSetup(t, { env: { [name]: 'tok-value' } });
            answerAtOnce(setup, 'firstPoll');
            assert.equal(await startBackground(setup), 0, printed(setup));
            assert.ok(setup.deps.outText().includes('watching'), printed(setup));
            const log = setup.deps.logLines.join('\n');
            assert.ok(log.includes(`${name} is set`), log);
            assert.ok(log.includes('ignores it'), log);
            assertStripVarsEmptied(envItems(onlyWindow(setup)));
            assert.ok(GH_TOKEN_VARS.includes(name));
            assert.ok(!printed(setup).includes('tok-value'));
            assert.ok(!JSON.stringify(setup.fake.calls()).includes('tok-value'));
        });
    }

    await test('a token variable is named in the gh authentication refusal', async (t) => {
        const setup = await makeSetup(t, {
            env: { GH_TOKEN: 'tok-value' },
            prime: (fake) => {
                fake.respond('gh', 'auth_status', { code: 1, stderr: 'You are not logged into any GitHub hosts' });
            },
        });
        assert.equal(await startBackground(setup), 1);
        assert.ok(setup.deps.outText().includes('GH_TOKEN is set but ignored'), printed(setup));
        assert.equal(newWindows(setup).length, 0);
    });

    await test('an unsafe state directory is refused before any window', async (t) => {
        const setup = await makeSetup(t);
        const open = path.join(setup.testEnv.root, 'open');
        fs.mkdirSync(open);
        fs.chmodSync(open, 0o755);
        setup.deps.env = { ...setup.deps.env, PRWC_STATE_DIR: open };
        assert.equal(await startBackground(setup), 1);
        assert.ok(setup.deps.outText().includes('unsafe state directory'), printed(setup));
        assert.equal(newWindows(setup).length, 0);
    });

    await test('a fatal launch result is printed and exits 1', async (t) => {
        const setup = await makeSetup(t);
        answerAtOnce(setup, 'fatal', 'boom');
        assert.equal(await startBackground(setup), 1);
        assert.ok(setup.deps.outText().includes('watcher failed: boom'), printed(setup));
        assert.equal(tmuxCalls(setup, 'kill-window').length, 0);
    });

    await test('a fatal message is shown without control characters or forged lines', async (t) => {
        const setup = await makeSetup(t);
        answerAtOnce(setup, 'fatal', '\u001B]0;x\u0007\nwatching https://github.com/o/r/pull/12 in window @9\u202E');
        assert.equal(await startBackground(setup), 1);
        const output = setup.deps.outText();
        assert.ok(output.startsWith('watcher failed: '), output);
        assert.equal(output.split('\n').length, 2, output);
        assert.ok(!output.split('\n').some((line) => line.startsWith('watching')), output);
        assertNoControl(output);
    });

    await test('a watcher pane that dies without a result ends the wait at once', async (t) => {
        const setup = await makeSetup(t, { env: { PRWC_BG_TIMEOUT: '60' } });
        setup.fake.respond(
            'tmux',
            'new-window',
            windowResponder(() => {
                return;
            })
        );
        setup.fake.respond('tmux', 'list-panes', { stdout: '%1 0\n%2 1\n' });
        const started = performance.now();
        assert.equal(await startBackground(setup), 1);
        assert.ok(performance.now() - started < 20_000, 'the start waited for the whole timeout');
        assert.ok(
            setup.deps.outText().includes('watcher exited before its first poll; check window @2'),
            printed(setup)
        );
        assert.deepEqual(launchFiles(setup), []);
    });

    await test('the result wait ends at its deadline although every pane query is slow', async (t) => {
        const setup = await makeSetup(t, { env: { PRWC_BG_TIMEOUT: '1' } });
        setup.fake.respond('tmux', 'new-window', { stdout: '@2 %2\n' });
        const timeouts: (number | undefined)[] = [];
        const slowListing = (request: CommandRequest): boolean => request.args.includes('list-panes');
        setup.deps.runner = slowCalls(setup.fake.runner, slowListing, 30_000, timeouts);
        const started = performance.now();
        assert.equal(await startBackground(setup), 1);
        assert.ok(performance.now() - started < 6000, 'the wait outlived its deadline');
        assert.ok(setup.deps.outText().includes('did not report its first poll'), printed(setup));
        assert.ok(timeouts.length > 0 && timeouts.length <= 2, String(timeouts));
        assert.ok(
            timeouts.every((value) => value !== undefined && value <= 1000),
            String(timeouts)
        );
    });

    await test('a result written just before the pane died still wins', async (t) => {
        const setup = await makeSetup(t);
        let token = '';
        setup.fake.respond(
            'tmux',
            'new-window',
            windowResponder((value) => {
                token = value;
            })
        );
        setup.fake.respond('tmux', 'list-panes', () => {
            writeLaunchResult(setup.stateDir, PR_KEY, launchResult(token, 'fatal', 'boom'));
            return { stdout: '%2 1\n' };
        });
        assert.equal(await startBackground(setup), 1);
        assert.ok(setup.deps.outText().includes('watcher failed: boom'), printed(setup));
    });

    await test('of two concurrent starts the loser reports already watched and kills its own window', async (t) => {
        const setup = await makeSetup(t);
        let created = 0;
        setup.fake.respond('tmux', 'new-window', (call) => {
            created += 1;
            const token = tokenOf(call);
            if (created === 1) {
                writeJson(path.join(watcherDir(setup.stateDir, PR_KEY), 'status.json'), STATUS);
                assert.ok(writeLaunchResult(setup.stateDir, PR_KEY, launchResult(token, 'firstPoll')));
                return { stdout: '@2 %2\n' };
            }
            const holder = { ...launchResult(token, 'alreadyWatched', 'already watched'), pid: 4242, windowId: '@2' };
            assert.ok(writeLaunchResult(setup.stateDir, PR_KEY, holder));
            return { stdout: '@3 %3\n' };
        });
        const codes = await Promise.all([startBackground(setup), startBackground(setup)]);
        assert.deepEqual(codes, [0, 0], printed(setup));
        const output = setup.deps.outText();
        assert.equal(output.split('watching ').length - 1, 1, output);
        assert.equal(output.split('already watched by pid 4242 (window @2)').length - 1, 1, output);
        const kills = tmuxCalls(setup, 'kill-window');
        assert.equal(kills.length, 1);
        assert.equal(kills[0]?.args.at(-1), '@3');
        assert.ok(fs.existsSync(path.join(watcherDir(setup.stateDir, PR_KEY), 'status.json')));
        assert.deepEqual(launchFiles(setup), []);
    });
});

await describe('list', async () => {
    await test('an empty state directory has no watchers', async (t) => {
        const setup = await makeSetup(t);
        assert.equal(await runList(setup.deps, setup.stateDir), 0);
        assert.equal(setup.deps.outText(), 'no watchers\n');
    });

    await test('a watcher line shows state, age, reason and hint, and its runs', async (t) => {
        const setup = await makeSetup(t);
        await seedLiveOwner(setup);
        seedStatus(setup);
        seedRecord(setup, '20261002120000-101', { startedAt: setup.now - 90 });
        assert.equal(await runList(setup.deps, setup.stateDir), 0);
        const output = setup.deps.outText();
        const [watcherLine = '', runLine = ''] = output.split('\n');
        assert.ok(watcherLine.startsWith('o/r pull 12 state=holding age=30s'), output);
        assert.ok(watcherLine.includes('reason=clone busy'), output);
        assert.ok(watcherLine.includes('hint=commit or stash first'), output);
        assert.ok(watcherLine.includes('comments=101,102'), output);
        assert.ok(watcherLine.includes('last_error=HTTP 502: Bad Gateway'), output);
        assert.ok(!watcherLine.endsWith(' dead'), output);
        assert.equal(runLine, 'run 20261002120000-101 state=running comments=101,102 age=90s');
    });

    await test('status text is shown without control characters or forged lines', async (t) => {
        const setup = await makeSetup(t);
        await seedLiveOwner(setup);
        const hostile = 'x\u001B[2J\ny/z pull 1 state=polling\u202E\u0007';
        seedStatus(setup, { reason: hostile, hint: hostile, comment: hostile, lastError: hostile });
        assert.equal(await runList(setup.deps, setup.stateDir), 0);
        const output = setup.deps.outText();
        assert.equal(output.split('\n').length, 2, output);
        assert.ok(output.startsWith('o/r pull 12 state=holding'), output);
        assertNoControl(output);
    });

    await test('a dead lock pid is marked dead', async (t) => {
        const setup = await makeSetup(t);
        seedLock(setup, { pid: await deadPid(setup), pidStart: OLD_START });
        seedStatus(setup, { state: 'polling' });
        assert.equal(await runList(setup.deps, setup.stateDir), 0);
        const [watcherLine = ''] = setup.deps.outText().split('\n');
        assert.ok(watcherLine.startsWith('o/r pull 12 state=polling'), watcherLine);
        assert.ok(watcherLine.endsWith(' dead'), watcherLine);
    });

    await test('an unreadable record is reported and the command still succeeds', async (t) => {
        const setup = await makeSetup(t);
        seedStatus(setup);
        const runId = seedUnreadableRecord(setup);
        assert.equal(await runList(setup.deps, setup.stateDir), 0);
        const expected = `unreadable record ${path.join(runDir(setup.stateDir, runId), 'record.json')} (format 9)`;
        assert.ok(setup.deps.outText().includes(expected), setup.deps.outText());
    });

    await test('another state format is reported and exits 0', async (t) => {
        const setup = await makeSetup(t);
        setFormat(setup, '2');
        assert.equal(await runList(setup.deps, setup.stateDir), 0);
        assert.ok(setup.deps.outText().includes('unsupported state format 2'), setup.deps.outText());
    });

    await test('an unsafe state directory exits 1', async (t) => {
        const setup = await makeSetup(t);
        fs.chmodSync(setup.stateDir, 0o755);
        assert.equal(await runList(setup.deps, setup.stateDir), 1);
        assert.ok(setup.deps.outText().includes('unsafe state directory'), setup.deps.outText());
    });
});

await describe('stop', async () => {
    await test('stops the watcher and kills only its tagged dead pane on the lock socket', async (t) => {
        const setup = await makeSetup(t, { env: { TMUX: OTHER_TMUX } });
        const owner = await seedLiveOwner(setup);
        seedRecord(setup, '20261002120000-101');
        seedRecord(setup, '20261002120000-303', { prKey: 'o+r+13' });
        respondPanes(setup, '%1 1\n%2 0\n', '%2 0\n');
        assert.equal(await stop(setup), 0, printed(setup));
        const output = setup.deps.outText();
        assert.ok(output.includes('left in place: run 20261002120000-101 state=running'), output);
        assert.ok(!output.includes('20261002120000-303'), output);
        assert.ok(output.includes(`stopped watcher for ${PR.prUrl}`), output);
        assert.equal(pidAlive(owner), false);
        assertConditionalKill(setup);
        assert.ok(!setup.deps.logLines.join('\n').includes('left the pane'));
        for (const key of ['list-panes', 'if-shell']) {
            const calls = tmuxCalls(setup, key);
            assert.ok(calls.length > 0, key);
            for (const call of calls) {
                assert.deepEqual(call.args.slice(0, 2), ['-S', LOCK_SOCKET], key);
            }
        }
        assert.ok(fs.existsSync(path.join(runDir(setup.stateDir, '20261002120000-101'), 'record.json')));
    });

    await test('a pane the conditional kill leaves in place is logged, never killed directly', async (t) => {
        const setup = await makeSetup(t);
        await seedLiveOwner(setup);
        respondPanes(setup, '%1 1\n');
        assert.equal(await stop(setup), 0, printed(setup));
        assertConditionalKill(setup);
        assert.ok(setup.deps.logLines.join('\n').includes('left the pane %1 alone'), printed(setup));
    });

    await test('a watcher that was already dead is reported and its dead pane goes through the conditional kill', async (t) => {
        const setup = await makeSetup(t);
        seedLock(setup, { pid: await deadPid(setup), pidStart: OLD_START });
        respondPanes(setup, '%1 1\n', '');
        assert.equal(await stop(setup), 0, printed(setup));
        const output = setup.deps.outText();
        assert.ok(output.includes('was not running'), output);
        assert.ok(output.includes(`stopped watcher for ${PR.prUrl}`), output);
        assertConditionalKill(setup);
        assert.equal(setup.fake.calls('other').length, 0);
    });

    await test('a watcher that was already dead keeps a live pane', async (t) => {
        const setup = await makeSetup(t);
        seedLock(setup, { pid: await deadPid(setup), pidStart: OLD_START });
        respondPanes(setup, '%1 0\n');
        assert.equal(await stop(setup), 0, printed(setup));
        assert.equal(conditionalKills(setup).length, 0);
    });

    await test('a signalled watcher left as an unreaped zombie counts as exited', async (t) => {
        const setup = await makeSetup(t);
        const zombie = await spawnZombie(setup);
        seedLock(setup, { pid: zombie, pidStart: await startOf(setup, zombie) });
        respondPanes(setup, '%1 1\n', '');
        const started = performance.now();
        assert.equal(await stop(setup), 0, printed(setup));
        assert.ok(performance.now() - started < 5000, 'the stop waited for a zombie');
        assert.equal(pidAlive(zombie), true);
        assertConditionalKill(setup);
    });

    await test('a pane still alive right after the exit is checked again until tmux reports it dead', async (t) => {
        const setup = await makeSetup(t);
        await seedLiveOwner(setup);
        let listed = 0;
        setup.fake.respond('tmux', 'list-panes', () => {
            listed += 1;
            return { stdout: listed === 1 ? '%1 0\n' : '%1 1\n' };
        });
        assert.equal(await stop(setup), 0, printed(setup));
        assert.ok(listed >= 2);
        assert.equal(conditionalKills(setup).length, 1);
    });

    await test('a failed ps for a live watcher is unverifiable and nothing is signalled', async (t) => {
        const setup = await makeSetup(t, {
            psPassthrough: false,
            prime: (fake) => {
                fake.respond('other', 'other', { code: 1 });
            },
        });
        const owner = setup.testEnv.spawnOrphan('sleep', ['300']);
        seedLock(setup, { pid: owner, pidStart: OLD_START });
        respondPanes(setup, '%1 1\n');
        assert.equal(await stop(setup), 1);
        assert.ok(setup.deps.outText().includes(`could not verify watcher pid ${owner}`), printed(setup));
        assert.equal(pidAlive(owner), true);
        assert.equal(conditionalKills(setup).length, 0);
    });

    await test('a pid with another start time is not signalled', async (t) => {
        const setup = await makeSetup(t);
        const owner = setup.testEnv.spawnOrphan('sleep', ['300']);
        seedLock(setup, { pid: owner, pidStart: OLD_START });
        respondPanes(setup, '%1 1\n');
        assert.equal(await stop(setup), 1);
        assert.ok(setup.deps.outText().includes('belongs to another process'), printed(setup));
        assert.equal(pidAlive(owner), true);
        assert.equal(conditionalKills(setup).length, 0);
    });

    await test('a watcher that outlives the stop wait fails the stop', async (t) => {
        const setup = await makeSetup(t, { env: { PRWC_STOP_WAIT: '1' } });
        const readyFile = path.join(setup.testEnv.root, 'term-ready');
        const owner = setup.testEnv.spawnOrphan(process.execPath, ['-e', TERM_IGNORER, readyFile]);
        assert.ok(await waitUntil(10_000, () => fs.existsSync(readyFile)), 'the TERM-ignoring orphan never started');
        seedLock(setup, { pid: owner, pidStart: await startOf(setup, owner) });
        respondPanes(setup, '%1 1\n');
        assert.equal(await stop(setup), 1);
        assert.ok(setup.deps.outText().includes(`watcher pid ${owner} did not exit within 1 seconds`), printed(setup));
        assert.equal(pidAlive(owner), true);
        assert.equal(conditionalKills(setup).length, 0);
    });

    await test('the exit wait ends at its deadline although every ps call is slow', async (t) => {
        const setup = await makeSetup(t, { env: { PRWC_STOP_WAIT: '1' } });
        const readyFile = path.join(setup.testEnv.root, 'term-ready');
        const owner = setup.testEnv.spawnOrphan(process.execPath, ['-e', TERM_IGNORER, readyFile]);
        assert.ok(await waitUntil(10_000, () => fs.existsSync(readyFile)), 'the TERM-ignoring orphan never started');
        seedLock(setup, { pid: owner, pidStart: await startOf(setup, owner) });
        const timeouts: (number | undefined)[] = [];
        const slowPs = (request: CommandRequest): boolean => path.basename(request.file) === 'ps';
        setup.deps.runner = slowCalls(setup.fake.runner, slowPs, 30_000, timeouts);
        const started = performance.now();
        assert.equal(await stop(setup), 1);
        assert.ok(performance.now() - started < 4000, 'the stop outlived its wait');
        assert.ok(setup.deps.outText().includes('did not exit within 1 seconds'), printed(setup));
        assert.ok(timeouts.length > 0 && timeouts.length <= 2, String(timeouts));
        assert.ok(
            timeouts.every((value) => value !== undefined && value <= 1000),
            String(timeouts)
        );
        assert.equal(pidAlive(owner), true);
    });

    await test('a relative lock socket is refused before any signal', async (t) => {
        const setup = await makeSetup(t);
        const owner = await seedLiveOwner(setup, 'relative/sock');
        assert.equal(await stop(setup), 1);
        assert.ok(setup.deps.outText().includes('invalid lock socket'), printed(setup));
        assert.equal(pidAlive(owner), true);
    });

    await test('a live pane is never killed', async (t) => {
        const setup = await makeSetup(t);
        await seedLiveOwner(setup);
        respondPanes(setup, '%1 0\n');
        assert.equal(await stop(setup), 0, printed(setup));
        assert.equal(conditionalKills(setup).length, 0);
        assert.equal(tmuxCalls(setup, 'kill-pane').length, 0);
    });

    await test('an unknown PR is not watched', async (t) => {
        const setup = await makeSetup(t);
        const other: PrRef = { ...PR, number: 13, prUrl: 'https://github.com/o/r/pull/13', prKey: 'o+r+13' };
        assert.equal(await stop(setup, other), 1);
        assert.ok(setup.deps.outText().includes(`not watched: ${other.prUrl}`), printed(setup));
    });

    await test('another state format sends no signal', async (t) => {
        const setup = await makeSetup(t);
        const owner = await seedLiveOwner(setup);
        setFormat(setup, '2');
        assert.equal(await stop(setup), 1);
        assert.ok(setup.deps.outText().includes('unsupported state format 2'), printed(setup));
        assert.equal(pidAlive(owner), true);
    });

    await test('an unsafe state directory sends no signal', async (t) => {
        const setup = await makeSetup(t);
        const owner = await seedLiveOwner(setup);
        fs.chmodSync(setup.stateDir, 0o755);
        assert.equal(await stop(setup), 1);
        assert.ok(setup.deps.outText().includes('unsafe state directory'), printed(setup));
        assert.equal(pidAlive(owner), true);
    });

    await test('an unreadable record is reported while the stop still succeeds', async (t) => {
        const setup = await makeSetup(t);
        await seedLiveOwner(setup);
        seedUnreadableRecord(setup);
        respondPanes(setup, '%1 0\n');
        assert.equal(await stop(setup), 0, printed(setup));
        const output = setup.deps.outText();
        assert.ok(output.includes('unreadable record'), output);
        assert.ok(output.includes(`stopped watcher for ${PR.prUrl}`), output);
    });
});
