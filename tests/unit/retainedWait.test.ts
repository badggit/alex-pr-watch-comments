import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test, type TestContext } from 'node:test';

import { RETAINED_REMINDER_SECONDS } from '../../src/constants.ts';
import { acquireWorktreeLock } from '../../src/locks.ts';
import {
    busyHint,
    initialNoticeState,
    planNotice,
    retainedStatus,
    sameWaitingSet,
    waitingSetOf,
    waitingSuffix,
    type NoticePlan,
    type NoticeState,
    type RetainedStatusInput,
    type WaitingSet,
} from '../../src/retainedWait.ts';
import { createRun, writeRecord } from '../../src/runStore.ts';
import { initState, runDir } from '../../src/stateStore.ts';
import type { Candidate, RunRecord, RunState } from '../../src/types.ts';
import { safeText } from '../../src/validate.ts';
import { createFakeRunner } from '../support/fakeRunner.ts';
import { createTestEnv, type TestDeps } from '../support/testEnv.ts';

const RUN_ID = '20261008120000-7';
const WT_KEY = '0123456789abcdef';
const NOW = 1_791_460_800;
const MINUTE = 60;
const ROCKET_AT = 1_791_400_000;
// Named stand-ins for "no poll yet" and "PR still open".
const UNSET = { waiting: undefined, closed: undefined } as const;

function candidate(nodeId: string, rocketAt: number): Candidate {
    return {
        poll: { threadId: `T_${nodeId}`, position: 0, nodeId, dbId: 1, topDbId: 1, rocket: true },
        entry: {
            nodeId,
            dbId: 1,
            rocketAt,
            plus1At: undefined,
            eyes: false,
            minus1: false,
            editedAt: undefined,
            url: 'https://github.com/o/r/pull/12#discussion_r1',
            author: 'someone',
            path: 'src/a.ts',
            line: 1,
            body: 'fix this',
        },
    };
}

function waiting(...nodeIds: string[]): WaitingSet {
    return waitingSetOf(nodeIds.map((nodeId) => candidate(nodeId, ROCKET_AT)));
}

function status(waitingSet: WaitingSet | undefined, closed?: 'CLOSED' | 'MERGED'): RetainedStatusInput {
    return { outcome: 'failed', paneId: '%7', waiting: waitingSet, closed };
}

function assertSafe(text: string | undefined): void {
    if (text !== undefined) {
        assert.equal(safeText(text), text);
    }
}

function plan(previous: NoticeState, now: number, input: RetainedStatusInput): NoticePlan {
    const result = planNotice(previous, { now, runId: RUN_ID, status: input });
    assertSafe(result.notice);
    assertSafe(result.log);
    return result;
}

await describe('waiting set', async () => {
    await test('keys are sorted NODEID:ROCKETAT strings over all candidates', () => {
        const set = waitingSetOf([candidate('PRRC_b', 2), candidate('PRRC_a', 1), candidate('PRRC_c', 3)]);
        assert.deepEqual(set.keys, ['PRRC_a:1', 'PRRC_b:2', 'PRRC_c:3']);
        assert.equal(set.count, 3);
    });

    await test('sameWaitingSet compares keys, not counts', () => {
        const a = waitingSetOf([candidate('PRRC_a', 1)]);
        assert.ok(sameWaitingSet(a, waitingSetOf([candidate('PRRC_a', 1)])));
        assert.ok(!sameWaitingSet(a, waitingSetOf([candidate('PRRC_a', 2)])));
        assert.ok(!sameWaitingSet(a, UNSET.waiting));
        assert.ok(sameWaitingSet(UNSET.waiting, UNSET.waiting));
    });
});

