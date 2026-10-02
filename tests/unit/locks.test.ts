import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test, type TestContext } from 'node:test';

import { getNumber, getString } from '../../src/json.ts';
import {
    acquirePrLock,
    acquireWorktreeLock,
    adoptWorktreeLock,
    claimLock,
    dropClaims,
    newLockToken,
    readPrLockOwner,
    releasePrLock,
    releaseWorktreeLock,
    worktreeLockHolder,
    worktreeLockReclaimable,
} from '../../src/locks.ts';
import { pidAlive } from '../../src/proc.ts';
import { createRun, launchDecision, writeRecord } from '../../src/runStore.ts';
import { initState, readJsonFile, worktreeDir, watcherDir } from '../../src/stateStore.ts';
import type { PrLockOwner, RunRecord } from '../../src/types.ts';
import { createFakeRunner } from '../support/fakeRunner.ts';
import { createTestEnv, waitUntil, type TestDeps, type TestEnv } from '../support/testEnv.ts';

const PR_KEY = 'o+r+12';
const WT_KEY = '0123456789abcdef';
const RUN_A = '20261002120000-1';
const RUN_B = '20261002120000-2';
const NOW = 1_790_942_400;

interface Fixture {
    env: TestEnv;
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
    return { env, stateDir: result.stateDir, deps: env.deps(createFakeRunner().runner) };
}

function livePid(env: TestEnv): number {
    return env.spawnOrphan('sleep', ['30']);
}

async function deadPid(env: TestEnv): Promise<number> {
    const pid = env.spawnOrphan('true', []);
    assert.ok(await waitUntil(3000, () => !pidAlive(pid)));
    return pid;
}

function prFields(windowId: string): Omit<PrLockOwner, 'pid' | 'token'> {
    return {
        pidStart: 'Fri Oct  2 12:00:00 2026',
        paneId: '%1',
        windowId,
        socket: '/tmp/prwc-test-socket',
        dir: '/path/to/project',
        startedAt: NOW,
    };
}

function prLockDir(stateDir: string): string {
    return path.join(watcherDir(stateDir, PR_KEY), 'lock');
}

function wtLockDir(stateDir: string): string {
    return path.join(worktreeDir(stateDir, WT_KEY), 'lock');
}

function ownerToken(lockDir: string): string {
    const token = getString(readJsonFile(path.join(lockDir, 'owner.json')), 'token');
    assert.ok(token !== undefined);
    return token;
}

function ownerWatcherPid(lockDir: string): number | undefined {
    return getNumber(readJsonFile(path.join(lockDir, 'owner.json')), 'watcherPid');
}

function claimEntries(lockDir: string): string[] {
    return fs.readdirSync(lockDir).filter((name) => name.startsWith('claim.'));
}

function siblings(lockDir: string, marker: string): string[] {
    return fs.readdirSync(path.dirname(lockDir)).filter((name) => name.startsWith(`lock.${marker}.`));
}

function makeClaim(lockDir: string, name: string, claimant?: unknown): void {
    fs.mkdirSync(path.join(lockDir, name), { mode: 0o700 });
    if (claimant !== undefined) {
        fs.writeFileSync(path.join(lockDir, name, 'claimant.json'), JSON.stringify(claimant));
    }
}

function writeWtOwner(stateDir: string, owner: unknown): void {
    const lockDir = wtLockDir(stateDir);
    fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify(owner));
}

function sampleRecord(runId: string, panePid?: number): RunRecord {
    return {
        format: 1,
        runId,
        prKey: PR_KEY,
        owner: 'o',
        repo: 'r',
        number: 12,
        prUrl: 'https://github.com/o/r/pull/12',
        commentNodeId: 'PRRC_1',
        commentDbId: 1,
        commentUrl: 'https://github.com/o/r/pull/12#discussion_r1',
        threadId: 'PRRT_1',
        topDbId: 1,
        rocketAt: NOW,
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
        state: 'running',
        reason: '',
        eyesAdded: true,
        paneId: '%5',
        panePid,
        socket: '/tmp/prwc-test-socket',
        startedAt: NOW,
        watcherPid: 1,
    };
}

