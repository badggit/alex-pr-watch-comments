import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test, type TestContext } from 'node:test';

import { acquireWorktreeLock } from '../../src/locks.ts';
import {
    effectiveGhConfigDir,
    normalizeCallerPath,
    ownerStopHookSources,
    preflight,
    resolveExecutable,
    type PreflightResult,
} from '../../src/preflight.ts';
import { createProcessRunner } from '../../src/proc.ts';
import { createRun } from '../../src/runStore.ts';
import { initState, worktreeKey } from '../../src/stateStore.ts';
import { NOT_IN_TMUX } from '../../src/tmuxControl.ts';
import type { CliOptions, Env, PrRef, Session } from '../../src/types.ts';
import { createFakeRunner, type FakeRunner } from '../support/fakeRunner.ts';
import { gitSync, makePrClone, offlineGitRunner } from '../support/gitRepo.ts';
import { createTestEnv, type TestDeps, type TestEnv } from '../support/testEnv.ts';

const FIXTURES = path.join(import.meta.dirname, '..', 'fixtures', 'preflight');
const BRANCH = 'feature';
const PR: PrRef = {
    host: 'github.com',
    owner: 'o',
    repo: 'r',
    number: 12,
    prUrl: 'https://github.com/o/r/pull/12',
    prKey: 'o+r+12',
};
const STOP_HOOK = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'true' }] }] } };
const AUTH_FAILURE = { code: 1, stderr: 'You are not logged into any GitHub hosts. To log in, run: gh auth login\n' };
const TOKEN_VALUE = 'tok-value';
const RUN_A = '20261002120000-101';
const RUN_B = '20261002120001-102';

interface Setup {
    testEnv: TestEnv;
    fake: FakeRunner;
    gitRoot: string;
    clone: string;
}

interface SetupOptions {
    prInfo?: string;
    ownerRepo?: string;
    authFails?: boolean;
}

interface RunOptions {
    pr?: PrRef;
    env?: Env;
    dir?: string;
    claude?: string;
    cwd?: string;
    nodePath?: string;
    psPath?: string;
    inPlace?: boolean;
}

interface Run {
    result: PreflightResult;
    deps: TestDeps;
}

function readFixture(name: string): unknown {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
    return parsed;
}

async function setUp(t: TestContext, opts?: SetupOptions): Promise<Setup> {
    const testEnv = await createTestEnv();
    t.after(() => {
        testEnv.cleanup();
    });
    const gitRoot = path.join(testEnv.root, 'git');
    const ownerRepo = opts?.ownerRepo ?? 'o/r';
    const clone = makePrClone(gitRoot, BRANCH, ownerRepo, testEnv.env);
    const offline = offlineGitRunner(createProcessRunner(testEnv.env), gitRoot, ownerRepo);
    const fake = createFakeRunner({ passthrough: { git: offline } });
    fake.respond('tmux', 'display-message', { stdout: '$1 @1\n' });
    fake.respond('gh', 'PrwcPrInfo', { json: readFixture(opts?.prInfo ?? 'prInfoOpen.json') });
    if (opts?.authFails === true) {
        fake.respond('gh', 'auth_status', AUTH_FAILURE);
    }
    return { testEnv, fake, gitRoot, clone };
}

function cliOptions(dir: string, claude?: string, pr = PR, inPlace = true): CliOptions {
    return {
        mode: 'watch',
        pr,
        dir,
        interval: 15,
        claude,
        claudeArgs: [],
        keepPanes: 5,
        batchMax: 5,
        once: false,
        inPlace,
        attach: false,
    };
}

async function runPreflight(setup: Setup, opts?: RunOptions): Promise<Run> {
    const deps: TestDeps = { ...setup.testEnv.deps(setup.fake.runner), env: opts?.env ?? setup.testEnv.env };
    const options = cliOptions(opts?.dir ?? setup.clone, opts?.claude, opts?.pr, opts?.inPlace);
    const cwd = opts?.cwd ?? setup.testEnv.root;
    const nodePath = opts?.nodePath ?? process.execPath;
    const result =
        opts?.psPath === undefined
            ? await preflight(deps, options, cwd, nodePath)
            : await preflight(deps, options, cwd, nodePath, opts.psPath);
    return { result, deps };
}

function sessionOf(result: PreflightResult): Session {
    assert.ok(result.ok, result.ok ? '' : `preflight refused: ${result.reason}`);
    return result.session;
}

function reasonOf(result: PreflightResult): string {
    assert.ok(!result.ok, 'preflight was expected to refuse');
    return result.reason;
}

async function refusalOf(setup: Setup, opts?: RunOptions): Promise<string> {
    const run = await runPreflight(setup, opts);
    return reasonOf(run.result);
}

async function sessionFrom(setup: Setup, opts?: RunOptions): Promise<Session> {
    const run = await runPreflight(setup, opts);
    return sessionOf(run.result);
}

function warnings(deps: TestDeps): string[] {
    return deps.logLines.filter((line) => line.startsWith('warn '));
}

