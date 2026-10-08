import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test, type TestContext } from 'node:test';

import { pidAlive } from '../../src/proc.ts';
import {
    claimLaunch,
    createRun,
    launchDecision,
    listRunIds,
    mergeRecord,
    readEvents,
    readLoggedCursor,
    readRecord,
    readStatus,
    runIdsForPr,
    workerAlive,
    writeLoggedCursor,
    writeRecord,
    writeStatus,
} from '../../src/runStore.ts';
import { initState, runDir } from '../../src/stateStore.ts';
import type { RecordPatch, RunRecord } from '../../src/types.ts';
import { createTestEnv, waitUntil, type TestEnv } from '../support/testEnv.ts';

const PR_KEY = 'o+r+12';
const RUN_A = '20261002120000-1';
const RUN_B = '20261002120000-2';
const NOW = 1_790_942_400;

interface Fixture {
    env: TestEnv;
    stateDir: string;
}

async function newFixture(t: TestContext): Promise<Fixture> {
    const env = await createTestEnv();
    t.after(() => {
        env.cleanup();
    });
    const result = initState(env.stateDir);
    assert.ok(result.ok);
    return { env, stateDir: result.stateDir };
}

function livePid(env: TestEnv): number {
    return env.spawnOrphan('sleep', ['30']);
}

async function deadPid(env: TestEnv): Promise<number> {
    const pid = env.spawnOrphan('true', []);
    assert.ok(await waitUntil(3000, () => !pidAlive(pid)));
    return pid;
}

function sampleRecord(runId: string, prKey: string, panePid?: number): RunRecord {
    return {
        format: 2,
        runId,
        prKey,
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
                rocketAt: NOW,
                eyesAdded: false,
            },
        ],
        headSha: 'a'.repeat(40),
        remote: 'origin',
        branch: 'feature',
        dir: '/path/to/project',
        worktreeKey: '0123456789abcdef',
        claude: '/path/to/claude',
        git: '/usr/bin/git',
        gh: '/usr/bin/gh',
        callerPath: '/usr/bin:/bin',
        claudeArgs: ['--model', 'x'],
        state: 'preparing',
        reason: '',
        paneId: '',
        panePid,
        socket: '/tmp/prwc-test-socket',
        startedAt: undefined,
        watcherPid: 1,
    };
}

function withEvents(fixture: Fixture, content: string): ReturnType<typeof readEvents> {
    fs.writeFileSync(path.join(runDir(fixture.stateDir, RUN_A), 'events'), content);
    return readEvents(fixture.stateDir, RUN_A);
}

