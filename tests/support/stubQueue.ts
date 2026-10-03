import fs from 'node:fs';
import path from 'node:path';

import type { FakeResponse } from './fakeRunner.ts';
import { routingKey, type ToolName } from './stubRouting.ts';

// ghConfigDir and ghHost are the caller's GH_CONFIG_DIR and GH_HOST or empty; tokenVars names the GH_STRIP_VARS
// variables that were set and non-empty, never their values.
export interface StubCall {
    args: string[];
    input: string;
    cwd: string;
    path: string;
    ghConfigDir: string;
    ghHost: string;
    tokenVars: string[];
    pid: number;
}

const LOCK_TIMEOUT_MS = 10_000;
const LOCK_RETRY_MS = 5;
const RESPONSE_FILE = /^\d+\.json$/u;

function sleepSync(ms: number): void {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function queueDir(stubDir: string, tool: ToolName, key: string): string {
    return path.join(stubDir, 'queues', tool, `k-${encodeURIComponent(key)}`);
}

function callsFile(stubDir: string, tool: ToolName): string {
    return path.join(stubDir, `${tool}.calls.jsonl`);
}

function errorCode(error: unknown): string | undefined {
    if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
        return error.code;
    }
    return;
}

// Serializes queue access across processes with an mkdir lock, so concurrent stubs never hand out one response twice.
function withQueueLock<T>(dir: string, action: () => T): T {
    fs.mkdirSync(dir, { recursive: true });
    const lock = path.join(dir, 'lock');
    const deadline = performance.now() + LOCK_TIMEOUT_MS;
    for (;;) {
        try {
            fs.mkdirSync(lock);
            break;
        } catch (error) {
            if (errorCode(error) !== 'EEXIST' || performance.now() > deadline) {
                throw error;
            }
            sleepSync(LOCK_RETRY_MS);
        }
    }
    try {
        return action();
    } finally {
        fs.rmdirSync(lock);
    }
}

function queueLength(dir: string): number {
    return fs.readdirSync(dir).filter((name) => RESPONSE_FILE.test(name)).length;
}

function writeAtomic(file: string, text: string): void {
    const temp = `${file}.tmp.${process.pid}`;
    fs.writeFileSync(temp, text);
    fs.renameSync(temp, file);
}

function ownValue(record: object, key: string): unknown {
    return Object.getOwnPropertyDescriptor(record, key)?.value;
}

function isUnknownArray(value: unknown): value is unknown[] {
    return Array.isArray(value);
}

function optionalNumber(record: object, key: string): number | undefined {
    const value = ownValue(record, key);
    return typeof value === 'number' ? value : undefined;
}

function optionalString(record: object, key: string): string | undefined {
    const value = ownValue(record, key);
    return typeof value === 'string' ? value : undefined;
}

function requiredString(record: object, key: string): string {
    const value = optionalString(record, key);
    if (value === undefined) {
        throw new TypeError(`stub call field ${key} is not a string`);
    }
    return value;
}

function stringList(record: object, key: string): string[] {
    const value = ownValue(record, key);
    if (!isUnknownArray(value)) {
        throw new TypeError(`stub call field ${key} is not an array`);
    }
    const items = value.filter((item): item is string => typeof item === 'string');
    if (items.length !== value.length) {
        throw new TypeError(`stub call field ${key} holds a non-string item`);
    }
    return items;
}

function parseObject(text: string, what: string): object {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) {
        throw new TypeError(`${what} is not a JSON object`);
    }
    return parsed;
}

function parseResponse(text: string): FakeResponse {
    const record = parseObject(text, 'stub response');
    return {
        code: optionalNumber(record, 'code'),
        stdout: optionalString(record, 'stdout'),
        stderr: optionalString(record, 'stderr'),
        json: ownValue(record, 'json'),
        delayMs: optionalNumber(record, 'delayMs'),
    };
}

function parseCall(line: string): StubCall {
    const record = parseObject(line, 'stub call');
    const pid = optionalNumber(record, 'pid');
    if (pid === undefined) {
        throw new TypeError('stub call field pid is not a number');
    }
    return {
        args: stringList(record, 'args'),
        input: requiredString(record, 'input'),
        cwd: requiredString(record, 'cwd'),
        path: requiredString(record, 'path'),
        ghConfigDir: requiredString(record, 'ghConfigDir'),
        ghHost: requiredString(record, 'ghHost'),
        tokenVars: stringList(record, 'tokenVars'),
        pid,
    };
}

export function stubRespond(stubDir: string, tool: ToolName, key: string, response: FakeResponse): void {
    const dir = queueDir(stubDir, tool, key);
    withQueueLock(dir, () => {
        writeAtomic(path.join(dir, `${queueLength(dir)}.json`), JSON.stringify(response));
    });
}

// Consumes the next queued response of TOOL and KEY (the last one repeats); undefined when nothing was queued.
export function takeStubResponse(stubDir: string, tool: ToolName, key: string): FakeResponse | undefined {
    const dir = queueDir(stubDir, tool, key);
    if (!fs.existsSync(dir)) {
        return;
    }
    return withQueueLock(dir, () => {
        const counter = path.join(dir, 'next');
        const next = fs.existsSync(counter) ? Number.parseInt(fs.readFileSync(counter, 'utf8'), 10) : 0;
        const length = queueLength(dir);
        if (length === 0) {
            return;
        }
        writeAtomic(counter, String(next + 1));
        return parseResponse(fs.readFileSync(path.join(dir, `${Math.min(next, length - 1)}.json`), 'utf8'));
    });
}

export function appendStubCall(stubDir: string, tool: ToolName, call: StubCall): void {
    fs.appendFileSync(callsFile(stubDir, tool), `${JSON.stringify(call)}\n`);
}

export function stubCalls(stubDir: string, tool: ToolName): StubCall[] {
    const file = callsFile(stubDir, tool);
    if (!fs.existsSync(file)) {
        return [];
    }
    return fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => parseCall(line));
}

export function stubCallCount(stubDir: string, tool: ToolName, key: string): number {
    return stubCalls(stubDir, tool).filter((call) => routingKey(tool, call.args, call.input) === key).length;
}