await describe('retainedStatus', async () => {
    await test('two waiting comments name the count and the pane', () => {
        const result = retainedStatus(status(waiting('PRRC_a', 'PRRC_b')));
        assert.equal(result.reason, 'failed-waiting-for-owner, 2 approved comments waiting');
        assert.equal(result.hint, 'exit Claude in pane 7 to start the next batch');
    });

    await test('one waiting comment uses the singular', () => {
        const result = retainedStatus({ ...status(waiting('PRRC_a')), outcome: 'completed' });
        assert.equal(result.reason, 'completed-waiting-for-owner, 1 approved comment waiting');
        assert.equal(result.hint, 'exit Claude in pane 7 to start the next batch');
    });

    await test('a closed PR hides the count and asks to finish', () => {
        const merged = retainedStatus(status(waiting('PRRC_a', 'PRRC_b'), 'MERGED'));
        assert.equal(merged.reason, 'failed-waiting-for-owner, PR merged');
        assert.equal(merged.hint, 'exit Claude in pane 7 to finish');
        const closed = retainedStatus(status(undefined, 'CLOSED'));
        assert.equal(closed.reason, 'failed-waiting-for-owner, PR closed');
        assert.equal(waitingSuffix(undefined, 'CLOSED'), ', PR closed');
    });

    await test('an empty or unknown set keeps the plain reason and no hint', () => {
        for (const set of [waiting(), undefined]) {
            const result = retainedStatus(status(set));
            assert.equal(result.reason, 'failed-waiting-for-owner');
            assert.equal(result.hint, '');
            assert.equal(waitingSuffix(set, UNSET.closed), '');
        }
    });

    await test('a pane id without % shows as its worker pane and every text is safe', () => {
        const result = retainedStatus({ ...status(waiting('PRRC_a')), paneId: 'pane-x' });
        assert.equal(result.hint, 'exit Claude in its worker pane to start the next batch');
        const inputs: RetainedStatusInput[] = [
            status(waiting('PRRC_a')),
            status(waiting('PRRC_a', 'PRRC_b')),
            status(waiting(), 'MERGED'),
            status(UNSET.waiting),
            { ...status(waiting('PRRC_a'), 'CLOSED'), paneId: '%x;y' },
        ];
        for (const input of inputs) {
            const text = retainedStatus(input);
            assertSafe(text.reason);
            assertSafe(text.hint);
        }
    });
});

await describe('planNotice', async () => {
    await test('a new set notifies once, then reminds after the deadline', () => {
        const set = waiting('PRRC_a', 'PRRC_b');
        const first = plan(initialNoticeState(), NOW, status(set));
        assert.equal(
            first.notice,
            `run ${RUN_ID}: 2 approved comments waiting, exit Claude in pane 7 to start the next batch`
        );
        assert.ok(first.log?.includes(RUN_ID));
        assert.ok(first.log?.includes('2 approved comments'));
        assert.equal(first.next.remindAt, NOW + RETAINED_REMINDER_SECONDS);

        const quiet = plan(first.next, NOW + 10 * MINUTE, status(set));
        assert.equal(quiet.notice, undefined);
        assert.equal(quiet.log, undefined);
        assert.deepEqual(quiet.next, first.next);

        const reminder = plan(quiet.next, NOW + 30 * MINUTE, status(set));
        assert.equal(reminder.notice, first.notice);
        assert.equal(reminder.log, undefined);
        assert.equal(reminder.next.remindAt, NOW + 30 * MINUTE + RETAINED_REMINDER_SECONDS);
    });

    await test('the same count with a different approval time is a new set', () => {
        const first = plan(initialNoticeState(), NOW, status(waiting('PRRC_a')));
        const moved = waitingSetOf([candidate('PRRC_a', ROCKET_AT + 5)]);
        const changed = plan(first.next, NOW + MINUTE, status(moved));
        assert.ok(changed.notice?.includes('1 approved comment waiting'));
        assert.ok(changed.log !== undefined);
        assert.equal(changed.next.remindAt, NOW + MINUTE + RETAINED_REMINDER_SECONDS);
    });

    await test('an emptying set logs, sends nothing and clears the deadline', () => {
        const first = plan(initialNoticeState(), NOW, status(waiting('PRRC_a')));
        const emptied = plan(first.next, NOW + MINUTE, status(waiting()));
        assert.equal(emptied.notice, undefined);
        assert.ok(emptied.log?.includes(RUN_ID));
        assert.equal(emptied.next.remindAt, undefined);
        const later = plan(emptied.next, NOW + 60 * MINUTE, status(waiting()));
        assert.equal(later.notice, undefined);
        assert.equal(later.log, undefined);
    });

    await test('an initial empty set and an unknown set give nothing', () => {
        const empty = plan(initialNoticeState(), NOW, status(waiting()));
        assert.equal(empty.notice, undefined);
        assert.equal(empty.log, undefined);
        const unknown = plan(initialNoticeState(), NOW, status(UNSET.waiting));
        assert.equal(unknown.notice, undefined);
        assert.equal(unknown.log, undefined);
        assert.deepEqual(unknown.next, initialNoticeState());
    });

    await test('a closed PR notifies once, then reminds only after the deadline', () => {
        const opened = plan(initialNoticeState(), NOW, status(waiting('PRRC_a')));
        const closed = plan(opened.next, NOW + MINUTE, status(waiting('PRRC_a', 'PRRC_b'), 'MERGED'));
        assert.equal(closed.notice, 'PR merged, exit Claude to finish');
        assert.ok(closed.log?.includes(RUN_ID));
        assert.equal(closed.next.remindAt, NOW + MINUTE + RETAINED_REMINDER_SECONDS);

        const early = plan(closed.next, NOW + 20 * MINUTE, status(waiting('PRRC_c'), 'MERGED'));
        assert.equal(early.notice, undefined);
        assert.equal(early.log, undefined);

        const due = NOW + MINUTE + RETAINED_REMINDER_SECONDS;
        const reminder = plan(early.next, due, status(waiting('PRRC_c'), 'MERGED'));
        assert.equal(reminder.notice, 'PR merged, exit Claude to finish');
        assert.equal(reminder.next.remindAt, due + RETAINED_REMINDER_SECONDS);
    });

    await test('a closed PR without a prior set uses the closed wording', () => {
        const closed = plan(initialNoticeState(), NOW, status(undefined, 'CLOSED'));
        assert.equal(closed.notice, 'PR closed, exit Claude to finish');
        assert.ok(closed.next.closedSeen);
    });
});