await describe('records', async () => {
    await test('createRun makes an owner-only directory and records round-trip', async (t) => {
        const fixture = await newFixture(t);
        const dir = createRun(fixture.stateDir, RUN_A);
        assert.equal(dir, runDir(fixture.stateDir, RUN_A));
        assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
        const record = sampleRecord(RUN_A, PR_KEY);
        writeRecord(fixture.stateDir, record);
        assert.deepEqual(readRecord(fixture.stateDir, RUN_A), { kind: 'ok', record });
    });

    await test('mergeRecord patches fields in one rewrite and keeps the rest', async (t) => {
        const fixture = await newFixture(t);
        createRun(fixture.stateDir, RUN_A);
        writeRecord(fixture.stateDir, sampleRecord(RUN_A, PR_KEY));
        const merged = mergeRecord(fixture.stateDir, RUN_A, { paneId: '%5', panePid: 42, state: 'running' });
        assert.equal(merged?.paneId, '%5');
        const read = readRecord(fixture.stateDir, RUN_A);
        assert.ok(read.kind === 'ok');
        assert.equal(read.record.panePid, 42);
        assert.equal(read.record.state, 'running');
        assert.deepEqual(read.record.claudeArgs, ['--model', 'x']);
        assert.equal(mergeRecord(fixture.stateDir, RUN_B, { state: 'running' }), undefined);
    });

    await test('a record with another format or a broken field is unreadable', async (t) => {
        const fixture = await newFixture(t);
        const dir = createRun(fixture.stateDir, RUN_A);
        fs.writeFileSync(path.join(dir, 'record.json'), JSON.stringify({ ...sampleRecord(RUN_A, PR_KEY), format: 9 }));
        assert.deepEqual(readRecord(fixture.stateDir, RUN_A), { kind: 'unreadable', format: '9' });
        fs.writeFileSync(path.join(dir, 'record.json'), JSON.stringify({ ...sampleRecord(RUN_A, PR_KEY), state: 'x' }));
        assert.deepEqual(readRecord(fixture.stateDir, RUN_A), { kind: 'unreadable', format: '2' });
        fs.writeFileSync(
            path.join(dir, 'record.json'),
            JSON.stringify({ ...sampleRecord(RUN_A, PR_KEY), panePid: 'x' })
        );
        assert.equal(readRecord(fixture.stateDir, RUN_A).kind, 'unreadable');
    });

    await test('a record without comments, with a broken comment or in the one-comment format 1 is unreadable', async (t) => {
        const fixture = await newFixture(t);
        const dir = createRun(fixture.stateDir, RUN_A);
        const sample = sampleRecord(RUN_A, PR_KEY);
        const write = (value: unknown): void => {
            fs.writeFileSync(path.join(dir, 'record.json'), JSON.stringify(value));
        };
        write({ ...sample, comments: [] });
        assert.equal(readRecord(fixture.stateDir, RUN_A).kind, 'unreadable');
        const [comment] = sample.comments;
        write({ ...sample, comments: [comment, { ...comment, dbId: 'x' }] });
        assert.equal(readRecord(fixture.stateDir, RUN_A).kind, 'unreadable');
        const flat = Object.fromEntries(Object.entries(sample).filter(([key]) => key !== 'comments'));
        write({ ...flat, format: 1, commentNodeId: 'PRRC_1', commentDbId: 1, eyesAdded: false });
        assert.deepEqual(readRecord(fixture.stateDir, RUN_A), { kind: 'unreadable', format: '1' });
        write({ ...sample, comments: [comment, { ...comment, nodeId: 'PRRC_2', dbId: 2 }] });
        const read = readRecord(fixture.stateDir, RUN_A);
        assert.ok(read.kind === 'ok');
        assert.deepEqual(
            read.record.comments.map((item) => item.dbId),
            [1, 2]
        );
    });

    await test('pending failure targets round-trip only for failed comments of the same run', async (t) => {
        const fixture = await newFixture(t);
        const dir = createRun(fixture.stateDir, RUN_A);
        const sample = sampleRecord(RUN_A, PR_KEY);
        const target = { nodeId: 'PRRC_1', dbId: 1, eyesOn: true };
        const write = (value: unknown): void => {
            fs.writeFileSync(path.join(dir, 'record.json'), JSON.stringify(value));
        };

        const failed = { ...sample, state: 'failed', pendingFailures: [target] };
        write(failed);
        const mapped: RunRecord = { ...sample, state: 'retained', outcome: 'failed', pendingFailures: [target] };
        assert.deepEqual(readRecord(fixture.stateDir, RUN_A), { kind: 'ok', record: mapped });

        for (const pendingFailures of [
            [{ ...target, nodeId: 'PRRC_other' }],
            [{ ...target, dbId: 2 }],
            [{ ...target, eyesOn: 'yes' }],
            [target, target],
        ]) {
            write({ ...failed, pendingFailures });
            assert.deepEqual(readRecord(fixture.stateDir, RUN_A), { kind: 'unreadable', format: '2' });
        }
        write({ ...sample, state: 'completed', pendingFailures: [target] });
        assert.deepEqual(readRecord(fixture.stateDir, RUN_A), { kind: 'unreadable', format: '2' });
        write({ ...failed, pendingFailures: 'broken' });
        assert.deepEqual(readRecord(fixture.stateDir, RUN_A), { kind: 'unreadable', format: '2' });
    });

    await test('a legacy settled record without an outcome reads as retained with that outcome', async (t) => {
        const fixture = await newFixture(t);
        const dir = createRun(fixture.stateDir, RUN_A);
        const sample = sampleRecord(RUN_A, PR_KEY);
        const write = (value: unknown): void => {
            fs.writeFileSync(path.join(dir, 'record.json'), JSON.stringify(value));
        };
        const target = { nodeId: 'PRRC_1', dbId: 1, eyesOn: false };

        write({ ...sample, state: 'completed', reason: 'done' });
        const completed: RunRecord = { ...sample, state: 'retained', outcome: 'completed', reason: 'done' };
        assert.deepEqual(readRecord(fixture.stateDir, RUN_A), { kind: 'ok', record: completed });

        write({ ...sample, state: 'failed', reason: 'claude-took-failure-path', pendingFailures: [target] });
        const read = readRecord(fixture.stateDir, RUN_A);
        assert.ok(read.kind === 'ok');
        assert.equal(read.record.state, 'retained');
        assert.equal(read.record.outcome, 'failed');
        assert.equal(read.record.reason, 'claude-took-failure-path');
        assert.deepEqual(read.record.pendingFailures, [target]);

        for (const value of [
            { ...sample, state: 'completed', reason: 'done', pendingFailures: [target] },
            { ...sample, state: 'failed', reason: 'claude-took-failure-path', outcome: 'failed' },
            { ...sample, state: 'completed', reason: 'done', outcome: 'completed' },
        ]) {
            write(value);
            assert.deepEqual(readRecord(fixture.stateDir, RUN_A), { kind: 'unreadable', format: '2' });
        }
    });

    await test('a retained record round-trips with either outcome', async (t) => {
        const fixture = await newFixture(t);
        createRun(fixture.stateDir, RUN_A);
        for (const outcome of ['completed', 'failed'] as const) {
            const record: RunRecord = { ...sampleRecord(RUN_A, PR_KEY), state: 'retained', outcome };
            writeRecord(fixture.stateDir, record);
            assert.deepEqual(readRecord(fixture.stateDir, RUN_A), { kind: 'ok', record });
        }
    });

    await test('mergeRecord rewrites a legacy completed record in the retained form', async (t) => {
        const fixture = await newFixture(t);
        const dir = createRun(fixture.stateDir, RUN_A);
        const file = path.join(dir, 'record.json');
        fs.writeFileSync(file, JSON.stringify({ ...sampleRecord(RUN_A, PR_KEY), state: 'completed', reason: 'done' }));
        const merged = mergeRecord(fixture.stateDir, RUN_A, { watcherPid: 77 });
        assert.equal(merged?.state, 'retained');
        assert.equal(merged.outcome, 'completed');
        const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
        assert.ok(typeof raw === 'object' && raw !== null);
        assert.equal(Reflect.get(raw, 'state'), 'retained');
        assert.equal(Reflect.get(raw, 'outcome'), 'completed');
        assert.equal(Reflect.get(raw, 'watcherPid'), 77);
        assert.equal(Reflect.get(raw, 'reason'), 'done');
    });

    await test('mergeRecord keeps a retained record when the patch keeps its state and outcome', async (t) => {
        const fixture = await newFixture(t);
        createRun(fixture.stateDir, RUN_A);
        const target = { nodeId: 'PRRC_1', dbId: 1, eyesOn: false };
        const record: RunRecord = {
            ...sampleRecord(RUN_A, PR_KEY),
            state: 'retained',
            outcome: 'failed',
            pendingFailures: [target],
        };
        writeRecord(fixture.stateDir, record);
        mergeRecord(fixture.stateDir, RUN_A, { state: 'retained', outcome: 'failed', pendingFailures: undefined });
        const read = readRecord(fixture.stateDir, RUN_A);
        assert.ok(read.kind === 'ok');
        assert.equal(read.record.state, 'retained');
        assert.equal(read.record.outcome, 'failed');
        assert.equal(read.record.pendingFailures, undefined);
    });

    await test('mergeRecord refuses to change the state or outcome of a retained record', async (t) => {
        const fixture = await newFixture(t);
        const dir = createRun(fixture.stateDir, RUN_A);
        const file = path.join(dir, 'record.json');
        const sample = sampleRecord(RUN_A, PR_KEY);
        // Each stored value is paired with the outcome it reads with; a legacy failed file carries it in the state.
        const stored = [
            { value: { ...sample, state: 'retained', outcome: 'failed' }, outcome: 'failed' },
            { value: { ...sample, state: 'retained', outcome: 'completed' }, outcome: 'completed' },
            { value: { ...sample, state: 'failed', reason: 'claude-took-failure-path' }, outcome: 'failed' },
        ];
        const patches: RecordPatch[] = [
            { state: 'running' },
            { outcome: 'completed' },
            { outcome: 'failed' },
            { outcome: undefined },
        ];
        for (const { value, outcome } of stored) {
            for (const patch of patches) {
                if (patch.outcome === outcome) {
                    continue;
                }
                const bytes = JSON.stringify(value);
                fs.writeFileSync(file, bytes);
                assert.throws(
                    () => mergeRecord(fixture.stateDir, RUN_A, patch),
                    (error: unknown) => error instanceof Error && error.message.includes(RUN_A)
                );
                assert.equal(fs.readFileSync(file, 'utf8'), bytes);
            }
        }
    });

    await test('pending failure targets are kept only for a retained record with the failed outcome', async (t) => {
        const fixture = await newFixture(t);
        createRun(fixture.stateDir, RUN_A);
        const target = { nodeId: 'PRRC_1', dbId: 1, eyesOn: false };
        const record: RunRecord = {
            ...sampleRecord(RUN_A, PR_KEY),
            state: 'retained',
            outcome: 'failed',
            pendingFailures: [target],
        };
        writeRecord(fixture.stateDir, record);
        const read = readRecord(fixture.stateDir, RUN_A);
        assert.ok(read.kind === 'ok');
        assert.deepEqual(read.record.pendingFailures, [target]);
        assert.deepEqual(read.record, record);
        writeRecord(fixture.stateDir, { ...record, outcome: 'completed' });
        assert.deepEqual(readRecord(fixture.stateDir, RUN_A), { kind: 'unreadable', format: '2' });
    });

    await test('outcome is required for a retained record and rejected elsewhere', async (t) => {
        const fixture = await newFixture(t);
        const dir = createRun(fixture.stateDir, RUN_A);
        const sample = sampleRecord(RUN_A, PR_KEY);
        const write = (value: unknown): void => {
            fs.writeFileSync(path.join(dir, 'record.json'), JSON.stringify(value));
        };
        for (const value of [
            { ...sample, state: 'retained' },
            { ...sample, state: 'running', outcome: 'completed' },
            { ...sample, state: 'failed', outcome: 'failed' },
            { ...sample, state: 'retained', outcome: 'done' },
            { ...sample, state: 'retained', outcome: 1 },
            { ...sample, state: 'held' },
            { ...sample, state: 'held', outcome: 'completed' },
        ]) {
            write(value);
            assert.deepEqual(readRecord(fixture.stateDir, RUN_A), { kind: 'unreadable', format: '2' });
        }
    });

    await test('runIdsForPr lists only runs of that PR', async (t) => {
        const fixture = await newFixture(t);
        for (const [runId, prKey] of [
            [RUN_A, PR_KEY],
            [RUN_B, 'o+r+13'],
        ] as const) {
            createRun(fixture.stateDir, runId);
            writeRecord(fixture.stateDir, sampleRecord(runId, prKey));
        }
        assert.deepEqual(listRunIds(fixture.stateDir), [RUN_A, RUN_B]);
        assert.deepEqual(runIdsForPr(fixture.stateDir, PR_KEY), [RUN_A]);
        assert.deepEqual(runIdsForPr(fixture.stateDir, 'o+r+13'), [RUN_B]);
        assert.deepEqual(runIdsForPr(fixture.stateDir, 'o+r+14'), []);
    });
});

