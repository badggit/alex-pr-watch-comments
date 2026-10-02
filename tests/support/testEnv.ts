import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { PS_PATH } from '../../src/constants.ts';
import { pidAlive } from '../../src/proc.ts';
import type { CommandRunner, Deps, Env } from '../../src/types.ts';

export interface TestDeps extends Deps {
    logLines: string[];
    outText(): string;
}

export interface ProcessOptions {
    env?: Env;
    cwd?: string;
}

export interface ObservedOptions extends ProcessOptions {
    input?: string;
}

export interface ObservedResult {
    code: number;
    signal: string | undefined;
    stdout: string;
    stderr: string;
}

export interface ObservedProcess {
    pid: number;
    result: Promise<ObservedResult>;
}

interface OrphanRecord {
    pid: number;
    start: string | undefined;
}

export interface TestTools {
    node: string;
    git: string;
    tmux: string | undefined;
}

export interface TestEnv {
    root: string;
    stateDir: string;
    home: string;
    stubDir: string;
    binDir: string;
    toolsDir: string;
    tools: TestTools;
    env: Env;
    deps(_runner: CommandRunner): TestDeps;
    spawnOrphan(_file: string, _args: readonly string[], _opts?: ProcessOptions): number;
    spawnObserved(_file: string, _args: readonly string[], _opts?: ObservedOptions): ObservedProcess;
    cleanup(): void;
}

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const FAKE_TOOL = path.join(REPO_ROOT, 'tests', 'stubs', 'fakeTool.ts');
const TEST_TMUX = '/tmp/prwc-test-socket,1,0';
// The starttime field of /proc/PID/stat, counted after the closing parenthesis of the command name.
const PROC_STAT_START_INDEX = 19;
// Starts the command in the background with all stdio on /dev/null and prints its pid; the shell then exits, so
// the command is reparented to init and reaped there when it dies.
const ORPHAN_SCRIPT = '"$@" </dev/null >/dev/null 2>&1 & echo $!';
const GIT_CONFIG = [
    '[user]',
    '\tname = prwc-test',
    '\temail = prwc-test@example.invalid',
    '[init]',
    '\tdefaultBranch = main',
    '',
].join('\n');

function shellQuote(value: string): string {
    return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}

function definedEntries(env: Env): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [name, value] of Object.entries(env)) {
        if (value !== undefined) {
            result[name] = value;
        }
    }
    return result;
}

function isExecutableFile(file: string): boolean {
    try {
        fs.accessSync(file, fs.constants.X_OK);
        return fs.statSync(file).isFile();
    } catch {
        return false;
    }
}

function findExecutable(name: string, searchPath: string): string | undefined {
    return searchPath
        .split(':')
        .filter((dir) => path.isAbsolute(dir))
        .map((dir) => path.join(dir, name))
        .find((file) => isExecutableFile(file));
}

function wrapperScript(tool: string, stubDir: string): string {
    return [
        '#!/bin/sh',
        'if [ -z "${STUB_DIR+x}" ]; then STUB_DIR=' + shellQuote(stubDir) + '; export STUB_DIR; fi',
        `exec ${shellQuote(process.execPath)} --disable-warning=ExperimentalWarning ${shellQuote(FAKE_TOOL)} ${shellQuote(tool)} "$@"`,
        '',
    ].join('\n');
}

function exitCodeOf(code: number | null, signal: NodeJS.Signals | null): number {
    if (code !== null) {
        return code;
    }
    if (signal !== null) {
        return 128 + os.constants.signals[signal];
    }
    return 1;
}

function killQuietly(pid: number): void {
    try {
        process.kill(pid, 'SIGKILL');
    } catch {
        return;
    }
}

// The boot-relative start tick (field 22) of /proc/PID/stat. Linux ps derives lstart from the current wall clock
// minus the uptime, so lstart shifts whenever the wall clock steps; this tick never changes for a live process.
function procStartTicks(pid: number): string | undefined {
    let stat: string;
    try {
        stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    } catch {
        return;
    }
    const ticks = stat.slice(stat.lastIndexOf(')') + 2).split(' ', PROC_STAT_START_INDEX + 1)[PROC_STAT_START_INDEX];
    return ticks === undefined || ticks.length === 0 ? undefined : ticks;
}

// An identity token that stays equal for the whole life of a process, read synchronously so spawnOrphan and cleanup
// stay synchronous. Elsewhere than Linux (macOS) ps lstart is recorded at process start and is stable.
function startTimeSync(pid: number): string | undefined {
    if (process.platform === 'linux') {
        return procStartTicks(pid);
    }
    const ps = spawnSync(PS_PATH, ['-o', 'lstart=', '-p', String(pid)], {
        env: { LC_ALL: 'C', TZ: 'UTC', PATH: '/usr/bin:/bin' },
        encoding: 'utf8',
    });
    const start = typeof ps.stdout === 'string' ? ps.stdout.trim() : '';
    return ps.status === 0 && start.length > 0 ? start : undefined;
}

// Kills an orphan only while its pid still has the start time recorded at spawn, so a pid reused by an unrelated
// process after the orphan died is never signalled.
function killOrphan(orphan: OrphanRecord): void {
    if (orphan.start === undefined || !pidAlive(orphan.pid) || startTimeSync(orphan.pid) !== orphan.start) {
        return;
    }
    killQuietly(orphan.pid);
}

// Resolves early, without throwing, when the signal aborts (the Deps.sleep contract).
async function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
    try {
        await delay(ms, undefined, { signal });
    } catch (error) {
        if (!signal?.aborted) {
            throw error;
        }
    }
}