interface Fixture {
    stateDir: string;
    deps: TestDeps;
}

async function newFixture(t: TestContext): Promise<Fixture> {
    const env = await createTestEnv();
    t.after(() => {
        env.cleanup();
    });
    const result = initState(env.stateDir);
    assert.ok(result.ok);
    return { stateDir: result.stateDir, deps: env.deps(createFakeRunner().runner) };
}

function record(state: RunState): RunRecord {
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
                nodeId: 'PRRC_1',
                dbId: 1,
                url: 'https://github.com/o/r/pull/12#discussion_r1',
                threadId: 'PRRT_1',
                topDbId: 1,
                rocketAt: ROCKET_AT,
                eyesAdded: true,
            },
        ],
        headSha: 'a'.repeat(40),
        remote: 'origin',
        branch: 'feature',
        dir: '/path/to/project',
        worktreeKey: WT_KEY,
        claude: '/path/to/claude',
        git: '/usr/bin/git',
        gh: '/usr/bin/gh',
        callerPath: '/usr/bin:/bin',
        claudeArgs: [],
        state,
        ...(state === 'retained' ? { outcome: 'completed' as const } : {}),
        reason: '',
        paneId: '%7',
        panePid: undefined,
        socket: '/tmp/prwc-test-socket',
        startedAt: NOW,
        watcherPid: process.pid,
    };
}

function holdLock(fixture: Fixture): void {
    assert.ok(acquireWorktreeLock(fixture.stateDir, WT_KEY, RUN_ID, process.pid, fixture.deps.log, NOW));
}

await describe('busyHint', async () => {
    await test('a retained holder names its run and PR', async (t) => {
        const fixture = await newFixture(t);
        createRun(fixture.stateDir, RUN_ID);
        writeRecord(fixture.stateDir, record('retained'));
        holdLock(fixture);
        const hint = busyHint(fixture.stateDir, WT_KEY);
        assert.equal(hint, `run ${RUN_ID} of PR 12 holds the clone until its Claude session exits`);
        assertSafe(hint);
    });

    await test('a running holder gives no hint', async (t) => {
        const fixture = await newFixture(t);
        createRun(fixture.stateDir, RUN_ID);
        writeRecord(fixture.stateDir, record('running'));
        holdLock(fixture);
        assert.equal(busyHint(fixture.stateDir, WT_KEY), '');
    });

    await test('no lock gives no hint', async (t) => {
        const fixture = await newFixture(t);
        assert.equal(busyHint(fixture.stateDir, WT_KEY), '');
    });

    await test('a holder with an unreadable record gives no hint', async (t) => {
        const fixture = await newFixture(t);
        createRun(fixture.stateDir, RUN_ID);
        fs.writeFileSync(path.join(runDir(fixture.stateDir, RUN_ID), 'record.json'), '{"format":1}');
        holdLock(fixture);
        assert.equal(busyHint(fixture.stateDir, WT_KEY), '');
    });
});
