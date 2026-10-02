// Test driver for the watch loop until the entry is wired: node runWatch.ts ARGS... runs runWatch with real Deps
// built from this process's environment, the runner bound to the stop signal of installStopSignals.
import { setTimeout as delay } from 'node:timers/promises';

import { parseArgs } from '../../../src/cli.ts';
import { createLogger } from '../../../src/log.ts';
import { createProcessRunner } from '../../../src/proc.ts';
import type { Deps, Env } from '../../../src/types.ts';
import { installStopSignals, runWatch } from '../../../src/watcher.ts';

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    try {
        await delay(ms, undefined, { signal });
    } catch (error) {
        if (!signal?.aborted) {
            throw error;
        }
    }
}

process.umask(0o077);
const stop = installStopSignals();
const env: Env = { ...process.env };
const deps: Deps = {
    runner: createProcessRunner(env, { signal: stop }),
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
const parsed = parseArgs(process.argv.slice(2), process.cwd());
if (parsed.kind === 'ok' && parsed.options.mode === 'watch') {
    try {
        process.exitCode = await runWatch(deps, parsed.options, process.cwd(), process.execPath, stop);
    } catch (error) {
        process.stderr.write(`runWatch driver: ${error instanceof Error ? error.message : 'unknown error'}\n`);
        process.exitCode = 1;
    }
} else {
    process.stderr.write('runWatch driver: expected watch mode arguments\n');
    process.exitCode = 2;
}
