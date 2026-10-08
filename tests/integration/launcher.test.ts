import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { PS_PATH } from '../../src/constants.ts';
import { createProcessRunner, LINUX_BOOT_ID_FILE, pidAlive, processStart } from '../../src/proc.ts';
import { removeRun } from '../../src/runRemoval.ts';
import { claimLaunch, createRun, launchDecision } from '../../src/runStore.ts';
import type { Env, Logger, RecordPatch, RunRecord } from '../../src/types.ts';
import { buildHookScript, buildLauncherScript, writeWorkerKit } from '../../src/workerKit.ts';
import { createTestEnv, waitUntil, type ObservedResult, type TestEnv } from '../support/testEnv.ts';

const RUN_ID = '20261002120000-456';
const OWNER_ARGS: readonly string[] = ['--model', 'x', 'a b', '$(echo pwned)', '*', 'SHELL=/bin/true'];
const STALE_TOKEN = 'stale-token';
const TRAILING_NEWLINES = /\n+$/u;
const GIT_REDIRECT_VARS: readonly string[] = [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_CONFIG_PARAMETERS',
    'GIT_CONFIG_COUNT',
    'GIT_NAMESPACE',
    'GIT_COMMON_DIR',
];
const HOOK_UTILITIES: readonly string[] = ['cat', 'tr', 'grep', 'date'];

interface Kit {
    env: TestEnv;
    rd: string;
    record: RunRecord;
}

interface KitOptions {
    patch?: RecordPatch;
    wait?: number;
    go?: boolean;
}

async function newEnv(t: TestContext): Promise<TestEnv> {
    const env = await createTestEnv();
    t.after(() => {
        env.cleanup();
    });
    return env;
}

function launcherRecord(env: TestEnv, patch?: RecordPatch): RunRecord {
    const project = path.join(env.root, 'project');
    fs.mkdirSync(project, { recursive: true });
    return {
        format: 2,
        runId: RUN_ID,
        prKey: 'o+r+12',
        owner: 'o',
        repo: 'r',
        number: 12,
        prUrl: 'https://github.com/o/r/pull/12',
        comments: [
            {
                nodeId: 'PRRC_kwDOAbc456',
                dbId: 456,
                url: 'https://github.com/o/r/pull/12#discussion_r456',
                threadId: 'PRRT_kwDOThread9',
                topDbId: 400,
                rocketAt: 1_790_000_000,
                eyesAdded: true,
            },
        ],
        headSha: 'a'.repeat(40),
        remote: 'origin',
        branch: 'feature-x',
        dir: project,
        worktreeKey: '0123456789abcdef',
        claude: path.join(env.binDir, 'claude'),
        git: path.join(env.toolsDir, 'git'),
        gh: path.join(env.binDir, 'gh'),
        callerPath: env.env.PATH ?? '',
        claudeArgs: [...OWNER_ARGS],
        state: 'running',
        reason: '',
        paneId: '%5',
        panePid: undefined,
        socket: '/tmp/prwc-test-socket',
        startedAt: undefined,
        watcherPid: 1,
        ...patch,
    };
}

async function prepareKit(t: TestContext, options?: KitOptions): Promise<Kit> {
    const env = await newEnv(t);
    const rd = createRun(env.stateDir, RUN_ID);
    const record = launcherRecord(env, options?.patch);
    assert.equal(writeWorkerKit(rd, record, options?.wait ?? 30), true);
    if (options?.go ?? true) {
        assert.equal(claimLaunch(env.stateDir, RUN_ID, 'go'), true);
    }
    return { env, rd, record };
}

function launcherEnv(kit: Kit, extra?: Env): Env {
    return { ...kit.env.env, PATH: '/usr/bin:/bin', ...extra };
}

function runLauncher(kit: Kit, extra?: Env): Promise<ObservedResult> {
    const launcher = path.join(kit.rd, 'launcher.sh');
    const observed = kit.env.spawnObserved('/bin/sh', [launcher], { env: launcherEnv(kit, extra) });
    return observed.result;
}

