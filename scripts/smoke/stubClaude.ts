// Stand-in claude for the stub mode of the live smoke. It acts like a worker that found nothing to change: it fires
// the run's hooks, posts an inline reply and swaps eyes for a fresh +1, each through the exact conveyor line of the
// prompt's command list, then waits until the watcher terminates it.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { getArray, getPath, parseJson } from '../../src/json.ts';
import { quoteUntrusted, visibleText } from '../../src/untrustedText.ts';

interface RunInfo {
    commentDbId: string;
    replyTo: string;
    repository: string;
    prNumber: string;
    runDir: string;
    replyFile: string;
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
const PR_NUMBER = /\/pull\/(\d+)$/u;
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

function readRunInfo(lines: readonly string[]): RunInfo | undefined {
    const commentDbId = labeled(lines, 'Comment database id');
    const replyTo = labeled(lines, 'Reply to comment database id');
    const repository = labeled(lines, 'Repository');
    const prNumber = PR_NUMBER.exec(labeled(lines, 'PR') ?? '')?.[1];
    const replyFile = labeled(lines, 'Reply body file');
    if (
        commentDbId !== undefined &&
        replyTo !== undefined &&
        repository !== undefined &&
        prNumber !== undefined &&
        replyFile !== undefined
    ) {
        return { commentDbId, replyTo, repository, prNumber, runDir: path.dirname(replyFile), replyFile };
    }
    return;
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

// Only the lines of the prompt's command list start with "gh api"; the step texts quote them mid-sentence.
function findCommand(lines: readonly string[], matches: (_line: string) => boolean): string | undefined {
    return lines.find((line) => line.startsWith('gh api ') && matches(line));
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

function gqlLine(lines: readonly string[], runDir: string, name: string): string | undefined {
    const suffix = `=@${path.join(runDir, 'gql', `${name}.graphql`)}`;
    return findCommand(lines, (line) => line.startsWith('gh api graphql ') && line.endsWith(suffix));
}

// Reply, then eyes off and a fresh +1; a removePlus1 failure (no +1 to remove) is logged and ignored. False when a
// line was blocked by a permission prompt: claude would then wait without reaching its Stop hook.
function resolveComment(lines: readonly string[], info: RunInfo, allow: ReadonlySet<string>): boolean {
    const replyPrefix = `gh api repos/${info.repository}/pulls/${info.prNumber}/comments/${info.replyTo}/replies `;
    const steps: ConveyorStep[] = [
        { name: 'reply', line: findCommand(lines, (line) => line.startsWith(replyPrefix)), optional: false },
        { name: 'removeEyes', line: gqlLine(lines, info.runDir, 'removeEyes'), optional: false },
        { name: 'removePlus1', line: gqlLine(lines, info.runDir, 'removePlus1'), optional: true },
        { name: 'addPlus1', line: gqlLine(lines, info.runDir, 'addPlus1'), optional: false },
    ];
    for (const step of steps) {
        if (step.line === undefined) {
            say(`the prompt has no conveyor line for ${step.name}`);
            return true;
        }
        const outcome = runConveyor(step.line, allow, info.runDir);
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
    const lines = prompt.split('\n');
    const info = readRunInfo(lines);
    if (info === undefined) {
        say('the prompt has no run details');
        return 2;
    }
    const allow = readAllowRules(settingsFile);
    runHook(info.runDir, 'prompt');
    runHook(info.runDir, 'tool');
    fs.writeFileSync(
        info.replyFile,
        `Stub reply from the pr-watch-comments smoke test for comment ${info.commentDbId}: no change was needed.\n`
    );
    const finished = resolveComment(lines, info, allow);
    recordPath();
    if (finished) {
        runHook(info.runDir, 'stop');
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
