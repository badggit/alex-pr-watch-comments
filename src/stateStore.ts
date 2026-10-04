import { createHash, randomInt } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ENV_NAMES, STATE_FORMAT } from './constants.ts';
import { getArray, getBoolean, getNumber, getPath, getString, parseJson } from './json.ts';
import type { Env } from './types.ts';
import { isSafeRunPath } from './validate.ts';

export type InitStateResult =
    | { ok: true; stateDir: string }
    | { ok: false; kind: 'format'; found: string }
    | { ok: false; kind: 'unsafe'; reason: string };

// Typed field access on parsed JSON: a missing or mistyped field returns a placeholder and marks the read failed,
// so a reader builds its object in one expression and then checks failed() once.
export interface FieldReader {
    text(_key: string): string;
    integer(_key: string): number;
    flag(_key: string): boolean;
    texts(_key: string): string[];
    optionalNumber(_key: string): number | undefined;
    failed(): boolean;
}

interface Violation {
    problem: string;
    hint: string;
}

const FIXED_CHILDREN: readonly string[] = ['watchers', 'worktrees', 'runs'];
const FORMAT_FILE = 'format';
const GROUP_OTHER_WRITE = 0o022;
const GROUP_OTHER_ANY = 0o077;
const STICKY = 0o1000;
const KEY_LENGTH = 16;
const TEMP_RANDOM_LIMIT = 1_000_000_000;
const OWNER_ONLY_HINT = `set ${ENV_NAMES.stateDir} to an owner-only directory`;

export function resolveStateDir(env: Env, cwd: string): string {
    const configured = env[ENV_NAMES.stateDir];
    if (configured !== undefined && configured.length > 0) {
        return path.resolve(cwd, configured);
    }
    const home = env.HOME !== undefined && env.HOME.length > 0 ? env.HOME : os.homedir();
    return path.join(home, '.local', 'state', 'alex-pr-watch-comments');
}

export function watcherDir(stateDir: string, prKey: string): string {
    return path.join(stateDir, 'watchers', prKey);
}

export function worktreeDir(stateDir: string, wtKey: string): string {
    return path.join(stateDir, 'worktrees', wtKey);
}

export function runDir(stateDir: string, runId: string): string {
    return path.join(stateDir, 'runs', runId);
}

export function worktreeKey(canonToplevel: string): string {
    return createHash('sha256').update(canonToplevel).digest('hex').slice(0, KEY_LENGTH);
}

// A unique name next to file, for building content that is then renamed or linked into place.
export function tempSiblingPath(file: string): string {
    return `${file}.tmp.${process.pid}-${randomInt(TEMP_RANDOM_LIMIT)}`;
}

export function writeTextAtomic(file: string, text: string): void {
    const temp = tempSiblingPath(file);
    try {
        fs.writeFileSync(temp, text, { mode: 0o600, flag: 'wx' });
        fs.renameSync(temp, file);
    } catch (error) {
        fs.rmSync(temp, { force: true });
        throw error;
    }
}

export function writeJsonAtomic(file: string, value: unknown): void {
    writeTextAtomic(file, `${JSON.stringify(value)}\n`);
}

export function readTextFile(file: string): string | undefined {
    try {
        return fs.readFileSync(file, 'utf8');
    } catch {
        return;
    }
}

export function readJsonFile(file: string): unknown {
    const text = readTextFile(file);
    return text === undefined ? undefined : parseJson(text);
}

export function readStateFormat(stateDir: string): string | undefined {
    return readTextFile(path.join(stateDir, FORMAT_FILE))?.trim();
}

export function createFieldReader(value: unknown): FieldReader {
    let failed = false;
    const fail = (): void => {
        failed = true;
    };
    return {
        text: (key) => {
            const item = getString(value, key);
            if (item === undefined) {
                fail();
            }
            return item ?? '';
        },
        integer: (key) => {
            const item = getNumber(value, key);
            if (item === undefined || !Number.isInteger(item)) {
                fail();
            }
            return item ?? 0;
        },
        flag: (key) => {
            const item = getBoolean(value, key);
            if (item === undefined) {
                fail();
            }
            return item ?? false;
        },
        texts: (key) => {
            const items = getArray(value, key);
            const strings = items?.filter((item) => typeof item === 'string') ?? [];
            if (items?.length !== strings.length) {
                fail();
            }
            return strings;
        },
        optionalNumber: (key) => {
            if (getPath(value, key) === undefined) {
                return;
            }
            const item = getNumber(value, key);
            if (item === undefined || !Number.isInteger(item)) {
                fail();
            }
            return item;
        },
        failed: () => failed,
    };
}

