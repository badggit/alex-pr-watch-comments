import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { constants as osConstants } from 'node:os';

import { COMMAND_TIMEOUT_MS, GH_STRIP_VARS, KILL_GRACE_MS, PS_PATH } from './constants.ts';
import type { CommandRequest, CommandResult, CommandRunner, Env, SignalOutcome } from './types.ts';

export interface RunnerDefaults {
    signal?: AbortSignal;
    timeoutMs?: number;
}

type SpawnAttempt = { child: ChildProcessWithoutNullStreams } | { error: string };

const ABORTED_CODE = 143;
const SPAWN_FAILED_CODE = 127;
const KILLED_CODE = 137;
const PS_ENV: Env = { LC_ALL: 'C', TZ: 'UTC', PATH: '/usr/bin:/bin' };
export const LINUX_BOOT_ID_FILE = '/proc/sys/kernel/random/boot_id';

function errorCode(error: unknown): string | undefined {
    if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
        return error.code;
    }
    return;
}

// Drops undefined entries and every GH_STRIP_VARS name, so no child ever sees a gh token variable or GH_REPO.
function childEnv(env: Env): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [name, value] of Object.entries(env)) {
        if (value !== undefined && !GH_STRIP_VARS.includes(name)) {
            result[name] = value;
        }
    }
    return result;
}

function exitCodeOf(code: number | null, signal: NodeJS.Signals | null): number {
    if (code !== null) {
        return code;
    }
    if (signal !== null) {
        return 128 + osConstants.signals[signal];
    }
    return 1;
}

function signalGroup(pid: number | undefined, signal: NodeJS.Signals): void {
    if (pid === undefined) {
        return;
    }
    try {
        process.kill(-pid, signal);
    } catch {
        return;
    }
}

function groupHasMembers(pid: number | undefined): boolean {
    if (pid === undefined) {
        return false;
    }
    try {
        process.kill(-pid, 0);
        return true;
    } catch (error) {
        return errorCode(error) !== 'ESRCH';
    }
}

function trySpawn(request: CommandRequest, baseEnv: Env): SpawnAttempt {
    try {
        const child = spawn(request.file, [...request.args], {
            cwd: request.cwd,
            env: childEnv(request.env ?? baseEnv),
            stdio: 'pipe',
            detached: true,
        });
        return { child };
    } catch (error) {
        return { error: errorCode(error) ?? (error instanceof Error ? error.message : 'spawn failed') };
    }
}

function feedInput(child: ChildProcessWithoutNullStreams, input: string | undefined): void {
    // A child that exits without reading its input makes the write fail with EPIPE; that is not an error here.
    child.stdin.on('error', () => {
        return;
    });
    if (input === undefined) {
        child.stdin.end();
    } else {
        child.stdin.end(input);
    }
}

// Cancellation (abort or timeout) sends SIGTERM to the whole process group, SIGKILL after KILL_GRACE_MS whenever
// any group member remains, and gives up on the streams at two graces, so every call ends within the timeout plus
// two graces whatever the leader and its helpers do.
function superviseChild(
    child: ChildProcessWithoutNullStreams,
    signal: AbortSignal | undefined,
    timeoutMs: number,
    resolve: (_result: CommandResult) => void
): void {
    const pid = child.pid;
    const output = { stdout: '', stderr: '' };
    const cleanups: (() => void)[] = [];
    let settled = false;
    let cancelled = false;
    let killStepDone = false;
    let exitCode: number | undefined;
    let closeCode: number | undefined;

    const finish = (result: CommandResult): void => {
        if (settled) {
            return;
        }
        settled = true;
        for (const cleanup of cleanups) {
            cleanup();
        }
        resolve(result);
    };
    const later = (ms: number, action: () => void): void => {
        const timer = setTimeout(action, ms);
        cleanups.push(() => {
            clearTimeout(timer);
        });
    };
    const shutdownStreams = (): void => {
        child.stdout.destroy();
        child.stderr.destroy();
        child.stdin.destroy();
    };
    const cancel = (): void => {
        if (cancelled || settled) {
            return;
        }
        cancelled = true;
        signalGroup(pid, 'SIGTERM');
        later(KILL_GRACE_MS, () => {
            if (groupHasMembers(pid)) {
                signalGroup(pid, 'SIGKILL');
            }
            killStepDone = true;
            if (closeCode !== undefined) {
                finish({ code: closeCode, ...output });
            }
        });
        later(2 * KILL_GRACE_MS, () => {
            shutdownStreams();
            finish({ code: closeCode ?? exitCode ?? KILLED_CODE, ...output });
        });
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
        output.stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
        output.stderr += chunk;
    });
    // ENOENT and other spawn failures emit 'error' before 'close'; the first settle wins.
    child.on('error', (error) => {
        finish({ code: SPAWN_FAILED_CODE, ...output, spawnError: errorCode(error) ?? error.message });
    });
    child.on('exit', (code, exitSignal) => {
        exitCode = exitCodeOf(code, exitSignal);
    });
    child.on('close', (code, closeSignal) => {
        closeCode = exitCodeOf(code, closeSignal);
        if (!cancelled || killStepDone || !groupHasMembers(pid)) {
            finish({ code: closeCode, ...output });
        }
    });

    later(timeoutMs, cancel);
    if (signal !== undefined) {
        const onAbort = (): void => {
            cancel();
        };
        signal.addEventListener('abort', onAbort, { once: true });
        cleanups.push(() => {
            signal.removeEventListener('abort', onAbort);
        });
    }
}