function startOrphanLauncher(kit: Kit, extra?: Env): number {
    return kit.env.spawnOrphan('/bin/sh', [path.join(kit.rd, 'launcher.sh')], { env: launcherEnv(kit, extra) });
}

function stubFile(kit: Kit, name: string): string {
    return path.join(kit.env.stubDir, name);
}

function readText(file: string): string {
    return fs.readFileSync(file, 'utf8');
}

function stubArgv(kit: Kit): string[] {
    return readText(stubFile(kit, 'claude.argv')).split('\0');
}

function promptArgument(kit: Kit): string {
    return readText(path.join(kit.rd, 'prompt.txt')).replace(TRAILING_NEWLINES, '');
}

function exitStatus(kit: Kit): string {
    return readText(path.join(kit.rd, 'exit_status'));
}

function filesUnder(dir: string): string[] {
    return fs
        .readdirSync(dir, { recursive: true, encoding: 'utf8' })
        .map((name) => path.join(dir, name))
        .filter((file) => fs.statSync(file).isFile());
}

function assertClaudeNeverStarted(kit: Kit): void {
    assert.ok(!fs.existsSync(stubFile(kit, 'claude.argv')), 'claude.argv exists');
    assert.ok(!fs.existsSync(stubFile(kit, 'claude.selfpid')), 'claude.selfpid exists');
    assert.ok(!fs.existsSync(path.join(kit.rd, 'claude.pid')), 'claude.pid exists');
}

function runHook(env: TestEnv, hook: string, kind: string, input = '', hookEnv?: Env): Promise<ObservedResult> {
    const observed = env.spawnObserved('/bin/sh', [hook, kind], { input, env: hookEnv });
    return observed.result;
}

function silentLogger(): Logger {
    const ignore = (): void => {
        // Removal warnings are not asserted here.
    };
    return { info: ignore, warn: ignore, error: ignore };
}

function writeScript(file: string, lines: readonly string[]): void {
    fs.writeFileSync(file, `${['#!/bin/sh', ...lines].join('\n')}\n`, { mode: 0o755 });
}

// Swaps the identity source inside the generated launcher for a test file: the boot id file on Linux, the ps
// executable elsewhere.
function replaceIdentitySource(kit: Kit, stub: string): void {
    const launcher = path.join(kit.rd, 'launcher.sh');
    const text = readText(launcher);
    const source = process.platform === 'linux' ? LINUX_BOOT_ID_FILE : PS_PATH;
    assert.ok(text.includes(source));
    fs.writeFileSync(launcher, text.replace(source, stub));
}

function assertNotStartedWithFailure(kit: Kit): void {
    assert.ok(!fs.existsSync(stubFile(kit, 'claude.argv')), 'claude.argv exists');
    assert.ok(!fs.existsSync(stubFile(kit, 'claude.selfpid')), 'claude.selfpid exists');
    const pidFile = path.join(kit.rd, 'claude.pid');
    assert.ok(!fs.existsSync(pidFile) || !fs.statSync(pidFile).isFile(), 'claude.pid written');
    const status = exitStatus(kit);
    assert.match(status, /^\d+$/u);
    assert.notEqual(status, '0');
}

