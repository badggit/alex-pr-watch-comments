import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { CommandRunner, Env } from '../../src/types.ts';

import { routingKey, toolName } from './stubRouting.ts';

const OFFLINE_COMMANDS: ReadonlySet<string> = new Set(['fetch', 'push', 'ls-remote']);
const REMOTE_NAME = 'remote.git';

function definedEntries(env: Env): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [name, value] of Object.entries(env)) {
        if (value !== undefined) {
            result[name] = value;
        }
    }
    return result;
}

// Runs git synchronously with exactly the given environment (git is found through its PATH) and returns stdout.
export function gitSync(env: Env, args: readonly string[], cwd?: string): string {
    return execFileSync('git', [...args], { env: definedEntries(env), cwd, encoding: 'utf8', stdio: 'pipe' });
}

function githubUrl(ownerRepo: string): string {
    return `https://github.com/${ownerRepo}.git`;
}

function commitFile(env: Env, dir: string, file: string, text: string, message: string): void {
    fs.writeFileSync(path.join(dir, file), text);
    gitSync(env, ['-C', dir, 'add', '--', file]);
    gitSync(env, ['-C', dir, 'commit', '--quiet', '-m', message]);
}

// Creates ROOT/remote.git with main and BRANCH (one commit each) and the clone ROOT/clone on BRANCH tracking
// origin/BRANCH, whose origin URL is the GitHub URL of OWNER/REPO with no insteadOf rewrite anywhere.
export function makePrClone(root: string, branch: string, ownerRepo = 'o/r', env: Env): string {
    const bare = path.join(root, REMOTE_NAME);
    const seed = path.join(root, 'seed');
    const clone = path.join(root, 'clone');
    fs.mkdirSync(root, { recursive: true });
    gitSync(env, ['init', '--quiet', '--bare', '--initial-branch=main', bare]);
    gitSync(env, ['init', '--quiet', '--initial-branch=main', seed]);
    commitFile(env, seed, 'README.md', 'main\n', 'main commit');
    gitSync(env, ['-C', seed, 'push', '--quiet', bare, 'main']);
    gitSync(env, ['-C', seed, 'checkout', '--quiet', '-b', branch]);
    commitFile(env, seed, 'feature.txt', 'feature\n', 'branch commit');
    gitSync(env, ['-C', seed, 'push', '--quiet', bare, branch]);
    fs.rmSync(seed, { recursive: true, force: true });
    gitSync(env, ['clone', '--quiet', '--branch', branch, bare, clone]);
    gitSync(env, ['-C', clone, 'remote', 'set-url', 'origin', githubUrl(ownerRepo)]);
    return clone;
}

// The test-only transport to ROOT/remote.git: fetch, push and ls-remote get a one-call insteadOf rewrite of the
// GitHub URL, every other call goes to inner unchanged.
export function offlineGitRunner(inner: CommandRunner, root: string, ownerRepo = 'o/r'): CommandRunner {
    const rewrite = `url.${path.join(root, REMOTE_NAME)}.insteadOf=${githubUrl(ownerRepo)}`;
    return {
        run: (request) => {
            const isGit = toolName(request.file) === 'git';
            if (!isGit || !OFFLINE_COMMANDS.has(routingKey('git', request.args))) {
                return inner.run(request);
            }
            return inner.run({ ...request, args: ['-c', rewrite, ...request.args] });
        },
    };
}

// Adds one commit to BRANCH in ROOT/remote.git through a temporary second clone and returns its sha.
export function pushRemoteCommit(root: string, branch: string, env: Env): string {
    const work = path.join(root, `pusher-${randomBytes(4).toString('hex')}`);
    try {
        gitSync(env, ['clone', '--quiet', '--branch', branch, path.join(root, REMOTE_NAME), work]);
        commitFile(env, work, 'remote.txt', `${work}\n`, 'remote commit');
        gitSync(env, ['-C', work, 'push', '--quiet', 'origin', branch]);
        return gitSync(env, ['-C', work, 'rev-parse', 'HEAD']).trim();
    } finally {
        fs.rmSync(work, { recursive: true, force: true });
    }
}