function acquireWt(fixture: Fixture, runId: string, watcherPid: number): boolean {
    return acquireWorktreeLock(fixture.stateDir, WT_KEY, runId, watcherPid, fixture.deps.log, NOW);
}

await describe('lock tokens', async () => {
    await test('newLockToken is PID-EPOCH-RANDOM with digits and dashes only and new every time', () => {
        const token = newLockToken(NOW);
        assert.match(token, new RegExp(String.raw`^${process.pid}-${NOW}-\d+$`, 'u'));
        assert.notEqual(newLockToken(NOW), newLockToken(NOW));
    });
});

await describe('PR lock', async () => {
    await test('the first acquire writes the given pid and a live owner holds the lock', async (t) => {
        const fixture = await newFixture(t);
        const owner = livePid(fixture.env);
        assert.deepEqual(acquirePrLock(fixture.stateDir, PR_KEY, prFields('@7'), owner, NOW), { kind: 'acquired' });
        assert.equal(readPrLockOwner(fixture.stateDir, PR_KEY)?.pid, owner);
        assert.equal(readPrLockOwner(fixture.stateDir, PR_KEY)?.windowId, '@7');
        assert.deepEqual(acquirePrLock(fixture.stateDir, PR_KEY, prFields('@9'), process.pid, NOW), {
            kind: 'held',
            pid: owner,
            windowId: '@7',
        });
    });

    await test('a dead owner is reclaimed with a new token and no claim left', async (t) => {
        const fixture = await newFixture(t);
        const dead = await deadPid(fixture.env);
        assert.equal(acquirePrLock(fixture.stateDir, PR_KEY, prFields('@1'), dead, NOW).kind, 'acquired');
        const before = ownerToken(prLockDir(fixture.stateDir));
        assert.equal(acquirePrLock(fixture.stateDir, PR_KEY, prFields('@2'), process.pid, NOW).kind, 'acquired');
        const owner = readPrLockOwner(fixture.stateDir, PR_KEY);
        assert.ok(owner !== undefined);
        assert.equal(owner.pid, process.pid);
        assert.equal(owner.windowId, '@2');
        assert.notEqual(owner.token, before);
        assert.deepEqual(claimEntries(prLockDir(fixture.stateDir)), []);
    });

    await test('a live claimant of the dead owner token keeps the lock held', async (t) => {
        const fixture = await newFixture(t);
        const dead = await deadPid(fixture.env);
        acquirePrLock(fixture.stateDir, PR_KEY, prFields('@1'), dead, NOW);
        const lockDir = prLockDir(fixture.stateDir);
        const token = ownerToken(lockDir);
        makeClaim(lockDir, `claim.${token}.0`, { pid: livePid(fixture.env), token: '1-2-3' });
        assert.deepEqual(acquirePrLock(fixture.stateDir, PR_KEY, prFields('@2'), process.pid, NOW), {
            kind: 'held',
            pid: dead,
            windowId: '@1',
        });
        assert.equal(ownerToken(lockDir), token);
    });

    await test('release by another pid fails and release by the owner succeeds', async (t) => {
        const fixture = await newFixture(t);
        acquirePrLock(fixture.stateDir, PR_KEY, prFields('@1'), process.pid, NOW);
        assert.equal(releasePrLock(fixture.stateDir, PR_KEY, process.pid + 1), false);
        assert.ok(fs.existsSync(prLockDir(fixture.stateDir)));
        assert.equal(releasePrLock(fixture.stateDir, PR_KEY, process.pid), true);
        assert.equal(readPrLockOwner(fixture.stateDir, PR_KEY), undefined);
    });

    await test('an owner file with an empty token is unreadable and reported as held by pid 0', async (t) => {
        const fixture = await newFixture(t);
        const lockDir = prLockDir(fixture.stateDir);
        fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
        fs.writeFileSync(
            path.join(lockDir, 'owner.json'),
            JSON.stringify({ ...prFields('@1'), pid: await deadPid(fixture.env), token: '' })
        );
        assert.equal(readPrLockOwner(fixture.stateDir, PR_KEY), undefined);
        assert.deepEqual(acquirePrLock(fixture.stateDir, PR_KEY, prFields('@2'), process.pid, NOW), {
            kind: 'held',
            pid: 0,
            windowId: '',
        });
    });
});