function commandV(name: string, pathValue: string): string {
    const shell = spawnSync('/bin/sh', ['-c', `command -v ${name}`], { env: { PATH: pathValue }, encoding: 'utf8' });
    return shell.stdout.trim();
}

function writeJson(file: string, value: unknown): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
}

function writeExecutable(file: string, text: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, { mode: 0o755 });
}

await describe('gitRepo helper', async () => {
    await test('the clone fetches only through the offline runner and keeps the GitHub URL', async (t) => {
        const setup = await setUp(t);
        const { testEnv, gitRoot, clone } = setup;
        const fetchArgs = ['-C', clone, 'fetch', 'origin'];
        const git = path.join(testEnv.toolsDir, 'git');
        const offline = offlineGitRunner(createProcessRunner(testEnv.env), gitRoot);
        const viaOffline = await offline.run({ file: git, args: fetchArgs });
        assert.equal(viaOffline.code, 0, viaOffline.stderr);
        const plain = await createProcessRunner(testEnv.env).run({ file: git, args: fetchArgs });
        assert.notEqual(plain.code, 0);
        assert.match(plain.stderr, /not allowed/u);
        const rewrites = spawnSync(git, ['-C', clone, 'config', '--get-regexp', 'insteadof'], {
            env: { ...testEnv.env },
            encoding: 'utf8',
        });
        assert.equal(rewrites.stdout, '');
        assert.equal(
            gitSync(testEnv.env, ['-C', clone, 'remote', 'get-url', 'origin']).trim(),
            'https://github.com/o/r.git'
        );
        assert.equal(gitSync(testEnv.env, ['-C', clone, 'symbolic-ref', '--short', 'HEAD']).trim(), BRANCH);
    });
});

await describe('PATH and gh config helpers', async () => {
    await test('normalizeCallerPath drops empty and relative entries and normalizes the rest', () => {
        assert.equal(
            normalizeCallerPath('rel/bin::/abs/one/:.:/abs//two:/abs/./three'),
            '/abs/one:/abs/two:/abs/three'
        );
        assert.equal(normalizeCallerPath('/:/abs'), '/:/abs');
        assert.equal(normalizeCallerPath(''), '');
        assert.equal(
            normalizeCallerPath('/abs/one:/abs/\u0001two:/abs/th\nree:/abs/\u007Ffour:/abs/five'),
            '/abs/one:/abs/five'
        );
    });

    await test('normalizeCallerPath drops entries in or below an excluded directory, in any spelling', async (t) => {
        const testEnv = await createTestEnv();
        t.after(() => {
            testEnv.cleanup();
        });
        const root = testEnv.root;
        const project = path.join(root, 'project');
        fs.mkdirSync(path.join(project, 'bin'), { recursive: true });
        fs.symlinkSync(project, path.join(root, 'link'));
        fs.symlinkSync(path.join(project, 'bin'), path.join(root, 'binlink'));
        const entries = [
            `${project}/bin`,
            `${project}/`,
            `${root}/link/bin`,
            `${root}/binlink`,
            `${project}/missing/bin`,
            `${root}/project-x`,
            `${root}/other`,
        ];
        const kept = `${root}/project-x:${root}/other`;
        assert.equal(normalizeCallerPath(entries.join(':'), [project]), kept);
        assert.equal(normalizeCallerPath(entries.join(':'), [`${root}/link`]), kept);
        assert.equal(normalizeCallerPath(`/:${root}/other`, [root]), '/');
    });

    await test('resolveExecutable returns the first absolute executable file as found', async (t) => {
        const testEnv = await createTestEnv();
        t.after(() => {
            testEnv.cleanup();
        });
        const root = testEnv.root;
        fs.mkdirSync(path.join(root, 'dirtool', 'tool'), { recursive: true });
        fs.mkdirSync(path.join(root, 'plain'), { recursive: true });
        fs.writeFileSync(path.join(root, 'plain', 'tool'), 'not executable\n', { mode: 0o644 });
        writeExecutable(path.join(root, 'exec', 'tool'), '#!/bin/sh\nexit 0\n');
        fs.symlinkSync(path.join(root, 'exec', 'tool'), path.join(root, 'link'));
        fs.mkdirSync(path.join(root, 'linkdir'));
        fs.symlinkSync(path.join(root, 'exec', 'tool'), path.join(root, 'linkdir', 'tool'));
        const searchPath = ['exec', `${root}/dirtool`, `${root}/plain`, `${root}/linkdir`, `${root}/exec`].join(':');
        assert.equal(resolveExecutable('tool', searchPath), path.join(root, 'linkdir', 'tool'));
        assert.equal(resolveExecutable('missing', searchPath), undefined);
    });

    await test('resolveExecutable spells a hit in the root entry with one slash', () => {
        // No executable lives directly in / on every system, so a name with a directory part stands in: dash
        // prints //NAME for a root PATH entry and bash prints /NAME; the single-slash form is the recorded one.
        assert.equal(resolveExecutable('bin/sh', '/'), '/bin/sh');
        assert.equal(resolveExecutable('sh', '/bin'), '/bin/sh');
    });

    await test('effectiveGhConfigDir follows the gh lookup order and makes relative values absolute', () => {
        assert.equal(
            effectiveGhConfigDir({ GH_CONFIG_DIR: '/cfg dir', XDG_CONFIG_HOME: '/x', HOME: '/h' }, '/c'),
            '/cfg dir'
        );
        assert.equal(effectiveGhConfigDir({ GH_CONFIG_DIR: '', XDG_CONFIG_HOME: '/x', HOME: '/h' }, '/c'), '/x/gh');
        assert.equal(effectiveGhConfigDir({ XDG_CONFIG_HOME: '', HOME: '/h' }, '/c'), '/h/.config/gh');
        assert.equal(effectiveGhConfigDir({ GH_CONFIG_DIR: 'rel' }, '/c'), '/c/rel');
        assert.equal(effectiveGhConfigDir({ HOME: '' }, '/c'), undefined);
    });

    await test('ownerStopHookSources reads user, project and local settings', async (t) => {
        const testEnv = await createTestEnv();
        t.after(() => {
            testEnv.cleanup();
        });
        const top = path.join(testEnv.root, 'top');
        assert.deepEqual(ownerStopHookSources(testEnv.home, top), []);
        writeJson(path.join(testEnv.home, '.claude', 'settings.json'), STOP_HOOK);
        writeJson(path.join(top, '.claude', 'settings.json'), { hooks: { Stop: [] } });
        writeJson(path.join(top, '.claude', 'settings.local.json'), STOP_HOOK);
        assert.deepEqual(ownerStopHookSources(testEnv.home, top), ['user', 'local']);
        writeJson(path.join(top, '.claude', 'settings.json'), STOP_HOOK);
        assert.deepEqual(ownerStopHookSources(undefined, top), ['project', 'local']);
    });
});

