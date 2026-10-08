import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test, type TestContext } from 'node:test';

import type { TargetFacts } from '../../src/newWorktreeDecide.ts';
import { gatherFacts, isGitBranchName, lockedByAdminDir, resolveStartCommit } from '../../src/newWorktreeFacts.ts';
import type { RepoLayout } from '../../src/newWorktreeRepo.ts';
import { createProcessRunner } from '../../src/proc.ts';
import type { CommandRunner } from '../../src/types.ts';
import { WORKTREE_PREFIX } from '../../src/watchWorktree.ts';
import { gitSync } from '../support/gitRepo.ts';
import { createTestEnv, type TestDeps, type TestEnv } from '../support/testEnv.ts';
import { addFetchedRemote, headOf, mainClone } from '../support/worktreeRepo.ts';

interface Setup {
    testEnv: TestEnv;
    gitRoot: string;
    clone: string;
    git: string;
    runner: CommandRunner;
    deps: TestDeps;
    repo: RepoLayout;
}

async function setUp(t: TestContext): Promise<Setup> {
    const testEnv = await createTestEnv();
    t.after(() => {
        testEnv.cleanup();
    });
    const gitRoot = path.join(testEnv.root, 'git');
    const clone = mainClone(gitRoot, testEnv.env);
    const runner = createProcessRunner(testEnv.env);
    return {
        testEnv,
        gitRoot,
        clone,
        git: path.join(testEnv.toolsDir, 'git'),
        runner,
        deps: testEnv.deps(runner),
        repo: { current: clone, main: clone, mainFound: true, linked: false },
    };
}

function git(setup: Setup, args: readonly string[]): string {
    return gitSync(setup.testEnv.env, args);
}

// Adds a linked worktree at GIT_ROOT/NAME and returns its canonical path; extra args go after the path.
function addWorktree(setup: Setup, name: string, extra: readonly string[]): string {
    const dir = path.join(setup.gitRoot, name);
    git(setup, ['-C', setup.clone, 'worktree', 'add', '--quiet', dir, ...extra]);
    return fs.realpathSync.native(dir);
}

async function factsFor(
    setup: Setup,
    targetPath: string,
    branch: string,
    deps: TestDeps = setup.deps
): Promise<TargetFacts> {
    const target = { name: path.basename(targetPath), path: targetPath, branch };
    const result = await gatherFacts(deps, setup.git, setup.repo, target, false);
    assert.ok(result.ok, result.ok ? '' : result.reason);
    return result.facts;
}

function isWorktreeList(args: readonly string[]): boolean {
    return args.includes('worktree') && args.includes('list');
}

// The git 2.29 porcelain format: no locked lines.
function withoutLockedLines(inner: CommandRunner): CommandRunner {
    return {
        run: async (request) => {
            const result = await inner.run(request);
            if (!isWorktreeList(request.args)) {
                return result;
            }
            const stdout = result.stdout
                .split('\n')
                .filter((line) => line !== 'locked' && !line.startsWith('locked '))
                .join('\n');
            return { ...result, stdout };
        },
    };
}

// Rewrites the worktree path FROM to TO in the porcelain worktree list.
function listedAs(inner: CommandRunner, from: string, to: string): CommandRunner {
    return {
        run: async (request) => {
            const result = await inner.run(request);
            if (!isWorktreeList(request.args)) {
                return result;
            }
            return { ...result, stdout: result.stdout.replaceAll(`worktree ${from}\n`, `worktree ${to}\n`) };
        },
    };
}

function failingGit(inner: CommandRunner, matches: (_args: readonly string[]) => boolean, code: number): CommandRunner {
    return {
        run: (request) =>
            matches(request.args)
                ? Promise.resolve({ code, stdout: '', stderr: 'fatal: broken\n' })
                : inner.run(request),
    };
}

async function refusalFor(setup: Setup, deps: TestDeps, branch: string): Promise<string> {
    const target = { name: 'new', path: path.join(setup.gitRoot, 'new'), branch };
    const result = await gatherFacts(deps, setup.git, setup.repo, target, false);
    assert.ok(!result.ok);
    return result.reason;
}

