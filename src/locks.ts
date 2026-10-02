import { randomInt } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { getNumber, getString } from './json.ts';
import { pidAlive } from './proc.ts';
import { claimLaunch, workerAlive } from './runStore.ts';
import { createFieldReader, readJsonFile, watcherDir, worktreeDir, writeJsonAtomic } from './stateStore.ts';
import type { Logger, PrLockOwner, WorktreeLockOwner } from './types.ts';

export type PrLockFields = Omit<PrLockOwner, 'pid' | 'token'>;

export type PrLockAcquire = { kind: 'acquired' } | { kind: 'held'; pid: number; windowId: string };

export interface PrLockHooks {
    afterAcquireFailed?(): void;
}

export interface ClaimHooks {
    beforeClaimRename?(): void;
}

const LOCK_NAME = 'lock';
const OWNER_FILE = 'owner.json';
const CLAIMANT_FILE = 'claimant.json';
const TOKEN = /^\d[\d-]*$/u;
const CHAIN_INDEX = /^\d+$/u;
const RUN_ID = /^[\w-]+$/u;
const CLAIM_TEMP = /^claim\.[^.]+\.\d+\.tmp\.(?<pid>\d+)-[\d-]*$/u;
const TOKEN_RANDOM_LIMIT = 1_000_000_000;

function isToken(value: string | undefined): value is string {
    return value !== undefined && TOKEN.test(value);
}

function tokenPid(token: string): number | undefined {
    const pid = Number.parseInt(token.split('-', 1)[0] ?? '', 10);
    return Number.isInteger(pid) ? pid : undefined;
}

function epochNow(): number {
    return Math.floor(Date.now() / 1000);
}

function entryExists(file: string): boolean {
    try {
        fs.lstatSync(file);
        return true;
    } catch {
        return false;
    }
}

function readNames(dir: string): string[] | undefined {
    try {
        return fs.readdirSync(dir);
    } catch {
        return;
    }
}

function removeTree(dir: string): void {
    fs.rmSync(dir, { recursive: true, force: true });
}

export function newLockToken(nowSeconds: number): string {
    return `${process.pid}-${nowSeconds}-${randomInt(TOKEN_RANDOM_LIMIT)}`;
}

