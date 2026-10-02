import fs from 'node:fs';
import path from 'node:path';

import { acquireWorktreeLock } from '../../../src/locks.ts';
import { createLogger } from '../../../src/log.ts';
import { claimLaunch } from '../../../src/runStore.ts';
import { initState } from '../../../src/stateStore.ts';

const BARRIER_TIMEOUT_MS = 60_000;

// Announces itself in barrierDir, then spins (no sleep) until barrierDir/go exists, so every racer leaves the barrier
// within microseconds of the others.
function waitAtBarrier(barrierDir: string): void {
    fs.writeFileSync(path.join(barrierDir, `ready.${process.pid}`), '');
    const go = path.join(barrierDir, 'go');
    const deadline = performance.now() + BARRIER_TIMEOUT_MS;
    while (!fs.existsSync(go)) {
        if (performance.now() > deadline) {
            throw new Error('lockRacer: barrier timed out');
        }
    }
}

function raceInit(stateDir: string, barrierDir: string): boolean {
    waitAtBarrier(barrierDir);
    const result = initState(stateDir);
    if (!result.ok) {
        process.stderr.write(`${JSON.stringify(result)}\n`);
    }
    return result.ok;
}

// Usage: lockRacer.ts STATE_DIR WTKEY RUN_ID WATCHER_PID, lockRacer.ts --launch STATE_DIR RUN_ID go|cancel, or
// lockRacer.ts --init STATE_DIR BARRIER_DIR.
function race(args: readonly string[]): boolean {
    if (args[0] === '--init') {
        const [, stateDir = '', barrierDir = ''] = args;
        return raceInit(stateDir, barrierDir);
    }
    if (args[0] === '--launch') {
        const [, stateDir = '', runId = '', value = ''] = args;
        if (value !== 'go' && value !== 'cancel') {
            throw new Error(`lockRacer: unknown decision ${value}`);
        }
        return claimLaunch(stateDir, runId, value);
    }
    const [stateDir = '', wtKey = '', runId = '', watcherPid = ''] = args;
    const log = createLogger(
        (line) => {
            process.stderr.write(`${line}\n`);
        },
        () => new Date()
    );
    const now = Math.floor(Date.now() / 1000);
    return acquireWorktreeLock(stateDir, wtKey, runId, Number.parseInt(watcherPid, 10), log, now);
}

process.stdout.write(race(process.argv.slice(2)) ? '1\n' : '0\n');