function lstatOrUndefined(file: string): fs.Stats | undefined {
    try {
        return fs.lstatSync(file);
    } catch {
        return;
    }
}

function realpathOrUndefined(file: string): string | undefined {
    try {
        return fs.realpathSync.native(file);
    } catch {
        return;
    }
}

function currentUid(): number {
    return process.getuid?.() ?? -1;
}

function modeText(mode: number): string {
    return (mode & 0o7777).toString(8);
}

function unsafeResult(violation: Violation): InitStateResult {
    return { ok: false, kind: 'unsafe', reason: `unsafe state directory: ${violation.problem}; ${violation.hint}` };
}

// Proper ancestors of an absolute path, from the root down.
function ancestorsOf(dir: string): string[] {
    const ancestors: string[] = [];
    let current = dir;
    let parent = path.dirname(current);
    while (parent !== current) {
        ancestors.push(parent);
        current = parent;
        parent = path.dirname(current);
    }
    return ancestors.toReversed();
}

function deepestExisting(dir: string): string {
    let current = dir;
    while (lstatOrUndefined(current) === undefined) {
        const parent = path.dirname(current);
        if (parent === current) {
            return current;
        }
        current = parent;
    }
    return current;
}

function ancestorViolation(dir: string, uid: number): Violation | undefined {
    const stats = lstatOrUndefined(dir);
    if (stats === undefined) {
        return { problem: `${dir} cannot be read`, hint: `fix its permissions, or ${OWNER_ONLY_HINT}` };
    }
    if (stats.uid !== 0 && stats.uid !== uid) {
        return { problem: `${dir} is owned by uid ${stats.uid}`, hint: OWNER_ONLY_HINT };
    }
    if ((stats.mode & GROUP_OTHER_WRITE) !== 0 && (stats.mode & STICKY) === 0) {
        return {
            problem: `${dir} is writable by group or others (mode ${modeText(stats.mode)})`,
            hint: `fix with chmod go-w ${dir}, or ${OWNER_ONLY_HINT}`,
        };
    }
    return;
}

function ownedDirViolation(dir: string, uid: number): Violation | undefined {
    const stats = lstatOrUndefined(dir);
    if (stats === undefined) {
        return { problem: `${dir} is missing`, hint: OWNER_ONLY_HINT };
    }
    if (stats.isSymbolicLink()) {
        return { problem: `${dir} is a symlink`, hint: OWNER_ONLY_HINT };
    }
    if (!stats.isDirectory()) {
        return { problem: `${dir} is not a directory`, hint: OWNER_ONLY_HINT };
    }
    if (stats.uid !== uid) {
        return { problem: `${dir} is owned by uid ${stats.uid}, expected ${uid}`, hint: OWNER_ONLY_HINT };
    }
    if ((stats.mode & GROUP_OTHER_ANY) !== 0) {
        return {
            problem: `${dir} has mode ${modeText(stats.mode)}, expected 700`,
            hint: `fix with chmod 700 ${dir}, or ${OWNER_ONLY_HINT}`,
        };
    }
    return;
}

function firstViolation(
    dirs: readonly string[],
    check: (_dir: string) => Violation | undefined
): Violation | undefined {
    for (const dir of dirs) {
        const violation = check(dir);
        if (violation !== undefined) {
            return violation;
        }
    }
    return;
}

function pathViolation(canonical: string): Violation | undefined {
    if (isSafeRunPath(canonical)) {
        return;
    }
    return {
        problem: `${canonical} has a character outside A-Za-z0-9_./+-`,
        hint: `set ${ENV_NAMES.stateDir} to a path without spaces`,
    };
}

