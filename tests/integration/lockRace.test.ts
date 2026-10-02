import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test, type TestContext } from 'node:test';

import { getString } from '../../src/json.ts';
import { acquireWorktreeLock } from '../../src/locks.ts';
import { pidAlive } from '../../src/proc.ts';
import { createRun, launchDecision } from '../../src/runStore.ts';
import { initState, readJsonFile, runDir, worktreeDir } from '../../src/stateStore.ts';
import { createTestEnv, waitUntil, type TestEnv } from '../support/testEnv.ts';

const RACER = path.join(import.meta.dirname, '..', 'fixtures', 'state', 'lockRacer.ts');
const WT_KEY = '0123456789abcdef';
const HOLDER = '20261002120000-1';
const RACERS = 8;
const INIT_ROUNDS = 5;
const FIXED_ENTRIES = ['format', 'runs', 'watchers', 'worktrees'];

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

async function deadPid(env: TestEnv): Promise<number> {
    const pid = env.spawnOrphan('true', []);
    assert.ok(await waitUntil(3000, () => !pidAlive(pid)));
    return pid;
}

function lockDir(stateDir: string): string {
    return path.join(worktreeDir(stateDir, WT_KEY), 'lock');
}

// A lock held by a run whose watcher is dead and whose run directory is gone, so every racer may reclaim it.
async function reclaimableLock(fixture: Fixture): Promise<string> {
    const log = fixture.env.deps({ run: () => Promise.reject(new Error('no commands')) }).log;
    assert.ok(acquireWorktreeLock(fixture.stateDir, WT_KEY, HOLDER, await deadPid(fixture.env), log, 1));
    const token = getString(readJsonFile(path.join(lockDir(fixture.stateDir), 'owner.json')), 'token');
    assert.ok(token !== undefined);
    return token;
}

// Starts every racer before awaiting any, and returns the indexes of the racers that printed 1.
async function race(fixture: Fixture, argsFor: (_index: number) => string[]): Promise<number[]> {
    const observed = Array.from({ length: RACERS }, (_unused, index) =>
        fixture.env.spawnObserved(process.execPath, [RACER, ...argsFor(index)])
    );
    const results = await Promise.all(observed.map((racer) => racer.result));
    for (const result of results) {
        assert.equal(result.code, 0, result.stderr);
        assert.match(result.stdout, /^[01]\n$/u);
    }
    return results.flatMap((result, index) => (result.stdout.trim() === '1' ? [index] : []));
}

function runIdOf(index: number): string {
    return `20261002120100-${index + 10}`;
}

await describe('lock race', async () => {
    await test('eight racers on one reclaimable lock: exactly one wins and owns it', async (t) => {
        const fixture = await newFixture(t);
        await reclaimableLock(fixture);
        const winners = await race(fixture, (index) => [fixture.stateDir, WT_KEY, runIdOf(index), String(process.pid)]);
        assert.equal(winners.length, 1, `winners: ${winners.join(',')}`);
        const owner = readJsonFile(path.join(lockDir(fixture.stateDir), 'owner.json'));
        assert.equal(getString(owner, 'runId'), runIdOf(winners[0] ?? -1));
    });

    await test('eight recoverers after a crashed claimant: exactly one wins', async (t) => {
        const fixture = await newFixture(t);
        const token = await reclaimableLock(fixture);
        const claim = path.join(lockDir(fixture.stateDir), `claim.${token}.0`);
        fs.mkdirSync(claim, { mode: 0o700 });
        fs.writeFileSync(
            path.join(claim, 'claimant.json'),
            JSON.stringify({ pid: await deadPid(fixture.env), token: '1-2-3' })
        );
        const winners = await race(fixture, (index) => [fixture.stateDir, WT_KEY, runIdOf(index), String(process.pid)]);
        assert.equal(winners.length, 1, `winners: ${winners.join(',')}`);
        const owner = readJsonFile(path.join(lockDir(fixture.stateDir), 'owner.json'));
        assert.equal(getString(owner, 'runId'), runIdOf(winners[0] ?? -1));
    });

    await test('eight launch claims alternating go and cancel: exactly one wins and its word stays', async (t) => {
        const fixture = await newFixture(t);
        createRun(fixture.stateDir, HOLDER);
        const words = ['go', 'cancel'];
        const winners = await race(fixture, (index) => [
            '--launch',
            fixture.stateDir,
            HOLDER,
            words[index % 2] ?? 'go',
        ]);
        assert.equal(winners.length, 1, `winners: ${winners.join(',')}`);
        const word = words[(winners[0] ?? 0) % 2];
        const value = fs.readFileSync(path.join(runDir(fixture.stateDir, HOLDER), 'decision.d', 'value'), 'utf8');
        assert.equal(value, word);
        assert.equal(launchDecision(fixture.stateDir, HOLDER), word);
    });
});

// Starts the init racers, releases them together once all wait at the barrier, and returns their results.
async function raceInit(env: TestEnv, stateDir: string, barrierDir: string): Promise<string[]> {
    fs.mkdirSync(barrierDir, { mode: 0o700 });
    const observed = Array.from({ length: RACERS }, () =>
        env.spawnObserved(process.execPath, [RACER, '--init', stateDir, barrierDir])
    );
    assert.ok(await waitUntil(60_000, () => fs.readdirSync(barrierDir).length === RACERS));
    fs.writeFileSync(path.join(barrierDir, 'go'), '');
    const results = await Promise.all(observed.map((racer) => racer.result));
    return results.map((result) => {
        assert.equal(result.code, 0, result.stderr);
        return `${result.stdout.trim()} ${result.stderr.trim()}`.trim();
    });
}

await describe('concurrent state initialisation', async () => {
    await test('eight processes initialising one fresh state directory all succeed', async (t) => {
        const env = await createTestEnv();
        t.after(() => {
            env.cleanup();
        });
        for (let round = 0; round < INIT_ROUNDS; round += 1) {
            const stateDir = path.join(env.root, `fresh-${round}`, 'state');
            const outputs = await raceInit(env, stateDir, path.join(env.root, `barrier-${round}`));
            assert.deepEqual(
                outputs,
                Array.from({ length: RACERS }, () => '1'),
                `round ${round}`
            );
            assert.deepEqual(fs.readdirSync(stateDir).toSorted(), FIXED_ENTRIES);
            assert.equal(fs.readFileSync(path.join(stateDir, 'format'), 'utf8'), '1\n');
            for (const dir of [stateDir, ...FIXED_ENTRIES.slice(1).map((child) => path.join(stateDir, child))]) {
                assert.equal(fs.statSync(dir).mode & 0o777, 0o700, dir);
            }
            assert.ok(initState(stateDir).ok);
        }
    });
});