function runCommand(request: CommandRequest, baseEnv: Env, defaults: RunnerDefaults): Promise<CommandResult> {
    const signal = request.signal ?? defaults.signal;
    if (signal?.aborted) {
        return Promise.resolve({ code: ABORTED_CODE, stdout: '', stderr: '' });
    }
    const timeoutMs = request.timeoutMs ?? defaults.timeoutMs ?? COMMAND_TIMEOUT_MS;
    const attempt = trySpawn(request, baseEnv);
    if ('error' in attempt) {
        return Promise.resolve({ code: SPAWN_FAILED_CODE, stdout: '', stderr: '', spawnError: attempt.error });
    }
    return new Promise((resolve) => {
        superviseChild(attempt.child, signal, timeoutMs, resolve);
        feedInput(attempt.child, request.input);
    });
}

export function createProcessRunner(baseEnv: Env, defaults?: RunnerDefaults): CommandRunner {
    return {
        run: (request) => runCommand(request, baseEnv, defaults ?? {}),
    };
}

// True for an integer above 1 that kill(pid, 0) accepts or refuses with EPERM (alive, owned by someone else).
export function pidAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 1) {
        return false;
    }
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return errorCode(error) === 'EPERM';
    }
}

// Linux ps derives lstart from the boot time, which moves whenever the wall clock is stepped, so on Linux the
// identity is the boot id (UUID shape) plus the boot-relative start tick of /proc/PID/stat: field 22, the 20th field
// after the LAST ')' of the whole file, because the command name may hold spaces, parentheses and newlines. Only shell
// builtins are used; any unreadable or malformed value fails, so the identity is unverifiable, never a match.
const HEX = '[0-9a-f]';
const UUID_PATTERN = [8, 4, 4, 4, 12].map((count) => HEX.repeat(count)).join('-');
const LINUX_IDENTITY = [
    'prwc_identity() (',
    "    IFS=' '",
    '    set -f',
    "    stat=''",
    '    while IFS= read -r line || [ -n "$line" ]; do',
    '        stat="$stat$line "',
    '    done < "/proc/$1/stat" || exit 1',
    `    read -r boot < ${LINUX_BOOT_ID_FILE} || exit 1`,
    "    case $stat in *')'*) ;; *) exit 1 ;; esac",
    `    case $boot in ${UUID_PATTERN}) ;; *) exit 1 ;; esac`,
    "    rest=${stat##*')'}",
    '    set -- $rest',
    '    [ "$#" -ge 20 ] || exit 1',
    '    start=${20}',
    "    case $start in '' | *[!0-9]*) exit 1 ;; esac",
    `    printf '%s:%s\n' "$boot" "$start"`,
    ')',
].join('\n');
// macOS ps records lstart at process start, so it stays stable for the life of the process.
const PS_IDENTITY = ['prwc_identity() (', `    LC_ALL=C TZ=UTC exec ${PS_PATH} -o lstart= -p "$1"`, ')'].join('\n');

// The POSIX sh function prwc_identity PID that prints the process identity token: the only definition, shared by
// processStart and the worker launcher, which records claude's identity before it execs claude.
export function identityFunction(platform: NodeJS.Platform = process.platform): string {
    return platform === 'linux' ? LINUX_IDENTITY : PS_IDENTITY;
}

// The identity token of pid (see identityFunction). Undefined does not tell a dead pid from a failed read;
// signalIfSame decides that with pidAlive.
export async function processStart(runner: CommandRunner, pid: number): Promise<string | undefined> {
    const script = `${identityFunction()}\nprwc_identity "$1"`;
    const result = await runner.run({ file: '/bin/sh', args: ['-c', script, 'sh', String(pid)], env: PS_ENV });
    const start = result.stdout.trim();
    if (result.code !== 0 || start.length === 0) {
        return;
    }
    return start;
}

// Signals pid only when its identity token still equals expectedStart and the optional guard, called synchronously
// after the ps result with no await before the kill, agrees. EPERM from the kill means the pid now belongs to a
// process this user may not signal, so it cannot be the recorded one: mismatch.
export async function signalIfSame(
    runner: CommandRunner,
    pid: number,
    expectedStart: string,
    signal: 'SIGTERM',
    guard?: () => boolean
): Promise<SignalOutcome> {
    if (!pidAlive(pid)) {
        return 'gone';
    }
    const start = await processStart(runner, pid);
    if (start === undefined) {
        return pidAlive(pid) ? 'unverifiable' : 'gone';
    }
    if (start !== expectedStart.trim()) {
        return 'mismatch';
    }
    if (guard !== undefined && !guard()) {
        return 'vetoed';
    }
    try {
        process.kill(pid, signal);
    } catch (error) {
        const code = errorCode(error);
        if (code === 'ESRCH') {
            return 'gone';
        }
        if (code === 'EPERM') {
            return 'mismatch';
        }
        throw error;
    }
    return 'sent';
}
