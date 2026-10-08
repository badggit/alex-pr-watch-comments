import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test, type TestContext } from 'node:test';

import { locateRepository, type RepoLayout } from '../../src/newWorktreeRepo.ts';
import { createProcessRunner } from '../../src/proc.ts';
import type { CommandRunner } from '../../src/types.ts';
import { gitSync } from '../support/gitRepo.ts';
import { createTestEnv, type TestDeps, type TestEnv } from '../support/testEnv.ts';
import { addFetchedRemote, headOf, mainClone } from '../support/worktreeRepo.ts';

interface Setup {
    testEnv: TestEnv;
    gitRoot: string;
    clone: string;
    git: string;
    deps: TestDeps;
}

async function setUp(t: TestContext): Promise<Setup> {
    const testEnv = await createTestEnv();
    t.after(() => {
        testEnv.cleanup();
    });
    const gitRoot = path.join(testEnv.root, 'git');
    const clone = mainClone(gitRoot, testEnv.env);
    return {
        testEnv,
        gitRoot,
        clone,
        git: path.join(testEnv.toolsDir, 'git'),
        deps: testEnv.deps(createProcessRunner(testEnv.env)),
    };
}

async function located(setup: Setup, cwd: string): Promise<RepoLayout> {
    const result = await locateRepository(setup.deps, setup.git, cwd);
    assert.ok(result.ok, result.ok ? '' : result.reason);
    return result.repo;
}

async function refusal(setup: Setup, cwd: string): Promise<string> {
    const result = await locateRepository(setup.deps, setup.git, cwd);
    assert.ok(!result.ok);
    return result.reason;
}

function makeDir(dir: string): string {
    fs.mkdirSync(dir, { recursive: true });
    return fs.realpathSync.native(dir);
}

// GIT_ROOT/super with the clone added as submodule sub; returns the canonical superproject path.
function withSubmodule(setup: Setup): string {
    const env = setup.testEnv.env;
    const superDir = makeDir(path.join(setup.gitRoot, 'super'));
    gitSync(env, ['init', '--quiet', superDir]);
    gitSync(env, ['-C', superDir, 'commit', '--quiet', '--allow-empty', '-m', 'root']);
    const addArgs = ['-C', superDir, '-c', 'protocol.file.allow=always', 'submodule', 'add', '--quiet'];
    gitSync(env, [...addArgs, setup.clone, 'sub']);
    return superDir;
}

function submoduleReason(sub: string, superDir: string): string {
    return `the main working tree ${sub} is a submodule; a sibling worktree would land inside the superproject ${superDir}`;
}