// Builds temp as a private directory holding file, then renames it to target. An existing target, even an empty
// directory that renameSync would silently replace, counts as taken; so does a rename that fails because the parent
// vanished meanwhile (ENOENT).
function renameIntoPlace(
    temp: string,
    file: string,
    value: unknown,
    target: string,
    beforeRename?: () => void
): boolean {
    try {
        fs.mkdirSync(temp, { mode: 0o700 });
        fs.writeFileSync(path.join(temp, file), `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
    } catch {
        removeTree(temp);
        return false;
    }
    if (entryExists(target)) {
        removeTree(temp);
        return false;
    }
    beforeRename?.();
    try {
        fs.renameSync(temp, target);
        return true;
    } catch {
        removeTree(temp);
        return false;
    }
}

function highestClaimIndex(names: readonly string[], token: string): number {
    const prefix = `claim.${token}.`;
    let highest = -1;
    for (const name of names) {
        const index = name.slice(prefix.length);
        if (name.startsWith(prefix) && CHAIN_INDEX.test(index)) {
            highest = Math.max(highest, Number.parseInt(index, 10));
        }
    }
    return highest;
}

// A claimant that cannot be identified is treated as alive, so the chain stays blocked rather than doubly claimed.
function claimantDead(claimDir: string): boolean {
    const pid = getNumber(readJsonFile(path.join(claimDir, CLAIMANT_FILE)), 'pid');
    return pid !== undefined && !pidAlive(pid);
}

function takeClaim(
    lockDir: string,
    token: string,
    selfPid: number,
    nowSeconds: number,
    hooks?: ClaimHooks
): string | undefined {
    if (!isToken(token)) {
        return;
    }
    const names = readNames(lockDir);
    if (names === undefined) {
        return;
    }
    const highest = highestClaimIndex(names, token);
    if (highest >= 0 && !claimantDead(path.join(lockDir, `claim.${token}.${highest}`))) {
        return;
    }
    const target = path.join(lockDir, `claim.${token}.${highest + 1}`);
    const ownToken = newLockToken(nowSeconds);
    const claimant = { pid: selfPid, token: ownToken };
    const temp = `${target}.tmp.${ownToken}`;
    const renamed = renameIntoPlace(temp, CLAIMANT_FILE, claimant, target, () => {
        hooks?.beforeClaimRename?.();
    });
    return renamed ? target : undefined;
}

// The claim-chain step shared by every reclaim, adopt and release: true when this process won the next free link of
// the chain for token. hooks.beforeClaimRename is a test seam called after the claim was built and before its rename.
export function claimLock(
    lockDir: string,
    token: string,
    selfPid: number,
    nowSeconds: number,
    hooks?: ClaimHooks
): boolean {
    return takeClaim(lockDir, token, selfPid, nowSeconds, hooks) !== undefined;
}

function isChainEntry(name: string, token: string): boolean {
    const prefix = `claim.${token}.`;
    return name.startsWith(prefix) && CHAIN_INDEX.test(name.slice(prefix.length));
}

function isDeadClaimTemp(name: string): boolean {
    const pid = CLAIM_TEMP.exec(name)?.groups?.pid;
    return pid !== undefined && !pidAlive(Number.parseInt(pid, 10));
}

// Removes the chain of a replaced token and claim temp leftovers whose builder is dead (a live one may still be
// between building and renaming its claim).
export function dropClaims(lockDir: string, token: string): void {
    for (const name of readNames(lockDir) ?? []) {
        if (isChainEntry(name, token) || isDeadClaimTemp(name)) {
            removeTree(path.join(lockDir, name));
        }
    }
}

function ownerTokenAt(lockDir: string): string | undefined {
    return getString(readJsonFile(path.join(lockDir, OWNER_FILE)), 'token');
}

// Claims readToken, re-reads the owner and runs change only while that token is still current. A claim on a token
// that was replaced meanwhile is removed again: nobody can act on a stale token anyway.
function changeLock(
    lockDir: string,
    readToken: string,
    claimantPid: number,
    nowSeconds: number,
    change: () => boolean
): boolean {
    const claim = takeClaim(lockDir, readToken, claimantPid, nowSeconds);
    if (claim === undefined) {
        return false;
    }
    if (ownerTokenAt(lockDir) !== readToken) {
        removeTree(claim);
        return false;
    }
    return change();
}

function replaceOwner(lockDir: string, owner: PrLockOwner | WorktreeLockOwner, oldToken: string): boolean {
    writeJsonAtomic(path.join(lockDir, OWNER_FILE), owner);
    dropClaims(lockDir, oldToken);
    return true;
}

// Renames first, so a concurrent acquire sees the old lock or no lock, never a half-removed one.
function releaseLockDir(lockDir: string, token: string): boolean {
    const released = `${lockDir}.released.${token}`;
    try {
        fs.renameSync(lockDir, released);
    } catch {
        return false;
    }
    removeTree(released);
    return true;
}

function removeDeadTemps(lockDir: string): void {
    const prefix = `${path.basename(lockDir)}.tmp.`;
    for (const name of readNames(path.dirname(lockDir)) ?? []) {
        const pid = name.startsWith(prefix) ? tokenPid(name.slice(prefix.length)) : undefined;
        if (pid !== undefined && !pidAlive(pid)) {
            removeTree(path.join(path.dirname(lockDir), name));
        }
    }
}

// The atomic acquire of both lock kinds: the owner file is built in LOCKDIR.tmp.TOKEN and renamed into place.
function acquireLockDir(lockDir: string, owner: PrLockOwner | WorktreeLockOwner): boolean {
    fs.mkdirSync(path.dirname(lockDir), { recursive: true, mode: 0o700 });
    removeDeadTemps(lockDir);
    return renameIntoPlace(`${lockDir}.tmp.${owner.token}`, OWNER_FILE, owner, lockDir);
}

function prLockDir(stateDir: string, prKey: string): string {
    return path.join(watcherDir(stateDir, prKey), LOCK_NAME);
}

function worktreeLockDir(stateDir: string, wtKey: string): string {
    return path.join(worktreeDir(stateDir, wtKey), LOCK_NAME);
}

function readPrOwnerAt(lockDir: string): PrLockOwner | undefined {
    const value = readJsonFile(path.join(lockDir, OWNER_FILE));
    const token = getString(value, 'token');
    if (!isToken(token)) {
        return;
    }
    const read = createFieldReader(value);
    const owner: PrLockOwner = {
        pid: read.integer('pid'),
        pidStart: read.text('pidStart'),
        token,
        paneId: read.text('paneId'),
        windowId: read.text('windowId'),
        socket: read.text('socket'),
        dir: read.text('dir'),
        startedAt: read.integer('startedAt'),
    };
    return read.failed() ? undefined : owner;
}

function readWorktreeOwnerAt(lockDir: string): WorktreeLockOwner | undefined {
    const value = readJsonFile(path.join(lockDir, OWNER_FILE));
    const token = getString(value, 'token');
    const runId = getString(value, 'runId');
    const watcherPid = getNumber(value, 'watcherPid');
    if (!isToken(token) || runId === undefined || !RUN_ID.test(runId) || watcherPid === undefined) {
        return;
    }
    return { runId, watcherPid, token };
}

export function readPrLockOwner(stateDir: string, prKey: string): PrLockOwner | undefined {
    return readPrOwnerAt(prLockDir(stateDir, prKey));
}

function heldBy(owner: PrLockOwner | undefined): PrLockAcquire {
    return { kind: 'held', pid: owner?.pid ?? 0, windowId: owner?.windowId ?? '' };
}

function reclaimPrLock(lockDir: string, fields: PrLockFields, selfPid: number, nowSeconds: number): PrLockAcquire {
    const current = readPrOwnerAt(lockDir);
    if (current === undefined || pidAlive(current.pid)) {
        return heldBy(current);
    }
    const owner: PrLockOwner = { ...fields, pid: selfPid, token: newLockToken(nowSeconds) };
    const reclaimed = changeLock(lockDir, current.token, selfPid, nowSeconds, () =>
        replaceOwner(lockDir, owner, current.token)
    );
    return reclaimed ? { kind: 'acquired' } : heldBy(readPrOwnerAt(lockDir));
}

function tryAcquirePrLock(
    lockDir: string,
    fields: PrLockFields,
    selfPid: number,
    nowSeconds: number,
    hooks: PrLockHooks | undefined,
    retried: boolean
): PrLockAcquire {
    if (acquireLockDir(lockDir, { ...fields, pid: selfPid, token: newLockToken(nowSeconds) })) {
        return { kind: 'acquired' };
    }
    hooks?.afterAcquireFailed?.();
    if (!retried && !entryExists(lockDir)) {
        return tryAcquirePrLock(lockDir, fields, selfPid, nowSeconds, hooks, true);
    }
    return reclaimPrLock(lockDir, fields, selfPid, nowSeconds);
}

// A lock that vanished between the failed acquire and the owner read (released in between) is retried once.
export function acquirePrLock(
    stateDir: string,
    prKey: string,
    fields: PrLockFields,
    selfPid: number,
    nowSeconds: number,
    hooks?: PrLockHooks
): PrLockAcquire {
    return tryAcquirePrLock(prLockDir(stateDir, prKey), fields, selfPid, nowSeconds, hooks, false);
}

export function releasePrLock(stateDir: string, prKey: string, selfPid: number): boolean {
    const lockDir = prLockDir(stateDir, prKey);
    const owner = readPrOwnerAt(lockDir);
    if (owner?.pid !== selfPid) {
        return false;
    }
    return changeLock(lockDir, owner.token, selfPid, epochNow(), () => releaseLockDir(lockDir, owner.token));
}

function ownerReclaimable(stateDir: string, owner: WorktreeLockOwner | undefined): boolean {
    return owner !== undefined && !pidAlive(owner.watcherPid) && !workerAlive(stateDir, owner.runId);
}

// Takes a free lock, or reclaims one whose watcher and worker are both gone; a run directory that does not exist
// yet never makes a lock reclaimable, so the gap between acquire and run creation cannot be stolen.
export function acquireWorktreeLock(
    stateDir: string,
    wtKey: string,
    runId: string,
    watcherPid: number,
    log: Logger,
    nowSeconds: number
): boolean {
    const lockDir = worktreeLockDir(stateDir, wtKey);
    if (acquireLockDir(lockDir, { runId, watcherPid, token: newLockToken(nowSeconds) })) {
        return true;
    }
    const current = readWorktreeOwnerAt(lockDir);
    if (current === undefined || !ownerReclaimable(stateDir, current)) {
        return false;
    }
    return changeLock(lockDir, current.token, process.pid, nowSeconds, () => {
        log.info(`reclaimed worktree lock from run ${current.runId}`);
        claimLaunch(stateDir, current.runId, 'cancel');
        return replaceOwner(lockDir, { runId, watcherPid, token: newLockToken(nowSeconds) }, current.token);
    });
}

export function releaseWorktreeLock(stateDir: string, wtKey: string, runId: string): boolean {
    const lockDir = worktreeLockDir(stateDir, wtKey);
    const owner = readWorktreeOwnerAt(lockDir);
    if (owner?.runId !== runId) {
        return false;
    }
    return changeLock(lockDir, owner.token, process.pid, epochNow(), () => releaseLockDir(lockDir, owner.token));
}

export function worktreeLockHolder(stateDir: string, wtKey: string): string | undefined {
    return readWorktreeOwnerAt(worktreeLockDir(stateDir, wtKey))?.runId;
}

export function worktreeLockReclaimable(stateDir: string, wtKey: string): boolean {
    return ownerReclaimable(stateDir, readWorktreeOwnerAt(worktreeLockDir(stateDir, wtKey)));
}

export function adoptWorktreeLock(
    stateDir: string,
    wtKey: string,
    runId: string,
    watcherPid: number,
    nowSeconds: number
): boolean {
    const lockDir = worktreeLockDir(stateDir, wtKey);
    const owner = readWorktreeOwnerAt(lockDir);
    if (owner?.runId !== runId) {
        return false;
    }
    const adopted: WorktreeLockOwner = { runId, watcherPid, token: newLockToken(nowSeconds) };
    return changeLock(lockDir, owner.token, process.pid, nowSeconds, () => replaceOwner(lockDir, adopted, owner.token));
}
