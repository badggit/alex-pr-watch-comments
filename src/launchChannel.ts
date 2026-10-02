import fs from 'node:fs';
import path from 'node:path';

import { getString } from './json.ts';
import { createFieldReader, readJsonFile, tempSiblingPath, watcherDir, writeTextAtomic } from './stateStore.ts';
import type { LaunchResult } from './types.ts';

const LAUNCH_TOKEN = /^[\d-]+$/u;
const RESULT_KINDS: ReadonlySet<string> = new Set<LaunchResult['result']>(['firstPoll', 'fatal', 'alreadyWatched']);

function isResultKind(value: string | undefined): value is LaunchResult['result'] {
    return value !== undefined && RESULT_KINDS.has(value);
}

function launchDir(stateDir: string, prKey: string): string {
    return path.join(watcherDir(stateDir, prKey), 'launch');
}

// Undefined for a token that could escape its file name; every caller then does nothing.
function launchFile(stateDir: string, prKey: string, token: string, extension: string): string | undefined {
    if (!LAUNCH_TOKEN.test(token)) {
        return;
    }
    return path.join(launchDir(stateDir, prKey), `${token}.${extension}`);
}

function ensureLaunchDir(stateDir: string, prKey: string): void {
    fs.mkdirSync(launchDir(stateDir, prKey), { recursive: true, mode: 0o700 });
}

export function markLaunchReady(stateDir: string, prKey: string, token: string): void {
    const file = launchFile(stateDir, prKey, token, 'ready');
    if (file === undefined) {
        return;
    }
    ensureLaunchDir(stateDir, prKey);
    writeTextAtomic(file, '');
}

export function launchReady(stateDir: string, prKey: string, token: string): boolean {
    const file = launchFile(stateDir, prKey, token, 'ready');
    return file !== undefined && fs.existsSync(file);
}

// Write-once: linkSync fails when the result file exists, so the first result of a launch always wins.
export function writeLaunchResult(stateDir: string, prKey: string, result: LaunchResult): boolean {
    const file = launchFile(stateDir, prKey, result.token, 'json');
    if (file === undefined) {
        return false;
    }
    ensureLaunchDir(stateDir, prKey);
    const temp = tempSiblingPath(file);
    try {
        fs.writeFileSync(temp, `${JSON.stringify(result)}\n`, { mode: 0o600, flag: 'wx' });
        fs.linkSync(temp, file);
        return true;
    } catch {
        return false;
    } finally {
        fs.rmSync(temp, { force: true });
    }
}

export function readLaunchResult(stateDir: string, prKey: string, token: string): LaunchResult | undefined {
    const file = launchFile(stateDir, prKey, token, 'json');
    if (file === undefined) {
        return;
    }
    const value = readJsonFile(file);
    const kind = getString(value, 'result');
    if (getString(value, 'token') !== token || !isResultKind(kind)) {
        return;
    }
    const read = createFieldReader(value);
    const result: LaunchResult = {
        token,
        result: kind,
        message: read.text('message'),
        pid: read.integer('pid'),
        windowId: read.text('windowId'),
    };
    return read.failed() ? undefined : result;
}

export function clearLaunch(stateDir: string, prKey: string, token: string): void {
    for (const extension of ['ready', 'json']) {
        const file = launchFile(stateDir, prKey, token, extension);
        if (file !== undefined) {
            fs.rmSync(file, { force: true });
        }
    }
}