await describe('resolveStartCommit', async () => {
    await test('without a base it resolves the HEAD of the current linked worktree', async (t) => {
        const setup = await setUp(t);
        const linked = addWorktree(setup, 'linked', ['-b', 'linked-branch']);
        git(setup, ['-C', linked, 'commit', '--quiet', '--allow-empty', '-m', 'extra']);
        const result = await resolveStartCommit(setup.deps, setup.git, linked);
        assert.ok(result.ok);
        assert.equal(result.sha, headOf(setup.testEnv.env, linked));
        assert.notEqual(result.sha, headOf(setup.testEnv.env, setup.clone));
    });

    await test('a base resolves to its commit', async (t) => {
        const setup = await setUp(t);
        const linked = addWorktree(setup, 'linked', ['-b', 'linked-branch']);
        git(setup, ['-C', linked, 'commit', '--quiet', '--allow-empty', '-m', 'extra']);
        const result = await resolveStartCommit(setup.deps, setup.git, linked, 'main');
        assert.ok(result.ok);
        assert.equal(result.sha, headOf(setup.testEnv.env, setup.clone));
    });

    await test('an unknown base is refused', async (t) => {
        const setup = await setUp(t);
        const result = await resolveStartCommit(setup.deps, setup.git, setup.clone, 'nope');
        assert.ok(!result.ok);
        assert.equal(result.reason, 'unknown commit: nope');
    });

    await test('a base that looks like an option is refused without running git', async (t) => {
        const setup = await setUp(t);
        const deps = setup.testEnv.deps(failingGit(setup.runner, () => true, 0));
        const result = await resolveStartCommit(deps, setup.git, setup.clone, '--all');
        assert.ok(!result.ok);
        assert.equal(result.reason, 'unknown commit: --all');
    });

    await test('output that is not a full object id is refused', async (t) => {
        const setup = await setUp(t);
        const runner: CommandRunner = { run: () => Promise.resolve({ code: 0, stdout: 'abc123\n', stderr: '' }) };
        const result = await resolveStartCommit(setup.testEnv.deps(runner), setup.git, setup.clone, 'main');
        assert.ok(!result.ok);
        assert.equal(result.reason, 'cannot resolve commit: main');
    });

    await test('an unborn HEAD without a base is refused', async (t) => {
        const setup = await setUp(t);
        const fresh = path.join(setup.gitRoot, 'fresh');
        git(setup, ['init', '--quiet', fresh]);
        const result = await resolveStartCommit(setup.deps, setup.git, fresh);
        assert.ok(!result.ok);
        assert.match(result.reason, /no commits yet/u);
    });
});

await describe('isGitBranchName', async () => {
    await test('accepts a valid branch and rejects an invalid one', async (t) => {
        const setup = await setUp(t);
        assert.deepEqual(await isGitBranchName(setup.deps, setup.git, setup.clone, 'feature/x'), { kind: 'valid' });
        assert.deepEqual(await isGitBranchName(setup.deps, setup.git, setup.clone, 'x..y'), { kind: 'invalid' });
    });

    await test('a check that cannot start git is an error, not an invalid name', async (t) => {
        const setup = await setUp(t);
        const runner: CommandRunner = {
            run: () => Promise.resolve({ code: 127, stdout: '', stderr: '', spawnError: 'ENOENT' }),
        };
        const checked = await isGitBranchName(setup.testEnv.deps(runner), setup.git, setup.clone, 'feature/x');
        assert.deepEqual(checked, { kind: 'error', reason: 'cannot check branch name feature/x: ENOENT' });
    });

    await test('a fatal check is an error with the first stderr line', async (t) => {
        const setup = await setUp(t);
        const runner: CommandRunner = {
            run: () => Promise.resolve({ code: 128, stdout: '', stderr: 'fatal: broken\nmore\n' }),
        };
        const checked = await isGitBranchName(setup.testEnv.deps(runner), setup.git, setup.clone, 'feature/x');
        assert.deepEqual(checked, { kind: 'error', reason: 'cannot check branch name feature/x: fatal: broken' });
    });
});