await describe('crashed claimant', async () => {
    await test('claimLock skips past a dead claimant to the next link of the chain', async (t) => {
        const fixture = await newFixture(t);
        const lockDir = prLockDir(fixture.stateDir);
        fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
        makeClaim(lockDir, 'claim.5-6-7.0', { pid: await deadPid(fixture.env), token: '1-2-3' });
        assert.equal(claimLock(lockDir, '5-6-7', process.pid, NOW), true);
        const claimant = readJsonFile(path.join(lockDir, 'claim.5-6-7.1', 'claimant.json'));
        assert.equal(getNumber(claimant, 'pid'), process.pid);
        assert.match(getString(claimant, 'token') ?? '', new RegExp(String.raw`^${process.pid}-${NOW}-\d+$`, 'u'));
        assert.equal(claimLock(lockDir, '5-6-7', process.pid, NOW), false);
        assert.deepEqual(claimEntries(lockDir).toSorted(), ['claim.5-6-7.0', 'claim.5-6-7.1']);
    });

    await test('the PR lock recovers from a claimant that died before the owner rewrite', async (t) => {
        const fixture = await newFixture(t);
        acquirePrLock(fixture.stateDir, PR_KEY, prFields('@1'), await deadPid(fixture.env), NOW);
        const lockDir = prLockDir(fixture.stateDir);
        const token = ownerToken(lockDir);
        makeClaim(lockDir, `claim.${token}.0`, { pid: await deadPid(fixture.env), token: '1-2-3' });
        assert.equal(acquirePrLock(fixture.stateDir, PR_KEY, prFields('@2'), process.pid, NOW).kind, 'acquired');
        assert.notEqual(ownerToken(lockDir), token);
        assert.equal(readPrLockOwner(fixture.stateDir, PR_KEY)?.pid, process.pid);
        assert.deepEqual(claimEntries(lockDir), []);
    });

    await test('the worktree lock recovers from a claimant that died before the owner rewrite', async (t) => {
        const fixture = await newFixture(t);
        assert.ok(acquireWt(fixture, RUN_A, await deadPid(fixture.env)));
        const lockDir = wtLockDir(fixture.stateDir);
        const token = ownerToken(lockDir);
        makeClaim(lockDir, `claim.${token}.0`, { pid: await deadPid(fixture.env), token: '1-2-3' });
        assert.ok(acquireWt(fixture, RUN_B, process.pid));
        assert.equal(worktreeLockHolder(fixture.stateDir, WT_KEY), RUN_B);
        assert.notEqual(ownerToken(lockDir), token);
        assert.deepEqual(claimEntries(lockDir), []);
    });

    await test('a claim without claimant.json is busy for both lock kinds', async (t) => {
        const fixture = await newFixture(t);
        const dead = await deadPid(fixture.env);
        acquirePrLock(fixture.stateDir, PR_KEY, prFields('@1'), dead, NOW);
        const prDir = prLockDir(fixture.stateDir);
        makeClaim(prDir, `claim.${ownerToken(prDir)}.0`);
        assert.deepEqual(acquirePrLock(fixture.stateDir, PR_KEY, prFields('@2'), process.pid, NOW), {
            kind: 'held',
            pid: dead,
            windowId: '@1',
        });
        assert.ok(acquireWt(fixture, RUN_A, dead));
        const wtDir = wtLockDir(fixture.stateDir);
        makeClaim(wtDir, `claim.${ownerToken(wtDir)}.0`);
        assert.equal(acquireWt(fixture, RUN_B, process.pid), false);
        assert.equal(worktreeLockHolder(fixture.stateDir, WT_KEY), RUN_A);
    });
});