await describe('hook script', async () => {
    await test('records prompt, stop, tool and permission prompts only', async (t) => {
        const env = await newEnv(t);
        const rd = createRun(env.stateDir, RUN_ID);
        const hook = path.join(rd, 'hook.sh');
        fs.writeFileSync(hook, buildHookScript(rd));
        const events = path.join(rd, 'events');
        const lines = (): string[] => (fs.existsSync(events) ? readText(events).split('\n').slice(0, -1) : []);
        const cases: [string, string, number][] = [
            ['prompt', '{"prompt":"hello"}', 1],
            ['stop', '{"stop_hook_active":false}', 2],
            ['tool', '{"tool_name":"Bash"}', 3],
            ['permission', '{"notification_type": "permission_prompt", "message": "Claude needs your permission"}', 4],
            ['permission', '{"notification_type":"idle_prompt","message":"waiting"}', 4],
            ['permission', '{"notification_type"\n  :\t"permission_prompt"}', 5],
            ['unknown', '{}', 5],
        ];
        for (const [kind, input, count] of cases) {
            const result = await runHook(env, hook, kind, input);
            assert.equal(result.code, 0, `${kind} ${input}`);
            assert.equal(result.stdout, '', `${kind} stdout`);
            assert.equal(result.stderr, '', `${kind} stderr`);
            assert.equal(lines().length, count, `${kind} ${input}`);
        }
        const recorded = lines();
        assert.deepEqual(
            recorded.map((line) => line.split(' ', 1)[0]),
            ['prompt', 'stop', 'tool', 'permission', 'permission']
        );
        for (const line of recorded) {
            assert.match(line, /^[a-z]+ \d+$/u);
        }
        assert.ok(!readText(events).includes('needs your permission'));
    });

    await test('never runs utilities from the inherited PATH', async (t) => {
        const env = await newEnv(t);
        const rd = createRun(env.stateDir, RUN_ID);
        const hook = path.join(rd, 'hook.sh');
        fs.writeFileSync(hook, buildHookScript(rd));
        const planted = path.join(env.root, 'planted');
        const marker = path.join(env.root, 'planted.ran');
        fs.mkdirSync(planted);
        for (const name of HOOK_UTILITIES) {
            writeScript(path.join(planted, name), [`echo ${name} >> '${marker}'`, 'exit 0']);
        }
        const hookEnv: Env = { ...env.env, PATH: `${planted}:/usr/bin:/bin` };
        const input = '{"notification_type": "permission_prompt"}';
        for (const kind of ['prompt', 'permission']) {
            const result = await runHook(env, hook, kind, input, hookEnv);
            assert.equal(result.code, 0, kind);
            assert.equal(result.stdout, '', kind);
            assert.equal(result.stderr, '', kind);
        }
        assert.ok(!fs.existsSync(marker), 'a planted utility ran');
        const recorded = readText(path.join(rd, 'events')).split('\n').slice(0, -1);
        assert.deepEqual(
            recorded.map((line) => line.split(' ', 1)[0]),
            ['prompt', 'permission']
        );
        for (const line of recorded) {
            assert.match(line, /^[a-z]+ \d+$/u);
        }
    });

    await test('exits 0 silently even when the events file cannot be written', async (t) => {
        const env = await newEnv(t);
        const rd = path.join(env.stateDir, 'runs', 'missing');
        const hook = path.join(env.root, 'hook.sh');
        fs.writeFileSync(hook, buildHookScript(rd));
        const result = await runHook(env, hook, 'stop');
        assert.equal(result.code, 0);
        assert.equal(result.stdout, '');
        assert.equal(result.stderr, '');
    });
});

