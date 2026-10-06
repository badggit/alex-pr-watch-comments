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
