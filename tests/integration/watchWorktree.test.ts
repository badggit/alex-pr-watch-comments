import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test, type TestContext } from 'node:test';

import { CLONE_TEMP_PREFIX, createCloner } from '../../src/cowClone.ts';
import { runGuards } from '../../src/guards.ts';
import { syncIgnoredLinks } from '../../src/ignoredLinks.ts';
import { acquireWorktreeLock, releaseWorktreeLock } from '../../src/locks.ts';
import { createProcessRunner } from '../../src/proc.ts';
import { initState, worktreeKey } from '../../src/stateStore.ts';
import type { CommandRunner, PrRef, Session, WatchWorktree } from '../../src/types.ts';
import {
    prepareWatchWorktree,
    removeWatchWorktree,
    watchWorktreePath,
    type WorktreeResult,
} from '../../src/watchWorktree.ts';
import { gitSync, makePrClone, offlineGitRunner, pushRemoteCommit } from '../support/gitRepo.ts';
import { createTestEnv, type TestDeps, type TestEnv } from '../support/testEnv.ts';

const BRANCH = 'feature';
const PR: PrRef = {
    host: 'github.com',
    owner: 'o',
    repo: 'r',
    number: 12,
    prUrl: 'https://github.com/o/r/pull/12',
    prKey: 'o+r+12',
};
const IGNORE_RULES = ['node_modules/', '.env', 'dist/', '*.local.md', 'docs.local', '*.tsbuildinfo', ''].join('\n');
const linkOnly = createCloner({ platform: 'aix' });

interface Setup {
    testEnv: TestEnv;
    gitRoot: string;
    clone: string;
    target: string;
    git: string;
    runner: CommandRunner;
    deps: TestDeps;
}

async function setUp(t: TestContext): Promise<Setup> {
    const testEnv = await createTestEnv();
    t.after(() => {
        testEnv.cleanup();
    });
    const gitRoot = path.join(testEnv.root, 'git');
    const clone = fs.realpathSync.native(makePrClone(gitRoot, BRANCH, 'o/r', testEnv.env));
    const runner = offlineGitRunner(createProcessRunner(testEnv.env), gitRoot);
    assert.ok(initState(testEnv.stateDir).ok);
    return {
        testEnv,
        gitRoot,
        clone,
        target: watchWorktreePath(clone, PR.number),
        git: path.join(testEnv.toolsDir, 'git'),
        runner,
        deps: testEnv.deps(runner),
    };
}

function git(setup: Setup, dir: string, args: readonly string[]): string {
    return gitSync(setup.testEnv.env, ['-C', dir, ...args]).trim();
}

// The usual start: the owner has switched the clone to another branch, the local head branch stays.
function leaveBranch(setup: Setup): void {
    git(setup, setup.clone, ['checkout', '--quiet', 'main']);
}

function prepare(setup: Setup, sourceToplevel = setup.clone): Promise<WorktreeResult> {
    return prepareWatchWorktree(setup.deps, {
        gitPath: setup.git,
        sourceToplevel,
        prNumber: PR.number,
        remote: 'origin',
        branch: BRANCH,
    });
}

async function prepared(setup: Setup, sourceToplevel?: string): Promise<WatchWorktree> {
    const result = await prepare(setup, sourceToplevel);
    assert.ok(result.ok, result.ok ? '' : result.reason);
    return result.worktree;
}

async function refusal(setup: Setup): Promise<string> {
    const result = await prepare(setup);
    assert.ok(!result.ok, 'prepareWatchWorktree was expected to refuse');
    return result.reason;
}

function sessionFor(setup: Setup, worktree: WatchWorktree): Session {
    const { testEnv } = setup;
    return {
        pr: PR,
        viewer: 'reviewer',
        headRef: BRANCH,
        headOwner: 'o',
        headRepo: 'r',
        remote: 'origin',
        dirCanon: worktree.path,
        toplevel: worktree.path,
        worktreeKey: worktreeKey(worktree.path),
        tools: {
            node: process.execPath,
            git: setup.git,
            gh: path.join(testEnv.binDir, 'gh'),
            tmux: path.join(testEnv.binDir, 'tmux'),
            claude: path.join(testEnv.binDir, 'claude'),
        },
        callerPath: testEnv.env.PATH ?? '',
        ghEnv: [],
        tmux: { socket: '/tmp/prwc-test-socket', pane: '%1', sessionId: '$1', windowId: '@1' },
        stateDir: testEnv.stateDir,
        interval: 15,
        keepPanes: 5,
        batchMax: 5,
        claudeArgs: [],
        once: false,
        worktree,
    };
}

