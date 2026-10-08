import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test, type TestContext } from 'node:test';

import type { WorktreeTarget } from '../../src/newWorktreeArgs.ts';
import { applyDecision, type ApplyResult, type ApplyStep } from '../../src/newWorktreeCreate.ts';
import type { RepoLayout } from '../../src/newWorktreeRepo.ts';
import { createProcessRunner } from '../../src/proc.ts';
import type { CommandRequest, CommandResult, CommandRunner, Env } from '../../src/types.ts';
import { gitSync } from '../support/gitRepo.ts';
import { createTestEnv, type TestDeps } from '../support/testEnv.ts';
import { headOf, mainClone } from '../support/worktreeRepo.ts';

const BRANCH = 'feature';

interface Setup {
    env: Env;
    clone: string;
    git: string;
    repo: RepoLayout;
    target: WorktreeTarget;
    deps(_runner?: CommandRunner): TestDeps;
    inner: CommandRunner;
}

async function setUp(t: TestContext): Promise<Setup> {
    const testEnv = await createTestEnv();
    t.after(() => {
        testEnv.cleanup();
    });
    const clone = mainClone(path.join(testEnv.root, 'git'), testEnv.env);
    const inner = createProcessRunner(testEnv.env);
    return {
        env: testEnv.env,
        clone,
        git: path.join(testEnv.toolsDir, 'git'),
        repo: { current: clone, main: clone, mainFound: true, linked: false },
        target: { name: 'wt', path: path.join(path.dirname(clone), 'wt'), branch: BRANCH },
        deps: (runner) => testEnv.deps(runner ?? inner),
        inner,
    };
}

function isGitCall(request: CommandRequest, first: string, second: string): boolean {
    return request.args.includes(first) && request.args.includes(second);
}

// Places a file at the target path right before git worktree add runs, so the add fails without registering.
function blockingRunner(inner: CommandRunner, target: string, afterAdd?: () => void): CommandRunner {
    return {
        run: async (request) => {
            if (!isGitCall(request, 'worktree', 'add')) {
                return inner.run(request);
            }
            fs.writeFileSync(target, 'blocker\n');
            const result = await inner.run(request);
            afterAdd?.();
            return result;
        },
    };
}

// Fails the git branch --set-upstream-to call without running it.
function failingUpstreamRunner(inner: CommandRunner, calls: CommandRequest[]): CommandRunner {
    const failed: CommandResult = { code: 128, stdout: '', stderr: 'fatal: upstream refused\nsecond line\n' };
    return {
        run: (request) => {
            calls.push(request);
            const setsUpstream = request.args.some((arg) => arg.startsWith('--set-upstream-to='));
            return setsUpstream ? Promise.resolve(failed) : inner.run(request);
        },
    };
}

// Runs git worktree add, then removes the new folder and reports a failure, so the registration stays behind
// with its folder gone; the porcelain list spells the path FROM as TO, and rewrites counts the rewritten lists.
function registeringFailureRunner(
    inner: CommandRunner,
    from: string,
    to: string,
    rewrites: { count: number }
): CommandRunner {
    return {
        run: async (request) => {
            if (isGitCall(request, 'worktree', 'add')) {
                await inner.run(request);
                fs.rmSync(from, { recursive: true, force: true });
                return { code: 128, stdout: '', stderr: 'fatal: injected add failure\n' };
            }
            const result = await inner.run(request);
            if (!isGitCall(request, 'worktree', 'list') || !result.stdout.includes(`worktree ${from}\n`)) {
                return result;
            }
            rewrites.count += 1;
            return { ...result, stdout: result.stdout.replaceAll(`worktree ${from}\n`, `worktree ${to}\n`) };
        },
    };
}

function failingListRunner(inner: CommandRunner): CommandRunner {
    const failed: CommandResult = { code: 128, stdout: '', stderr: 'fatal: list failed\n' };
    return {
        run: (request) => (isGitCall(request, 'worktree', 'list') ? Promise.resolve(failed) : inner.run(request)),
    };
}

function git(setup: Setup, args: readonly string[]): string {
    return gitSync(setup.env, ['-C', setup.clone, ...args]).trim();
}

