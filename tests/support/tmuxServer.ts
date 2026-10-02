import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { Env } from '../../src/types.ts';

export interface TmuxServer {
    name: string;
    socket: string;
    pane: string;
    envFor(): Env;
    kill(): Promise<void>;
}

interface TmuxOutput {
    code: number;
    stdout: string;
    stderr: string;
}

const SESSION = 'prwc';
const DEFAULT_WIDTH = 80;
const DEFAULT_HEIGHT = 24;

function isExecutableFile(file: string): boolean {
    try {
        fs.accessSync(file, fs.constants.X_OK);
        return fs.statSync(file).isFile();
    } catch {
        return false;
    }
}

function tmuxBinary(env: Env): string {
    const found = (env.PATH ?? '')
        .split(':')
        .filter((dir) => path.isAbsolute(dir))
        .map((dir) => path.join(dir, 'tmux'))
        .find((file) => isExecutableFile(file));
    if (found === undefined) {
        throw new Error('startTmuxServer: tmux is not on the PATH of the given env');
    }
    return found;
}

function removeSocketFile(socket: string): void {
    try {
        if (fs.lstatSync(socket).isSocket()) {
            fs.rmSync(socket, { force: true });
        }
    } catch {
        return;
    }
}

// The server starts from the given env as is (token variables included, so a test can build a stale server), only
// without the caller's TMUX and TMUX_PANE, which would point at another server.
function serverEnv(env: Env): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [name, value] of Object.entries(env)) {
        if (value !== undefined && name !== 'TMUX' && name !== 'TMUX_PANE') {
            result[name] = value;
        }
    }
    return result;
}

function runTmux(file: string, args: readonly string[], env: Record<string, string>): Promise<TmuxOutput> {
    return new Promise((resolve) => {
        const child = spawn(file, [...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        const output = { stdout: '', stderr: '' };
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
            output.stdout += chunk;
        });
        child.stderr.on('data', (chunk: string) => {
            output.stderr += chunk;
        });
        child.on('error', (error) => {
            resolve({ code: 127, stdout: output.stdout, stderr: error.message });
        });
        child.on('close', (code) => {
            resolve({ code: code ?? 1, ...output });
        });
    });
}

// Starts an isolated tmux server (its own -L name, no config file) so tests never reach the default server.
export async function startTmuxServer(env: Env, opts?: { width?: number; height?: number }): Promise<TmuxServer> {
    const tmux = tmuxBinary(env);
    const name = `prwc-test-${process.pid}-${randomBytes(4).toString('hex')}`;
    const childEnv = serverEnv(env);
    const width = String(opts?.width ?? DEFAULT_WIDTH);
    const height = String(opts?.height ?? DEFAULT_HEIGHT);
    // tmux leaves its socket file behind; it is removed only once no server answers on that name any more.
    const kill = async (socketPath?: string): Promise<void> => {
        await runTmux(tmux, ['-L', name, 'kill-server'], childEnv);
        const probe = await runTmux(tmux, ['-L', name, 'list-sessions'], childEnv);
        if (probe.code !== 0 && socketPath !== undefined) {
            removeSocketFile(socketPath);
        }
    };
    const started = await runTmux(
        tmux,
        ['-L', name, '-f', '/dev/null', 'new-session', '-d', '-s', SESSION, '-x', width, '-y', height],
        childEnv
    );
    if (started.code !== 0) {
        await kill();
        throw new Error(`startTmuxServer: new-session failed: ${started.stderr}`);
    }
    const info = await runTmux(
        tmux,
        ['-L', name, 'display-message', '-p', '-t', SESSION, '#{pane_id} #{socket_path}'],
        childEnv
    );
    const line = info.stdout.trim();
    const space = line.indexOf(' ');
    if (info.code !== 0 || space <= 0) {
        await kill();
        throw new Error(`startTmuxServer: cannot read the server socket: ${info.stderr}`);
    }
    const pane = line.slice(0, space);
    const socket = line.slice(space + 1);
    return {
        name,
        socket,
        pane,
        envFor: () => ({ ...env, TMUX: `${socket},0,0`, TMUX_PANE: pane }),
        kill: () => kill(socket),
    };
}