await describe('gatherFacts branch facts', async () => {
    await test('an existing local branch with an absent target', async (t) => {
        const setup = await setUp(t);
        const facts = await factsFor(setup, path.join(setup.gitRoot, 'new'), 'feature');
        assert.equal(facts.targetState, 'absent');
        assert.equal(facts.registered, undefined);
        assert.ok(facts.localBranch);
        assert.ok(!facts.targetIsOwnTree);
        assert.equal(facts.holder, undefined);
    });

    await test('remote matches are listed per remote without a fetch', async (t) => {
        const setup = await setUp(t);
        git(setup, ['-C', setup.clone, 'branch', '--quiet', '-D', 'feature']);
        const target = path.join(setup.gitRoot, 'new');
        const before = await factsFor(setup, target, 'feature');
        assert.ok(!before.localBranch);
        assert.deepEqual(before.remoteMatches, ['origin/feature']);
        addFetchedRemote(setup.gitRoot, setup.clone, setup.testEnv.env, 'upstream');
        const after = await factsFor(setup, target, 'feature');
        assert.deepEqual(after.remoteMatches.toSorted(), ['origin/feature', 'upstream/feature']);
    });

    await test('a linked worktree on the branch is its holder', async (t) => {
        const setup = await setUp(t);
        const holder = addWorktree(setup, 'holder', ['feature']);
        const facts = await factsFor(setup, path.join(setup.gitRoot, 'new'), 'feature');
        assert.equal(facts.holder, holder);
    });
});

