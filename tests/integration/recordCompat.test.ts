import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test, type TestContext } from 'node:test';

import { RECORD_FORMAT } from '../../src/constants.ts';
import { runList } from '../../src/control.ts';
import { getPath, getString, isRecord } from '../../src/json.ts';
import { mergeRecord, readRecord } from '../../src/runStore.ts';
import { initState, runDir } from '../../src/stateStore.ts';
import { createFakeRunner } from '../support/fakeRunner.ts';
import { createTestEnv, type TestDeps } from '../support/testEnv.ts';

const FIXTURES = path.resolve(import.meta.dirname, '..', 'fixtures', 'records');
const LEGACY_COMPLETED = '20261008120000-101';
const LEGACY_FAILED = '20261008120000-102';
const RETAINED_FAILED = '20261008120000-103';
const RETAINED_COMPLETED = '20261008120000-104';
const RUNNING = '20261008120000-105';
const RUN_IDS = [LEGACY_COMPLETED, LEGACY_FAILED, RETAINED_FAILED, RETAINED_COMPLETED, RUNNING];
// The run states the previous release (format 2 before retained existed) accepts; any other state is unreadable there.
const PREVIOUS_RELEASE_STATES: ReadonlySet<string> = new Set([
    'preparing',
    'running',
    'needs_attention',
    'completed',
    'failed',
    'exited',
    'abandoned',
]);
const PENDING_TARGET = [{ nodeId: 'PRRC_c102', dbId: 102, eyesOn: true }];

type JsonObject = Record<string, unknown>;

interface Setup {
    stateDir: string;
    deps: TestDeps;
}

function loadFixture(runId: string): JsonObject {
    const value: unknown = JSON.parse(fs.readFileSync(path.join(FIXTURES, `${runId}.json`), 'utf8'));
    assert.ok(isRecord(value), runId);
    return value;
}

function recordFile(stateDir: string, runId: string): string {
    return path.join(runDir(stateDir, runId), 'record.json');
}

function storeRecord(stateDir: string, runId: string, value: JsonObject): void {
    fs.mkdirSync(runDir(stateDir, runId), { recursive: true, mode: 0o700 });
    fs.writeFileSync(recordFile(stateDir, runId), `${JSON.stringify(value, undefined, 4)}\n`, { mode: 0o600 });
}

function readRaw(stateDir: string, runId: string): JsonObject {
    const value: unknown = JSON.parse(fs.readFileSync(recordFile(stateDir, runId), 'utf8'));
    assert.ok(isRecord(value), runId);
    return value;
}