await describe('worktree lock', async () => {
    await test('only the holder releases the lock', async (t) => {
        const fixture = await newFixture(t);
        assert.ok(acquireWt(fixture, RUN_A, process.pid));
        createRun(fixture.stateDir, RUN_A);
        assert.equal(acquireWt(fixture, RUN_B, process.pid), false);
        assert.equal(releaseWorktreeLock(fixture.stateDir, WT_KEY, RUN_B), false);
        assert.equal(worktreeLockHolder(fixture.stateDir, WT_KEY), RUN_A);
        assert.equal(releaseWorktreeLock(fixture.stateDir, WT_KEY, RUN_A), true);
        assert.equal(worktreeLockHolder(fixture.stateDir, WT_KEY), undefined);
    });

    await test('reclaimable only when the watcher and the worker are both dead', async (t) => {
        const fixture = await newFixture(t);
        const { env, stateDir } = fixture;
        const dead = await deadPid(env);
        assert.ok(acquireWt(fixture, RUN_A, dead));
        const runPath = createRun(stateDir, RUN_A);
        writeRecord(stateDir, sampleRecord(RUN_A, dead));

        fs.writeFileSync(path.join(runPath, 'claude.pid'), `${livePid(env)}\n`);
        assert.equal(worktreeLockReclaimable(stateDir, WT_KEY), false, 'live claude.pid');
        fs.rmSync(path.join(runPath, 'claude.pid'));

        writeRecord(stateDir, sampleRecord(RUN_A, livePid(env)));
        assert.equal(worktreeLockReclaimable(stateDir, WT_KEY), false, 'launcher still waiting');
        writeRecord(stateDir, sampleRecord(RUN_A, dead));

        assert.equal(worktreeLockReclaimable(stateDir, WT_KEY), true, 'both dead');
        fs.rmSync(runPath, { recursive: true });
        assert.equal(worktreeLockReclaimable(stateDir, WT_KEY), true, 'both dead, run directory gone');
    });

    await test('not reclaimable while the watcher lives although the worker is dead', async (t) => {
        const fixture = await newFixture(t);
        assert.ok(acquireWt(fixture, RUN_A, livePid(fixture.env)));
        createRun(fixture.stateDir, RUN_A);
        writeRecord(fixture.stateDir, sampleRecord(RUN_A, await deadPid(fixture.env)));
        assert.equal(worktreeLockReclaimable(fixture.stateDir, WT_KEY), false);
    });

    await test('acquire over a reclaimable holder takes the lock and cancels its launch', async (t) => {
        const fixture = await newFixture(t);
        const { stateDir } = fixture;
        assert.ok(acquireWt(fixture, RUN_A, await deadPid(fixture.env)));
        createRun(stateDir, RUN_A);
        const before = ownerToken(wtLockDir(stateDir));
        assert.equal(launchDecision(stateDir, RUN_A), 'none');
        assert.ok(acquireWt(fixture, RUN_B, process.pid));
        assert.equal(worktreeLockHolder(stateDir, WT_KEY), RUN_B);
        assert.notEqual(ownerToken(wtLockDir(stateDir)), before);
        assert.equal(ownerWatcherPid(wtLockDir(stateDir)), process.pid);
        assert.equal(launchDecision(stateDir, RUN_A), 'cancel');
        assert.ok(fixture.deps.logLines.some((line) => line.includes(`reclaimed worktree lock from run ${RUN_A}`)));
    });

    await test('adopt rewrites the watcher pid and the token for the holder only', async (t) => {
        const fixture = await newFixture(t);
        const { stateDir } = fixture;
        const dead = await deadPid(fixture.env);
        assert.ok(acquireWt(fixture, RUN_A, dead));
        const before = ownerToken(wtLockDir(stateDir));
        assert.equal(adoptWorktreeLock(stateDir, WT_KEY, RUN_B, process.pid, NOW), false);
        assert.equal(ownerWatcherPid(wtLockDir(stateDir)), dead);
        assert.equal(adoptWorktreeLock(stateDir, WT_KEY, RUN_A, process.pid, NOW), true);
        assert.equal(ownerWatcherPid(wtLockDir(stateDir)), process.pid);
        assert.notEqual(ownerToken(wtLockDir(stateDir)), before);
        assert.equal(worktreeLockHolder(stateDir, WT_KEY), RUN_A);
        assert.deepEqual(claimEntries(wtLockDir(stateDir)), []);
    });

    await test('a lock acquired before its run exists is never stolen while the watcher lives', async (t) => {
        const fixture = await newFixture(t);
        assert.ok(acquireWt(fixture, RUN_A, process.pid));
        assert.equal(acquireWt(fixture, RUN_B, process.pid), false);
        assert.equal(worktreeLockReclaimable(fixture.stateDir, WT_KEY), false);
        assert.equal(worktreeLockHolder(fixture.stateDir, WT_KEY), RUN_A);
    });

    await test('a lost claim leaves the owner unchanged and blocks the holder release', async (t) => {
        const fixture = await newFixture(t);
        assert.ok(acquireWt(fixture, RUN_A, await deadPid(fixture.env)));
        const lockDir = wtLockDir(fixture.stateDir);
        const ownerText = fs.readFileSync(path.join(lockDir, 'owner.json'), 'utf8');
        makeClaim(lockDir, `claim.${ownerToken(lockDir)}.0`, { pid: livePid(fixture.env), token: '1-2-3' });
        assert.equal(worktreeLockReclaimable(fixture.stateDir, WT_KEY), true);
        assert.equal(acquireWt(fixture, RUN_B, process.pid), false);
        assert.equal(fs.readFileSync(path.join(lockDir, 'owner.json'), 'utf8'), ownerText);
        assert.equal(releaseWorktreeLock(fixture.stateDir, WT_KEY, RUN_A), false);
        assert.equal(worktreeLockHolder(fixture.stateDir, WT_KEY), RUN_A);
    });
});