// Checks everything above the state directory before anything is created, using the canonical path the state
// directory will have once its missing parts exist.
function preCreateViolation(absolute: string, uid: number): Violation | undefined {
    const existing = deepestExisting(absolute);
    const canonExisting = realpathOrUndefined(existing);
    if (canonExisting === undefined) {
        return { problem: `${existing} cannot be resolved`, hint: OWNER_ONLY_HINT };
    }
    const checked = existing === absolute ? ancestorsOf(canonExisting) : [...ancestorsOf(canonExisting), canonExisting];
    const expected = path.join(canonExisting, path.relative(existing, absolute));
    return firstViolation(checked, (dir) => ancestorViolation(dir, uid)) ?? pathViolation(expected);
}

function canonicalViolation(canonical: string, uid: number): Violation | undefined {
    return (
        firstViolation(ancestorsOf(canonical), (dir) => ancestorViolation(dir, uid)) ??
        pathViolation(canonical) ??
        ownedDirViolation(canonical, uid)
    );
}

function existingChildViolation(canonical: string, uid: number): Violation | undefined {
    const existing = FIXED_CHILDREN.map((child) => path.join(canonical, child)).filter(
        (child) => lstatOrUndefined(child) !== undefined
    );
    return firstViolation(existing, (child) => ownedDirViolation(child, uid));
}

function errorCode(error: unknown): string | undefined {
    return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

// A concurrent initState may create a child between the check and the mkdir; the entry is validated afterwards
// either way.
function createChildren(canonical: string, uid: number): Violation | undefined {
    const children = FIXED_CHILDREN.map((child) => path.join(canonical, child));
    for (const child of children) {
        try {
            fs.mkdirSync(child, { mode: 0o700 });
        } catch (error) {
            if (errorCode(error) !== 'EEXIST') {
                return {
                    problem: `${child} cannot be created (${errorCode(error) ?? 'unknown error'})`,
                    hint: OWNER_ONLY_HINT,
                };
            }
        }
    }
    return firstViolation(children, (child) => ownedDirViolation(child, uid));
}

type FormatRead = { kind: 'absent' } | { kind: 'found'; format: string } | { kind: 'unreadable'; code: string };

// Only a missing file counts as absent: an unreadable format must never be overwritten.
function readFormatForInit(canonical: string): FormatRead {
    try {
        return { kind: 'found', format: fs.readFileSync(path.join(canonical, FORMAT_FILE), 'utf8').trim() };
    } catch (error) {
        const code = errorCode(error) ?? 'unknown error';
        return code === 'ENOENT' ? { kind: 'absent' } : { kind: 'unreadable', code };
    }
}

export function initState(stateDir: string): InitStateResult {
    const uid = currentUid();
    const absolute = path.resolve(stateDir);
    const before = preCreateViolation(absolute, uid);
    if (before !== undefined) {
        return unsafeResult(before);
    }
    try {
        fs.mkdirSync(absolute, { recursive: true, mode: 0o700 });
    } catch {
        return unsafeResult({ problem: `${absolute} cannot be created`, hint: OWNER_ONLY_HINT });
    }
    const canonical = realpathOrUndefined(absolute);
    if (canonical === undefined) {
        return unsafeResult({ problem: `${absolute} cannot be resolved`, hint: OWNER_ONLY_HINT });
    }
    const violation = canonicalViolation(canonical, uid) ?? existingChildViolation(canonical, uid);
    if (violation !== undefined) {
        return unsafeResult(violation);
    }
    const format = readFormatForInit(canonical);
    if (format.kind === 'unreadable') {
        const file = path.join(canonical, FORMAT_FILE);
        return unsafeResult({
            problem: `${file} cannot be read (${format.code})`,
            hint: `fix or remove it, or ${OWNER_ONLY_HINT}`,
        });
    }
    if (format.kind === 'found' && format.format !== String(STATE_FORMAT)) {
        return { ok: false, kind: 'format', found: format.format };
    }
    const childViolation = createChildren(canonical, uid);
    if (childViolation !== undefined) {
        return unsafeResult(childViolation);
    }
    if (format.kind === 'absent') {
        writeTextAtomic(path.join(canonical, FORMAT_FILE), `${STATE_FORMAT}\n`);
    }
    return { ok: true, stateDir: canonical };
}
