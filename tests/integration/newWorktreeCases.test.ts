import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test, type TestContext } from 'node:test';

import { createCloner, type Cloner } from '../../src/cowClone.ts';
import type { NewWorktreeArgs } from '../../src/newWorktreeArgs.ts';
import { runNewWorktree, type NewWorktreeOutcome } from '../../src/newWorktreeCommand.ts';
import { createProcessRunner } from '../../src/proc.ts';
import type { CommandRunner, Env } from '../../src/types.ts';
import { gitSync } from '../support/gitRepo.ts';
import { createTestEnv, type TestDeps } from '../support/testEnv.ts';
import { addFetchedRemote, mainClone } from '../support/worktreeRepo.ts';

const IGNORE_RULES = ['node_modules/', '.env', ''].join('\n');
const NO_ARGS: NewWorktreeArgs = { name: undefined, task: undefined, branch: undefined, base: undefined };

interface Setup {
    env: Env;
    gitRoot: string;
    clone: string;
    parent: string;
    deps: TestDeps;
}

interface RunOptions {
    cloner?: Cloner;
    wrap?: (_inner: CommandRunner) => CommandRunner;
}

// What a refused run must leave untouched: the local branches and the worktree registrations.
interface Snapshot {
    branches: string;
    worktrees: string;
}

async function setUp(t: TestContext): Promise<Setup> {
    const testEnv = await createTestEnv();
    t.after(() => {
        testEnv.cleanup();
    });
    const gitRoot = path.join(testEnv.root, 'git');
    const clone = mainClone(gitRoot, testEnv.env);
    return {
        env: testEnv.env,
        gitRoot,
        clone,
        parent: path.dirname(clone),
        deps: testEnv.deps(createProcessRunner(testEnv.env)),
    };
}

function git(setup: Setup, dir: string, args: readonly string[]): string {
    return gitSync(setup.env, ['-C', dir, ...args]);
}