// Drops top-level properties whose value is undefined, so a read record compares with the JSON it came from.
function plain(value: object): JsonObject {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function readOk(stateDir: string, runId: string): unknown {
    const read = readRecord(stateDir, runId);
    assert.equal(read.kind, 'ok', runId);
    return read.kind === 'ok' ? plain(read.record) : undefined;
}

function mapped(runId: string, outcome: 'completed' | 'failed'): JsonObject {
    return { ...loadFixture(runId), state: 'retained', outcome };
}

async function makeSetup(t: TestContext, runIds: readonly string[] = RUN_IDS): Promise<Setup> {
    const testEnv = await createTestEnv();
    t.after(() => {
        testEnv.cleanup();
    });
    const init = initState(testEnv.stateDir);
    assert.ok(init.ok);
    for (const runId of runIds) {
        storeRecord(init.stateDir, runId, loadFixture(runId));
    }
    return { stateDir: init.stateDir, deps: testEnv.deps(createFakeRunner().runner) };
}

function runLineOf(output: string, runId: string): string {
    return output.split('\n').find((line) => line.startsWith(`run ${runId} `)) ?? '';
}

await describe('record fixtures', async () => {
    await test('every fixture is a format 2 record named after its run', () => {
        assert.equal(RECORD_FORMAT, 2);
        for (const runId of RUN_IDS) {
            const fixture = loadFixture(runId);
            assert.equal(getPath(fixture, 'format'), RECORD_FORMAT, runId);
            assert.equal(getString(fixture, 'runId'), runId);
        }
    });
});

await describe('forward compatibility', async () => {
    await test('legacy records read as retained with their outcome', async (t) => {
        const setup = await makeSetup(t);
        assert.deepEqual(readOk(setup.stateDir, LEGACY_COMPLETED), mapped(LEGACY_COMPLETED, 'completed'));
        const failed = readOk(setup.stateDir, LEGACY_FAILED);
        assert.deepEqual(failed, mapped(LEGACY_FAILED, 'failed'));
        assert.deepEqual(getPath(failed, 'pendingFailures'), PENDING_TARGET);
    });

    await test('current records read back field for field', async (t) => {
        const setup = await makeSetup(t);
        for (const runId of [RETAINED_FAILED, RETAINED_COMPLETED, RUNNING]) {
            assert.deepEqual(readOk(setup.stateDir, runId), loadFixture(runId), runId);
        }
    });

    await test('the first update persists the mapped legacy form', async (t) => {
        const setup = await makeSetup(t);
        const cases: [string, 'completed' | 'failed'][] = [
            [LEGACY_COMPLETED, 'completed'],
            [LEGACY_FAILED, 'failed'],
        ];
        for (const [runId, outcome] of cases) {
            assert.ok(mergeRecord(setup.stateDir, runId, { watcherPid: 4242 }) !== undefined, runId);
            const raw = readRaw(setup.stateDir, runId);
            assert.equal(raw.state, 'retained', runId);
            assert.equal(raw.outcome, outcome, runId);
            assert.equal(raw.watcherPid, 4242, runId);
            const first = readOk(setup.stateDir, runId);
            assert.deepEqual(first, { ...mapped(runId, outcome), watcherPid: 4242 }, runId);
            assert.deepEqual(readOk(setup.stateDir, runId), first, runId);
        }
    });

    await test('the list shows every run with its state and outcome', async (t) => {
        const setup = await makeSetup(t);
        assert.equal(await runList(setup.deps, setup.stateDir), 0);
        const output = setup.deps.outText();
        assert.ok(!output.includes('unreadable record'), output);
        for (const runId of [LEGACY_COMPLETED, RETAINED_COMPLETED]) {
            assert.ok(runLineOf(output, runId).includes(' state=retained outcome=completed '), output);
        }
        for (const runId of [LEGACY_FAILED, RETAINED_FAILED]) {
            assert.ok(runLineOf(output, runId).includes(' state=retained outcome=failed '), output);
        }
        const running = runLineOf(output, RUNNING);
        assert.ok(running.includes(' state=running comments='), output);
        assert.ok(!running.includes('outcome='), output);
    });

    await test('a legacy state next to an outcome field is unreadable', async (t) => {
        const setup = await makeSetup(t, []);
        storeRecord(setup.stateDir, LEGACY_COMPLETED, { ...loadFixture(LEGACY_COMPLETED), outcome: 'completed' });
        assert.deepEqual(readRecord(setup.stateDir, LEGACY_COMPLETED), { kind: 'unreadable', format: '2' });
    });

    await test('a retained record without an outcome is unreadable and listed as such', async (t) => {
        const setup = await makeSetup(t, []);
        const { outcome: _dropped, ...withoutOutcome } = loadFixture(RETAINED_COMPLETED);
        assert.equal(_dropped, 'completed');
        storeRecord(setup.stateDir, RETAINED_COMPLETED, withoutOutcome);
        assert.deepEqual(readRecord(setup.stateDir, RETAINED_COMPLETED), { kind: 'unreadable', format: '2' });
        assert.equal(await runList(setup.deps, setup.stateDir), 0);
        const expected = `unreadable record ${recordFile(setup.stateDir, RETAINED_COMPLETED)} (format 2)`;
        assert.ok(setup.deps.outText().includes(expected), setup.deps.outText());
    });
});

await describe('rollback to the previous release', async () => {
    await test('current retained records carry a state the previous release refuses', () => {
        for (const runId of [RETAINED_FAILED, RETAINED_COMPLETED]) {
            const state = getString(loadFixture(runId), 'state') ?? '';
            assert.ok(!PREVIOUS_RELEASE_STATES.has(state), runId);
        }
        for (const runId of [LEGACY_COMPLETED, LEGACY_FAILED, RUNNING]) {
            assert.ok(PREVIOUS_RELEASE_STATES.has(getString(loadFixture(runId), 'state') ?? ''), runId);
        }
    });

    await test('legacy records after the first update carry a state the previous release refuses', async (t) => {
        const setup = await makeSetup(t);
        for (const runId of [LEGACY_COMPLETED, LEGACY_FAILED]) {
            mergeRecord(setup.stateDir, runId, { watcherPid: 4242 });
            const raw = readRaw(setup.stateDir, runId);
            assert.equal(raw.format, RECORD_FORMAT, runId);
            assert.ok(!PREVIOUS_RELEASE_STATES.has(getString(raw, 'state') ?? ''), runId);
        }
    });
});
