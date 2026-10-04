import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test, type TestContext } from 'node:test';

import { acquireWorktreeLock, worktreeLockHolder } from '../../src/locks.ts';
import { pidAlive } from '../../src/proc.ts';
import { reconcile } from '../../src/reconcile.ts';
import { captureRun, evaluateRun } from '../../src/runState.ts';
import { createRun, launchDecision, readRecord, writeRecord } from '../../src/runStore.ts';
import { runDir } from '../../src/stateStore.ts';
import {
    answerLookup,
    baseComment,
    baseRecord,
    deadPid,
    eyesRemovals,
    FRESH_PLUS1,
    lockExists,
    lockWatcherPid,
    lookupWith,
    newRunFixture,
    OTHER_KEY,
    recordOf,
    RUN_ID,
    runExists,
    seedRun,
    SESSION_KEY,
    SESSION_SOCKET,
    socketOf,
    startClaude,
    thumbsDownAdds,
    tmuxMessages,
    WORKER_SOCKET,
    type RunFixture,
} from '../fixtures/runstate/runFixture.ts';
import { waitUntil } from '../support/testEnv.ts';

const RUN_2 = '20261002120500-457';

function assertNoRocketAdded(fixture: RunFixture): void {
    const added = fixture.fake
        .calls('gh')
        .filter((call) => call.key === 'PrwcAddReaction' && (call.input ?? '').includes('ROCKET'));
    assert.equal(added.length, 0);
}

// Lets every lock rename under the worktrees directory fail like a full disk, so a lock release cannot complete.
function failLockRenames(t: TestContext): void {
    const original = fs.renameSync;
    const marker = `${path.sep}worktrees${path.sep}`;
    t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
        if (String(to).includes(marker)) {
            throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
        }
        original(from, to);
    });
}

async function evaluateNow(fixture: RunFixture, runId = RUN_ID) {
    const capture = captureRun(fixture.stateDir, runId);
    const signal = new AbortController().signal;
    return await evaluateRun(fixture.deps, fixture.session, runId, capture, lookupWith(), signal);
}

function breakRecord(fixture: RunFixture): void {
    fs.writeFileSync(path.join(runDir(fixture.stateDir, RUN_ID), 'record.json'), '{"format": 1, "sta');
}

function paneListings(fixture: RunFixture) {
    return fixture.fake.calls('tmux').filter((call) => call.key === 'list-panes');
}