function buildDeps(runner: CommandRunner, env: Env): TestDeps {
    const logLines: string[] = [];
    const outParts: string[] = [];
    return {
        runner,
        env,
        log: {
            info: (message) => {
                logLines.push(`info ${message}`);
            },
            warn: (message) => {
                logLines.push(`warn ${message}`);
            },
            error: (message) => {
                logLines.push(`error ${message}`);
            },
        },
        out: (text) => {
            outParts.push(text);
        },
        nowSeconds: () => Math.floor(Date.now() / 1000),
        sleep: (ms, signal) => abortableSleep(ms, signal),
        logLines,
        outText: () => outParts.join(''),
    };
}

function observe(file: string, args: readonly string[], env: Env, opts: ObservedOptions | undefined) {
    const child = spawn(file, [...args], { env: definedEntries(env), cwd: opts?.cwd, stdio: 'pipe' });
    const output = { stdout: '', stderr: '' };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
        output.stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
        output.stderr += chunk;
    });
    child.stdin.on('error', () => {
        return;
    });
    const result = new Promise<ObservedResult>((resolve) => {
        let spawnFailed = false;
        child.on('error', () => {
            spawnFailed = true;
        });
        child.on('close', (code, signal) => {
            resolve({
                code: spawnFailed ? 127 : exitCodeOf(code, signal),
                signal: signal ?? undefined,
                ...output,
            });
        });
    });
    if (opts?.input === undefined) {
        child.stdin.end();
    } else {
        child.stdin.end(opts.input);
    }
    return { child, observed: { pid: child.pid ?? 0, result } };
}

function linkTools(toolsDir: string, realTmux: boolean): TestTools {
    const searchPath = process.env.PATH ?? '';
    const git = findExecutable('git', searchPath);
    if (git === undefined) {
        throw new Error('createTestEnv: git is not on PATH');
    }
    const tools: TestTools = {
        node: findExecutable('node', searchPath) ?? process.execPath,
        git,
        tmux: findExecutable('tmux', searchPath),
    };
    if (realTmux && tools.tmux === undefined) {
        throw new Error('createTestEnv: realTmux requested but tmux is not on PATH');
    }
    fs.mkdirSync(toolsDir, { recursive: true });
    for (const [name, target] of Object.entries(tools)) {
        if (typeof target === 'string') {
            fs.symlinkSync(target, path.join(toolsDir, name));
        }
    }
    return tools;
}

// gh and claude are always stubs and tmux is one unless realTmux is set; PATH is built from scratch so no real gh or
// claude of the developer machine is reachable.
export async function createTestEnv(options?: { realTmux?: boolean }): Promise<TestEnv> {
    const realTmux = options?.realTmux ?? false;
    const root = fs.realpathSync.native(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'prwc-')));
    const home = path.join(root, 'home');
    const stubDir = path.join(root, 'stub');
    const binDir = path.join(root, 'bin');
    const toolsDir = path.join(root, 'tools');
    const stateDir = path.join(root, 'state');
    for (const dir of [home, stubDir, binDir]) {
        fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(path.join(home, '.gitconfig'), GIT_CONFIG);
    const tools = linkTools(toolsDir, realTmux);
    const stubbed = realTmux ? ['gh', 'claude'] : ['gh', 'claude', 'tmux'];
    for (const tool of stubbed) {
        fs.writeFileSync(path.join(binDir, tool), wrapperScript(tool, stubDir), { mode: 0o755 });
    }
    const env: Env = {
        HOME: home,
        PRWC_STATE_DIR: stateDir,
        STUB_DIR: stubDir,
        PATH: [binDir, toolsDir, '/usr/bin', '/bin'].join(':'),
        TMUX: TEST_TMUX,
        TMUX_PANE: '%1',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'),
        PRWC_TEST_NODE: process.execPath,
        GIT_ALLOW_PROTOCOL: 'file',
    };
    const orphans: OrphanRecord[] = [];
    const observedKills: (() => void)[] = [];
    return {
        root,
        stateDir,
        home,
        stubDir,
        binDir,
        toolsDir,
        tools,
        env,
        deps: (runner) => buildDeps(runner, env),
        spawnOrphan: (file, args, opts) => {
            const shell = spawnSync('/bin/sh', ['-c', ORPHAN_SCRIPT, 'sh', file, ...args], {
                env: definedEntries(opts?.env ?? env),
                cwd: opts?.cwd,
                encoding: 'utf8',
            });
            const pid = Number.parseInt(shell.stdout.trim(), 10);
            if (!Number.isInteger(pid) || pid <= 1) {
                throw new Error(`spawnOrphan failed for ${file}: ${shell.stderr}`);
            }
            orphans.push({ pid, start: startTimeSync(pid) });
            return pid;
        },
        spawnObserved: (file, args, opts) => {
            const { child, observed } = observe(file, args, opts?.env ?? env, opts);
            // Only a still running child is killed, so cleanup never signals a pid reused after the child was reaped.
            observedKills.push(() => {
                if (child.exitCode === null && child.signalCode === null) {
                    child.kill('SIGKILL');
                }
            });
            return observed;
        },
        cleanup: () => {
            for (const orphan of orphans) {
                killOrphan(orphan);
            }
            for (const kill of observedKills) {
                kill();
            }
            fs.rmSync(root, { recursive: true, force: true });
        },
    };
}

export async function waitUntil(
    timeoutMs: number,
    predicate: () => boolean | Promise<boolean>,
    intervalMs = 100
): Promise<boolean> {
    const deadline = performance.now() + timeoutMs;
    for (;;) {
        if (await predicate()) {
            return true;
        }
        const remaining = deadline - performance.now();
        if (remaining <= 0) {
            return false;
        }
        await delay(Math.min(intervalMs, remaining));
    }
}