function snapshot(setup: Setup): Snapshot {
    return {
        branches: git(setup, setup.clone, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads']),
        worktrees: git(setup, setup.clone, ['worktree', 'list', '--porcelain']),
    };
}

function seedIgnored(setup: Setup): void {
    const { clone } = setup;
    fs.writeFileSync(path.join(clone, '.git', 'info', 'exclude'), IGNORE_RULES);
    fs.mkdirSync(path.join(clone, 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(clone, 'node_modules', 'pkg', 'index.js'), 'kept\n');
    fs.writeFileSync(path.join(clone, '.env'), 'KEY=value\n');
}

function addLinked(setup: Setup, name: string, branchArgs: readonly string[]): string {
    const linked = path.join(setup.parent, name);
    git(setup, setup.clone, ['worktree', 'add', '--quiet', linked, ...branchArgs]);
    return fs.realpathSync.native(linked);
}

function exists(file: string): boolean {
    try {
        fs.lstatSync(file);
        return true;
    } catch {
        return false;
    }
}

function branchExists(setup: Setup, branch: string): boolean {
    return git(setup, setup.clone, ['branch', '--list', branch]).trim().length > 0;
}

function run(setup: Setup, args: Partial<NewWorktreeArgs>, options: RunOptions = {}): Promise<NewWorktreeOutcome> {
    return runNewWorktree(
        {
            env: setup.env,
            log: setup.deps.log,
            makeRunner: (env) => {
                const inner = createProcessRunner(env);
                return options.wrap === undefined ? inner : options.wrap(inner);
            },
            cloner: options.cloner ?? createCloner({ platform: 'aix' }),
        },
        { ...NO_ARGS, ...args },
        setup.clone
    );
}

function refusalOf(outcome: NewWorktreeOutcome): string {
    assert.equal(outcome.kind, 'refused', JSON.stringify(outcome));
    assert.ok(outcome.kind === 'refused');
    return outcome.reason;
}

function okPath(outcome: NewWorktreeOutcome): string {
    assert.equal(outcome.kind, 'ok', JSON.stringify(outcome));
    assert.ok(outcome.kind === 'ok');
    return outcome.path;
}

// Fails every ls-files call as git would on a broken index and forwards everything else.
function failingLsFiles(inner: CommandRunner): CommandRunner {
    return {
        run: (request) =>
            request.args.includes('ls-files')
                ? Promise.resolve({ code: 128, stdout: '', stderr: 'fatal: index file corrupt\n' })
                : inner.run(request),
    };
}

await describe('runNewWorktree decision cases', async () => {
    await test('a branch on two remotes is refused with both candidates', async (t) => {
        const setup = await setUp(t);
        addFetchedRemote(setup.gitRoot, setup.clone, setup.env, 'upstream');
        git(setup, setup.clone, ['branch', '--quiet', '-D', 'feature']);
        const before = snapshot(setup);
        const reason = refusalOf(await run(setup, { name: 'x', branch: 'feature' }));
        assert.equal(
            reason,
            'branch feature exists on several remotes (origin/feature, upstream/feature); create it locally first'
        );
        assert.deepEqual(snapshot(setup), before);
        assert.ok(!exists(path.join(setup.parent, 'x')));
    });

    await test('a branch checked out in another worktree is refused naming that worktree', async (t) => {
        const setup = await setUp(t);
        const holder = addLinked(setup, 'holder', ['feature']);
        const before = snapshot(setup);
        const reason = refusalOf(await run(setup, { name: 'x', branch: 'feature' }));
        assert.equal(reason, `branch feature is checked out in another worktree: ${holder}`);
        assert.deepEqual(snapshot(setup), before);
        assert.ok(!exists(path.join(setup.parent, 'x')));
    });

    await test('a worktree at the target on another branch is refused naming its branch', async (t) => {
        const setup = await setUp(t);
        const occupied = addLinked(setup, 'x', ['feature']);
        const before = snapshot(setup);
        const reason = refusalOf(await run(setup, { name: 'x' }));
        assert.equal(reason, `${occupied} is a worktree on branch feature, not on x`);
        assert.deepEqual(snapshot(setup), before);
        assert.ok(!branchExists(setup, 'x'));
    });

    await test('a symlink at the target to a watcher worktree is refused and left alone', async (t) => {
        const setup = await setUp(t);
        const watcher = addLinked(setup, 'alex-pr-watch-comments-pr-7', ['-b', 'pr-7']);
        const link = path.join(setup.parent, 'x');
        fs.symlinkSync(watcher, link);
        const entries = fs.readdirSync(watcher).toSorted();
        const before = snapshot(setup);
        const reason = refusalOf(await run(setup, { name: 'x' }));
        assert.equal(reason, `${link} is a symlink; refusing to follow it`);
        assert.equal(fs.readlinkSync(link), watcher);
        assert.deepEqual(fs.readdirSync(watcher).toSorted(), entries);
        assert.deepEqual(snapshot(setup), before);
    });

    await test('--base with an existing local branch is refused', async (t) => {
        const setup = await setUp(t);
        const before = snapshot(setup);
        const reason = refusalOf(await run(setup, { name: 'x', branch: 'feature', base: 'main' }));
        assert.equal(reason, '--base applies only to a new branch; branch feature already exists');
        assert.deepEqual(snapshot(setup), before);
        assert.ok(!exists(path.join(setup.parent, 'x')));
    });

    await test('a failing post-checkout hook keeps the worktree and the branch without syncing', async (t) => {
        const setup = await setUp(t);
        seedIgnored(setup);
        const hook = path.join(setup.clone, '.git', 'hooks', 'post-checkout');
        fs.mkdirSync(path.dirname(hook), { recursive: true });
        fs.writeFileSync(hook, ['#!/bin/sh', 'exit 1', ''].join('\n'), { mode: 0o755 });
        const target = path.join(setup.parent, 'hooked');
        const reason = refusalOf(await run(setup, { name: 'hooked' }));
        assert.ok(reason.startsWith(`the worktree exists at ${target} on hooked`), reason);
        const listed = git(setup, setup.clone, ['worktree', 'list', '--porcelain']);
        assert.ok(listed.split('\n').includes(`worktree ${target}`), listed);
        assert.ok(branchExists(setup, 'hooked'));
        assert.ok(!exists(path.join(target, 'node_modules')));
        assert.ok(!exists(path.join(target, '.env')));
    });

    await test('a sync that cannot list the ignored files is a warning and the run succeeds', async (t) => {
        const setup = await setUp(t);
        seedIgnored(setup);
        const outcome = await run(setup, { name: 'listless' }, { wrap: failingLsFiles });
        const created = okPath(outcome);
        assert.equal(created, path.join(setup.parent, 'listless'));
        assert.ok(
            setup.deps.logLines.some((line) => line.startsWith('warn cannot list the ignored files')),
            setup.deps.logLines.join('\n')
        );
        assert.ok(!exists(path.join(created, 'node_modules')));
    });

    await test('without copy-on-write node_modules is linked to the main clone', async (t) => {
        const setup = await setUp(t);
        seedIgnored(setup);
        const created = okPath(await run(setup, { name: 'linkonly' }, { cloner: createCloner({ platform: 'aix' }) }));
        const modules = path.join(created, 'node_modules');
        assert.ok(fs.lstatSync(modules).isSymbolicLink());
        assert.equal(fs.readlinkSync(modules), path.join(setup.clone, 'node_modules'));
        assert.ok(
            setup.deps.logLines.some((line) => line.startsWith('info ') && line.includes('no copy-on-write')),
            setup.deps.logLines.join('\n')
        );
    });
});