await describe('reconcile', async () => {
    await test('re-adopts a live run whose tagged pane exists', async (t) => {
        const fixture = await newRunFixture(t);
        const watcher = await deadPid(fixture.env);
        await seedRun(fixture, {
            patch: { socket: WORKER_SOCKET, watcherPid: watcher },
            events: ['prompt'],
            lockWatcherPid: watcher,
        });
        await startClaude(fixture, 'cooperative');
        fixture.fake.respond('tmux', 'list-panes', { stdout: `%3 other-run\n%7 ${RUN_ID}\n` });
        assert.equal(fixture.session.tmux.socket, SESSION_SOCKET);
        const result = await reconcile(fixture.deps, fixture.session);
        assert.deepEqual(result, { inflightRunId: RUN_ID });
        assert.ok(runExists(fixture));
        assert.equal(launchDecision(fixture.stateDir, RUN_ID), 'go');
        assert.equal(fixture.fake.calls('gh').length, 0);
        const record = recordOf(fixture);
        assert.equal(record.watcherPid, process.pid);
        assert.equal(record.state, 'running');
        assert.equal(lockWatcherPid(fixture, SESSION_KEY), process.pid);
        const listings = paneListings(fixture);
        assert.equal(listings.length, 1);
        assert.equal(socketOf(listings[0]), WORKER_SOCKET);
        assert.equal(tmuxMessages(fixture).length, 0);
        assertNoRocketAdded(fixture);
    });

    await test("adopts the lock under the record's worktree key, not the session's", async (t) => {
        const fixture = await newRunFixture(t);
        const watcher = await deadPid(fixture.env);
        await seedRun(fixture, {
            patch: { worktreeKey: OTHER_KEY, watcherPid: watcher },
            events: ['prompt'],
            lockWatcherPid: watcher,
        });
        await startClaude(fixture, 'cooperative');
        fixture.fake.respond('tmux', 'list-panes', { stdout: `%7 ${RUN_ID}\n` });
        const result = await reconcile(fixture.deps, fixture.session);
        assert.equal(result.inflightRunId, RUN_ID);
        assert.equal(lockWatcherPid(fixture, OTHER_KEY), process.pid);
        assert.equal(lockExists(fixture, SESSION_KEY), false);
        assertNoRocketAdded(fixture);
    });

    await test('a live claude without its pane needs attention and keeps the slot', async (t) => {
        const fixture = await newRunFixture(t);
        const watcher = await deadPid(fixture.env);
        await seedRun(fixture, { patch: { watcherPid: watcher }, events: ['prompt'], lockWatcherPid: watcher });
        const claude = await startClaude(fixture, 'cooperative');
        fixture.fake.respond('tmux', 'list-panes', { stdout: '%3 other-run\n' });
        const result = await reconcile(fixture.deps, fixture.session);
        assert.equal(result.inflightRunId, RUN_ID);
        const record = recordOf(fixture);
        assert.equal(record.state, 'needs_attention');
        assert.equal(record.reason, 'worker-pane-not-found');
        assert.equal(record.watcherPid, process.pid);
        assert.equal(lockWatcherPid(fixture, SESSION_KEY), process.pid);
        assert.ok(pidAlive(claude));
        assert.equal(fixture.fake.calls('gh').length, 0);
        assert.equal(tmuxMessages(fixture).length, 1);
        assertNoRocketAdded(fixture);
    });

    await test('a dead claude is interrupted: EYES removed, -1 added, run cleared, lock released', async (t) => {
        const fixture = await newRunFixture(t);
        const watcher = await deadPid(fixture.env);
        await seedRun(fixture, {
            patch: { state: 'needs_attention', reason: 'waiting-for-permission', watcherPid: watcher },
            events: ['prompt', 'permission'],
            lockWatcherPid: watcher,
        });
        answerLookup(fixture, { eyes: true });
        const result = await reconcile(fixture.deps, fixture.session);
        assert.deepEqual(result, { inflightRunId: undefined });
        assert.equal(eyesRemovals(fixture).length, 1);
        assert.equal(thumbsDownAdds(fixture).length, 1);
        assert.ok(
            fixture.deps.logLines.some((line) =>
                line.includes(`interrupted run ${RUN_ID}, add the rocket again to retry`)
            )
        );
        assert.equal(runExists(fixture), false);
        assert.equal(lockExists(fixture, SESSION_KEY), false);
        assertNoRocketAdded(fixture);
    });

    await test('a done comment of a dead run keeps its +1 and gets no -1', async (t) => {
        const fixture = await newRunFixture(t);
        const watcher = await deadPid(fixture.env);
        await seedRun(fixture, { patch: { watcherPid: watcher }, lockWatcherPid: watcher });
        answerLookup(fixture, { eyes: false, plus1At: FRESH_PLUS1 });
        await reconcile(fixture.deps, fixture.session);
        assert.deepEqual(
            fixture.fake.calls('gh').map((call) => call.key),
            ['PrwcLookup']
        );
        assert.equal(runExists(fixture), false);
    });

    await test('a comment approved again during a dead run gets no -1', async (t) => {
        const fixture = await newRunFixture(t);
        const watcher = await deadPid(fixture.env);
        await seedRun(fixture, { patch: { watcherPid: watcher }, lockWatcherPid: watcher });
        answerLookup(fixture, { eyes: false, rocketAt: FRESH_PLUS1 });
        await reconcile(fixture.deps, fixture.session);
        assert.equal(thumbsDownAdds(fixture).length, 0);
        assert.equal(runExists(fixture), false);
    });

    await test('a failed lookup of a dead run removes EYES only', async (t) => {
        const fixture = await newRunFixture(t);
        const watcher = await deadPid(fixture.env);
        await seedRun(fixture, { patch: { watcherPid: watcher }, lockWatcherPid: watcher });
        fixture.fake.respond('gh', 'PrwcLookup', { code: 1, stderr: 'gh: failed\n' });
        await reconcile(fixture.deps, fixture.session);
        assert.equal(eyesRemovals(fixture).length, 1);
        assert.equal(thumbsDownAdds(fixture).length, 0);
        assert.ok(fixture.deps.logLines.some((line) => line.includes('none was marked as failed')));
        assert.equal(runExists(fixture), false);
    });

    await test('a dead run without EYES and a failed lookup only looks up', async (t) => {
        const fixture = await newRunFixture(t);
        const watcher = await deadPid(fixture.env);
        await seedRun(fixture, {
            patch: { comments: [baseComment({ eyesAdded: false })], watcherPid: watcher },
            lockWatcherPid: watcher,
        });
        const result = await reconcile(fixture.deps, fixture.session);
        assert.equal(result.inflightRunId, undefined);
        assert.deepEqual(
            fixture.fake.calls('gh').map((call) => call.key),
            ['PrwcLookup']
        );
        assert.equal(runExists(fixture), false);
        assert.equal(lockExists(fixture, SESSION_KEY), false);
    });

    await test('a preparing run without a worker is cleared after one lookup', async (t) => {
        const fixture = await newRunFixture(t);
        const watcher = await deadPid(fixture.env);
        await seedRun(fixture, {
            patch: {
                state: 'preparing',
                comments: [baseComment({ eyesAdded: false })],
                paneId: '',
                panePid: undefined,
                watcherPid: watcher,
            },
            decision: 'none',
            lockWatcherPid: watcher,
        });
        const result = await reconcile(fixture.deps, fixture.session);
        assert.equal(result.inflightRunId, undefined);
        assert.deepEqual(
            fixture.fake.calls('gh').map((call) => call.key),
            ['PrwcLookup']
        );
        assert.equal(runExists(fixture), false);
        assert.equal(lockExists(fixture, SESSION_KEY), false);
        assertNoRocketAdded(fixture);
    });

    await test('a preparing run with a live worker is adopted as running and finished after it exits', async (t) => {
        const fixture = await newRunFixture(t);
        const watcher = await deadPid(fixture.env);
        await seedRun(fixture, {
            patch: { state: 'preparing', watcherPid: watcher },
            events: ['prompt'],
            lockWatcherPid: watcher,
        });
        const claude = await startClaude(fixture, 'cooperative');
        fixture.fake.respond('tmux', 'list-panes', { stdout: `%7 ${RUN_ID}\n` });
        const result = await reconcile(fixture.deps, fixture.session);
        assert.equal(result.inflightRunId, RUN_ID);
        assert.ok(runExists(fixture));
        assert.ok(pidAlive(claude));
        const record = recordOf(fixture);
        assert.equal(record.state, 'running');
        assert.equal(record.reason, 'adopted');
        assert.equal(lockWatcherPid(fixture, SESSION_KEY), process.pid);
        assert.equal(fixture.fake.calls('gh').length, 0);
        assertNoRocketAdded(fixture);

        const working = await evaluateNow(fixture);
        assert.deepEqual(working, { state: 'running', reason: 'working' });
        process.kill(claude, 'SIGKILL');
        assert.ok(await waitUntil(5000, () => !pidAlive(claude)), 'the fake claude did not die');
        const finished = await evaluateNow(fixture);
        assert.deepEqual(finished, { state: 'exited', reason: 'claude-exited' });
        assert.equal(lockExists(fixture, SESSION_KEY), false);
        assert.equal(runExists(fixture), false);
    });

    await test('an unreadable record holding this clone for a dead watcher keeps the slot', async (t) => {
        const fixture = await newRunFixture(t);
        const watcher = await deadPid(fixture.env);
        await seedRun(fixture, { decision: 'none', events: ['prompt'], lockWatcherPid: watcher });
        breakRecord(fixture);
        fixture.fake.respond('tmux', 'list-panes', { stdout: `%7 ${RUN_ID}\n` });
        const result = await reconcile(fixture.deps, fixture.session);
        assert.equal(result.inflightRunId, RUN_ID);
        assert.equal(launchDecision(fixture.stateDir, RUN_ID), 'cancel');
        assert.equal(lockWatcherPid(fixture, SESSION_KEY), process.pid);
        assert.ok(runExists(fixture));
        assert.ok(fixture.deps.logLines.some((line) => line.includes(`run ${RUN_ID} has an unreadable record`)));
        const evaluated = await evaluateNow(fixture);
        assert.deepEqual(evaluated, { state: 'needs_attention', reason: 'record-unreadable' });
        assert.equal(worktreeLockHolder(fixture.stateDir, SESSION_KEY), RUN_ID);
        assert.equal(tmuxMessages(fixture).length, 1);
    });

    await test('an unreadable record of a clone whose slot is taken is not adopted', async (t) => {
        const fixture = await newRunFixture(t);
        const watcher = await deadPid(fixture.env);
        await seedRun(fixture, {
            patch: { worktreeKey: OTHER_KEY, watcherPid: watcher },
            events: ['prompt'],
            lockWatcherPid: watcher,
        });
        await startClaude(fixture, 'cooperative');
        createRun(fixture.stateDir, RUN_2);
        fs.writeFileSync(path.join(runDir(fixture.stateDir, RUN_2), 'record.json'), '{"format": 1, "sta');
        const now = Math.floor(Date.now() / 1000);
        assert.ok(acquireWorktreeLock(fixture.stateDir, SESSION_KEY, RUN_2, watcher, fixture.deps.log, now));
        fixture.fake.respond('tmux', 'list-panes', { stdout: `%7 ${RUN_ID}\n` });
        const result = await reconcile(fixture.deps, fixture.session);
        assert.equal(result.inflightRunId, RUN_ID);
        assert.equal(lockWatcherPid(fixture, OTHER_KEY), process.pid);
        assert.equal(lockWatcherPid(fixture, SESSION_KEY), watcher);
        assert.equal(launchDecision(fixture.stateDir, RUN_2), 'cancel');
        assert.ok(fixture.deps.logLines.some((line) => line.includes(`run ${RUN_ID} holds the slot`)));
    });

    await test('of two unreadable runs only the one holding this clone takes the slot', async (t) => {
        const fixture = await newRunFixture(t);
        const watcher = await deadPid(fixture.env);
        await seedRun(fixture, { decision: 'none', lockWatcherPid: watcher });
        breakRecord(fixture);
        createRun(fixture.stateDir, RUN_2);
        fs.writeFileSync(path.join(runDir(fixture.stateDir, RUN_2), 'record.json'), '{"format": 1, "sta');
        const now = Math.floor(Date.now() / 1000);
        assert.ok(acquireWorktreeLock(fixture.stateDir, OTHER_KEY, RUN_2, watcher, fixture.deps.log, now));
        const result = await reconcile(fixture.deps, fixture.session);
        assert.equal(result.inflightRunId, RUN_ID);
        assert.equal(lockWatcherPid(fixture, SESSION_KEY), process.pid);
        assert.equal(lockWatcherPid(fixture, OTHER_KEY), watcher);
        assert.equal(launchDecision(fixture.stateDir, RUN_2), 'none');
        assert.ok(
            fixture.deps.logLines.some((line) => line.includes(`run ${RUN_2} has an unreadable record and is not`))
        );
    });

    await test('an unreadable record held by a live watcher is left alone', async (t) => {
        const fixture = await newRunFixture(t);
        const watcher = fixture.env.spawnOrphan('sleep', ['300']);
        await seedRun(fixture, { decision: 'none', lockWatcherPid: watcher });
        breakRecord(fixture);
        const result = await reconcile(fixture.deps, fixture.session);
        assert.equal(result.inflightRunId, undefined);
        assert.equal(launchDecision(fixture.stateDir, RUN_ID), 'none');
        assert.equal(lockWatcherPid(fixture, SESSION_KEY), watcher);
        assert.ok(runExists(fixture));
    });

    await test('a dead run whose lock cannot be released stays in flight for a retry', async (t) => {
        const fixture = await newRunFixture(t);
        const watcher = await deadPid(fixture.env);
        await seedRun(fixture, {
            patch: { state: 'preparing', comments: [baseComment({ eyesAdded: false })], watcherPid: watcher },
            lockWatcherPid: watcher,
        });
        failLockRenames(t);
        const result = await reconcile(fixture.deps, fixture.session);
        assert.equal(result.inflightRunId, RUN_ID);
        const record = recordOf(fixture);
        assert.equal(record.state, 'running');
        assert.equal(record.reason, 'interrupted');
        assert.equal(worktreeLockHolder(fixture.stateDir, SESSION_KEY), RUN_ID);
        t.mock.restoreAll();
        const finished = await evaluateNow(fixture);
        assert.deepEqual(finished, { state: 'exited', reason: 'claude-exited' });
        assert.equal(lockExists(fixture, SESSION_KEY), false);
        assert.equal(runExists(fixture), false);
    });

    await test('a stop during the EYES removal of a dead run keeps record and lock', async (t) => {
        const fixture = await newRunFixture(t);
        const watcher = await deadPid(fixture.env);
        await seedRun(fixture, { patch: { watcherPid: watcher }, lockWatcherPid: watcher });
        const controller = new AbortController();
        fixture.fake.respond('gh', 'PrwcRemoveReaction', () => {
            controller.abort();
            return { code: 143 };
        });
        const result = await reconcile(fixture.deps, fixture.session, controller.signal);
        assert.equal(result.inflightRunId, undefined);
        assert.equal(eyesRemovals(fixture).length, 1);
        assert.ok(runExists(fixture));
        assert.equal(recordOf(fixture).comments[0]?.eyesAdded, true);
        assert.equal(worktreeLockHolder(fixture.stateDir, SESSION_KEY), RUN_ID);
    });

    await test('an abandoned run is cleared when its worker is gone, kept in flight when the release fails', async (t) => {
        const fixture = await newRunFixture(t);
        const watcher = await deadPid(fixture.env);
        await seedRun(fixture, {
            patch: { state: 'abandoned', reason: 'lock-release-failed', watcherPid: watcher },
            lockWatcherPid: watcher,
        });
        failLockRenames(t);
        const kept = await reconcile(fixture.deps, fixture.session);
        assert.equal(kept.inflightRunId, RUN_ID);
        assert.equal(recordOf(fixture).state, 'abandoned');
        assert.equal(worktreeLockHolder(fixture.stateDir, SESSION_KEY), RUN_ID);
        t.mock.restoreAll();
        const cleared = await reconcile(fixture.deps, fixture.session);
        assert.equal(cleared.inflightRunId, undefined);
        assert.equal(runExists(fixture), false);
        assert.equal(lockExists(fixture, SESSION_KEY), false);
        assert.equal(fixture.fake.calls('gh').length, 0);
    });

    await test('an abandoned run with a live worker is kept and not released', async (t) => {
        const fixture = await newRunFixture(t);
        const watcher = await deadPid(fixture.env);
        const panePid = fixture.env.spawnOrphan('sleep', ['300']);
        await seedRun(fixture, {
            patch: { state: 'abandoned', reason: 'lock-release-failed', watcherPid: watcher, panePid },
            lockWatcherPid: watcher,
        });
        const result = await reconcile(fixture.deps, fixture.session);
        assert.equal(result.inflightRunId, RUN_ID);
        assert.ok(runExists(fixture));
        assert.equal(worktreeLockHolder(fixture.stateDir, SESSION_KEY), RUN_ID);
    });

    await test('a second live run is left alone', async (t) => {
        const fixture = await newRunFixture(t);
        const watcher = await deadPid(fixture.env);
        await seedRun(fixture, { patch: { watcherPid: watcher }, events: ['prompt'], lockWatcherPid: watcher });
        await startClaude(fixture, 'cooperative');
        const panePid = fixture.env.spawnOrphan('sleep', ['300']);
        const second = baseRecord(fixture, { runId: RUN_2, worktreeKey: OTHER_KEY, watcherPid: watcher, panePid });
        createRun(fixture.stateDir, RUN_2);
        writeRecord(fixture.stateDir, second);
        const now = Math.floor(Date.now() / 1000);
        assert.ok(acquireWorktreeLock(fixture.stateDir, OTHER_KEY, RUN_2, watcher, fixture.deps.log, now));
        fixture.fake.respond('tmux', 'list-panes', { stdout: `%7 ${RUN_ID}\n` });
        const result = await reconcile(fixture.deps, fixture.session);
        assert.equal(result.inflightRunId, RUN_ID);
        const read = readRecord(fixture.stateDir, RUN_2);
        assert.ok(read.kind === 'ok');
        assert.equal(read.record.watcherPid, watcher);
        assert.equal(lockWatcherPid(fixture, OTHER_KEY), watcher);
        assert.ok(fixture.deps.logLines.some((line) => line.includes(`run ${RUN_2} also has a live worker`)));
    });
});