await describe('gatherFacts registered worktree', async () => {
    await test('an unlocked worktree on the branch is registered and not its own holder', async (t) => {
        const setup = await setUp(t);
        const dir = addWorktree(setup, 'wt', ['-b', 'wt-branch']);
        const facts = await factsFor(setup, dir, 'wt-branch');
        assert.equal(lockedByAdminDir(dir), 'unlocked');
        assert.deepEqual(facts.registered, {
            path: dir,
            folderName: 'wt',
            branch: 'wt-branch',
            detached: false,
            locked: false,
            missing: false,
        });
        assert.equal(facts.targetState, 'present');
        assert.equal(facts.holder, undefined);
    });

    await test('a locked worktree', async (t) => {
        const setup = await setUp(t);
        const dir = addWorktree(setup, 'wt', ['-b', 'wt-branch']);
        git(setup, ['-C', setup.clone, 'worktree', 'lock', dir]);
        const facts = await factsFor(setup, dir, 'wt-branch');
        assert.ok(facts.registered?.locked);
    });

    await test('a locked worktree without porcelain lock lines is locked through its admin directory', async (t) => {
        const setup = await setUp(t);
        const dir = addWorktree(setup, 'wt', ['-b', 'wt-branch']);
        git(setup, ['-C', setup.clone, 'worktree', 'lock', dir]);
        assert.equal(lockedByAdminDir(dir), 'locked');
        const deps = setup.testEnv.deps(withoutLockedLines(setup.runner));
        const facts = await factsFor(setup, dir, 'wt-branch', deps);
        assert.ok(facts.registered?.locked);
    });

    await test('an unreadable worktree .git file counts as locked', async (t) => {
        if (process.getuid?.() === 0) {
            t.skip('root reads files regardless of their mode');
            return;
        }
        const setup = await setUp(t);
        const dir = addWorktree(setup, 'wt', ['-b', 'wt-branch']);
        const dotGit = path.join(dir, '.git');
        fs.chmodSync(dotGit, 0o000);
        try {
            assert.equal(lockedByAdminDir(dir), 'unknown');
            const deps = setup.testEnv.deps(withoutLockedLines(setup.runner));
            const facts = await factsFor(setup, dir, 'wt-branch', deps);
            assert.ok(facts.registered?.locked);
        } finally {
            // The temp root cleanup runs first among the after hooks, so the mode is restored here.
            fs.chmodSync(dotGit, 0o644);
        }
    });

    await test('a .git file pointing at a missing admin directory gives an unknown lock state', async (t) => {
        const setup = await setUp(t);
        const dir = addWorktree(setup, 'wt', ['-b', 'wt-branch']);
        fs.writeFileSync(path.join(dir, '.git'), `gitdir: ${path.join(setup.gitRoot, 'no-such-admin')}\n`);
        assert.equal(lockedByAdminDir(dir), 'unknown');
        const deps = setup.testEnv.deps(withoutLockedLines(setup.runner));
        const facts = await factsFor(setup, dir, 'wt-branch', deps);
        assert.ok(facts.registered?.locked);
    });

    await test('a .git file pointing at an unrelated admin directory gives an unknown lock state', async (t) => {
        const setup = await setUp(t);
        const dir = addWorktree(setup, 'wt', ['-b', 'wt-branch']);
        const unrelated = path.join(setup.gitRoot, 'unrelated');
        fs.mkdirSync(unrelated);
        fs.writeFileSync(path.join(dir, '.git'), `gitdir: ${unrelated}\n`);
        assert.equal(lockedByAdminDir(dir), 'unknown');
        const deps = setup.testEnv.deps(withoutLockedLines(setup.runner));
        const facts = await factsFor(setup, dir, 'wt-branch', deps);
        assert.ok(facts.registered?.locked);
    });

    await test('an admin directory whose gitdir points elsewhere gives an unknown lock state', async (t) => {
        const setup = await setUp(t);
        const dir = addWorktree(setup, 'wt', ['-b', 'wt-branch']);
        const other = addWorktree(setup, 'other', ['-b', 'other-branch']);
        const adminDir = fs.readFileSync(path.join(other, '.git'), 'utf8').slice('gitdir: '.length).trim();
        fs.writeFileSync(path.join(dir, '.git'), `gitdir: ${adminDir}\n`);
        assert.equal(lockedByAdminDir(other), 'unlocked');
        assert.equal(lockedByAdminDir(dir), 'unknown');
    });

    await test('a malformed worktree .git file gives an unknown lock state', async (t) => {
        const setup = await setUp(t);
        const dir = path.join(setup.gitRoot, 'odd');
        fs.mkdirSync(dir);
        fs.writeFileSync(path.join(dir, '.git'), 'not a gitdir line\n');
        assert.equal(lockedByAdminDir(dir), 'unknown');
    });

    await test('a detached worktree', async (t) => {
        const setup = await setUp(t);
        const dir = addWorktree(setup, 'wt', ['-b', 'wt-branch']);
        git(setup, ['-C', dir, 'checkout', '--quiet', '--detach']);
        const facts = await factsFor(setup, dir, 'wt-branch');
        assert.ok(facts.registered?.detached);
        assert.equal(facts.registered.branch, undefined);
    });

    await test('a worktree whose folder is gone is missing', async (t) => {
        const setup = await setUp(t);
        const dir = addWorktree(setup, 'wt', ['-b', 'wt-branch']);
        fs.rmSync(dir, { recursive: true, force: true });
        const facts = await factsFor(setup, dir, 'wt-branch');
        assert.equal(facts.targetState, 'absent');
        assert.ok(facts.registered?.missing);
        assert.ok(!facts.registered.locked);
    });

    await test('a registration through a symlinked parent whose folder is gone is found as missing', async (t) => {
        const setup = await setUp(t);
        const real = path.join(setup.gitRoot, 'real');
        const alias = path.join(setup.gitRoot, 'alias');
        fs.mkdirSync(real);
        fs.symlinkSync(real, alias);
        git(setup, ['-C', setup.clone, 'worktree', 'add', '--quiet', path.join(alias, 'wt'), '-b', 'wt-branch']);
        const realDir = path.join(fs.realpathSync.native(real), 'wt');
        const aliasDir = path.join(alias, 'wt');
        fs.rmSync(realDir, { recursive: true, force: true });
        // Recent git lists the real path; older git lists the path as it was given, through the alias.
        const aliasDeps = setup.testEnv.deps(listedAs(setup.runner, realDir, aliasDir));
        for (const deps of [setup.deps, aliasDeps]) {
            for (const target of [realDir, aliasDir]) {
                const facts = await factsFor(setup, target, 'wt-branch', deps);
                assert.equal(facts.targetState, 'absent');
                assert.ok(facts.registered?.missing);
                assert.ok(!facts.registered.locked);
                assert.equal(facts.registered.folderName, 'wt');
            }
        }
    });
});

