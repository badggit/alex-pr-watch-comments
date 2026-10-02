import { setTimeout as delay } from 'node:timers/promises';

import type { CommandRequest, CommandResult, CommandRunner, Env } from '../../src/types.ts';

import { routingKey, toolName, type ToolName } from './stubRouting.ts';

// json, when set, is serialized to stdout; delayMs holds the answer back (the fake runner resolves 143 early when
// the request signal aborts during the delay).
export interface FakeResponse {
    code?: number;
    stdout?: string;
    stderr?: string;
    json?: unknown;
    delayMs?: number;
}

export interface RecordedCall {
    tool: ToolName;
    key: string;
    file: string;
    args: string[];
    input: string | undefined;
    env: Env | undefined;
    cwd: string | undefined;
}

// A function response is evaluated at call time; when it throws, the run call rejects with that error.
export type FakeResponder = FakeResponse | ((_call: RecordedCall) => FakeResponse);

export type Passthrough = Partial<Record<ToolName, CommandRunner>>;

export interface FakeRunner {
    runner: CommandRunner;
    respond(_tool: ToolName, _key: string, _response: FakeResponder): void;
    calls(_tool?: ToolName): RecordedCall[];
    callCount(_tool: ToolName, _key: string): number;
}

interface ResponseQueue {
    responses: FakeResponder[];
    next: number;
}

export function responseStdout(response: FakeResponse): string {
    return response.json === undefined ? (response.stdout ?? '') : JSON.stringify(response.json);
}

async function delayUnlessAborted(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
    try {
        await delay(ms, undefined, { signal });
        return false;
    } catch (error) {
        if (signal?.aborted) {
            return true;
        }
        throw error;
    }
}

function queueKey(tool: ToolName, key: string): string {
    return `${tool} ${key}`;
}

export function createFakeRunner(options?: { passthrough?: Passthrough }): FakeRunner {
    const recorded: RecordedCall[] = [];
    const queues = new Map<string, ResponseQueue>();

    const takeResponder = (tool: ToolName, key: string): FakeResponder | undefined => {
        const queue = queues.get(queueKey(tool, key));
        if (queue === undefined) {
            return;
        }
        // Consumed in order; the last response repeats once the queue is exhausted.
        const responder = queue.responses[Math.min(queue.next, queue.responses.length - 1)];
        queue.next += 1;
        return responder;
    };

    const run = async (request: CommandRequest): Promise<CommandResult> => {
        const tool = toolName(request.file);
        const key = routingKey(tool, request.args, request.input);
        const call: RecordedCall = {
            tool,
            key,
            file: request.file,
            args: [...request.args],
            input: request.input,
            env: request.env,
            cwd: request.cwd,
        };
        recorded.push(call);
        const delegate = options?.passthrough?.[tool];
        if (delegate !== undefined) {
            return delegate.run(request);
        }
        const responder = takeResponder(tool, key);
        if (responder === undefined) {
            return { code: 0, stdout: '', stderr: '' };
        }
        const response = typeof responder === 'function' ? responder(call) : responder;
        if (response.delayMs !== undefined && (await delayUnlessAborted(response.delayMs, request.signal))) {
            return { code: 143, stdout: '', stderr: '' };
        }
        return { code: response.code ?? 0, stdout: responseStdout(response), stderr: response.stderr ?? '' };
    };

    return {
        runner: { run },
        respond: (tool, key, response) => {
            const name = queueKey(tool, key);
            const queue = queues.get(name) ?? { responses: [], next: 0 };
            queue.responses.push(response);
            queues.set(name, queue);
        },
        calls: (tool) => recorded.filter((call) => tool === undefined || call.tool === tool),
        callCount: (tool, key) => recorded.filter((call) => call.tool === tool && call.key === key).length,
    };
}