await describe('launcher', async () => {
    await test('passes the owner args, the settings and the prompt as the last argument', async (t) => {
        const kit = await prepareKit(t);
        const result = await runLauncher(kit);
        assert.equal(result.code, 0);
        assert.deepEqual(stubArgv(kit), [
            ...OWNER_ARGS,
            '--settings',
            path.join(kit.rd, 'settings.json'),
            '--',
            promptArgument(kit),
        ]);
        assert.equal(exitStatus(kit), '0');
        assert.equal(readText(path.join(kit.rd, 'claude.pid')).trim(), readText(stubFile(kit, 'claude.selfpid')));
        assert.equal(readText(stubFile(kit, 'claude.path')), kit.record.callerPath);
    });

    await test('starts argv with --settings when there are no owner args', async (t) => {
        const kit = await prepareKit(t, { patch: { claudeArgs: [] } });
        await runLauncher(kit);
        const argv = stubArgv(kit);
        assert.equal(argv[0], '--settings');
        assert.equal(argv.length, 4);
    });

    await test('records the claude exit status', async (t) => {
        const kit = await prepareKit(t);
        await runLauncher(kit, { STUB_CLAUDE_EXIT: '7' });
        assert.equal(exitStatus(kit), '7');
    });

    await test('writes claude.start in processStart format before claude.pid', async (t) => {
        const kit = await prepareKit(t);
        const observed = kit.env.spawnObserved('/bin/sh', [path.join(kit.rd, 'launcher.sh')], {
            env: launcherEnv(kit, { STUB_CLAUDE_WAIT: '1' }),
        });
        assert.ok(await waitUntil(15_000, () => fs.existsSync(stubFile(kit, 'claude.selfpid'))));
        const pid = Number.parseInt(readText(stubFile(kit, 'claude.selfpid')), 10);
        assert.equal(readText(path.join(kit.rd, 'claude.pid')).trim(), String(pid));
        const start = readText(path.join(kit.rd, 'claude.start'));
        assert.ok(start.endsWith('\n'));
        const expected = await processStart(createProcessRunner(kit.env.env), pid);
        assert.ok(expected !== undefined);
        assert.equal(start.trim(), expected);
        if (process.platform === 'linux') {
            assert.match(expected, /^[\da-f-]+:\d+$/u);
        }
        process.kill(pid, 'SIGTERM');
        const result = await observed.result;
        assert.equal(result.code, 0);
        assert.equal(exitStatus(kit), '143');
    });

    await test('a relative claude path refuses the launcher', async (t) => {
        const env = await newEnv(t);
        const rd = createRun(env.stateDir, RUN_ID);
        assert.equal(buildLauncherScript(launcherRecord(env, { claude: 'claude' }), rd, 30), undefined);
    });

    await test('never starts claude when gh on PATH is not the checked one', async (t) => {
        const kit = await prepareKit(t, { patch: { gh: '/usr/bin/gh-other' } });
        const result = await runLauncher(kit);
        assertClaudeNeverStarted(kit);
        assert.equal(exitStatus(kit), 'cancelled');
        assert.ok(result.stderr.includes('claude not started'));
    });

    await test('never starts claude when git on PATH is not the checked one', async (t) => {
        const kit = await prepareKit(t, { patch: { git: '/usr/bin/git-other' } });
        const result = await runLauncher(kit);
        assertClaudeNeverStarted(kit);
        assert.equal(exitStatus(kit), 'cancelled');
        assert.ok(result.stderr.includes('claude not started'));
    });

    await test('removes stale gh tokens and pins the gh host', async (t) => {
        const kit = await prepareKit(t);
        const configDir = path.join(kit.env.root, 'cfg');
        const result = await runLauncher(kit, {
            GH_TOKEN: STALE_TOKEN,
            GITHUB_TOKEN: STALE_TOKEN,
            GH_ENTERPRISE_TOKEN: STALE_TOKEN,
            GITHUB_ENTERPRISE_TOKEN: STALE_TOKEN,
            GH_REPO: 'x/y',
            GH_HOST: 'stale.example',
            GH_CONFIG_DIR: configDir,
        });
        assert.equal(result.code, 0);
        const ghEnv = readText(stubFile(kit, 'claude.ghenv'));
        assert.equal(ghEnv, `GH_CONFIG_DIR=${configDir}\nGH_HOST=github.com\n`);
        assert.ok(!ghEnv.includes('=set'));
        for (const file of [...filesUnder(kit.env.stubDir), ...filesUnder(kit.rd)]) {
            assert.ok(!readText(file).includes(STALE_TOKEN), file);
        }
    });

    await test('removes stale git variables that could redirect the conveyor', async (t) => {
        const kit = await prepareKit(t);
        const gitEnvFile = stubFile(kit, 'claude.env');
        writeScript(stubFile(kit, 'claude.script'), [`env > '${gitEnvFile}'`]);
        const stale = path.join(kit.env.root, 'elsewhere');
        const extra: Record<string, string> = {};
        for (const name of GIT_REDIRECT_VARS) {
            extra[name] = name === 'GIT_CONFIG_COUNT' ? '1' : stale;
        }
        const result = await runLauncher(kit, {
            ...extra,
            GIT_CONFIG_KEY_0: 'core.hooksPath',
            GIT_CONFIG_VALUE_0: stale,
        });
        assert.equal(result.code, 0);
        assert.equal(exitStatus(kit), '0');
        const names = new Set(
            readText(gitEnvFile)
                .split('\n')
                .map((line) => line.split('=', 1)[0])
        );
        for (const name of GIT_REDIRECT_VARS) {
            assert.ok(!names.has(name), name);
        }
        assert.ok(names.has('GIT_CONFIG_GLOBAL'), 'the owner git config variable was removed');
    });

    await test('matches a tool found through a PATH entry spelled with a leading //', async (t) => {
        const env = await newEnv(t);
        const callerPath = [env.binDir, `/${env.toolsDir}`, '/usr/bin', '/bin'].join(':');
        const rd = createRun(env.stateDir, RUN_ID);
        const record = launcherRecord(env, { callerPath });
        assert.equal(writeWorkerKit(rd, record, 30), true);
        assert.equal(claimLaunch(env.stateDir, RUN_ID, 'go'), true);
        const kit: Kit = { env, rd, record };
        const result = await runLauncher(kit);
        assert.equal(result.code, 0);
        assert.equal(result.stderr.includes('claude not started'), false, result.stderr);
        assert.equal(exitStatus(kit), '0');
        assert.equal(readText(path.join(rd, 'claude.pid')).trim(), readText(stubFile(kit, 'claude.selfpid')));
        assert.equal(readText(stubFile(kit, 'claude.path')), callerPath);
    });

    await test('never starts claude when claude.start cannot be written', async (t) => {
        const kit = await prepareKit(t);
        fs.mkdirSync(path.join(kit.rd, 'claude.start'));
        await runLauncher(kit);
        assertNotStartedWithFailure(kit);
    });

    await test('never starts claude when claude.pid cannot be written', async (t) => {
        const kit = await prepareKit(t);
        fs.mkdirSync(path.join(kit.rd, 'claude.pid'));
        await runLauncher(kit);
        assertNotStartedWithFailure(kit);
    });

    await test('never starts claude when the start time cannot be read', async (t) => {
        // Linux: a missing, empty or malformed boot id; elsewhere: a ps that fails or prints nothing.
        const linux = process.platform === 'linux';
        const cases: [string, string | undefined][] = linux
            ? [
                  ['boot-missing', undefined],
                  ['boot-empty', '\n'],
                  ['boot-malformed', 'not a boot id\n'],
              ]
            : [
                  ['ps-fails', '#!/bin/sh\nexit 1\n'],
                  ['ps-empty', '#!/bin/sh\nexit 0\n'],
              ];
        for (const [name, content] of cases) {
            const kit = await prepareKit(t);
            const stub = path.join(kit.env.root, name);
            if (content !== undefined) {
                fs.writeFileSync(stub, content, { mode: 0o755 });
            }
            replaceIdentitySource(kit, stub);
            await runLauncher(kit);
            assertNotStartedWithFailure(kit);
            assert.ok(!fs.existsSync(path.join(kit.rd, 'claude.pid')), name);
        }
    });

    await test('starts a claude whose path holds an at sign and a space', async (t) => {
        const env = await newEnv(t);
        const toolDir = path.join(env.root, 'node@22 x');
        fs.mkdirSync(toolDir);
        const claude = path.join(toolDir, 'claude');
        fs.copyFileSync(path.join(env.binDir, 'claude'), claude);
        fs.chmodSync(claude, 0o755);
        const rd = createRun(env.stateDir, RUN_ID);
        const record = launcherRecord(env, { claude });
        assert.equal(writeWorkerKit(rd, record, 30), true);
        assert.equal(claimLaunch(env.stateDir, RUN_ID, 'go'), true);
        const kit: Kit = { env, rd, record };
        const result = await runLauncher(kit);
        assert.equal(result.code, 0);
        assert.equal(readText(path.join(rd, 'claude.pid')).trim(), readText(stubFile(kit, 'claude.selfpid')));
    });
});