await describe('atomic acquire', async () => {
    await test('a successful acquire leaves no temp sibling', async (t) => {
        const fixture = await newFixture(t);
        assert.ok(acquireWt(fixture, RUN_A, process.pid));
        assert.deepEqual(siblings(wtLockDir(fixture.stateDir), 'tmp'), []);
        assert.ok(fs.existsSync(path.join(wtLockDir(fixture.stateDir), 'owner.json')));
    });

    await test('a dead temp sibling is removed and does not block', async (t) => {
        const fixture = await newFixture(t);
        const leftover = `${wtLockDir(fixture.stateDir)}.tmp.${await deadPid(fixture.env)}-1-2`;
        fs.mkdirSync(leftover, { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(leftover, 'owner.json'), JSON.stringify({ runId: RUN_B, watcherPid: 1 }));
        assert.ok(acquireWt(fixture, RUN_A, process.pid));
        assert.equal(fs.existsSync(leftover), false);
        assert.equal(worktreeLockHolder(fixture.stateDir, WT_KEY), RUN_A);
    });

    await test('a crash before the rename leaves no holder and the next acquire succeeds', async (t) => {
        const fixture = await newFixture(t);
        const crashed = `${wtLockDir(fixture.stateDir)}.tmp.${process.pid}-1-2`;
        fs.mkdirSync(crashed, { recursive: true, mode: 0o700 });
        fs.writeFileSync(
            path.join(crashed, 'owner.json'),
            JSON.stringify({ runId: RUN_B, watcherPid: process.pid, token: `${process.pid}-1-2` })
        );
        assert.equal(worktreeLockHolder(fixture.stateDir, WT_KEY), undefined);
        assert.ok(acquireWt(fixture, RUN_A, process.pid));
        assert.equal(worktreeLockHolder(fixture.stateDir, WT_KEY), RUN_A);
    });

    await test('a lock without owner.json or with an empty token is busy and never reclaimable', async (t) => {
        const fixture = await newFixture(t);
        const lockDir = wtLockDir(fixture.stateDir);
        fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(lockDir, 'note'), 'tampered');
        assert.equal(acquireWt(fixture, RUN_A, process.pid), false);
        assert.equal(worktreeLockReclaimable(fixture.stateDir, WT_KEY), false);
        fs.rmSync(lockDir, { recursive: true });
        writeWtOwner(fixture.stateDir, { runId: RUN_B, watcherPid: await deadPid(fixture.env), token: '' });
        assert.equal(acquireWt(fixture, RUN_A, process.pid), false);
        assert.equal(worktreeLockReclaimable(fixture.stateDir, WT_KEY), false);
    });

    await test('an empty lock directory is held for both kinds and never replaced', async (t) => {
        const fixture = await newFixture(t);
        const prDir = prLockDir(fixture.stateDir);
        const wtDir = wtLockDir(fixture.stateDir);
        fs.mkdirSync(prDir, { recursive: true, mode: 0o700 });
        fs.mkdirSync(wtDir, { recursive: true, mode: 0o700 });
        assert.deepEqual(acquirePrLock(fixture.stateDir, PR_KEY, prFields('@1'), process.pid, NOW), {
            kind: 'held',
            pid: 0,
            windowId: '',
        });
        assert.equal(acquireWt(fixture, RUN_A, process.pid), false);
        assert.deepEqual(fs.readdirSync(prDir), []);
        assert.deepEqual(fs.readdirSync(wtDir), []);
    });
});

