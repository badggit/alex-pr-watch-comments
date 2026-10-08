import fs from 'node:fs';
import path from 'node:path';

import { createCloneGate, type CloneDeps, type GateEnv } from './cowGate.ts';
import { gitIn } from './guards.ts';
import { pidAlive } from './proc.ts';
import type { CommandResult } from './types.ts';
import { safeText } from './validate.ts';

export const CLONE_TEMP_PREFIX = 'alex-pr-watch-comments-clone-';
export const CLONE_TIMEOUT_MS = 600_000;

const ESCAPED_TEMP_PREFIX = CLONE_TEMP_PREFIX.replaceAll(/[$()*+.?[\\\]^{|}]/g, String.raw`\$&`);
const TEMP_NAME_PATTERN = new RegExp(String.raw`^${ESCAPED_TEMP_PREFIX}(\d+)-\d+$`);

export interface CloneCommand {
    file: string;
    args: string[];
}

export type PlaceResult = { kind: 'placed' } | { kind: 'refused'; code: string };

function errorCode(error: unknown): string {
    return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'unknown';
}

// Best-effort: a temp that cannot be removed now (EACCES, EBUSY) is left for the next dead-PID sweep.
function removeTemp(temp: string): void {
    try {
        fs.rmSync(temp, { recursive: true, force: true });
    } catch {
        // Nothing more to do here.
    }
}

function isAlive(alive: (_pid: number) => boolean, pid: number): boolean {
    try {
        return alive(pid);
    } catch {
        return true;
    }
}

export function cloneTempName(pid: number, counter: number): string {
    return `${CLONE_TEMP_PREFIX}${pid}-${counter}`;
}

// Removes temps left behind by watchers that died mid-clone; everything else in the area (git's own files,
// temps of live watchers) is left alone. Never throws.
export function sweepDeadTemps(tempArea: string, alive: (_pid: number) => boolean): void {
    let names: string[];
    try {
        names = fs.readdirSync(tempArea);
    } catch {
        return;
    }
    for (const name of names) {
        const match = TEMP_NAME_PATTERN.exec(name);
        if (!match || isAlive(alive, Number(match[1]))) {
            continue;
        }
        removeTemp(path.join(tempArea, name));
    }
}

// macOS `cp -c` uses clonefile(2) but silently falls back to a plain copy where cloning is impossible (hence
// the gate); GNU `--reflink=always` fails instead of copying. `-R` keeps symlinks as links on both.
// Linux takes `cp` from PATH (GNU coreutils is the system cp there); darwin pins `/bin/cp` so a Homebrew GNU cp
// earlier on PATH is never used. `temp` must not exist yet, otherwise `cp -R` copies the source inside it.
export function cloneCommand(platform: NodeJS.Platform, source: string, temp: string): CloneCommand | undefined {
    if (platform === 'darwin') {
        return { file: '/bin/cp', args: ['-c', '-R', source, temp] };
    }
    if (platform === 'linux') {
        return { file: 'cp', args: ['-R', '--reflink=always', source, temp] };
    }
    return undefined;
}

function lstatOrUndefined(target: string): fs.Stats | undefined {
    try {
        return fs.lstatSync(target);
    } catch {
        return undefined;
    }
}

function isOwnLink(dest: string, stat: fs.Stats, ownLinkText: string): boolean {
    if (!stat.isSymbolicLink()) {
        return false;
    }
    try {
        return fs.readlinkSync(dest) === ownLinkText;
    } catch {
        return false;
    }
}

// Best-effort: the link comes back only where nothing else has appeared at dest meanwhile.
function restoreOwnLink(dest: string, ownLinkText: string): void {
    if (lstatOrUndefined(dest) !== undefined) {
        return;
    }
    try {
        fs.symlinkSync(ownLinkText, dest);
    } catch {
        // The rename error is the one reported; a failed restore must not hide it.
    }
}

// Moves a finished clone into place. Only an empty destination or the watcher's own link (text exactly
// `ownLinkText`) is replaced; anything else is refused and never modified. A refused clone's temp is removed.
export function placeClone(
    temp: string,
    dest: string,
    ownLinkText: string,
    rename: (_from: string, _to: string) => void = fs.renameSync
): PlaceResult {
    const stat = lstatOrUndefined(dest);
    const replacesOwnLink = stat !== undefined && isOwnLink(dest, stat, ownLinkText);
    if (stat !== undefined && !replacesOwnLink) {
        removeTemp(temp);
        return { kind: 'refused', code: 'EEXIST' };
    }
    // Node has no RENAME_NOREPLACE, so an empty directory created at dest between the lstat above and the rename
    // would be replaced by rename(2); that window is accepted.
    try {
        if (replacesOwnLink) {
            fs.unlinkSync(dest);
        }
        rename(temp, dest);
        return { kind: 'placed' };
    } catch (error) {
        removeTemp(temp);
        if (replacesOwnLink) {
            restoreOwnLink(dest, ownLinkText);
        }
        return { kind: 'refused', code: errorCode(error) };
    }
}