await describe('launch handshake', async () => {
    await test('go claimed after start lets claude run', async (t) => {
        const kit = await prepareKit(t, { wait: 3, go: false });
        startOrphanLauncher(kit);
        await delay(1000);
        assert.equal(claimLaunch(kit.env.stateDir, RUN_ID, 'go'), true);
        assert.ok(await waitUntil(15_000, () => fs.existsSync(stubFile(kit, 'claude.selfpid'))));
        assert.ok(await waitUntil(15_000, () => fs.existsSync(path.join(kit.rd, 'exit_status'))));
        assert.equal(readText(path.join(kit.rd, 'claude.pid')).trim(), readText(stubFile(kit, 'claude.selfpid')));
        assert.equal(exitStatus(kit), '0');
    });

    await test('cancel claimed before start exits without claude', async (t) => {
        const kit = await prepareKit(t, { wait: 30, go: false });
        assert.equal(claimLaunch(kit.env.stateDir, RUN_ID, 'cancel'), true);
        const pid = startOrphanLauncher(kit);
        assert.ok(await waitUntil(6000, () => !pidAlive(pid)));
        assertClaudeNeverStarted(kit);
        assert.equal(exitStatus(kit), 'cancelled');
    });

    await test('no decision: the launcher claims cancel at the timeout', async (t) => {
        const kit = await prepareKit(t, { wait: 3, go: false });
        const pid = startOrphanLauncher(kit);
        assert.ok(await waitUntil(12_000, () => !pidAlive(pid)));
        assert.equal(launchDecision(kit.env.stateDir, RUN_ID), 'cancel');
        assertClaudeNeverStarted(kit);
        assert.equal(exitStatus(kit), 'cancelled');
    });

    await test('a claimed decision without a value exits after the grace period', async (t) => {
        const kit = await prepareKit(t, { wait: 3, go: false });
        fs.mkdirSync(path.join(kit.rd, 'decision.d'), { mode: 0o700 });
        const started = performance.now();
        const pid = startOrphanLauncher(kit);
        assert.ok(await waitUntil(20_000, () => !pidAlive(pid)));
        assert.ok(performance.now() - started >= 7000, 'exited before the timeout plus the grace period');
        assertClaudeNeverStarted(kit);
        assert.equal(exitStatus(kit), 'cancelled');
        assert.equal(launchDecision(kit.env.stateDir, RUN_ID), 'claimed');
    });

    await test('a removed run directory ends the wait', async (t) => {
        const kit = await prepareKit(t, { wait: 30, go: false });
        const pid = startOrphanLauncher(kit);
        await delay(500);
        assert.ok(pidAlive(pid));
        fs.rmSync(kit.rd, { recursive: true, force: true });
        assert.ok(await waitUntil(6000, () => !pidAlive(pid)));
        assert.ok(!fs.existsSync(stubFile(kit, 'claude.argv')));
        assert.ok(!fs.existsSync(stubFile(kit, 'claude.selfpid')));
        assert.ok(!fs.existsSync(kit.rd));
    });

    await test('late writers recreate nothing after the run is removed', async (t) => {
        const kit = await prepareKit(t);
        const hook = path.join(kit.env.root, 'hook.sh');
        fs.writeFileSync(hook, buildHookScript(kit.rd));
        const observed = kit.env.spawnObserved('/bin/sh', [path.join(kit.rd, 'launcher.sh')], {
            env: launcherEnv(kit, { STUB_CLAUDE_WAIT: '1' }),
        });
        assert.ok(await waitUntil(15_000, () => fs.existsSync(path.join(kit.rd, 'claude.pid'))));
        assert.ok(await waitUntil(15_000, () => fs.existsSync(stubFile(kit, 'claude.selfpid'))));
        const pid = Number.parseInt(readText(stubFile(kit, 'claude.selfpid')), 10);
        removeRun(kit.env.stateDir, RUN_ID, silentLogger());
        assert.ok(!fs.existsSync(kit.rd));
        process.kill(pid, 'SIGTERM');
        await observed.result;
        const runs = path.join(kit.env.stateDir, 'runs');
        assert.ok(!fs.existsSync(kit.rd));
        assert.deepEqual(fs.readdirSync(runs, { recursive: true }), []);
        const result = await runHook(kit.env, hook, 'stop', '{"stop_hook_active":false}');
        assert.equal(result.code, 0);
        assert.ok(!fs.existsSync(kit.rd));
        assert.deepEqual(fs.readdirSync(runs, { recursive: true }), []);
    });
});