await describe('release by rename', async () => {
    await test('both release kinds leave neither the lock nor a released sibling', async (t) => {
        const fixture = await newFixture(t);
        const { stateDir } = fixture;
        acquirePrLock(stateDir, PR_KEY, prFields('@1'), process.pid, NOW);
        assert.ok(releasePrLock(stateDir, PR_KEY, process.pid));
        assert.equal(fs.existsSync(prLockDir(stateDir)), false);
        assert.deepEqual(siblings(prLockDir(stateDir), 'released'), []);
        assert.equal(acquirePrLock(stateDir, PR_KEY, prFields('@1'), process.pid, NOW).kind, 'acquired');

        assert.ok(acquireWt(fixture, RUN_A, process.pid));
        assert.ok(releaseWorktreeLock(stateDir, WT_KEY, RUN_A));
        assert.equal(fs.existsSync(wtLockDir(stateDir)), false);
        assert.deepEqual(siblings(wtLockDir(stateDir), 'released'), []);
        assert.ok(acquireWt(fixture, RUN_B, process.pid));
    });

    await test('a worktree release whose rename fails once can be retried and frees the lock', async (t) => {
        const fixture = await newFixture(t);
        const { stateDir } = fixture;
        assert.ok(acquireWt(fixture, RUN_A, process.pid));
        const original = fs.renameSync;
        let failures = 0;
        t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
            if (failures === 0 && String(to).includes('.released.')) {
                failures += 1;
                throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
            }
            original(from, to);
        });
        assert.equal(releaseWorktreeLock(stateDir, WT_KEY, RUN_A), false);
        assert.equal(failures, 1);
        assert.equal(worktreeLockHolder(stateDir, WT_KEY), RUN_A);
        assert.ok(releaseWorktreeLock(stateDir, WT_KEY, RUN_A));
        assert.equal(fs.existsSync(wtLockDir(stateDir)), false);
        assert.ok(acquireWt(fixture, RUN_B, process.pid));
    });

    await test('a leftover claim of this process does not block a later release', async (t) => {
        const fixture = await newFixture(t);
        const { stateDir } = fixture;
        assert.ok(acquireWt(fixture, RUN_A, process.pid));
        const lockDir = wtLockDir(stateDir);
        makeClaim(lockDir, `claim.${ownerToken(lockDir)}.0`, { pid: process.pid, token: '1-2-3' });
        assert.ok(releaseWorktreeLock(stateDir, WT_KEY, RUN_A));
        assert.equal(fs.existsSync(lockDir), false);
        assert.ok(acquireWt(fixture, RUN_B, process.pid));
    });
});

