import fs from 'node:fs';
import path from 'node:path';

import type { Deps } from './types.ts';

export type CloneDeps = Pick<Deps, 'runner' | 'log'>;

export interface DfMount {
    device: string;
    mountPoint: string;
}

export const SAMPLE_ENTRY_LIMIT = 1000;

// Device, three numeric columns, a capacity ending with % and the mount point, which may hold spaces.
const DF_LINE = /^(\S+)\s+\S+\s+\S+\s+\S+\s+\S*%\s+(\S.*)$/;

// Reads the second line of `df -P PATH` output.
export function parseDfMount(stdout: string): DfMount | undefined {
    // Only leading space and a CR are dropped: a mount point may end with a space.
    const line = stdout.split('\n', 2)[1]?.replace(/\r$/, '').trimStart();
    if (!line) {
        return undefined;
    }
    const match = DF_LINE.exec(line);
    const device = match?.[1];
    const mountPoint = match?.[2];
    if (!device || !mountPoint?.startsWith('/')) {
        return undefined;
    }
    return { device, mountPoint };
}

// True only for a `mount` line "DEVICE on MOUNTPOINT (apfs, ...)" naming exactly this device and mount point.
export function isApfsMount(mountStdout: string, mount: DfMount): boolean {
    const prefix = `${mount.device} on ${mount.mountPoint} (`;
    return mountStdout.split('\n').some((line) => {
        if (!line.startsWith(prefix)) {
            return false;
        }
        const fsType = line.slice(prefix.length).split(/[),]/, 1)[0]?.trim();
        return fsType === 'apfs';
    });
}

function readEntries(dir: string): fs.Dirent[] {
    try {
        return fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return [];
    }
}

// Breadth-first search for a regular file that never follows symbolic links and gives up after `limit` entries.
export function findSampleFile(dir: string, limit = SAMPLE_ENTRY_LIMIT): string | undefined {
    const queue = [path.resolve(dir)];
    let seen = 0;
    // Directories pushed while iterating are still visited: an array iterator reads the length on every step.
    for (const current of queue) {
        for (const entry of readEntries(current)) {
            if (seen >= limit) {
                return undefined;
            }
            seen += 1;
            const full = path.join(current, entry.name);
            if (entry.isFile()) {
                return full;
            }
            if (entry.isDirectory()) {
                queue.push(full);
            }
        }
    }
    return undefined;
}

export interface GateEnv {
    platform: NodeJS.Platform;
    deviceOf: (_file: string) => number | undefined;
}

export interface GateRequest {
    sourceRoot: string;
    target: string;
    rel: string;
    tempArea: string;
    probePath: string;
}

export type GateResult = { kind: 'available' } | { kind: 'unavailable'; reason: string };

export interface CloneGate {
    check(_deps: CloneDeps, _request: GateRequest): Promise<GateResult>;
}

const DARWIN_TOOL_ENV = { LC_ALL: 'C', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };
const VOLUME_READ_FAILURE: GateResult = { kind: 'unavailable', reason: 'cannot read the volume type' };
const LINUX_PROBE_FAILURE: GateResult = {
    kind: 'unavailable',
    reason: 'no copy-on-write between the clone and the worktree',
};

function deviceOf(file: string): number | undefined {
    try {
        return fs.statSync(file).dev;
    } catch {
        return undefined;
    }
}

function sameVolume(env: GateEnv, request: GateRequest): boolean {
    const sourceDevice = env.deviceOf(path.join(request.sourceRoot, request.rel));
    const targetDevice = env.deviceOf(request.target);
    const tempDevice = env.deviceOf(request.tempArea);
    return sourceDevice !== undefined && sourceDevice === targetDevice && sourceDevice === tempDevice;
}

async function checkDarwin(deps: CloneDeps, request: GateRequest): Promise<GateResult> {
    try {
        const df = await deps.runner.run({ file: '/bin/df', args: ['-P', request.target], env: DARWIN_TOOL_ENV });
        const mount = await deps.runner.run({ file: '/sbin/mount', args: [], env: DARWIN_TOOL_ENV });
        if (df.code !== 0 || mount.code !== 0 || df.spawnError || mount.spawnError) {
            return VOLUME_READ_FAILURE;
        }
        const volume = parseDfMount(df.stdout);
        if (!volume) {
            return VOLUME_READ_FAILURE;
        }
        return isApfsMount(mount.stdout, volume)
            ? { kind: 'available' }
            : { kind: 'unavailable', reason: 'the worktree volume is not APFS' };
    } catch {
        return VOLUME_READ_FAILURE;
    }
}

async function probeLinux(deps: CloneDeps, sample: string, probePath: string): Promise<GateResult> {
    try {
        const result = await deps.runner.run({ file: 'cp', args: ['--reflink=always', sample, probePath] });
        return result.code === 0 && !result.spawnError ? { kind: 'available' } : LINUX_PROBE_FAILURE;
    } catch {
        return LINUX_PROBE_FAILURE;
    } finally {
        fs.rmSync(probePath, { force: true });
    }
}

// macOS cp -c can silently make a full copy, and Node copyFile cannot clone there; the gate selects a link fallback.
export function createCloneGate(env?: Partial<GateEnv>): CloneGate {
    const gateEnv: GateEnv = { platform: env?.platform ?? process.platform, deviceOf: env?.deviceOf ?? deviceOf };
    const cache = new Map<string, GateResult>();
    return {
        async check(deps, request) {
            if (gateEnv.platform !== 'darwin' && gateEnv.platform !== 'linux') {
                return { kind: 'unavailable', reason: 'copy-on-write clones are not supported on this platform' };
            }
            if (gateEnv.platform === 'darwin' && !sameVolume(gateEnv, request)) {
                return { kind: 'unavailable', reason: 'the clone and the worktree are on different volumes' };
            }
            const key = `${request.sourceRoot}\0${request.target}`;
            const cached = cache.get(key);
            if (cached) {
                return cached;
            }
            let result: GateResult;
            if (gateEnv.platform === 'darwin') {
                result = await checkDarwin(deps, request);
            } else {
                const sample = findSampleFile(path.join(request.sourceRoot, request.rel));
                if (!sample) {
                    return { kind: 'available' };
                }
                result = await probeLinux(deps, sample, request.probePath);
            }
            cache.set(key, result);
            return result;
        },
    };
}
