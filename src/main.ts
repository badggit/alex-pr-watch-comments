import path from 'node:path';
import type { Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';

import { parseArgs, usageText } from './cli.ts';
import { GH_STRIP_VARS } from './constants.ts';
import { runBackground, runList, runStop } from './control.ts';
import { createLogger } from './log.ts';
import type { NewWorktreeArgs } from './newWorktreeArgs.ts';
import { runNewWorktree, type NewWorktreeIo } from './newWorktreeCommand.ts';
import { createProcessRunner } from './proc.ts';
import { resolveStateDir } from './stateStore.ts';
import type { CliOptions, CommandRunner, Deps, Env, Logger } from './types.ts';
import { safeText } from './validate.ts';
import { installStopSignals, runWatch } from './watcher.ts';

function writeText(stream: Writable, text: string): Promise<void> {
    return new Promise((resolve) => {
        stream.write(text, () => {
            resolve();
        });
    });
}

// Resolves early, without throwing, when the signal aborts.
async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    try {
        await delay(ms, undefined, { signal });
    } catch (error) {
        if (!signal?.aborted) {
            throw error;
        }
    }
}

function stderrLogger(): Logger {
    return createLogger(
        (line) => {
            process.stderr.write(`${line}\n`);
        },
        () => new Date()
    );
}

function buildDeps(env: Env, runner: CommandRunner): Deps {
    return {
        runner,
        env,
        log: stderrLogger(),
        out: (text) => {
            process.stdout.write(text);
        },
        nowSeconds: () => Math.floor(Date.now() / 1000),
        sleep: (ms, signal) => sleep(ms, signal),
    };
}

// The runner removes the gh token variables and GH_REPO from every child, while deps.env keeps them so preflight can
// name them; a watch stop aborts every in-flight command.
async function runMode(options: CliOptions, env: Env, cwd: string): Promise<number> {
    switch (options.mode) {
        case 'watch': {
            const stop = installStopSignals();
            const deps = buildDeps(env, createProcessRunner(env, { signal: stop }));
            return await runWatch(deps, options, cwd, process.execPath, stop);
        }
        case 'background': {
            const entry = { node: process.execPath, mainTs: path.join(import.meta.dirname, 'main.ts') };
            return await runBackground(buildDeps(env, createProcessRunner(env)), options, cwd, entry);
        }
        case 'list': {
            return await runList(buildDeps(env, createProcessRunner(env)), resolveStateDir(env, cwd));
        }
        case 'stop': {
            return await runStop(buildDeps(env, createProcessRunner(env)), options, resolveStateDir(env, cwd));
        }
    }
}

// Prints the outcome and returns the exit code: only a created or reused worktree path reaches stdout.
async function runNewWorktreeMode(args: NewWorktreeArgs, env: Env, cwd: string): Promise<number> {
    const io: NewWorktreeIo = { env, log: stderrLogger(), makeRunner: (childEnv) => createProcessRunner(childEnv) };
    const outcome = await runNewWorktree(io, args, cwd);
    switch (outcome.kind) {
        case 'ok': {
            await writeText(process.stdout, `${outcome.path}\n`);
            return 0;
        }
        case 'refused': {
            await writeText(process.stderr, `alex-pr-watch-comments: ${outcome.reason}\n`);
            return 1;
        }
        case 'usage': {
            await writeText(process.stderr, `alex-pr-watch-comments: ${outcome.message}\n\n${usageText()}`);
            return 2;
        }
    }
}

// A background window empties each GH_STRIP_VARS name its tmux server environment may hold (tmux cannot unset one
// for a new window); an empty one is removed here before anything runs, so this process never holds it either.
function dropEmptyStripVars(): void {
    for (const name of GH_STRIP_VARS) {
        if (process.env[name] === '') {
            Reflect.deleteProperty(process.env, name);
        }
    }
}

// An unexpected error is reported on stderr and exits 1.
async function exitCodeOf(run: () => Promise<number>): Promise<number> {
    try {
        return await run();
    } catch (error) {
        const message = error instanceof Error ? error.message : 'unknown error';
        await writeText(process.stderr, `alex-pr-watch-comments: ${safeText(message)}\n`);
        return 1;
    }
}

process.umask(0o077);
dropEmptyStripVars();
const callerEnv: Env = { ...process.env };
const callerCwd = process.cwd();
const parsed = parseArgs(process.argv.slice(2), callerCwd);

switch (parsed.kind) {
    case 'help': {
        await writeText(process.stdout, usageText());
        process.exitCode = 0;
        break;
    }
    case 'error': {
        await writeText(process.stderr, `alex-pr-watch-comments: ${parsed.message}\n\n${usageText()}`);
        process.exitCode = 2;
        break;
    }
    case 'ok': {
        process.exitCode = await exitCodeOf(() => runMode(parsed.options, callerEnv, callerCwd));
        break;
    }
    case 'newWorktree': {
        process.exitCode = await exitCodeOf(() => runNewWorktreeMode(parsed.args, callerEnv, callerCwd));
        break;
    }
}