await describe('vanished lock', async () => {
    await test('a lock released between the failed acquire and the owner read is retried once', async (t) => {
        const fixture = await newFixture(t);
        const owner = livePid(fixture.env);
        acquirePrLock(fixture.stateDir, PR_KEY, prFields('@1'), owner, NOW);
        let calls = 0;
        const result = acquirePrLock(fixture.stateDir, PR_KEY, prFields('@2'), process.pid, NOW, {
            afterAcquireFailed: () => {
                calls += 1;
                fs.rmSync(prLockDir(fixture.stateDir), { recursive: true, force: true });
            },
        });
        assert.deepEqual(result, { kind: 'acquired' });
        assert.equal(calls, 1);
        assert.equal(readPrLockOwner(fixture.stateDir, PR_KEY)?.pid, process.pid);
    });

    await test('a seam that does nothing leaves the live owner holding the lock', async (t) => {
        const fixture = await newFixture(t);
        const owner = livePid(fixture.env);
        acquirePrLock(fixture.stateDir, PR_KEY, prFields('@1'), owner, NOW);
        let calls = 0;
        const result = acquirePrLock(fixture.stateDir, PR_KEY, prFields('@2'), process.pid, NOW, {
            afterAcquireFailed: () => {
                calls += 1;
            },
        });
        assert.deepEqual(result, { kind: 'held', pid: owner, windowId: '@1' });
        assert.equal(calls, 1);
    });
});

await describe('claim hygiene', async () => {
    await test('dropClaims removes the chain and only dead temp leftovers', async (t) => {
        const fixture = await newFixture(t);
        const lockDir = prLockDir(fixture.stateDir);
        fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
        const deadTemp = `claim.5-6-7.0.tmp.${await deadPid(fixture.env)}-1-2`;
        const liveTemp = `claim.5-6-7.0.tmp.${livePid(fixture.env)}-1-2`;
        makeClaim(lockDir, 'claim.5-6-7.0', { pid: 1, token: '1-2-3' });
        makeClaim(lockDir, 'claim.5-6-7.1', { pid: 1, token: '1-2-3' });
        makeClaim(lockDir, 'claim.8-8-8.0', { pid: process.pid, token: '1-2-3' });
        makeClaim(lockDir, deadTemp, { pid: 1, token: '1-2-3' });
        makeClaim(lockDir, liveTemp, { pid: 1, token: '1-2-3' });
        dropClaims(lockDir, '5-6-7');
        assert.deepEqual(claimEntries(lockDir).toSorted(), ['claim.8-8-8.0', liveTemp].toSorted());
    });

    await test('claimLock on a lock directory removed before the call returns false', async (t) => {
        const fixture = await newFixture(t);
        const lockDir = prLockDir(fixture.stateDir);
        assert.equal(claimLock(lockDir, '5-6-7', process.pid, NOW), false);
    });

    await test('claimLock whose lock directory is removed right before the claim rename returns false', async (t) => {
        const fixture = await newFixture(t);
        const lockDir = prLockDir(fixture.stateDir);
        fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
        let calls = 0;
        const claimed = claimLock(lockDir, '5-6-7', process.pid, NOW, {
            beforeClaimRename: () => {
                calls += 1;
                fs.rmSync(lockDir, { recursive: true, force: true });
            },
        });
        assert.equal(claimed, false);
        assert.equal(calls, 1);
        assert.equal(fs.existsSync(lockDir), false);
    });

    await test('claimLock whose lock directory is released right before the claim rename returns false', async (t) => {
        const fixture = await newFixture(t);
        const lockDir = prLockDir(fixture.stateDir);
        const released = `${lockDir}.released.5-6-7`;
        fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
        let calls = 0;
        const claimed = claimLock(lockDir, '5-6-7', process.pid, NOW, {
            beforeClaimRename: () => {
                calls += 1;
                fs.renameSync(lockDir, released);
            },
        });
        assert.equal(claimed, false);
        assert.equal(calls, 1);
        assert.equal(fs.existsSync(lockDir), false);
        assert.equal(fs.existsSync(path.join(released, 'claim.5-6-7.0')), false);
    });
});