await describe('gatherFacts target state', async () => {
    await test('a symlink at the target', async (t) => {
        const setup = await setUp(t);
        const target = path.join(setup.gitRoot, 'link');
        fs.symlinkSync(path.join(setup.gitRoot, 'elsewhere'), target);
        const facts = await factsFor(setup, target, 'feature');
        assert.equal(facts.targetState, 'symlink');
    });

    await test('a symlink to a watcher worktree is a symlink with the watcher entry registered', async (t) => {
        const setup = await setUp(t);
        const watcher = addWorktree(setup, `${WORKTREE_PREFIX}7`, ['-b', 'pr-7']);
        const target = path.join(setup.gitRoot, 'link');
        fs.symlinkSync(watcher, target);
        const facts = await factsFor(setup, target, 'feature');
        assert.equal(facts.targetState, 'symlink');
        assert.ok(facts.registered?.folderName.startsWith(WORKTREE_PREFIX));
    });

    await test('an empty folder is present', async (t) => {
        const setup = await setUp(t);
        const target = path.join(setup.gitRoot, 'empty');
        fs.mkdirSync(target);
        const facts = await factsFor(setup, target, 'feature');
        assert.equal(facts.targetState, 'present');
        assert.equal(facts.registered, undefined);
    });

    await test('a target under an unsearchable folder is unreadable', async (t) => {
        if (process.getuid?.() === 0) {
            t.skip('root reads folders regardless of their mode');
            return;
        }
        const setup = await setUp(t);
        const closed = path.join(setup.gitRoot, 'closed');
        fs.mkdirSync(closed);
        fs.chmodSync(closed, 0o000);
        try {
            const facts = await factsFor(setup, path.join(closed, 'wt'), 'feature');
            assert.equal(facts.targetState, 'unreadable');
        } finally {
            fs.chmodSync(closed, 0o755);
        }
    });

    await test('the main clone is its own tree', async (t) => {
        const setup = await setUp(t);
        const facts = await factsFor(setup, setup.clone, 'main');
        assert.ok(facts.targetIsOwnTree);
    });
});

await describe('gatherFacts failure', async () => {
    await test('a failing worktree list is refused', async (t) => {
        const setup = await setUp(t);
        const deps = setup.testEnv.deps(failingGit(setup.runner, (args) => isWorktreeList(args), 1));
        assert.equal(await refusalFor(setup, deps, 'feature'), 'cannot list the worktrees of the repository');
    });

    await test('a failing remote list is refused', async (t) => {
        const setup = await setUp(t);
        const deps = setup.testEnv.deps(failingGit(setup.runner, (args) => args.at(-1) === 'remote', 1));
        assert.equal(await refusalFor(setup, deps, 'feature'), 'cannot list the remotes of the repository');
    });

    await test('a fatal local branch query is refused', async (t) => {
        const setup = await setUp(t);
        const ref = 'refs/heads/feature';
        const deps = setup.testEnv.deps(failingGit(setup.runner, (args) => args.includes(ref), 128));
        assert.equal(await refusalFor(setup, deps, 'feature'), `cannot check branch ${ref}: fatal: broken`);
    });

    await test('a fatal remote-tracking query is refused', async (t) => {
        const setup = await setUp(t);
        const ref = 'refs/remotes/origin/feature';
        const deps = setup.testEnv.deps(failingGit(setup.runner, (args) => args.includes(ref), 128));
        assert.equal(await refusalFor(setup, deps, 'feature'), `cannot check remote branch ${ref}: fatal: broken`);
    });

    await test('a branch query that cannot start git is refused', async (t) => {
        const setup = await setUp(t);
        const runner: CommandRunner = {
            run: (request) =>
                request.args.includes('show-ref')
                    ? Promise.resolve({ code: 127, stdout: '', stderr: '', spawnError: 'ENOENT' })
                    : setup.runner.run(request),
        };
        const reason = await refusalFor(setup, setup.testEnv.deps(runner), 'feature');
        assert.equal(reason, 'cannot check remote branch refs/remotes/origin/feature: ENOENT');
    });
});
