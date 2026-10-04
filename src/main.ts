import path from 'node:path';
import type { Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';

import { parseArgs, usageText } from './cli.ts';
import { GH_STRIP_VARS } from './constants.ts';
import { runBackground, runList, runStop } from './control.ts';
import { createLogger } from './log.ts';
import { createProcessRunner } from './proc.ts';
import { resolveStateDir } from './stateStore.ts';
import type { CliOptions, CommandRunner, Deps, Env } from './types.ts';
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

function buildDeps(env: Env, runner: CommandRunner): Deps {
    return {
        runner,
        env,
        log: createLogger(
            (line) => {
                process.stderr.write(`${line}\n`);
            },
            () => new Date()
        ),
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

// A background window empties each GH_STRIP_VARS name its tmux server environment may hold (tmux cannot unset one
// for a new window); an empty one is removed here before anything runs, so this process never holds it either.
function dropEmptyStripVars(): void {
    for (const name of GH_STRIP_VARS) {
        if (process.env[name] === '') {
            Reflect.deleteProperty(process.env, name);
        }
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
        try {
            process.exitCode = await runMode(parsed.options, callerEnv, callerCwd);
        } catch (error) {
            const message = error instanceof Error ? error.message : 'unknown error';
            await writeText(process.stderr, `alex-pr-watch-comments: ${safeText(message)}\n`);
            process.exitCode = 1;
        }
        break;
    }
}