await describe('workerAlive', async () => {
    await test('a live claude.pid is alive', async (t) => {
        const fixture = await newFixture(t);
        const dir = createRun(fixture.stateDir, RUN_A);
        writeRecord(fixture.stateDir, sampleRecord(RUN_A, PR_KEY));
        fs.writeFileSync(path.join(dir, 'claude.pid'), `${livePid(fixture.env)}\n`);
        assert.equal(workerAlive(fixture.stateDir, RUN_A), true);
    });

    await test('a live panePid without claude.pid and exit_status is alive', async (t) => {
        const fixture = await newFixture(t);
        createRun(fixture.stateDir, RUN_A);
        writeRecord(fixture.stateDir, sampleRecord(RUN_A, PR_KEY, livePid(fixture.env)));
        assert.equal(workerAlive(fixture.stateDir, RUN_A), true);
    });

    await test('a live panePid stops counting once exit_status exists', async (t) => {
        const fixture = await newFixture(t);
        const dir = createRun(fixture.stateDir, RUN_A);
        writeRecord(fixture.stateDir, sampleRecord(RUN_A, PR_KEY, livePid(fixture.env)));
        fs.writeFileSync(path.join(dir, 'exit_status'), '0\n');
        fs.writeFileSync(path.join(dir, 'claude.pid'), `${await deadPid(fixture.env)}\n`);
        assert.equal(workerAlive(fixture.stateDir, RUN_A), false);
    });

    await test('a dead or undefined panePid and a missing run directory are not alive', async (t) => {
        const fixture = await newFixture(t);
        createRun(fixture.stateDir, RUN_A);
        writeRecord(fixture.stateDir, sampleRecord(RUN_A, PR_KEY, await deadPid(fixture.env)));
        assert.equal(workerAlive(fixture.stateDir, RUN_A), false);
        writeRecord(fixture.stateDir, sampleRecord(RUN_A, PR_KEY));
        assert.equal(workerAlive(fixture.stateDir, RUN_A), false);
        assert.equal(workerAlive(fixture.stateDir, RUN_B), false);
    });

    for (const code of ['EIO', 'EACCES']) {
        await test(`a claude.pid that fails to read with ${code} counts as alive without a live panePid`, async (t) => {
            const fixture = await newFixture(t);
            const dir = createRun(fixture.stateDir, RUN_A);
            writeRecord(fixture.stateDir, sampleRecord(RUN_A, PR_KEY, await deadPid(fixture.env)));
            const pidFile = path.join(dir, 'claude.pid');
            fs.writeFileSync(pidFile, `${await deadPid(fixture.env)}\n`);
            fs.writeFileSync(path.join(dir, 'exit_status'), '0');
            const original = fs.readFileSync;
            t.mock.method(fs, 'readFileSync', (target: fs.PathOrFileDescriptor, options: BufferEncoding) => {
                if (target === pidFile) {
                    throw Object.assign(new Error(`${code}: claude.pid cannot be read`), { code });
                }
                return original(target, options);
            });
            assert.equal(workerAlive(fixture.stateDir, RUN_A), true);
            t.mock.restoreAll();
            assert.equal(workerAlive(fixture.stateDir, RUN_A), false);
        });
    }
});