// Switches the clone to main and gives the repository ignore rules, shared by every working tree through
// info/exclude, and the clone a few ignored paths.
function seedIgnored(setup: Setup): void {
    const { clone } = setup;
    leaveBranch(setup);
    fs.writeFileSync(path.join(clone, '.git', 'info', 'exclude'), IGNORE_RULES);
    fs.mkdirSync(path.join(clone, 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(clone, 'node_modules', 'pkg', 'index.js'), 'kept\n');
    fs.writeFileSync(path.join(clone, '.env'), 'KEY=value\n');
    fs.writeFileSync(path.join(clone, 'CLAUDE.local.md'), 'local notes\n');
    fs.mkdirSync(path.join(clone, 'docs.local', 'wiki'), { recursive: true });
    fs.writeFileSync(path.join(clone, 'docs.local', 'wiki', 'README.md'), 'wiki\n');
    fs.mkdirSync(path.join(clone, 'dist'));
    fs.writeFileSync(path.join(clone, 'dist', 'out.js'), 'built\n');
    fs.writeFileSync(path.join(clone, 'tsconfig.tsbuildinfo'), '{}\n');
}

function linkText(file: string): string | undefined {
    try {
        return fs.readlinkSync(file);
    } catch {
        return;
    }
}

function exists(file: string): boolean {
    try {
        fs.lstatSync(file);
        return true;
    } catch {
        return false;
    }
}

await describe('guards in a linked worktree', async () => {
    await test('pass while the clone itself is on another branch with symlinked ignored paths', async (t) => {
        const setup = await setUp(t);
        leaveBranch(setup);
        const worktree = await prepared(setup);
        fs.mkdirSync(path.join(setup.clone, 'node_modules'));
        fs.symlinkSync(path.join(setup.clone, 'node_modules'), path.join(worktree.path, 'node_modules'));
        const remoteSha = pushRemoteCommit(setup.gitRoot, BRANCH, setup.testEnv.env);
        const result = await runGuards({ runner: setup.runner }, sessionFor(setup, worktree));
        assert.deepEqual(result, { ok: true, headSha: remoteSha });
        fs.writeFileSync(path.join(setup.clone, 'README.md'), 'edited in the clone\n');
        const again = await runGuards({ runner: setup.runner }, sessionFor(setup, worktree));
        assert.ok(again.ok, 'changes in the clone do not hold the worktree');
    });
});

await describe('prepareWatchWorktree', async () => {
    await test('creates the worktree next to the clone on the existing local branch, then reuses it', async (t) => {
        const setup = await setUp(t);
        leaveBranch(setup);
        const first = await prepare(setup);
        assert.ok(first.ok && first.created, JSON.stringify(first));
        assert.deepEqual(first.worktree, { path: setup.target, source: setup.clone });
        assert.equal(path.basename(setup.target), 'alex-pr-watch-comments-pr-12');
        assert.equal(path.dirname(setup.target), path.dirname(setup.clone));
        assert.equal(git(setup, setup.target, ['branch', '--show-current']), BRANCH);
        assert.equal(git(setup, setup.clone, ['branch', '--show-current']), 'main');
        const second = await prepare(setup);
        assert.ok(second.ok && !second.created, JSON.stringify(second));
    });

    await test('creates a tracking local branch from the remote when the clone has none', async (t) => {
        const setup = await setUp(t);
        leaveBranch(setup);
        git(setup, setup.clone, ['branch', '--quiet', '-D', BRANCH]);
        const remoteSha = pushRemoteCommit(setup.gitRoot, BRANCH, setup.testEnv.env);
        const fetchHead = path.join(setup.clone, '.git', 'FETCH_HEAD');
        fs.rmSync(fetchHead, { force: true });
        await prepared(setup);
        assert.equal(git(setup, setup.target, ['rev-parse', 'HEAD']), remoteSha);
        assert.equal(git(setup, setup.target, ['rev-parse', '--abbrev-ref', '@{upstream}']), `origin/${BRANCH}`);
        assert.ok(!exists(fetchHead), 'the fetch leaves the FETCH_HEAD of the clone alone');
    });

    await test('refuses while the clone has the head branch checked out', async (t) => {
        const setup = await setUp(t);
        const reason = await refusal(setup);
        assert.equal(
            reason,
            `feature is checked out in ${setup.clone} (switch that working tree to another branch, or start the watcher with --in-place)`
        );
        assert.ok(!exists(setup.target));
    });

    await test('refuses a foreign directory at the worktree path and leaves it alone', async (t) => {
        const setup = await setUp(t);
        leaveBranch(setup);
        fs.mkdirSync(setup.target);
        fs.writeFileSync(path.join(setup.target, 'mine.txt'), 'mine\n');
        const reason = await refusal(setup);
        assert.ok(reason.includes('exists and is not a worktree of this repository'), reason);
        assert.deepEqual(fs.readdirSync(setup.target), ['mine.txt']);
    });

    await test('refuses a registered worktree that was switched to another branch', async (t) => {
        const setup = await setUp(t);
        leaveBranch(setup);
        await prepared(setup);
        git(setup, setup.target, ['checkout', '--quiet', '-b', 'other']);
        const reason = await refusal(setup);
        assert.ok(reason.startsWith(`the watch worktree ${setup.target} is not on feature`), reason);
    });

    await test('recreates a worktree whose directory was deleted, other missing worktrees stay registered', async (t) => {
        const setup = await setUp(t);
        leaveBranch(setup);
        await prepared(setup);
        const other = path.join(setup.gitRoot, 'owner-worktree');
        git(setup, setup.clone, ['worktree', 'add', '--quiet', '-b', 'mine', other]);
        fs.rmSync(other, { recursive: true, force: true });
        fs.rmSync(setup.target, { recursive: true, force: true });
        const again = await prepare(setup);
        assert.ok(again.ok && again.created, JSON.stringify(again));
        assert.equal(git(setup, setup.target, ['branch', '--show-current']), BRANCH);
        assert.ok(git(setup, setup.clone, ['worktree', 'list', '--porcelain']).includes(`worktree ${other}`));
    });

    await test('started from inside the worktree, links come from the main working tree', async (t) => {
        const setup = await setUp(t);
        leaveBranch(setup);
        await prepared(setup);
        const inside = await prepared(setup, setup.target);
        assert.deepEqual(inside, { path: setup.target, source: setup.clone });
    });
});

await describe('ignored links', async () => {
    await test('links every ignored path except build and cache outputs, once', async (t) => {
        const setup = await setUp(t);
        seedIgnored(setup);
        const worktree = await prepared(setup);
        const created = await syncIgnoredLinks(setup.deps, setup.git, worktree.source, worktree.path, linkOnly);
        assert.deepEqual(created, { linked: 4, cloned: 0 });
        for (const rel of ['node_modules', '.env', 'CLAUDE.local.md', 'docs.local']) {
            assert.equal(linkText(path.join(worktree.path, rel)), path.join(setup.clone, rel), rel);
        }
        assert.ok(!exists(path.join(worktree.path, 'dist')));
        assert.ok(!exists(path.join(worktree.path, 'tsconfig.tsbuildinfo')));
        assert.equal(fs.readFileSync(path.join(worktree.path, 'docs.local', 'wiki', 'README.md'), 'utf8'), 'wiki\n');
        assert.equal(git(setup, worktree.path, ['status', '--porcelain']), '', 'the links are excluded');
        assert.equal(git(setup, setup.clone, ['status', '--porcelain']), '', 'the clone is unchanged');
        const exclude = path.join(setup.clone, '.git', 'info', 'exclude');
        const before = fs.readFileSync(exclude, 'utf8');
        for (const pattern of ['/node_modules', '/.env', '/CLAUDE.local.md', '/docs.local']) {
            assert.ok(before.split('\n').includes(pattern), pattern);
        }
        assert.deepEqual(await syncIgnoredLinks(setup.deps, setup.git, worktree.source, worktree.path, linkOnly), {
            linked: 0,
            cloned: 0,
        });
        assert.equal(fs.readFileSync(exclude, 'utf8'), before, 'a second sync adds no pattern');
    });

    await test('an existing file in the worktree and a missing parent directory are left alone', async (t) => {
        const setup = await setUp(t);
        seedIgnored(setup);
        fs.mkdirSync(path.join(setup.clone, 'only-here'));
        fs.writeFileSync(path.join(setup.clone, 'only-here', 'x.local.md'), 'x\n');
        fs.writeFileSync(path.join(setup.clone, 'only-here', 'plain.txt'), 'untracked, not ignored\n');
        const worktree = await prepared(setup);
        fs.writeFileSync(path.join(worktree.path, '.env'), 'OWN=1\n');
        await syncIgnoredLinks(setup.deps, setup.git, worktree.source, worktree.path, linkOnly);
        assert.equal(fs.readFileSync(path.join(worktree.path, '.env'), 'utf8'), 'OWN=1\n');
        assert.equal(linkText(path.join(worktree.path, '.env')), undefined);
        assert.ok(!exists(path.join(worktree.path, 'only-here')));
    });
});

async function linkedWorktree(setup: Setup): Promise<WatchWorktree> {
    seedIgnored(setup);
    const worktree = await prepared(setup);
    await syncIgnoredLinks(setup.deps, setup.git, worktree.source, worktree.path, linkOnly);
    return worktree;
}

function emulatedRunner(
    setup: Setup,
    options: { failClone?: boolean } = {}
): { runner: CommandRunner; calls: string[][] } {
    const calls: string[][] = [];
    return {
        calls,
        runner: {
            async run(request) {
                if (request.file !== 'cp') {
                    return setup.runner.run(request);
                }
                calls.push([...request.args]);
                if (options.failClone && request.args.includes('-R')) {
                    return { code: 1, stdout: '', stderr: 'cp: cannot create\n' };
                }
                const source = request.args.at(-2);
                const target = request.args.at(-1);
                assert.ok(source);
                assert.ok(target);
                fs.cpSync(source, target, { recursive: true, verbatimSymlinks: true });
                return { code: 0, stdout: '', stderr: '' };
            },
        },
    };
}

function assertClean(setup: Setup, worktree: WatchWorktree): void {
    for (const root of [setup.clone, worktree.path]) {
        assert.equal(git(setup, root, ['status', '--porcelain', '--untracked-files=all']), '');
    }
}

function assertNoCloneTemps(setup: Setup, worktree: WatchWorktree): void {
    const privateGitDir = git(setup, worktree.path, ['rev-parse', '--absolute-git-dir']);
    for (const root of [worktree.path, privateGitDir]) {
        assert.deepEqual(
            fs.readdirSync(root).filter((name) => name.startsWith(CLONE_TEMP_PREFIX)),
            []
        );
    }
}

await describe('dependency clones', async () => {
    await test('copy-on-write sync counts in-place calls and preserves failed listing behavior', async (t) => {
        const setup = await setUp(t);
        const deps = setup.testEnv.deps({
            run: () => Promise.resolve({ code: 1, stdout: '', stderr: 'git failed\n' }),
        });
        assert.deepEqual(await syncIgnoredLinks(deps, setup.git, setup.clone, setup.clone, linkOnly), {
            linked: 0,
            cloned: 0,
        });
        assert.deepEqual([...deps.logLines], []);
        assert.equal(await syncIgnoredLinks(deps, setup.git, setup.clone, setup.target, linkOnly), undefined);
        assert.equal(deps.logLines.length, 1);
        assert.ok(deps.logLines[0]?.startsWith('warn cannot list the ignored files of '));
        assert.ok(deps.logLines[0]?.endsWith('; nothing linked into the worktree'));
        assert.ok(!exists(setup.target));
    });

    await test('emulated copy-on-write clones node_modules and links the rest', async (t) => {
        const setup = await setUp(t);
        seedIgnored(setup);
        fs.appendFileSync(path.join(setup.clone, '.git', 'info', 'exclude'), '.venv/\n');
        fs.mkdirSync(path.join(setup.clone, '.venv', 'bin'), { recursive: true });
        fs.writeFileSync(path.join(setup.clone, '.venv', 'bin', 'python'), 'interpreter\n');
        const worktree = await prepared(setup);
        const emulated = emulatedRunner(setup);
        const deps = setup.testEnv.deps(emulated.runner);
        const cloner = createCloner({ platform: 'linux' });
        assert.deepEqual(await syncIgnoredLinks(deps, setup.git, worktree.source, worktree.path, cloner), {
            linked: 4,
            cloned: 1,
        });
        assert.ok(fs.lstatSync(path.join(worktree.path, 'node_modules')).isDirectory());
        const dependency = path.join(worktree.path, 'node_modules', 'pkg', 'index.js');
        assert.equal(fs.readFileSync(dependency, 'utf8'), 'kept\n');
        for (const rel of ['.env', 'CLAUDE.local.md', 'docs.local', '.venv']) {
            assert.equal(linkText(path.join(worktree.path, rel)), path.join(setup.clone, rel), rel);
        }
        assert.ok(
            fs
                .readFileSync(path.join(setup.clone, '.git', 'info', 'exclude'), 'utf8')
                .split('\n')
                .includes('/node_modules')
        );
        assertClean(setup, worktree);
        assertNoCloneTemps(setup, worktree);
        assert.ok(deps.logLines.includes('info cloning node_modules into the watch worktree with copy-on-write'));
        assert.ok(
            deps.logLines.some((line) => /^info cloned node_modules into the watch worktree in \d+\.\d s$/u.test(line))
        );
        fs.writeFileSync(dependency, 'changed in the worktree\n');
        assert.equal(fs.readFileSync(path.join(setup.clone, 'node_modules', 'pkg', 'index.js'), 'utf8'), 'kept\n');
        const before = emulated.calls.length;
        assert.deepEqual(await syncIgnoredLinks(deps, setup.git, worktree.source, worktree.path, cloner), {
            linked: 0,
            cloned: 0,
        });
        assert.equal(emulated.calls.length, before, 'an existing clone is not refreshed');
        assert.equal(fs.readFileSync(dependency, 'utf8'), 'changed in the worktree\n');
    });

    await test('copy-on-write converts an existing own node_modules link', async (t) => {
        const setup = await setUp(t);
        const worktree = await linkedWorktree(setup);
        assert.equal(linkText(path.join(worktree.path, 'node_modules')), path.join(setup.clone, 'node_modules'));
        const emulated = emulatedRunner(setup);
        const deps = setup.testEnv.deps(emulated.runner);
        assert.deepEqual(
            await syncIgnoredLinks(
                deps,
                setup.git,
                worktree.source,
                worktree.path,
                createCloner({ platform: 'linux' })
            ),
            { linked: 0, cloned: 1 }
        );
        assert.ok(fs.lstatSync(path.join(worktree.path, 'node_modules')).isDirectory());
        assert.equal(fs.readFileSync(path.join(worktree.path, 'node_modules', 'pkg', 'index.js'), 'utf8'), 'kept\n');
        assertClean(setup, worktree);
        assertNoCloneTemps(setup, worktree);
    });

    await test('copy-on-write leaves an existing dependency directory alone and excludes it', async (t) => {
        const setup = await setUp(t);
        seedIgnored(setup);
        const worktree = await prepared(setup);
        fs.mkdirSync(path.join(worktree.path, 'node_modules', 'pkg'), { recursive: true });
        const dependency = path.join(worktree.path, 'node_modules', 'pkg', 'index.js');
        fs.writeFileSync(dependency, 'existing installation\n');
        const emulated = emulatedRunner(setup);
        const deps = setup.testEnv.deps(emulated.runner);
        const cloner = createCloner({ platform: 'linux' });
        assert.deepEqual(await syncIgnoredLinks(deps, setup.git, worktree.source, worktree.path, cloner), {
            linked: 3,
            cloned: 0,
        });
        assert.equal(fs.readFileSync(dependency, 'utf8'), 'existing installation\n');
        assert.deepEqual(emulated.calls, []);
        const exclude = path.join(setup.clone, '.git', 'info', 'exclude');
        assert.ok(fs.readFileSync(exclude, 'utf8').split('\n').includes('/node_modules'));
        fs.writeFileSync(exclude, fs.readFileSync(exclude, 'utf8').replace('/node_modules\n', ''));
        assert.deepEqual(await syncIgnoredLinks(deps, setup.git, worktree.source, worktree.path, cloner), {
            linked: 0,
            cloned: 0,
        });
        assert.ok(fs.readFileSync(exclude, 'utf8').split('\n').includes('/node_modules'));
        assertClean(setup, worktree);
    });

    await test('copy-on-write leaves a foreign dependency link alone', async (t) => {
        const setup = await setUp(t);
        seedIgnored(setup);
        const worktree = await prepared(setup);
        const foreign = path.join(setup.testEnv.root, 'foreign-dependencies');
        fs.mkdirSync(foreign);
        const dest = path.join(worktree.path, 'node_modules');
        fs.symlinkSync(foreign, dest);
        const emulated = emulatedRunner(setup);
        const deps = setup.testEnv.deps(emulated.runner);
        assert.deepEqual(
            await syncIgnoredLinks(
                deps,
                setup.git,
                worktree.source,
                worktree.path,
                createCloner({ platform: 'linux' })
            ),
            { linked: 3, cloned: 0 }
        );
        assert.equal(linkText(dest), foreign);
        assert.deepEqual(emulated.calls, []);
        assert.ok(
            !fs
                .readFileSync(path.join(setup.clone, '.git', 'info', 'exclude'), 'utf8')
                .split('\n')
                .includes('/node_modules')
        );
    });

    await test('copy-on-write skipped cloning falls back to a new link without logging', async (t) => {
        const setup = await setUp(t);
        seedIgnored(setup);
        const worktree = await prepared(setup);
        assert.deepEqual(
            await syncIgnoredLinks(setup.deps, setup.git, worktree.source, worktree.path, {
                cloneDependency: () => Promise.resolve({ kind: 'skipped' }),
            }),
            { linked: 4, cloned: 0 }
        );
        assert.equal(linkText(path.join(worktree.path, 'node_modules')), path.join(setup.clone, 'node_modules'));
        assert.deepEqual(setup.deps.logLines, []);
        assertClean(setup, worktree);
    });

    await test('copy-on-write failure without an own link does not claim it linked instead', async (t) => {
        const setup = await setUp(t);
        seedIgnored(setup);
        const worktree = await prepared(setup);
        const dest = path.join(worktree.path, 'node_modules');
        assert.deepEqual(
            await syncIgnoredLinks(setup.deps, setup.git, worktree.source, worktree.path, {
                cloneDependency: () => {
                    fs.mkdirSync(dest);
                    return Promise.resolve({ kind: 'failed', reason: 'another writer\ncreated the directory' });
                },
            }),
            { linked: 3, cloned: 0 }
        );
        assert.ok(fs.lstatSync(dest).isDirectory());
        assert.deepEqual(setup.deps.logLines, [
            'warn cannot clone node_modules into the watch worktree (another writer?created the directory)',
        ]);
        assertClean(setup, worktree);
    });

    await test('a failing copy-on-write clone keeps a link and is not retried', async (t) => {
        const setup = await setUp(t);
        seedIgnored(setup);
        const worktree = await prepared(setup);
        const emulated = emulatedRunner(setup, { failClone: true });
        const deps = setup.testEnv.deps(emulated.runner);
        const cloner = createCloner({ platform: 'linux' });
        assert.deepEqual(await syncIgnoredLinks(deps, setup.git, worktree.source, worktree.path, cloner), {
            linked: 4,
            cloned: 0,
        });
        assert.equal(linkText(path.join(worktree.path, 'node_modules')), path.join(setup.clone, 'node_modules'));
        const warnings = deps.logLines.filter((line) => line.startsWith('warn cannot clone'));
        assert.deepEqual(warnings, [
            'warn cannot clone node_modules into the watch worktree (cp exited with 1: cp: cannot create); linked it instead',
        ]);
        assertClean(setup, worktree);
        assertNoCloneTemps(setup, worktree);
        const before = emulated.calls.length;
        assert.deepEqual(await syncIgnoredLinks(deps, setup.git, worktree.source, worktree.path, cloner), {
            linked: 0,
            cloned: 0,
        });
        assert.equal(emulated.calls.length, before);
        assert.deepEqual(
            deps.logLines.filter((line) => line.startsWith('warn cannot clone')),
            warnings
        );
    });

    await test('copy-on-write with the real cp on this machine', { skip: process.platform !== 'linux' }, async (t) => {
        const setup = await setUp(t);
        seedIgnored(setup);
        const worktree = await prepared(setup);
        const probe = path.join(setup.testEnv.root, 'reflink-probe');
        const actual = spawnSync(
            'cp',
            ['--reflink=always', path.join(setup.clone, 'node_modules', 'pkg', 'index.js'), probe],
            {
                env: setup.testEnv.env,
                encoding: 'utf8',
            }
        );
        fs.rmSync(probe, { force: true });
        const cloned = actual.status === 0;
        assert.deepEqual(
            await syncIgnoredLinks(
                setup.deps,
                setup.git,
                worktree.source,
                worktree.path,
                createCloner({ platform: 'linux' })
            ),
            { linked: cloned ? 3 : 4, cloned: cloned ? 1 : 0 }
        );
        const dependency = path.join(worktree.path, 'node_modules');
        if (cloned) {
            assert.ok(fs.lstatSync(dependency).isDirectory());
        } else {
            assert.equal(linkText(dependency), path.join(setup.clone, 'node_modules'));
            assert.ok(
                setup.deps.logLines.includes(
                    'info linked node_modules: no copy-on-write between the clone and the worktree'
                )
            );
        }
        assert.equal(fs.readFileSync(path.join(dependency, 'pkg', 'index.js'), 'utf8'), 'kept\n');
        assertClean(setup, worktree);
        assertNoCloneTemps(setup, worktree);
        const logs = [...setup.deps.logLines];
        assert.deepEqual(
            await syncIgnoredLinks(
                setup.deps,
                setup.git,
                worktree.source,
                worktree.path,
                createCloner({ platform: 'linux' })
            ),
            { linked: 0, cloned: 0 }
        );
        assert.deepEqual(setup.deps.logLines, logs, 'reuse is quiet when no link or clone is created');
    });

    await test('cleanup removes a worktree with a copy-on-write node_modules', async (t) => {
        const setup = await setUp(t);
        seedIgnored(setup);
        const worktree = await prepared(setup);
        const emulated = emulatedRunner(setup);
        const deps = setup.testEnv.deps(emulated.runner);
        assert.deepEqual(
            await syncIgnoredLinks(
                deps,
                setup.git,
                worktree.source,
                worktree.path,
                createCloner({ platform: 'linux' })
            ),
            { linked: 3, cloned: 1 }
        );
        assert.equal(await removeWatchWorktree(deps, sessionFor(setup, worktree)), true);
        assert.ok(!exists(worktree.path));
        assert.equal(fs.readFileSync(path.join(setup.clone, 'node_modules', 'pkg', 'index.js'), 'utf8'), 'kept\n');
    });
});

await describe('removeWatchWorktree', async () => {
    await test('removes a clean, pushed worktree without touching the linked clone files', async (t) => {
        const setup = await setUp(t);
        const worktree = await linkedWorktree(setup);
        fs.mkdirSync(path.join(worktree.path, 'dist'));
        fs.writeFileSync(path.join(worktree.path, 'dist', 'own.js'), 'own\n');
        assert.equal(await removeWatchWorktree(setup.deps, sessionFor(setup, worktree)), true);
        assert.ok(!exists(worktree.path));
        assert.equal(fs.readFileSync(path.join(setup.clone, 'node_modules', 'pkg', 'index.js'), 'utf8'), 'kept\n');
        assert.equal(fs.readFileSync(path.join(setup.clone, 'docs.local', 'wiki', 'README.md'), 'utf8'), 'wiki\n');
        assert.equal(fs.readFileSync(path.join(setup.clone, '.env'), 'utf8'), 'KEY=value\n');
        assert.ok(!git(setup, setup.clone, ['worktree', 'list']).includes(worktree.path));
        assert.equal(git(setup, setup.clone, ['branch', '--list', BRANCH]).replace('*', '').trim(), BRANCH);
    });

    await test('a link to a clone path that is gone is removed too', async (t) => {
        const setup = await setUp(t);
        const worktree = await linkedWorktree(setup);
        fs.rmSync(path.join(setup.clone, '.env'));
        assert.equal(await removeWatchWorktree(setup.deps, sessionFor(setup, worktree)), true);
        assert.ok(!exists(worktree.path));
    });

    await test('removes a worktree with reinstalled node_modules without touching the clone dependencies', async (t) => {
        const setup = await setUp(t);
        const worktree = await linkedWorktree(setup);
        fs.unlinkSync(path.join(worktree.path, 'node_modules'));
        fs.mkdirSync(path.join(worktree.path, 'node_modules', 'pkg'), { recursive: true });
        fs.writeFileSync(path.join(worktree.path, 'node_modules', 'pkg', 'index.js'), 'reinstalled\n');
        assert.equal(await removeWatchWorktree(setup.deps, sessionFor(setup, worktree)), true);
        assert.ok(!exists(worktree.path));
        assert.equal(fs.readFileSync(path.join(setup.clone, 'node_modules', 'pkg', 'index.js'), 'utf8'), 'kept\n');
    });

    await test('keeps a worktree with a real ignored Python venv', async (t) => {
        const setup = await setUp(t);
        const worktree = await linkedWorktree(setup);
        fs.appendFileSync(path.join(setup.clone, '.git', 'info', 'exclude'), '\n.venv/\n');
        fs.mkdirSync(path.join(worktree.path, '.venv', 'lib'), { recursive: true });
        fs.writeFileSync(path.join(worktree.path, '.venv', 'lib', 'x.py'), 'local venv\n');
        assert.equal(await removeWatchWorktree(setup.deps, sessionFor(setup, worktree)), false);
        assert.equal(fs.readFileSync(path.join(worktree.path, '.venv', 'lib', 'x.py'), 'utf8'), 'local venv\n');
        const kept = setup.deps.logLines.find((line) => line.includes('kept the watch worktree'));
        assert.ok(kept?.includes('it holds ignored files: .venv'), kept);
    });

    await test('keeps ignored notes alongside real node_modules and names only the notes', async (t) => {
        const setup = await setUp(t);
        const worktree = await linkedWorktree(setup);
        fs.unlinkSync(path.join(worktree.path, 'node_modules'));
        fs.mkdirSync(path.join(worktree.path, 'node_modules', 'pkg'), { recursive: true });
        fs.writeFileSync(path.join(worktree.path, 'node_modules', 'pkg', 'index.js'), 'reinstalled\n');
        fs.writeFileSync(path.join(worktree.path, 'notes.local.md'), 'only here\n');
        assert.equal(await removeWatchWorktree(setup.deps, sessionFor(setup, worktree)), false);
        assert.equal(fs.readFileSync(path.join(worktree.path, 'notes.local.md'), 'utf8'), 'only here\n');
        const kept = setup.deps.logLines.find((line) => line.includes('kept the watch worktree'));
        assert.ok(kept);
        assert.ok(kept.includes('it holds ignored files: notes.local.md'), kept);
        assert.ok(!kept.includes('node_modules'), kept);
    });

    await test('keeps a worktree with uncommitted changes, unpushed commits or untracked files', async (t) => {
        const setup = await setUp(t);
        const worktree = await linkedWorktree(setup);
        const session = sessionFor(setup, worktree);
        fs.writeFileSync(path.join(worktree.path, 'feature.txt'), 'changed\n');
        assert.equal(await removeWatchWorktree(setup.deps, session), false);
        git(setup, worktree.path, ['commit', '--quiet', '-am', 'local only']);
        assert.equal(await removeWatchWorktree(setup.deps, session), false);
        git(setup, worktree.path, ['reset', '--quiet', '--hard', `origin/${BRANCH}`]);
        fs.writeFileSync(path.join(worktree.path, 'stray.txt'), 'stray\n');
        assert.equal(await removeWatchWorktree(setup.deps, session), false);
        assert.ok(exists(path.join(worktree.path, 'feature.txt')));
        const kept = setup.deps.logLines.filter((line) => line.includes('kept the watch worktree'));
        assert.equal(kept.length, 3, kept.join('\n'));
        assert.ok(kept[0]?.includes('uncommitted changes'), kept[0]);
        assert.ok(kept[1]?.includes('not pushed'), kept[1]);
    });

    await test('keeps a worktree with ignored files that are not build outputs, links included', async (t) => {
        const setup = await setUp(t);
        const worktree = await linkedWorktree(setup);
        fs.writeFileSync(path.join(worktree.path, 'notes.local.md'), 'only here\n');
        assert.equal(await removeWatchWorktree(setup.deps, sessionFor(setup, worktree)), false);
        assert.equal(fs.readFileSync(path.join(worktree.path, 'notes.local.md'), 'utf8'), 'only here\n');
        assert.equal(linkText(path.join(worktree.path, '.env')), path.join(setup.clone, '.env'));
        const kept = setup.deps.logLines.find((line) => line.includes('kept the watch worktree'));
        assert.ok(kept?.includes('it holds ignored files: notes.local.md'), kept);
    });

    await test('keeps a worktree whose lock a run holds', async (t) => {
        const setup = await setUp(t);
        const worktree = await linkedWorktree(setup);
        const session = sessionFor(setup, worktree);
        const runId = '20261005120000-1';
        assert.ok(acquireWorktreeLock(session.stateDir, session.worktreeKey, runId, process.pid, setup.deps.log, 1));
        assert.equal(await removeWatchWorktree(setup.deps, session), false);
        assert.ok(exists(worktree.path));
        assert.ok(releaseWorktreeLock(session.stateDir, session.worktreeKey, runId));
    });
});