await describe('locateRepository', async () => {
    await test('the main clone is both the current and the main tree', async (t) => {
        const setup = await setUp(t);
        assert.deepEqual(await located(setup, setup.clone), {
            current: setup.clone,
            main: setup.clone,
            mainFound: true,
            linked: false,
        });
    });

    await test('a subdirectory of the main clone resolves to the clone', async (t) => {
        const setup = await setUp(t);
        const sub = makeDir(path.join(setup.clone, 'a', 'b'));
        assert.deepEqual(await located(setup, sub), {
            current: setup.clone,
            main: setup.clone,
            mainFound: true,
            linked: false,
        });
    });

    await test('a linked worktree and its subdirectory find the clone as the main tree', async (t) => {
        const setup = await setUp(t);
        addFetchedRemote(setup.gitRoot, setup.clone, setup.testEnv.env, 'upstream');
        const linked = path.join(setup.gitRoot, 'linked');
        gitSync(setup.testEnv.env, ['-C', setup.clone, 'worktree', 'add', '--quiet', linked, 'upstream/feature']);
        const linkedCanon = fs.realpathSync.native(linked);
        const fetched = gitSync(setup.testEnv.env, ['-C', setup.clone, 'rev-parse', 'refs/remotes/upstream/feature']);
        assert.equal(headOf(setup.testEnv.env, linkedCanon), fetched.trim());
        const expected = { current: linkedCanon, main: setup.clone, mainFound: true, linked: true };
        assert.deepEqual(await located(setup, linkedCanon), expected);
        assert.deepEqual(await located(setup, makeDir(path.join(linkedCanon, 'deep', 'dir'))), expected);
    });

    await test('a linked worktree of a separate-git-dir repository is linked without a main tree', async (t) => {
        const setup = await setUp(t);
        const env = setup.testEnv.env;
        const repo = path.join(setup.gitRoot, 'separate');
        gitSync(env, ['init', '--quiet', `--separate-git-dir=${path.join(setup.gitRoot, 'G')}`, repo]);
        fs.writeFileSync(path.join(repo, 'file.txt'), 'x\n');
        gitSync(env, ['-C', repo, 'add', 'file.txt']);
        gitSync(env, ['-C', repo, 'commit', '--quiet', '-m', 'one']);
        const linked = path.join(setup.gitRoot, 'separate-linked');
        gitSync(env, ['-C', repo, 'worktree', 'add', '--quiet', '-b', 'side', linked]);
        const linkedCanon = fs.realpathSync.native(linked);
        assert.deepEqual(await located(setup, linkedCanon), {
            current: linkedCanon,
            main: linkedCanon,
            mainFound: false,
            linked: true,
        });
    });

    await test('a submodule is refused', async (t) => {
        const setup = await setUp(t);
        const superDir = withSubmodule(setup);
        const sub = path.join(superDir, 'sub');
        const reason = await refusal(setup, sub);
        assert.equal(reason, submoduleReason(sub, superDir));
    });

    await test('a linked worktree of a submodule is linked and skips the superproject check', async (t) => {
        const setup = await setUp(t);
        const superDir = withSubmodule(setup);
        const sub = path.join(superDir, 'sub');
        const linked = path.join(superDir, 'subwt2');
        gitSync(setup.testEnv.env, ['-C', sub, 'worktree', 'add', '--quiet', '-b', 'side', linked]);
        const linkedCanon = fs.realpathSync.native(linked);
        // git lists the submodule's git directory first, so the main tree is not confirmed.
        assert.deepEqual(await located(setup, linkedCanon), {
            current: linkedCanon,
            main: linkedCanon,
            mainFound: false,
            linked: true,
        });
    });

    await test('git directories git cannot read refuse instead of guessing', async (t) => {
        const setup = await setUp(t);
        const real = createProcessRunner(setup.testEnv.env);
        const runner: CommandRunner = {
            run(request) {
                if (request.args.includes('--git-common-dir')) {
                    return Promise.resolve({ code: 128, stdout: '', stderr: 'fatal: broken\n' });
                }
                return real.run(request);
            },
        };
        const result = await locateRepository(setup.testEnv.deps(runner), setup.git, setup.clone);
        assert.deepEqual(result, { ok: false, reason: `cannot read the git directories of ${setup.clone}` });
    });

    await test('a failing superproject check refuses instead of passing', async (t) => {
        const setup = await setUp(t);
        const real = createProcessRunner(setup.testEnv.env);
        const runner: CommandRunner = {
            run(request) {
                if (request.args.includes('--show-superproject-working-tree')) {
                    return Promise.resolve({ code: 128, stdout: '', stderr: 'fatal: probe broke\nsecond line\n' });
                }
                return real.run(request);
            },
        };
        const result = await locateRepository(setup.testEnv.deps(runner), setup.git, setup.clone);
        assert.deepEqual(result, {
            ok: false,
            reason: `cannot check whether ${setup.clone} is inside a superproject: fatal: probe broke`,
        });
    });

    await test('a plain directory is not a git repository', async (t) => {
        const setup = await setUp(t);
        const plain = makeDir(path.join(setup.testEnv.root, 'plain'));
        assert.equal(await refusal(setup, plain), `not a git repository: ${plain}`);
    });

    await test('a bare repository is not inside a working tree', async (t) => {
        const setup = await setUp(t);
        const bare = path.join(setup.gitRoot, 'remote.git');
        assert.equal(await refusal(setup, bare), `not inside a git working tree: ${bare}`);
    });

    await test('a .git directory is not inside a working tree', async (t) => {
        const setup = await setUp(t);
        const gitDir = path.join(setup.clone, '.git');
        assert.equal(await refusal(setup, gitDir), `not inside a git working tree: ${gitDir}`);
    });
});