await describe('launch decision', async () => {
    await test('the first claim wins and the decision never changes', async (t) => {
        const fixture = await newFixture(t);
        createRun(fixture.stateDir, RUN_A);
        assert.equal(launchDecision(fixture.stateDir, RUN_A), 'none');
        assert.equal(claimLaunch(fixture.stateDir, RUN_A, 'go'), true);
        assert.equal(claimLaunch(fixture.stateDir, RUN_A, 'cancel'), false);
        assert.equal(launchDecision(fixture.stateDir, RUN_A), 'go');
        assert.equal(fs.readFileSync(path.join(runDir(fixture.stateDir, RUN_A), 'decision.d', 'value'), 'utf8'), 'go');
    });

    await test('a bare decision.d reads claimed and a removed run cannot be claimed', async (t) => {
        const fixture = await newFixture(t);
        const dir = createRun(fixture.stateDir, RUN_A);
        fs.mkdirSync(path.join(dir, 'decision.d'));
        assert.equal(launchDecision(fixture.stateDir, RUN_A), 'claimed');
        assert.equal(claimLaunch(fixture.stateDir, RUN_B, 'cancel'), false);
        assert.equal(fs.existsSync(runDir(fixture.stateDir, RUN_B)), false);
    });
});

await describe('readEvents', async () => {
    await test('a missing file gives an empty snapshot', async (t) => {
        const fixture = await newFixture(t);
        createRun(fixture.stateDir, RUN_A);
        assert.deepEqual(readEvents(fixture.stateDir, RUN_A), {
            lastEvent: 'none',
            lastEventAt: undefined,
            hasPrompt: false,
            count: 0,
            kinds: [],
        });
    });

    await test('derives the last event, its time, the prompt flag and every kind from one read', async (t) => {
        const fixture = await newFixture(t);
        createRun(fixture.stateDir, RUN_A);
        assert.deepEqual(withEvents(fixture, 'prompt 1\nstop 2\n'), {
            lastEvent: 'stop',
            lastEventAt: 2,
            hasPrompt: true,
            count: 2,
            kinds: ['prompt', 'stop'],
        });
        assert.equal(withEvents(fixture, 'prompt 1\ntool 2\n').lastEvent, 'tool');
        assert.deepEqual(withEvents(fixture, 'prompt 1\ntool 2\nstop 3\n').kinds, ['prompt', 'tool', 'stop']);
    });

    await test('an unknown kind is counted and listed but never becomes the last event', async (t) => {
        const fixture = await newFixture(t);
        createRun(fixture.stateDir, RUN_A);
        const snapshot = withEvents(fixture, 'prompt 1\nbogus 2\n');
        assert.deepEqual(snapshot.kinds, ['prompt', 'unknown']);
        assert.equal(snapshot.count, 2);
        assert.equal(snapshot.lastEvent, 'prompt');
        assert.equal(snapshot.lastEventAt, 1);
    });

    await test('a trailing line without a newline is ignored and stop alone has no prompt', async (t) => {
        const fixture = await newFixture(t);
        createRun(fixture.stateDir, RUN_A);
        const partial = withEvents(fixture, 'prompt 1\nstop 3');
        assert.equal(partial.lastEvent, 'prompt');
        assert.equal(partial.count, 1);
        assert.equal(partial.kinds.length, 1);
        const stopOnly = withEvents(fixture, 'stop 1\n');
        assert.equal(stopOnly.hasPrompt, false);
        assert.equal(stopOnly.lastEvent, 'stop');
    });

    await test('the logged cursor defaults to 0 and round-trips', async (t) => {
        const fixture = await newFixture(t);
        const dir = createRun(fixture.stateDir, RUN_A);
        assert.equal(readLoggedCursor(fixture.stateDir, RUN_A), 0);
        writeLoggedCursor(fixture.stateDir, RUN_A, 3);
        assert.equal(readLoggedCursor(fixture.stateDir, RUN_A), 3);
        fs.writeFileSync(path.join(dir, 'logged'), 'x');
        assert.equal(readLoggedCursor(fixture.stateDir, RUN_A), 0);
    });
});

await describe('watcher status', async () => {
    await test('writeStatus merges fields and refreshes updatedAt', async (t) => {
        const fixture = await newFixture(t);
        assert.equal(readStatus(fixture.stateDir, PR_KEY), undefined);
        writeStatus(fixture.stateDir, PR_KEY, { pid: 42, state: 'starting', reason: 'r', since: NOW }, NOW);
        writeStatus(fixture.stateDir, PR_KEY, { state: 'polling' }, NOW + 5);
        const status = readStatus(fixture.stateDir, PR_KEY);
        assert.ok(status !== undefined);
        assert.equal(status.state, 'polling');
        assert.equal(status.pid, 42);
        assert.equal(status.reason, 'r');
        assert.equal(status.since, NOW);
        assert.equal(status.updatedAt, NOW + 5);
    });
});
