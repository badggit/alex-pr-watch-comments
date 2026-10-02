import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { text } from 'node:stream/consumers';
import { setTimeout as delay } from 'node:timers/promises';

import { GH_STRIP_VARS } from '../../src/constants.ts';
import { responseStdout } from '../support/fakeRunner.ts';
import { appendStubCall, takeStubResponse } from '../support/stubQueue.ts';
import { routingKey, toolName, type ToolName } from '../support/stubRouting.ts';

// Usage: node tests/stubs/fakeTool.ts TOOL ARGS... (started by the wrappers createTestEnv writes into binDir).

function setTokenVars(): string[] {
    return GH_STRIP_VARS.filter((name) => (process.env[name] ?? '').length > 0);
}

function readsStdin(tool: ToolName, args: readonly string[]): boolean {
    const inputIndex = args.indexOf('--input');
    return tool === 'gh' && inputIndex !== -1 && args[inputIndex + 1] === '-';
}

function ghEnvLines(): string {
    const lines: string[] = [];
    for (const name of ['GH_CONFIG_DIR', 'GH_HOST']) {
        const value = process.env[name];
        if (value !== undefined) {
            lines.push(`${name}=${value}\n`);
        }
    }
    for (const name of setTokenVars()) {
        lines.push(`${name}=set\n`);
    }
    return lines.join('');
}

function waitForTerm(): Promise<void> {
    return new Promise((resolve) => {
        const keepAlive = setInterval(() => {
            return;
        }, 60_000);
        process.once('SIGTERM', () => {
            clearInterval(keepAlive);
            resolve();
        });
    });
}

async function runClaude(stubDir: string, args: readonly string[]): Promise<void> {
    // The SIGTERM handler is installed before claude.selfpid exists, so a test that signals as soon as it sees the
    // pid always gets exit code 143 from the handler.
    const terminated = process.env.STUB_CLAUDE_WAIT === '1' ? waitForTerm() : undefined;
    fs.writeFileSync(path.join(stubDir, 'claude.argv'), args.join('\0'));
    fs.writeFileSync(path.join(stubDir, 'claude.path'), process.env.PATH ?? '');
    fs.writeFileSync(path.join(stubDir, 'claude.ghenv'), ghEnvLines());
    // Written last, so a test that sees claude.selfpid also sees the other files.
    fs.writeFileSync(path.join(stubDir, 'claude.selfpid'), String(process.pid));
    const script = path.join(stubDir, 'claude.script');
    if (fs.existsSync(script)) {
        spawnSync('/bin/sh', [script, ...args], { stdio: 'inherit' });
    }
    if (terminated !== undefined) {
        await terminated;
        process.exitCode = 143;
        return;
    }
    const exitCode = Number.parseInt(process.env.STUB_CLAUDE_EXIT ?? '0', 10);
    process.exitCode = Number.isNaN(exitCode) ? 0 : exitCode;
}

async function answerFromQueue(stubDir: string, tool: ToolName, args: readonly string[], input: string): Promise<void> {
    const response = takeStubResponse(stubDir, tool, routingKey(tool, args, input));
    if (response === undefined) {
        return;
    }
    if (response.delayMs !== undefined && response.delayMs > 0) {
        await delay(response.delayMs);
    }
    process.stdout.write(responseStdout(response));
    process.stderr.write(response.stderr ?? '');
    process.exitCode = response.code ?? 0;
}

async function main(): Promise<void> {
    const [toolArgument = 'other', ...toolArgs] = process.argv.slice(2);
    const dir = process.env.STUB_DIR ?? '';
    if (dir.length === 0) {
        throw new Error('STUB_DIR is not set');
    }
    const name = toolName(toolArgument);
    const stdin = readsStdin(name, toolArgs) ? await text(process.stdin) : '';
    appendStubCall(dir, name, {
        args: toolArgs,
        input: stdin,
        cwd: process.cwd(),
        path: process.env.PATH ?? '',
        ghConfigDir: process.env.GH_CONFIG_DIR ?? '',
        ghHost: process.env.GH_HOST ?? '',
        tokenVars: setTokenVars(),
        pid: process.pid,
    });
    await (name === 'claude' ? runClaude(dir, toolArgs) : answerFromQueue(dir, name, toolArgs, stdin));
}

await main();
