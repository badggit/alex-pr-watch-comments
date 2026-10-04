// Stand-in claude for the stub mode of the live smoke. It acts like a worker that found nothing to change: it fires
// the run's hooks and, for every comment of the batch in order, posts an inline reply and swaps eyes for a fresh +1,
// each through the exact conveyor line the prompt names for that comment, then waits until the watcher terminates it.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { REPLY_TAG } from '../../src/constants.ts';
import { getArray, getPath, parseJson } from '../../src/json.ts';
import { quoteUntrusted, visibleText } from '../../src/untrustedText.ts';

interface CommentInfo {
    dbId: string;
    replyFile: string;
    reply: string | undefined;
    removeEyes: string | undefined;
    removePlus1: string | undefined;
    addPlus1: string | undefined;
}

interface ConveyorStep {
    name: string;
    line: string | undefined;
    optional: boolean;
}

const PATH_FILE = path.resolve(import.meta.dirname, '..', '..', '.cache', 'smoke', 'last-claude-path.txt');
const COMMAND_TIMEOUT_MS = 120_000;
const WAIT_SLICE_MS = 3_600_000;
const HOOK_INPUT = '{}';
const PERMISSION_INPUT = '{"notification_type":"permission_prompt"}';
const COMMENT_HEADER = /^Comment \d+ of \d+:$/u;
const TERMINATION_SIGNALS: readonly NodeJS.Signals[] = ['SIGTERM', 'SIGINT', 'SIGHUP'];

// Prompt lines, paths and gh output are printed through visibleText, so they cannot add lines or terminal escapes.
function say(text: string): void {
    process.stderr.write(`stub claude: ${visibleText(text)}\n`);
}

function optionValue(args: readonly string[], name: string): string | undefined {
    const index = args.indexOf(name);
    return index === -1 ? undefined : args[index + 1];
}

function labeled(lines: readonly string[], label: string): string | undefined {
    const prefix = `${label}: `;
    return lines.find((line) => line.startsWith(prefix))?.slice(prefix.length);
}

// Every "Comment K of N:" block of the prompt, in order; undefined when a block lacks its id or reply file.
function readComments(lines: readonly string[]): CommentInfo[] | undefined {
    const starts = lines.flatMap((line, index) => (COMMENT_HEADER.test(line) ? [index] : []));
    const comments: CommentInfo[] = [];
    for (const [order, start] of starts.entries()) {
        const block = lines.slice(start, starts[order + 1] ?? lines.length);
        const dbId = labeled(block, 'Comment database id');
        const replyFile = labeled(block, 'Reply body file');
        if (dbId === undefined || replyFile === undefined) {
            return;
        }
        comments.push({
            dbId,
            replyFile,
            reply: labeled(block, 'Reply command'),
            removeEyes: labeled(block, 'Remove eyes command'),
            removePlus1: labeled(block, 'Remove +1 command'),
            addPlus1: labeled(block, 'Add +1 command'),
        });
    }
    return comments.length > 0 ? comments : undefined;
}

function readAllowRules(settingsFile: string): ReadonlySet<string> {
    const settings = parseJson(fs.readFileSync(settingsFile, 'utf8'));
    const allow = getArray(getPath(settings, 'permissions'), 'allow') ?? [];
    return new Set(allow.filter((rule) => typeof rule === 'string'));
}

function runHook(runDir: string, kind: string, input = HOOK_INPUT): void {
    const result = spawnSync('/bin/sh', [path.join(runDir, 'hook.sh'), kind], {
        input,
        encoding: 'utf8',
        timeout: COMMAND_TIMEOUT_MS,
    });
    if (result.status !== 0) {
        say(`hook ${kind} failed`);
    }
}

// Runs one conveyor line like claude's Bash tool under this process's PATH. A line the settings do not allow
// raises the permission notification instead, as claude would, and is not run.
function runConveyor(line: string, allow: ReadonlySet<string>, runDir: string): 'ok' | 'failed' | 'blocked' {
    if (!allow.has(`Bash(${line})`)) {
        say(`not allowed by the run settings: ${line}`);
        runHook(runDir, 'permission', PERMISSION_INPUT);
        return 'blocked';
    }
    const result = spawnSync('/bin/sh', ['-c', line], {
        env: process.env,
        input: '',
        encoding: 'utf8',
        timeout: COMMAND_TIMEOUT_MS,
    });
    if (result.status === 0) {
        say(`ran: ${line}`);
        return 'ok';
    }
    say(`failed with status ${result.status ?? -1}: ${line}`);
    for (const quoted of quoteUntrusted(result.stderr.trim())) {
        say(quoted);
    }
    return 'failed';
}

// Reply, then eyes off and a fresh +1; a removePlus1 failure (no +1 to remove) is logged and ignored. False when a
// line was blocked by a permission prompt: claude would then wait without reaching its Stop hook.
function resolveComment(comment: CommentInfo, allow: ReadonlySet<string>, runDir: string): boolean {
    fs.writeFileSync(
        comment.replyFile,
        `Stub reply from the alex-pr-watch-comments smoke test for comment ${comment.dbId}: no change was needed.\n${REPLY_TAG}\n`
    );
    const steps: ConveyorStep[] = [
        { name: 'reply', line: comment.reply, optional: false },
        { name: 'removeEyes', line: comment.removeEyes, optional: false },
        { name: 'removePlus1', line: comment.removePlus1, optional: true },
        { name: 'addPlus1', line: comment.addPlus1, optional: false },
    ];
    for (const step of steps) {
        if (step.line === undefined) {
            say(`the prompt has no conveyor line for ${step.name} of comment ${comment.dbId}`);
            return true;
        }
        const outcome = runConveyor(step.line, allow, runDir);
        if (outcome === 'blocked') {
            return false;
        }
        if (outcome === 'failed' && !step.optional) {
            return true;
        }
    }
    return true;
}

function recordPath(): void {
    fs.mkdirSync(path.dirname(PATH_FILE), { recursive: true });
    fs.writeFileSync(PATH_FILE, `${process.env.PATH ?? ''}\n`);
}

async function waitForTermination(): Promise<void> {
    const controller = new AbortController();
    const stop = (): void => {
        controller.abort();
    };
    for (const name of TERMINATION_SIGNALS) {
        process.once(name, stop);
    }
    while (!controller.signal.aborted) {
        try {
            await delay(WAIT_SLICE_MS, undefined, { signal: controller.signal });
        } catch {
            return;
        }
    }
}

async function run(): Promise<number> {
    const args = process.argv.slice(2);
    const settingsFile = optionValue(args, '--settings');
    const prompt = args.at(-1);
    if (settingsFile === undefined || prompt === undefined) {
        say('usage: stubClaude.sh [ARGS] --settings FILE -- PROMPT');
        return 2;
    }
    const comments = readComments(prompt.split('\n'));
    const first = comments?.[0];
    if (comments === undefined || first === undefined) {
        say('the prompt has no comment details');
        return 2;
    }
    const runDir = path.dirname(first.replyFile);
    const allow = readAllowRules(settingsFile);
    runHook(runDir, 'prompt');
    runHook(runDir, 'tool');
    const finished = comments.every((comment) => resolveComment(comment, allow, runDir));
    recordPath();
    if (finished) {
        runHook(runDir, 'stop');
    }
    await waitForTermination();
    return 0;
}

async function main(): Promise<number> {
    try {
        return await run();
    } catch (error) {
        say(`failed: ${error instanceof Error ? error.message : 'unknown error'}`);
        return 1;
    }
}

process.exitCode = await main();
