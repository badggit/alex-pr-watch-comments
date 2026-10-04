import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';

import { acquireWorktreeLock, worktreeLockHolder } from '../../src/locks.ts';
import { pidAlive } from '../../src/proc.ts';
import { reconcile } from '../../src/reconcile.ts';
import { captureRun, evaluateRun } from '../../src/runState.ts';
import { claimLaunch, launchDecision, mergeRecord, readRecord } from '../../src/runStore.ts';
import { runDir } from '../../src/stateStore.ts';
import { writeWorkerKit } from '../../src/workerKit.ts';
import {
    baseComment,
    deadPid,
    lockExists,
    lookupWith,
    newRunFixture,
    RUN_ID,
    runExists,
    seedRun,
    SESSION_KEY,
    type RunFixture,
} from '../fixtures/runstate/runFixture.ts';
import { waitUntil } from '../support/testEnv.ts';

const RUN_B = '20261002130000-789';
const LAUNCH_WAIT = 30;
// Holds the pane process at a barrier: it creates READY, waits (bounded) for GO and then execs the launcher, so its
// pid stays the launcher's pid.
const BARRIER_SCRIPT = [
    ': > "$0"',
    'n=0',
    'while [ ! -e "$1" ] && [ "$n" -lt 1200 ]; do',
    '    sleep 0.05',
    '    n=$((n + 1))',
    'done',
    'exec /bin/sh "$2"',
].join('\n');

interface HeldLauncher {
    pid: number;
    ready: string;
    go: string;
}

function assertClaudeNeverRan(fixture: RunFixture): void {
    assert.ok(!fs.existsSync(path.join(fixture.env.stubDir, 'claude.argv')), 'stub claude ran');
    assert.ok(!fs.existsSync(path.join(fixture.env.stubDir, 'claude.selfpid')), 'stub claude ran');
}

function writeKit(fixture: RunFixture): string {
    const read = readRecord(fixture.stateDir, RUN_ID);
    assert.ok(read.kind === 'ok');
    const rd = runDir(fixture.stateDir, RUN_ID);
    assert.ok(writeWorkerKit(rd, read.record, LAUNCH_WAIT));
    return path.join(rd, 'launcher.sh');
}

function launcherEnv(fixture: RunFixture) {
    return { ...fixture.env.env, PATH: '/usr/bin:/bin' };
}

// Writes the real worker kit for the seeded record and starts its launcher as an orphan, the way a tmux pane would.
function startLauncher(fixture: RunFixture): number {
    return fixture.env.spawnOrphan('/bin/sh', [writeKit(fixture)], { env: launcherEnv(fixture) });
}

function startHeldLauncher(fixture: RunFixture): HeldLauncher {
    const launcher = writeKit(fixture);
    const ready = path.join(fixture.env.root, 'launcher.ready');
    const go = path.join(fixture.env.root, 'launcher.go');
    const args = ['-c', BARRIER_SCRIPT, ready, go, launcher];
    return { pid: fixture.env.spawnOrphan('/bin/sh', args, { env: launcherEnv(fixture) }), ready, go };
}

await describe('startup race', async () => {
    await test('a waiting launcher of a dead watcher is cancelled and claude never starts', async (t) => {
        const fixture = await newRunFixture(t);
        const watcher = await deadPid(fixture.env);
        await seedRun(fixture, {
            patch: { watcherPid: watcher, claudeArgs: [], startedAt: Math.floor(Date.now() / 1000) },
            decision: 'none',
            lockWatcherPid: watcher,
        });
        const held = startHeldLauncher(fixture);
        const launcher = held.pid;
        assert.ok(await waitUntil(10_000, () => fs.existsSync(held.ready)), 'the launcher never reached its barrier');
        mergeRecord(fixture.stateDir, RUN_ID, { panePid: launcher });

        const result = await reconcile(fixture.deps, fixture.session);
        assert.ok(pidAlive(launcher), 'the launcher left its barrier before reconcile finished');
        assert.equal(launchDecision(fixture.stateDir, RUN_ID), 'cancel');
        assert.equal(result.inflightRunId, RUN_ID);
        assert.ok(runExists(fixture));
        assert.equal(worktreeLockHolder(fixture.stateDir, SESSION_KEY), RUN_ID);

        fs.writeFileSync(held.go, '');
        assert.ok(await waitUntil(10_000, () => !pidAlive(launcher)), 'the launcher did not exit');
        assertClaudeNeverRan(fixture);

        const capture = captureRun(fixture.stateDir, RUN_ID);
        assert.equal(capture.alive, false);
        const lookup = lookupWith();
        const outcome = await evaluateRun(
            fixture.deps,
            fixture.session,
            RUN_ID,
            capture,
            lookup,
            new AbortController().signal
        );
        assert.equal(outcome.state, 'exited');
        assert.equal(lockExists(fixture, SESSION_KEY), false);
        assert.equal(runExists(fixture), false);

        const now = Math.floor(Date.now() / 1000);
        assert.ok(acquireWorktreeLock(fixture.stateDir, SESSION_KEY, RUN_B, process.pid, fixture.deps.log, now));
        assertClaudeNeverRan(fixture);
    });

    await test('a preparing run of a dead watcher is cleared and its launcher exits', async (t) => {
        const fixture = await newRunFixture(t);
        const watcher = await deadPid(fixture.env);
        await seedRun(fixture, {
            patch: {
                state: 'preparing',
                paneId: '',
                panePid: undefined,
                comments: [baseComment({ eyesAdded: false })],
                watcherPid: watcher,
            },
            decision: 'none',
            lockWatcherPid: watcher,
        });
        const launcher = startLauncher(fixture);

        const result = await reconcile(fixture.deps, fixture.session);
        assert.equal(result.inflightRunId, undefined);
        assert.equal(runExists(fixture), false);
        assert.equal(lockExists(fixture, SESSION_KEY), false);

        assert.ok(await waitUntil(10_000, () => !pidAlive(launcher)), 'the launcher did not exit');
        assertClaudeNeverRan(fixture);
    });

    await test('positive control: the same launcher starts the stub claude on go', async (t) => {
        const fixture = await newRunFixture(t);
        await seedRun(fixture, {
            patch: { claudeArgs: [], startedAt: Math.floor(Date.now() / 1000) },
            decision: 'none',
        });
        const launcher = startLauncher(fixture);
        assert.ok(claimLaunch(fixture.stateDir, RUN_ID, 'go'));
        const selfpid = path.join(fixture.env.stubDir, 'claude.selfpid');
        assert.ok(await waitUntil(10_000, () => fs.existsSync(selfpid)), 'the stub claude never started');
        assert.ok(await waitUntil(10_000, () => !pidAlive(launcher)), 'the launcher did not exit');
    });
});
