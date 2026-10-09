import fs from 'node:fs';
import path from 'node:path';

import { ghJson, sessionGh, type GhCli } from './gh.ts';
import { fetchReactionTime, lookupComments, type LookupOutcome } from './githubLookup.ts';
import { getNumber, getString, isRecord } from './json.ts';
import { readJsonFile, watcherDir, writeJsonAtomic } from './stateStore.ts';
import type { Deps, GhFailure, LookupEntry, PrRef, RateInfo, RunComment, Session } from './types.ts';

type ApprovalDeps = Pick<Deps, 'runner' | 'nowSeconds'>;

type PermissionOutcome = { kind: 'ok'; allowed: boolean } | GhFailure;
type ApprovalOutcome = { kind: 'ok'; entry: LookupEntry; rate: RateInfo | undefined } | GhFailure;

interface CachedPermission {
    allowed: boolean;
    at: number;
}

const PUSH_ROLES: ReadonlySet<string> = new Set(['admin', 'maintain', 'write']);
// Long enough to keep the per-tick cost at zero, short enough that revoked access stops counting soon.
const PERMISSION_TTL = 600;
// GitHub logins, plus the underscore of Enterprise managed users; a bot login like name[bot] never matches.
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,38}$/u;
const NOT_FOUND = 'HTTP 404';
const CONSUMED_FILE = 'consumed.json';

const permissionCache = new Map<string, CachedPermission>();

export function clearPermissionCache(): void {
    permissionCache.clear();
}

// The approval floor of every comment of a run in flight: an older rocket of another user is the one the run consumed.
export function approvalFloors(comments: readonly RunComment[]): Map<string, number> {
    return new Map(comments.map((comment) => [comment.nodeId, comment.rocketAt]));
}

function consumedFile(stateDir: string, prKey: string): string {
    return path.join(watcherDir(stateDir, prKey), CONSUMED_FILE);
}

// The approval time every comment of the PR was last dispatched with, by node id. An unreadable file reads as empty:
// the +1 and -1 of the viewer still consume every rocket of a run that ended normally.
export function readConsumed(stateDir: string, prKey: string): Map<string, number> {
    const value = readJsonFile(consumedFile(stateDir, prKey));
    const consumed = new Map<string, number>();
    if (!isRecord(value)) {
        return consumed;
    }
    for (const nodeId of Object.keys(value)) {
        const at = getNumber(value, nodeId);
        if (at !== undefined) {
            consumed.set(nodeId, at);
        }
    }
    return consumed;
}

// Written when a run is created, before any reaction changes: a rocket of another user cannot be removed, so this
// record, not the +1 or -1 that may fail to be placed later, is what keeps the comment from running twice.
export function recordConsumed(stateDir: string, prKey: string, comments: readonly RunComment[]): void {
    const consumed = readConsumed(stateDir, prKey);
    for (const comment of comments) {
        consumed.set(comment.nodeId, Math.max(consumed.get(comment.nodeId) ?? 0, comment.rocketAt));
    }
    fs.mkdirSync(watcherDir(stateDir, prKey), { recursive: true, mode: 0o700 });
    writeJsonAtomic(consumedFile(stateDir, prKey), Object.fromEntries(consumed));
}

// Push access to the PR's base repository, cached per login. A 404 (no such user, or no access) is a definite no;
// any other failure is returned, so an approval is never decided on a guess.
async function canPush(deps: ApprovalDeps, gh: GhCli, pr: PrRef, login: string): Promise<PermissionOutcome> {
    if (!LOGIN.test(login)) {
        return { kind: 'ok', allowed: false };
    }
    const key = `${pr.host}/${pr.owner}/${pr.repo}/${login.toLowerCase()}`;
    const now = deps.nowSeconds();
    const cached = permissionCache.get(key);
    if (cached !== undefined && now - cached.at < PERMISSION_TTL) {
        return { kind: 'ok', allowed: cached.allowed };
    }
    const endpoint = `repos/${pr.owner}/${pr.repo}/collaborators/${login}/permission`;
    const result = await ghJson(deps, gh, ['api', endpoint, '--hostname', gh.host]);
    let allowed: boolean;
    if (result.kind === 'ok') {
        const role = getString(result.data, 'role_name')?.toLowerCase() ?? '';
        const permission = getString(result.data, 'permission')?.toLowerCase() ?? '';
        allowed = PUSH_ROLES.has(role) || PUSH_ROLES.has(permission);
    } else if (result.kind === 'transient' && result.message.includes(NOT_FOUND)) {
        allowed = false;
    } else {
        return result.kind === 'gone' ? { kind: 'transient', message: result.message } : result;
    }
    permissionCache.set(key, { allowed, at: now });
    return { kind: 'ok', allowed };
}

function newest(...times: (number | undefined)[]): number | undefined {
    const defined = times.filter((time) => time !== undefined);
    return defined.length === 0 ? undefined : Math.max(...defined);
}

// The newest rocket of another user with push access that is newer than everything that consumed earlier rockets:
// the floor (a run in flight, or the consumed record of an earlier dispatch), the viewer's +1 and the viewer's -1. A -1 the
// reaction groups report but the reaction list does not show leaves no rocket counted.
async function resolveEntry(
    deps: ApprovalDeps,
    session: Session,
    entry: LookupEntry,
    floor: number | undefined
): Promise<ApprovalOutcome> {
    const gh = sessionGh(session);
    const baseline = newest(floor, entry.plus1At);
    let fresh = entry.rockets.filter((rocket) => baseline === undefined || rocket.at > baseline);
    let rate: RateInfo | undefined;
    if (fresh.length > 0 && entry.minus1) {
        const minus = await fetchReactionTime(deps, gh, entry.nodeId, 'THUMBS_DOWN', undefined, session.viewer);
        if (minus.kind !== 'ok') {
            return minus;
        }
        rate = minus.rate;
        const minusAt = minus.at;
        fresh = minusAt === undefined ? [] : fresh.filter((rocket) => rocket.at > minusAt);
    }
    for (const rocket of fresh.toSorted((a, b) => b.at - a.at)) {
        const permission = await canPush(deps, gh, session.pr, rocket.login);
        if (permission.kind !== 'ok') {
            return rate === undefined ? permission : { ...permission, rate };
        }
        if (permission.allowed) {
            const rocketAt = newest(entry.viewerRocketAt, rocket.at);
            return { kind: 'ok', entry: { ...entry, othersRocketAt: rocket.at, rocketAt }, rate };
        }
    }
    return { kind: 'ok', entry, rate };
}

// lookupComments plus the rockets of other users with push access. floors holds the approval time of every comment of
// a run in flight (approvalFloors); the consumed record of the PR is applied on top.
export async function lookupApproved(
    deps: ApprovalDeps,
    session: Session,
    ids: readonly string[],
    floors: ReadonlyMap<string, number> = new Map()
): Promise<LookupOutcome> {
    const looked = await lookupComments(deps, sessionGh(session), ids);
    if (looked.kind !== 'ok') {
        return looked;
    }
    let { rate } = looked.result;
    const consumed = readConsumed(session.stateDir, session.pr.prKey);
    const entries: LookupEntry[] = [];
    for (const entry of looked.result.entries) {
        const floor = newest(floors.get(entry.nodeId), consumed.get(entry.nodeId));
        const resolved = await resolveEntry(deps, session, entry, floor);
        if (resolved.kind !== 'ok') {
            return resolved.rate === undefined ? { ...resolved, rate } : resolved;
        }
        rate = resolved.rate ?? rate;
        entries.push(resolved.entry);
    }
    return { kind: 'ok', result: { ...looked.result, rate, entries } };
}
