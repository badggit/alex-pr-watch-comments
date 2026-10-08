import fs from 'node:fs';
import path from 'node:path';

import { ensureTrashDir, runDir, tempSiblingPath, trashDir } from './stateStore.ts';
import type { Logger } from './types.ts';

// Test injection points; production uses the plain fs calls.
export interface RemovalHooks {
    rename?: (_from: string, _to: string) => void;
    remove?: (_target: string) => void;
}

function defaultRemove(target: string): void {
    fs.rmSync(target, { recursive: true, force: true });
}

function errorCode(error: unknown): string {
    return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'unknown error';
}

function isMissing(file: string): boolean {
    try {
        fs.lstatSync(file);
        return false;
    } catch (error) {
        return errorCode(error) === 'ENOENT';
    }
}

// Deletes every entry of the trash area without reading it. A trash path that is not a real directory is only
// logged, so a watcher start never fails on it; removeRun refuses such a trash area through ensureTrashDir.
export function sweepTrash(stateDir: string, log: Logger, hooks?: RemovalHooks): void {
    const trash = trashDir(stateDir);
    const remove = hooks?.remove ?? defaultRemove;
    let entries: string[];
    try {
        if (!fs.lstatSync(trash).isDirectory()) {
            log.warn(`trash area ${trash} is not a directory; not swept`);
            return;
        }
        entries = fs.readdirSync(trash);
    } catch (error) {
        if (errorCode(error) !== 'ENOENT') {
            log.warn(`trash area ${trash} cannot be swept (${errorCode(error)})`);
        }
        return;
    }
    for (const name of entries) {
        const entry = path.join(trash, name);
        try {
            remove(entry);
        } catch (error) {
            log.warn(`trash entry ${entry} cannot be deleted (${errorCode(error)}); skipped`);
        }
    }
}

// Renames the run directory into the trash area first, so the run disappears from runs/ in one step and late
// shell writers, which never create directories, cannot bring it back; the trash entry is deleted afterwards.
export function removeRun(stateDir: string, runId: string, log: Logger, hooks?: RemovalHooks): void {
    const source = runDir(stateDir, runId);
    if (isMissing(source)) {
        return;
    }
    if (!ensureTrashDir(stateDir)) {
        throw new Error(`cannot remove run ${runId}: unsafe trash area ${trashDir(stateDir)}`);
    }
    const target = tempSiblingPath(path.join(trashDir(stateDir), runId));
    try {
        (hooks?.rename ?? fs.renameSync)(source, target);
    } catch (error) {
        if (errorCode(error) === 'ENOENT' && isMissing(source)) {
            return;
        }
        throw error;
    }
    try {
        (hooks?.remove ?? defaultRemove)(target);
    } catch (error) {
        log.warn(`run ${runId}: trash entry ${target} cannot be deleted (${errorCode(error)}); left for the sweep`);
    }
    sweepTrash(stateDir, log, hooks);
}