await describe('preflight', async () => {
    await test('happy path records the session', async (t) => {
        const setup = await setUp(t);
        const { testEnv, fake, clone } = setup;
        const { result, deps } = await runPreflight(setup);
        const session = sessionOf(result);
        assert.equal(session.remote, 'origin');
        assert.deepEqual(session.tools, {
            node: process.execPath,
            git: path.join(testEnv.toolsDir, 'git'),
            gh: path.join(testEnv.binDir, 'gh'),
            tmux: path.join(testEnv.binDir, 'tmux'),
            claude: path.join(testEnv.binDir, 'claude'),
        });
        assert.notEqual(fs.realpathSync(session.tools.git), session.tools.git);
        assert.equal(commandV('git', session.callerPath), session.tools.git);
        assert.equal(session.callerPath, testEnv.env.PATH);
        assert.equal(session.dirCanon, clone);
        assert.equal(session.toplevel, clone);
        assert.equal(session.worktreeKey, worktreeKey(clone));
        assert.deepEqual(session.ghEnv, [`GH_CONFIG_DIR=${testEnv.home}/.config/gh`, 'GH_HOST=github.com']);
        assert.deepEqual(session.tmux, {
            socket: '/tmp/prwc-test-socket',
            pane: '%1',
            sessionId: '$1',
            windowId: '@1',
        });
        assert.deepEqual(session.pr, PR);
        assert.equal(session.viewer, 'reviewer');
        assert.equal(session.headRef, BRANCH);
        assert.equal(session.headOwner, 'o');
        assert.equal(session.headRepo, 'r');
        assert.equal(session.stateDir, testEnv.stateDir);
        assert.deepEqual(
            [session.interval, session.keepPanes, session.batchMax, session.claudeArgs, session.once],
            [15, 5, 5, [], false]
        );
        const auth = fake.calls('gh').find((call) => call.key === 'auth_status');
        assert.deepEqual(auth?.args, ['auth', 'status', '--hostname', 'github.com']);
        const info = fake.calls('gh').find((call) => call.key === 'PrwcPrInfo');
        const args = info?.args ?? [];
        assert.equal(args[args.indexOf('--hostname') + 1], 'github.com');
        assert.deepEqual(warnings(deps), []);
    });

    await test('a mixed-case head repository matches a mixed-case origin URL', async (t) => {
        const setup = await setUp(t, { prInfo: 'prInfoMixedCase.json', ownerRepo: 'Owner/Repo' });
        const { result } = await runPreflight(setup);
        const session = sessionOf(result);
        assert.equal(session.remote, 'origin');
        assert.equal(session.headOwner, 'owner');
        assert.equal(session.headRepo, 'repo');
    });

    await test('gh context forwards only the effective config directory and github.com', async (t) => {
        const setup = await setUp(t);
        const base = setup.testEnv.env;
        const root = setup.testEnv.root;
        const explicit = await runPreflight(setup, {
            env: { ...base, GH_CONFIG_DIR: '/cfg dir', GH_HOST: 'github.com', GH_REPO: 'x/y' },
        });
        assert.deepEqual(sessionOf(explicit.result).ghEnv, ['GH_CONFIG_DIR=/cfg dir', 'GH_HOST=github.com']);
        const xdg = await runPreflight(setup, { env: { ...base, XDG_CONFIG_HOME: `${root}/xdg` } });
        assert.equal(sessionOf(xdg.result).ghEnv[0], `GH_CONFIG_DIR=${root}/xdg/gh`);
        for (const host of ['GitHub.com', '']) {
            const run = await runPreflight(setup, { env: { ...base, GH_HOST: host } });
            assert.deepEqual(sessionOf(run.result).ghEnv[1], 'GH_HOST=github.com');
        }
    });

    await test('a set token variable only warns, by name', async (t) => {
        const setup = await setUp(t);
        const { result, deps } = await runPreflight(setup, { env: { ...setup.testEnv.env, GH_TOKEN: TOKEN_VALUE } });
        sessionOf(result);
        const lines = warnings(deps);
        assert.ok(
            lines.some((line) => line.includes('GH_TOKEN is set') && line.includes('gh login stored for github.com'))
        );
        assert.ok(deps.logLines.every((line) => !line.includes(TOKEN_VALUE)));
    });

    await test('a failed gh login check names the ignored token variable', async (t) => {
        const setup = await setUp(t, { authFails: true });
        const { result, deps } = await runPreflight(setup, { env: { ...setup.testEnv.env, GH_TOKEN: TOKEN_VALUE } });
        const reason = reasonOf(result);
        assert.ok(reason.includes('gh is not authenticated for github.com'), reason);
        assert.ok(reason.includes('GH_TOKEN is set but ignored'), reason);
        assert.ok(!reason.includes(TOKEN_VALUE));
        assert.ok(deps.logLines.every((line) => !line.includes(TOKEN_VALUE)));
    });

    await test('a GitHub Enterprise Server PR uses its own host for gh, the remote and the worker panes', async (t) => {
        const setup = await setUp(t);
        const host = 'git.example.com';
        const pr: PrRef = { ...PR, host, prUrl: `https://${host}/o/r/pull/12`, prKey: `${host}+o+r+12` };
        gitSync(setup.testEnv.env, ['-C', setup.clone, 'remote', 'set-url', 'origin', `git@${host}:o/r.git`]);
        const session = await sessionFrom(setup, { pr, env: { ...setup.testEnv.env, GH_HOST: host } });
        assert.deepEqual(session.pr, pr);
        assert.equal(session.remote, 'origin');
        assert.deepEqual(session.ghEnv[1], `GH_HOST=${host}`);
        const calls = setup.fake.calls('gh');
        assert.deepEqual(calls.find((call) => call.key === 'auth_status')?.args, [
            'auth',
            'status',
            '--hostname',
            host,
        ]);
        const args = calls.find((call) => call.key === 'PrwcPrInfo')?.args ?? [];
        assert.equal(args[args.indexOf('--hostname') + 1], host);
    });

    await test('a github.com remote does not satisfy a GitHub Enterprise Server PR', async (t) => {
        const setup = await setUp(t);
        const host = 'git.example.com';
        const pr: PrRef = { ...PR, host, prUrl: `https://${host}/o/r/pull/12`, prKey: `${host}+o+r+12` };
        const reason = await refusalOf(setup, { pr });
        assert.ok(reason.includes(`git remote add NAME https://${host}/o/r.git`), reason);
    });

    await test('another GH_HOST is refused before any gh call and never printed', async (t) => {
        const setup = await setUp(t);
        const host = 'ghe.example.invalid';
        const { result, deps } = await runPreflight(setup, { env: { ...setup.testEnv.env, GH_HOST: host } });
        const reason = reasonOf(result);
        assert.ok(reason.includes('another host than the PR host github.com'), reason);
        assert.ok(!reason.includes(host));
        assert.equal(setup.fake.calls('gh').length, 0);
        assert.ok(deps.logLines.every((line) => !line.includes(host)));
    });

    await test('an undeterminable gh config directory is refused before any gh call', async (t) => {
        const setup = await setUp(t);
        const { result } = await runPreflight(setup, { env: { ...setup.testEnv.env, HOME: undefined } });
        assert.equal(reasonOf(result), 'cannot determine the gh config directory (set GH_CONFIG_DIR)');
        assert.equal(setup.fake.calls('gh').length, 0);
    });

    await test('a missing ps is refused before any gh call', async (t) => {
        const setup = await setUp(t);
        const psPath = path.join(setup.testEnv.root, 'no-ps');
        const { result } = await runPreflight(setup, { psPath });
        assert.ok(reasonOf(result).startsWith('missing required tool: ps'), reasonOf(result));
        assert.equal(setup.fake.calls('gh').length, 0);
    });

    await test('owner Stop hooks give a warning with the stop quiet period', async (t) => {
        const setup = await setUp(t);
        const { testEnv, clone } = setup;
        const none = await runPreflight(setup);
        sessionOf(none.result);
        assert.ok(none.deps.logLines.every((line) => !line.includes('Stop hooks')));
        const userSettings = path.join(testEnv.home, '.claude', 'settings.json');
        writeJson(userSettings, { hooks: { Stop: [] } });
        const empty = await runPreflight(setup);
        sessionOf(empty.result);
        assert.ok(empty.deps.logLines.every((line) => !line.includes('Stop hooks')));
        fs.writeFileSync(userSettings, '{"hooks": {"Stop": [');
        const broken = await runPreflight(setup);
        sessionOf(broken.result);
        assert.ok(broken.deps.logLines.every((line) => !line.includes('Stop hooks')));
        writeJson(userSettings, STOP_HOOK);
        const user = await runPreflight(setup);
        sessionOf(user.result);
        assert.ok(
            warnings(user.deps).some(
                (line) =>
                    line.includes('owner Stop hooks found (user)') &&
                    line.includes('completion waits for PRWC_STOP_QUIET (10 s) without hook activity') &&
                    line.includes('completed Claude and its lock stay open until you close Claude')
            ),
            user.deps.logLines.join('\n')
        );
        const slow = await runPreflight(setup, { env: { ...testEnv.env, PRWC_STOP_QUIET: '30' } });
        assert.ok(warnings(slow.deps).some((line) => line.includes('PRWC_STOP_QUIET (30 s)')));
        fs.rmSync(userSettings);
        writeJson(path.join(clone, '.claude', 'settings.local.json'), STOP_HOOK);
        const local = await runPreflight(setup);
        sessionOf(local.result);
        assert.ok(warnings(local.deps).some((line) => line.includes('owner Stop hooks found (local)')));
        assert.ok(local.deps.logLines.every((line) => !line.includes(clone)));
    });

    await test('a subdirectory shares the worktree key and contends for one worktree lock', async (t) => {
        const setup = await setUp(t);
        const { testEnv, clone } = setup;
        const sub = path.join(clone, 'sub');
        fs.mkdirSync(sub);
        const first = await sessionFrom(setup);
        const second = await sessionFrom(setup, { dir: sub });
        assert.equal(first.worktreeKey, second.worktreeKey);
        assert.notEqual(first.dirCanon, second.dirCanon);
        assert.equal(second.dirCanon, sub);
        assert.equal(second.toplevel, clone);
        const state = initState(testEnv.stateDir);
        assert.ok(state.ok);
        const deps = testEnv.deps(setup.fake.runner);
        const now = deps.nowSeconds();
        assert.ok(acquireWorktreeLock(state.stateDir, first.worktreeKey, RUN_A, process.pid, deps.log, now));
        createRun(state.stateDir, RUN_A);
        assert.equal(acquireWorktreeLock(state.stateDir, second.worktreeKey, RUN_B, process.pid, deps.log, now), false);
    });

    await test('refuses outside tmux', async (t) => {
        const setup = await setUp(t);
        const { result } = await runPreflight(setup, { env: { ...setup.testEnv.env, TMUX: undefined } });
        assert.equal(reasonOf(result), NOT_IN_TMUX);
        assert.equal(setup.fake.calls('gh').length, 0);
    });

    await test('the tmux check runs before the state directory check', async (t) => {
        const setup = await setUp(t);
        const env = { ...setup.testEnv.env, TMUX: undefined, PRWC_STATE_DIR: `${setup.testEnv.root}/state dir` };
        assert.equal(await refusalOf(setup, { env }), NOT_IN_TMUX);
    });

    await test('refuses when gh is not authenticated', async (t) => {
        const setup = await setUp(t, { authFails: true });
        const { result } = await runPreflight(setup);
        const reason = reasonOf(result);
        assert.equal(reason, 'gh is not authenticated for github.com (run: gh auth login)');
        assert.ok(!reason.includes('ignored'));
    });

    await test('refuses a merged pull request', async (t) => {
        const setup = await setUp(t, { prInfo: 'prInfoMerged.json' });
        assert.equal(await refusalOf(setup), 'pull request is MERGED');
    });

    await test('refuses without push access', async (t) => {
        const setup = await setUp(t, { prInfo: 'prInfoNoPush.json' });
        assert.equal(await refusalOf(setup), 'no push access to the PR head');
    });

    await test('refuses a deleted head repository with the PR info message', async (t) => {
        const setup = await setUp(t, { prInfo: 'prInfoDeletedHead.json' });
        const reason = await refusalOf(setup);
        assert.ok(reason.includes('head repository deleted'), reason);
    });

    await test('refuses an unsupported head branch name', async (t) => {
        const setup = await setUp(t, { prInfo: 'prInfoBadRef.json' });
        const reason = await refusalOf(setup);
        assert.ok(reason.startsWith('unsupported head branch name'), reason);
        assert.ok(!reason.includes(';'));
    });

    await test('--worktree works in the watch worktree next to the clone', async (t) => {
        const setup = await setUp(t);
        const { testEnv } = setup;
        const clone = fs.realpathSync.native(setup.clone);
        gitSync(testEnv.env, ['-C', clone, 'checkout', '--quiet', 'main']);
        fs.writeFileSync(path.join(clone, '.git', 'info', 'exclude'), 'CLAUDE.local.md\n');
        fs.writeFileSync(path.join(clone, 'CLAUDE.local.md'), 'notes\n');
        const worktree = path.join(path.dirname(clone), 'alex-pr-watch-comments-pr-12');
        const first = await runPreflight(setup, { inPlace: false });
        const session = sessionOf(first.result);
        assert.equal(session.dirCanon, worktree);
        assert.equal(session.toplevel, worktree);
        assert.equal(session.worktreeKey, worktreeKey(worktree));
        assert.deepEqual(session.worktree, { path: worktree, source: clone });
        assert.equal(fs.readlinkSync(path.join(worktree, 'CLAUDE.local.md')), path.join(clone, 'CLAUDE.local.md'));
        assert.ok(warnings(first.deps).some((line) => line.includes(`created the watch worktree ${worktree}`)));
        const second = await runPreflight(setup, { inPlace: false });
        assert.equal(sessionOf(second.result).dirCanon, worktree);
        assert.ok(!warnings(second.deps).some((line) => line.includes('created the watch worktree')));
        const inPlaceRun = await runPreflight(setup, { dir: worktree });
        const inPlace = sessionOf(inPlaceRun.result);
        assert.equal(inPlace.worktree, undefined);
        assert.equal(inPlace.dirCanon, worktree);
    });

    await test('--worktree inside another linked worktree works there in place and creates none', async (t) => {
        const setup = await setUp(t);
        const env = setup.testEnv.env;
        const clone = fs.realpathSync.native(setup.clone);
        gitSync(env, ['-C', clone, 'checkout', '--quiet', 'main']);
        const linked = path.join(path.dirname(clone), 'mine');
        gitSync(env, ['-C', clone, 'worktree', 'add', '--quiet', linked, BRANCH]);
        const run = await runPreflight(setup, { inPlace: false, dir: linked });
        const session = sessionOf(run.result);
        assert.equal(session.dirCanon, linked);
        assert.equal(session.toplevel, linked);
        assert.equal(session.worktree, undefined);
        assert.ok(!fs.existsSync(path.join(path.dirname(clone), 'alex-pr-watch-comments-pr-12')));
        assert.ok(
            run.deps.logLines.includes(`info already in the worktree ${linked}: --worktree works in place there`),
            run.deps.logLines.join('\n')
        );
    });

    await test('--worktree inside a linked worktree on another branch is refused without a new worktree', async (t) => {
        const setup = await setUp(t);
        const clone = fs.realpathSync.native(setup.clone);
        const linked = path.join(path.dirname(clone), 'other');
        gitSync(setup.testEnv.env, ['-C', clone, 'worktree', 'add', '--quiet', '-b', 'other', linked]);
        const reason = await refusalOf(setup, { inPlace: false, dir: linked });
        assert.equal(reason, `other is checked out, not ${BRANCH} (switch with: gh pr checkout 12)`);
        assert.ok(!fs.existsSync(path.join(path.dirname(clone), 'alex-pr-watch-comments-pr-12')));
    });

    await test('--worktree in a linked worktree that only shares the watch worktree name works in place', async (t) => {
        const setup = await setUp(t);
        const env = setup.testEnv.env;
        const clone = fs.realpathSync.native(setup.clone);
        gitSync(env, ['-C', clone, 'checkout', '--quiet', 'main']);
        const nested = path.join(clone, '.claude', 'worktrees', 'alex-pr-watch-comments-pr-12');
        gitSync(env, ['-C', clone, 'worktree', 'add', '--quiet', nested, BRANCH]);
        const session = await sessionFrom(setup, { inPlace: false, dir: nested });
        assert.equal(session.dirCanon, nested);
        assert.equal(session.worktree, undefined);
        assert.ok(!fs.existsSync(path.join(path.dirname(clone), 'alex-pr-watch-comments-pr-12')));
    });

    await test('--worktree in the watch worktree of another PR, reached through a symlink, works in place', async (t) => {
        const setup = await setUp(t);
        const env = setup.testEnv.env;
        const clone = fs.realpathSync.native(setup.clone);
        gitSync(env, ['-C', clone, 'checkout', '--quiet', 'main']);
        const other = path.join(path.dirname(clone), 'alex-pr-watch-comments-pr-7');
        gitSync(env, ['-C', clone, 'worktree', 'add', '--quiet', other, BRANCH]);
        fs.mkdirSync(path.join(other, 'deep'));
        const link = path.join(setup.testEnv.root, 'link');
        fs.symlinkSync(other, link);
        const session = await sessionFrom(setup, { inPlace: false, dir: path.join(link, 'deep') });
        assert.equal(session.dirCanon, path.join(other, 'deep'));
        assert.equal(session.toplevel, other);
        assert.equal(session.worktree, undefined);
        assert.ok(!fs.existsSync(path.join(path.dirname(clone), 'alex-pr-watch-comments-pr-12')));
    });

    await test('--worktree in a name-alike worktree of a separate-git-dir clone works in place', async (t) => {
        const setup = await setUp(t);
        const env = setup.testEnv.env;
        const clone = fs.realpathSync.native(setup.clone);
        gitSync(env, ['-C', clone, 'checkout', '--quiet', 'main']);
        // git lists the git directory first; next to the clone, its sibling has the watch worktree's path.
        gitSync(env, ['-C', clone, 'init', '--quiet', `--separate-git-dir=${path.join(path.dirname(clone), 'G')}`]);
        const alike = path.join(path.dirname(clone), 'alex-pr-watch-comments-pr-12');
        gitSync(env, ['-C', clone, 'worktree', 'add', '--quiet', alike, BRANCH]);
        const session = await sessionFrom(setup, { inPlace: false, dir: alike });
        assert.equal(session.dirCanon, alike);
        assert.equal(session.worktree, undefined);
    });

    await test('--worktree started inside the watch worktree keeps using it as the watch worktree', async (t) => {
        const setup = await setUp(t);
        const clone = fs.realpathSync.native(setup.clone);
        gitSync(setup.testEnv.env, ['-C', clone, 'checkout', '--quiet', 'main']);
        const first = await runPreflight(setup, { inPlace: false });
        const { worktree } = sessionOf(first.result);
        assert.ok(worktree !== undefined);
        const second = await runPreflight(setup, { inPlace: false, dir: worktree.path });
        const inside = sessionOf(second.result);
        assert.deepEqual(inside.worktree, { path: worktree.path, source: clone });
    });

    await test('--worktree refuses while the clone has the head branch checked out', async (t) => {
        const setup = await setUp(t);
        const reason = await refusalOf(setup, { inPlace: false });
        assert.ok(reason.startsWith('feature is checked out in '), reason);
        assert.ok(reason.endsWith('or start the watcher with --in-place)'), reason);
    });

    await test('refuses a directory that is not a git repository', async (t) => {
        const setup = await setUp(t);
        const plain = path.join(setup.testEnv.root, 'plain');
        fs.mkdirSync(plain);
        const reason = await refusalOf(setup, { dir: plain });
        assert.ok(reason.startsWith('not a git repository'), reason);
    });

    await test('refuses a missing directory', async (t) => {
        const setup = await setUp(t);
        const reason = await refusalOf(setup, { dir: path.join(setup.testEnv.root, 'gone') });
        assert.ok(reason.startsWith('cannot open directory'), reason);
    });

    await test('refuses when no remote points to the head repository', async (t) => {
        const setup = await setUp(t);
        gitSync(setup.testEnv.env, ['-C', setup.clone, 'remote', 'set-url', 'origin', 'https://github.com/x/y.git']);
        const reason = await refusalOf(setup);
        assert.ok(reason.includes('git remote add NAME https://github.com/o/r.git'), reason);
    });

    await test('refuses another checked-out branch', async (t) => {
        const setup = await setUp(t);
        gitSync(setup.testEnv.env, ['-C', setup.clone, 'checkout', '--quiet', 'main']);
        const reason = await refusalOf(setup);
        assert.ok(reason.includes('gh pr checkout 12'), reason);
    });

    await test('refuses a --claude that is not an executable file', async (t) => {
        const setup = await setUp(t);
        const claude = path.join(setup.testEnv.root, 'claude-text');
        fs.writeFileSync(claude, '#!/bin/sh\n', { mode: 0o644 });
        const reason = await refusalOf(setup, { claude });
        assert.ok(reason.startsWith('missing required tool: claude'), reason);
    });

    await test('refuses push targets that are not the head repository', async (t) => {
        const cases: readonly (readonly (readonly string[])[])[] = [
            [['remote', 'set-url', '--push', 'origin', 'https://github.com/o/other.git']],
            [
                ['remote', 'set-url', '--add', '--push', 'origin', 'https://github.com/o/r.git'],
                ['remote', 'set-url', '--add', '--push', 'origin', 'git@github.com:o/r.git'],
            ],
            [['config', 'url.https://github.com/o/other.git.pushInsteadOf', 'https://github.com/o/r.git']],
            [['config', 'url.https://github.com/o/other.git.insteadOf', 'https://github.com/o/r.git']],
        ];
        const setup = await setUp(t);
        for (const [index, commands] of cases.entries()) {
            const root = path.join(setup.testEnv.root, `push-${index}`);
            const clone = makePrClone(root, BRANCH, 'o/r', setup.testEnv.env);
            for (const args of commands) {
                gitSync(setup.testEnv.env, ['-C', clone, ...args]);
            }
            const reason = await refusalOf(setup, { dir: clone });
            assert.equal(reason, 'push target of remote origin is not o/r', JSON.stringify(commands));
        }
    });

    await test('state directory path characters', async (t) => {
        const setup = await setUp(t);
        const { testEnv } = setup;
        const root = testEnv.root;
        const spaced = await runPreflight(setup, { env: { ...testEnv.env, PRWC_STATE_DIR: `${root}/state dir` } });
        const reason = reasonOf(spaced.result);
        assert.ok(reason.includes('PRWC_STATE_DIR') && reason.includes('without spaces'), reason);
        assert.equal(setup.fake.calls('gh').length, 0);
        const underscore = await runPreflight(setup, {
            env: { ...testEnv.env, PRWC_STATE_DIR: `${root}/state_dir_x` },
        });
        assert.equal(sessionOf(underscore.result).stateDir, `${root}/state_dir_x`);
        const relativeEnv = { ...testEnv.env, PRWC_STATE_DIR: 'rel_state' };
        const relative = await runPreflight(setup, { env: relativeEnv });
        assert.equal(sessionOf(relative.result).stateDir, `${root}/rel_state`);
        const spacedCwd = await runPreflight(setup, { env: relativeEnv, cwd: `${root}/my cwd` });
        assert.ok(reasonOf(spacedCwd.result).includes('without spaces'));
    });

    await test('tools resolve against the normalized caller PATH', async (t) => {
        const setup = await setUp(t);
        const { testEnv, clone } = setup;
        const root = testEnv.root;
        fs.mkdirSync(path.join(root, 'a'));
        fs.mkdirSync(path.join(root, 'b'));
        fs.symlinkSync(testEnv.tools.git, path.join(root, 'a', 'git'));
        const messy = await runPreflight(setup, {
            env: { ...testEnv.env, PATH: `${root}/a/:${root}//b:${testEnv.env.PATH}` },
        });
        const session = sessionOf(messy.result);
        assert.equal(session.tools.git, `${root}/a/git`);
        assert.ok(session.callerPath.startsWith(`${root}/a:${root}/b:`), session.callerPath);
        assert.equal(commandV('git', session.callerPath), session.tools.git);
        writeExecutable(path.join(clone, 'git'), '#!/bin/sh\nexit 0\n');
        const dotted = await runPreflight(setup, {
            env: { ...testEnv.env, PATH: `.:${testEnv.env.PATH}` },
            cwd: clone,
        });
        const dottedSession = sessionOf(dotted.result);
        assert.equal(dottedSession.tools.git, path.join(testEnv.toolsDir, 'git'));
        assert.equal(dottedSession.callerPath, testEnv.env.PATH);
    });

    await test('PATH entries inside the project working tree are never searched', async (t) => {
        const setup = await setUp(t);
        const { testEnv, clone } = setup;
        const sub = path.join(clone, 'sub');
        fs.mkdirSync(sub);
        writeExecutable(path.join(clone, 'bin', 'git'), '#!/bin/sh\nexit 0\n');
        const env = { ...testEnv.env, PATH: `${clone}/bin:${testEnv.root}/c\u0001trl:${testEnv.env.PATH}` };
        for (const dir of [clone, sub]) {
            const session = await sessionFrom(setup, { env, dir });
            assert.equal(session.tools.git, path.join(testEnv.toolsDir, 'git'), dir);
            assert.equal(session.callerPath, testEnv.env.PATH, dir);
        }
    });

    await test('a tool found inside the git toplevel through PATH is refused', async (t) => {
        const setup = await setUp(t);
        const { testEnv, clone } = setup;
        // GIT_DIR and GIT_WORK_TREE make git see the clone from a directory with no .git above it, so only the
        // check against the git toplevel can notice the planted git.
        const gitEnv = { ...testEnv.env, GIT_DIR: path.join(clone, '.git'), GIT_WORK_TREE: clone };
        const offline = offlineGitRunner(createProcessRunner(gitEnv), setup.gitRoot);
        const fake = createFakeRunner({ passthrough: { git: offline } });
        fake.respond('tmux', 'display-message', { stdout: '$1 @1\n' });
        fake.respond('gh', 'PrwcPrInfo', { json: readFixture('prInfoOpen.json') });
        writeExecutable(path.join(clone, 'bin', 'git'), `#!/bin/sh\nexec '${testEnv.tools.git}' "$@"\n`);
        const outside = path.join(testEnv.root, 'outside');
        fs.mkdirSync(outside);
        const env = { ...testEnv.env, PATH: `${clone}/bin:${testEnv.env.PATH}` };
        const reason = await refusalOf({ ...setup, fake }, { env, dir: outside });
        assert.equal(reason, `a required tool resolves inside the working tree ${clone} through PATH`);
    });

    await test('tool paths may contain @ and spaces but no control characters', async (t) => {
        const setup = await setUp(t);
        const root = setup.testEnv.root;
        const nodePath = path.join(root, 'opt', 'node@22', 'bin', 'node');
        fs.mkdirSync(path.dirname(nodePath), { recursive: true });
        fs.symlinkSync(process.execPath, nodePath);
        const withNode = await runPreflight(setup, { nodePath });
        assert.equal(sessionOf(withNode.result).tools.node, nodePath);
        const stub = fs.readFileSync(path.join(setup.testEnv.binDir, 'claude'), 'utf8');
        const spacedClaude = path.join(root, 'my tools', 'claude');
        writeExecutable(spacedClaude, stub);
        const spaced = await runPreflight(setup, { claude: spacedClaude });
        assert.equal(sessionOf(spaced.result).tools.claude, spacedClaude);
        const newlineClaude = path.join(root, 'cl\naude');
        writeExecutable(newlineClaude, stub);
        const newline = await runPreflight(setup, { claude: newlineClaude });
        assert.equal(
            reasonOf(newline.result),
            'unusable tool path for claude: it must be absolute with no control characters'
        );
    });
});