export interface ClonerEnv extends GateEnv {
    pid: number;
    alive: (_pid: number) => boolean;
    nowMs: () => number;
    timeoutMs: number;
}

export type CloneOutcome =
    | { kind: 'cloned' }
    | { kind: 'unavailable'; reason: string }
    | { kind: 'failed'; reason: string }
    | { kind: 'skipped' };

export interface Cloner {
    cloneDependency(
        _deps: CloneDeps,
        _gitPath: string,
        _source: string,
        _target: string,
        _rel: string
    ): Promise<CloneOutcome>;
}

async function privateGitDirectory(deps: CloneDeps, gitPath: string, target: string): Promise<string | undefined> {
    try {
        const result = await gitIn(deps, gitPath, target, ['rev-parse', '--absolute-git-dir']);
        const firstLine = result.stdout.split('\n', 1)[0] ?? '';
        return result.code === 0 && !result.spawnError && path.isAbsolute(firstLine) ? firstLine : undefined;
    } catch {
        return undefined;
    }
}

function cloneFailure(result: CommandResult): string {
    const reason = result.spawnError ?? `cp exited with ${result.code}`;
    const detail = result.stderr.split('\n', 1)[0];
    return detail ? `${reason}: ${detail}` : reason;
}

export function createCloner(env?: Partial<ClonerEnv>): Cloner {
    const platform = env?.platform ?? process.platform;
    const pid = env?.pid ?? process.pid;
    const alive = env?.alive ?? pidAlive;
    const nowMs = env?.nowMs ?? Date.now;
    const timeoutMs = env?.timeoutMs ?? CLONE_TIMEOUT_MS;
    const gate = createCloneGate({ platform, deviceOf: env?.deviceOf });
    const failed = new Set<string>();
    let counter = 0;
    const nextTemp = (tempArea: string): string => {
        let temp: string;
        do {
            counter += 1;
            temp = path.join(tempArea, cloneTempName(pid, counter));
        } while (lstatOrUndefined(temp) !== undefined);
        return temp;
    };
    const fail = (dest: string, reason: string): CloneOutcome => {
        failed.add(dest);
        return { kind: 'failed', reason };
    };
    return {
        async cloneDependency(deps, gitPath, source, target, rel) {
            const dest = path.join(target, rel);
            const ownLinkText = path.join(source, rel);
            const stat = lstatOrUndefined(dest);
            if (failed.has(dest) || (stat !== undefined && !isOwnLink(dest, stat, ownLinkText))) {
                return { kind: 'skipped' };
            }
            const tempArea = await privateGitDirectory(deps, gitPath, target);
            if (!tempArea) {
                return fail(dest, 'cannot find the git directory of the worktree');
            }
            sweepDeadTemps(tempArea, alive);
            const available = await gate.check(deps, {
                sourceRoot: source,
                target,
                rel,
                tempArea,
                probePath: nextTemp(tempArea),
            });
            if (available.kind === 'unavailable') {
                return available;
            }
            const temp = nextTemp(tempArea);
            const command = cloneCommand(platform, ownLinkText, temp);
            if (!command) {
                return { kind: 'unavailable', reason: 'copy-on-write clones are not supported on this platform' };
            }
            const started = nowMs();
            deps.log.info(`cloning ${safeText(rel)} into the watch worktree with copy-on-write`);
            try {
                const result = await deps.runner.run({ ...command, timeoutMs });
                if (result.code !== 0 || result.spawnError) {
                    removeTemp(temp);
                    return fail(dest, cloneFailure(result));
                }
            } catch (error) {
                removeTemp(temp);
                return fail(dest, error instanceof Error ? error.message : 'cp failed');
            }
            if (lstatOrUndefined(temp)?.isDirectory() !== true) {
                removeTemp(temp);
                return fail(dest, 'cp did not create a directory');
            }
            const placement = placeClone(temp, dest, ownLinkText);
            if (placement.kind === 'refused') {
                return fail(dest, `cannot place the clone (${placement.code})`);
            }
            const elapsed = ((nowMs() - started) / 1000).toFixed(1);
            deps.log.info(`cloned ${safeText(rel)} into the watch worktree in ${elapsed} s`);
            return { kind: 'cloned' };
        },
    };
}

export const defaultCloner: Cloner = createCloner();