function branchExists(setup: Setup): boolean {
    try {
        git(setup, ['rev-parse', '--verify', '--quiet', `refs/heads/${BRANCH}`]);
        return true;
    } catch {
        return false;
    }
}

function upstreamOf(setup: Setup): string {
    return git(setup, ['rev-parse', '--abbrev-ref', `${BRANCH}@{upstream}`]);
}

function registeredPaths(setup: Setup): string[] {
    return git(setup, ['worktree', 'list', '--porcelain'])
        .split('\n')
        .filter((line) => line.startsWith('worktree '))
        .map((line) => fs.realpathSync.native(line.slice('worktree '.length)));
}

function isRegistered(setup: Setup): boolean {
    return (
        fs.existsSync(setup.target.path) && registeredPaths(setup).includes(fs.realpathSync.native(setup.target.path))
    );
}

function refusalOf(result: ApplyResult): string {
    assert.ok(!result.ok);
    return result.reason;
}

function deleteLocalBranch(setup: Setup): void {
    git(setup, ['branch', '--quiet', '-D', BRANCH]);
}

function mainSha(setup: Setup): string {
    return git(setup, ['rev-parse', 'refs/remotes/origin/main']);
}

await describe('applyDecision', async () => {
    await test('reuse runs no git and logs the reuse', async (t) => {
        const setup = await setUp(t);
        const calls: CommandRequest[] = [];
        const deps = setup.deps({
            run: (request) => {
                calls.push(request);
                return setup.inner.run(request);
            },
        });
        assert.deepEqual(await applyDecision(deps, setup.git, setup.repo, setup.target, { kind: 'reuse' }), {
            ok: true,
        });
        assert.equal(calls.length, 0);
        assert.deepEqual(deps.logLines, [`info reusing worktree ${setup.target.path} on ${BRANCH}`]);
    });

    await test('create makes a new branch at the start sha without an upstream', async (t) => {
        const setup = await setUp(t);
        deleteLocalBranch(setup);
        const startSha = mainSha(setup);
        const deps = setup.deps();
        const step: ApplyStep = { kind: 'create', startSha };
        assert.deepEqual(await applyDecision(deps, setup.git, setup.repo, setup.target, step), { ok: true });
        assert.ok(isRegistered(setup));
        assert.equal(headOf(setup.env, setup.target.path), startSha);
        assert.equal(gitSync(setup.env, ['-C', setup.target.path, 'branch', '--show-current']).trim(), BRANCH);
        assert.throws(() => upstreamOf(setup));
        assert.deepEqual(deps.logLines, [
            `info created worktree ${setup.target.path} on new branch ${BRANCH} from ${startSha.slice(0, 7)}`,
        ]);
    });

    await test('checkout puts the worktree on the existing local branch', async (t) => {
        const setup = await setUp(t);
        const before = git(setup, ['rev-parse', `refs/heads/${BRANCH}`]);
        const deps = setup.deps();
        assert.deepEqual(await applyDecision(deps, setup.git, setup.repo, setup.target, { kind: 'checkout' }), {
            ok: true,
        });
        assert.equal(gitSync(setup.env, ['-C', setup.target.path, 'branch', '--show-current']).trim(), BRANCH);
        assert.equal(headOf(setup.env, setup.target.path), before);
        assert.deepEqual(deps.logLines, [`info created worktree ${setup.target.path} on existing branch ${BRANCH}`]);
    });

    await test('track creates the branch from the remote with its upstream', async (t) => {
        const setup = await setUp(t);
        deleteLocalBranch(setup);
        const deps = setup.deps();
        const step: ApplyStep = { kind: 'track', remote: 'origin' };
        assert.deepEqual(await applyDecision(deps, setup.git, setup.repo, setup.target, step), { ok: true });
        assert.equal(gitSync(setup.env, ['-C', setup.target.path, 'branch', '--show-current']).trim(), BRANCH);
        assert.equal(upstreamOf(setup), `origin/${BRANCH}`);
        assert.deepEqual(deps.logLines, [
            `info created worktree ${setup.target.path} on new branch ${BRANCH} tracking origin/${BRANCH}`,
        ]);
    });

    await test('create refuses at the branch step when the branch already exists', async (t) => {
        const setup = await setUp(t);
        const before = git(setup, ['rev-parse', `refs/heads/${BRANCH}`]);
        const step: ApplyStep = { kind: 'create', startSha: mainSha(setup) };
        const reason = refusalOf(await applyDecision(setup.deps(), setup.git, setup.repo, setup.target, step));
        assert.match(reason, /already exists/u);
        assert.equal(git(setup, ['rev-parse', `refs/heads/${BRANCH}`]), before);
        assert.ok(!fs.existsSync(setup.target.path));
        assert.equal(registeredPaths(setup).length, 1);
    });

    await test('a failing post-checkout hook keeps the registered worktree and the branch', async (t) => {
        const setup = await setUp(t);
        deleteLocalBranch(setup);
        const hook = path.join(setup.clone, '.git', 'hooks', 'post-checkout');
        fs.mkdirSync(path.dirname(hook), { recursive: true });
        fs.writeFileSync(hook, '#!/bin/sh\necho hook failed >&2\nexit 1\n', { mode: 0o755 });
        const step: ApplyStep = { kind: 'create', startSha: mainSha(setup) };
        const reason = refusalOf(await applyDecision(setup.deps(), setup.git, setup.repo, setup.target, step));
        assert.ok(
            reason.startsWith(`the worktree exists at ${setup.target.path} on ${BRANCH} but git reported an error: `),
            reason
        );
        assert.ok(isRegistered(setup));
        assert.ok(branchExists(setup));
    });

    await test('a failed create without registration removes the owned branch', async (t) => {
        const setup = await setUp(t);
        deleteLocalBranch(setup);
        const deps = setup.deps(blockingRunner(setup.inner, setup.target.path));
        const step: ApplyStep = { kind: 'create', startSha: mainSha(setup) };
        const reason = refusalOf(await applyDecision(deps, setup.git, setup.repo, setup.target, step));
        assert.match(reason, /already exists/u);
        assert.ok(!reason.includes('\n'));
        assert.ok(!branchExists(setup));
        assert.equal(registeredPaths(setup).length, 1);
    });

    await test('a failed track without registration removes the branch and its upstream keys', async (t) => {
        const setup = await setUp(t);
        deleteLocalBranch(setup);
        const deps = setup.deps(blockingRunner(setup.inner, setup.target.path));
        const step: ApplyStep = { kind: 'track', remote: 'origin' };
        const reason = refusalOf(await applyDecision(deps, setup.git, setup.repo, setup.target, step));
        assert.match(reason, /already exists/u);
        assert.ok(!branchExists(setup));
        assert.throws(() => git(setup, ['config', '--get-regexp', String.raw`^branch\.feature\.`]));
        fs.rmSync(setup.target.path);
        const create: ApplyStep = { kind: 'create', startSha: mainSha(setup) };
        assert.deepEqual(await applyDecision(setup.deps(), setup.git, setup.repo, setup.target, create), {
            ok: true,
        });
        assert.throws(() => upstreamOf(setup));
    });

    await test('a branch moved after the failed add is kept at its new commit', async (t) => {
        const setup = await setUp(t);
        deleteLocalBranch(setup);
        const startSha = mainSha(setup);
        const moved = git(setup, ['rev-parse', `refs/remotes/origin/${BRANCH}`]);
        const deps = setup.deps(
            blockingRunner(setup.inner, setup.target.path, () => {
                git(setup, ['update-ref', `refs/heads/${BRANCH}`, moved]);
            })
        );
        const step: ApplyStep = { kind: 'create', startSha };
        refusalOf(await applyDecision(deps, setup.git, setup.repo, setup.target, step));
        assert.equal(git(setup, ['rev-parse', `refs/heads/${BRANCH}`]), moved);
    });

    await test('a branch replaced by a symbolic ref is not followed by the rollback', async (t) => {
        const setup = await setUp(t);
        deleteLocalBranch(setup);
        const startSha = mainSha(setup);
        const other = 'other';
        git(setup, ['branch', '--no-track', other, startSha]);
        const deps = setup.deps(
            blockingRunner(setup.inner, setup.target.path, () => {
                git(setup, ['update-ref', '-d', `refs/heads/${BRANCH}`]);
                git(setup, ['symbolic-ref', `refs/heads/${BRANCH}`, `refs/heads/${other}`]);
            })
        );
        const step: ApplyStep = { kind: 'create', startSha };
        refusalOf(await applyDecision(deps, setup.git, setup.repo, setup.target, step));
        assert.equal(git(setup, ['rev-parse', `refs/heads/${other}`]), startSha);
    });

    await test('a failed upstream setup removes the tracked branch and adds no worktree', async (t) => {
        const setup = await setUp(t);
        deleteLocalBranch(setup);
        const calls: CommandRequest[] = [];
        const deps = setup.deps(failingUpstreamRunner(setup.inner, calls));
        const step: ApplyStep = { kind: 'track', remote: 'origin' };
        const reason = refusalOf(await applyDecision(deps, setup.git, setup.repo, setup.target, step));
        assert.equal(reason, `cannot set the upstream of ${BRANCH} to origin/${BRANCH}: fatal: upstream refused`);
        assert.ok(!branchExists(setup));
        assert.throws(() => git(setup, ['config', '--get-regexp', String.raw`^branch\.feature\.`]));
        assert.ok(!calls.some((request) => isGitCall(request, 'worktree', 'add')));
        assert.ok(!fs.existsSync(setup.target.path));
        assert.equal(registeredPaths(setup).length, 1);
    });

    await test('a failed upstream setup keeps the branch once another worktree checked it out', async (t) => {
        const setup = await setUp(t);
        deleteLocalBranch(setup);
        const other = path.join(path.dirname(setup.clone), 'other');
        const failed: CommandResult = { code: 128, stdout: '', stderr: 'fatal: upstream refused\n' };
        const runner: CommandRunner = {
            run: (request) => {
                if (!request.args.some((arg) => arg.startsWith('--set-upstream-to='))) {
                    return setup.inner.run(request);
                }
                git(setup, ['worktree', 'add', '--quiet', other, BRANCH]);
                return Promise.resolve(failed);
            },
        };
        const deps = setup.deps(runner);
        const step: ApplyStep = { kind: 'track', remote: 'origin' };
        const reason = refusalOf(await applyDecision(deps, setup.git, setup.repo, setup.target, step));
        assert.equal(reason, `cannot set the upstream of ${BRANCH} to origin/${BRANCH}: fatal: upstream refused`);
        assert.ok(branchExists(setup));
        assert.ok(deps.logLines.includes(`warn branch ${BRANCH} was kept: it may be checked out in a worktree`));
    });

    await test('a registration listed through a symlinked parent alias is kept after a failed add', async (t) => {
        const setup = await setUp(t);
        deleteLocalBranch(setup);
        const parent = path.dirname(setup.clone);
        const real = path.join(parent, 'real');
        const alias = path.join(parent, 'alias');
        fs.mkdirSync(real);
        fs.symlinkSync(real, alias);
        const target: WorktreeTarget = {
            name: 'wt',
            path: path.join(fs.realpathSync.native(real), 'wt'),
            branch: BRANCH,
        };
        const rewrites = { count: 0 };
        const runner = registeringFailureRunner(setup.inner, target.path, path.join(alias, 'wt'), rewrites);
        const step: ApplyStep = { kind: 'create', startSha: mainSha(setup) };
        const reason = refusalOf(await applyDecision(setup.deps(runner), setup.git, setup.repo, target, step));
        assert.ok(rewrites.count > 0);
        assert.equal(
            reason,
            `the worktree exists at ${target.path} on ${BRANCH} but git reported an error: fatal: injected add failure`
        );
        assert.ok(branchExists(setup));
        assert.ok(git(setup, ['worktree', 'list', '--porcelain']).includes(`worktree ${target.path}\n`));
    });

    await test('a failed re-read of the worktree list keeps the owned branch', async (t) => {
        const setup = await setUp(t);
        deleteLocalBranch(setup);
        const runner = failingListRunner(blockingRunner(setup.inner, setup.target.path));
        const step: ApplyStep = { kind: 'track', remote: 'origin' };
        const reason = refusalOf(await applyDecision(setup.deps(runner), setup.git, setup.repo, setup.target, step));
        assert.match(reason, new RegExp(`already exists.*; branch ${BRANCH} was kept$`, 'u'));
        assert.ok(branchExists(setup));
        assert.equal(upstreamOf(setup), `origin/${BRANCH}`);
    });
});
