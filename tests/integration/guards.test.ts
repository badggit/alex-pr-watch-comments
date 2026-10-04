import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test, type TestContext } from 'node:test';

import { currentBranch, findRemote, parseGithubRemoteUrl, runGuards, verifyRemote } from '../../src/guards.ts';
import { createProcessRunner } from '../../src/proc.ts';
import { worktreeKey } from '../../src/stateStore.ts';
import type { CommandRunner, PrRef, Session } from '../../src/types.ts';
import { createFakeRunner, type FakeRunner } from '../support/fakeRunner.ts';
import { gitSync, makePrClone, offlineGitRunner, pushRemoteCommit } from '../support/gitRepo.ts';
import { createTestEnv, type TestEnv } from '../support/testEnv.ts';

const BRANCH = 'feature';
const PR: PrRef = { owner: 'o', repo: 'r', number: 12, prUrl: 'https://github.com/o/r/pull/12', prKey: 'o+r+12' };
const PUSH_REFUSAL = 'push target of remote origin is not o/r';
const URL_REFUSAL = 'remote origin does not point to o/r';
const SHA = /^[\da-f]{40}$/u;

interface GitSetup {
    testEnv: TestEnv;
    gitRoot: string;
    clone: string;
    git: string;
    runner: CommandRunner;
}

interface GuardSetup extends GitSetup {
    fake: FakeRunner;
    session: Session;
}

async function makeEnv(t: TestContext): Promise<TestEnv> {
    const testEnv = await createTestEnv();
    t.after(() => {
        testEnv.cleanup();
    });
    return testEnv;
}

function gitSetup(testEnv: TestEnv, name: string, branch = BRANCH): GitSetup {
    const gitRoot = path.join(testEnv.root, name);
    const clone = makePrClone(gitRoot, branch, 'o/r', testEnv.env);
    const runner = offlineGitRunner(createProcessRunner(testEnv.env), gitRoot);
    return { testEnv, gitRoot, clone, git: path.join(testEnv.toolsDir, 'git'), runner };
}

function sessionFor(testEnv: TestEnv, clone: string): Session {
    return {
        pr: PR,
        viewer: 'reviewer',
        headRef: BRANCH,
        headOwner: 'o',
        headRepo: 'r',
        remote: 'origin',
        dirCanon: clone,
        toplevel: clone,
        worktreeKey: worktreeKey(clone),
        tools: {
            node: process.execPath,
            git: path.join(testEnv.toolsDir, 'git'),
            gh: path.join(testEnv.binDir, 'gh'),
            tmux: path.join(testEnv.binDir, 'tmux'),
            claude: path.join(testEnv.binDir, 'claude'),
        },
        callerPath: testEnv.env.PATH ?? '',
        ghEnv: [`GH_CONFIG_DIR=${testEnv.home}/.config/gh`, 'GH_HOST=github.com'],
        tmux: { socket: '/tmp/prwc-test-socket', pane: '%1', sessionId: '$1', windowId: '@1' },
        stateDir: testEnv.stateDir,
        interval: 15,
        keepPanes: 5,
        batchMax: 5,
        claudeArgs: [],
        once: false,
    };
}

async function guardSetup(t: TestContext, branch = BRANCH): Promise<GuardSetup> {
    const testEnv = await makeEnv(t);
    const base = gitSetup(testEnv, 'git', branch);
    const fake = createFakeRunner({ passthrough: { git: base.runner } });
    return { ...base, fake, session: { ...sessionFor(testEnv, base.clone), headRef: branch } };
}

async function guards(setup: GuardSetup) {
    const result = await runGuards(setup.testEnv.deps(setup.fake.runner), setup.session);
    assert.equal(setup.fake.calls('gh').length, 0);
    return result;
}

function git(setup: GitSetup, args: readonly string[]): string {
    return gitSync(setup.testEnv.env, ['-C', setup.clone, ...args]).trim();
}

function commitLocal(setup: GitSetup): void {
    fs.writeFileSync(path.join(setup.clone, 'local.txt'), 'local\n');
    git(setup, ['add', 'local.txt']);
    git(setup, ['commit', '--quiet', '-m', 'local commit']);
}

await describe('parseGithubRemoteUrl', async () => {
    await test('accepts the three GitHub URL forms and lowercases owner and repo', () => {
        const accepted: readonly [string, string, string][] = [
            ['git@github.com:Owner/Repo.git', 'owner', 'repo'],
            ['https://github.com/owner/repo', 'owner', 'repo'],
            ['https://github.com/owner/repo.git/', 'owner', 'repo'],
            ['ssh://git@github.com/owner/repo', 'owner', 'repo'],
            ['https://github.com/owner/repo-evil.git', 'owner', 'repo-evil'],
            ['https://github.com/xowner/repo', 'xowner', 'repo'],
        ];
        for (const [url, owner, repo] of accepted) {
            assert.deepEqual(parseGithubRemoteUrl(url), { owner, repo }, url);
        }
    });

    await test('rejects other hosts, extra segments and credentials', () => {
        const rejected = [
            'https://evilgithub.com/owner/repo',
            'https://github.com.evil.com/owner/repo',
            'https://github.com/owner/repo/extra',
            'https://user:pw@github.com/owner/repo',
            'https://github.com/owner',
            'https://github.com/-owner/repo',
            'https://github.com/owner/.git',
            'git@github.com:owner/repo.git\nx',
            ' https://github.com/owner/repo',
        ];
        for (const url of rejected) {
            assert.equal(parseGithubRemoteUrl(url), undefined, url);
        }
    });
});

await describe('findRemote', async () => {
    await test('remotes of other repositories do not match', async (t) => {
        const testEnv = await makeEnv(t);
        for (const [index, url] of ['https://github.com/o/r-evil.git', 'https://github.com/xo/r'].entries()) {
            const setup = gitSetup(testEnv, `other-${index}`);
            git(setup, ['remote', 'set-url', 'origin', url]);
            const found = await findRemote({ runner: setup.runner }, setup.git, setup.clone, 'o', 'r');
            assert.ok(!found.ok);
            assert.ok(found.reason.includes('git remote add NAME https://github.com/o/r.git'), found.reason);
            git(setup, ['remote', 'add', 'upstream', 'https://github.com/o/r.git']);
            const upstream = await findRemote({ runner: setup.runner }, setup.git, setup.clone, 'o', 'r');
            assert.deepEqual(upstream, { ok: true, remote: 'upstream' });
        }
    });

    await test('a matching remote with a foreign push target is refused', async (t) => {
        const setup = gitSetup(await makeEnv(t), 'git');
        git(setup, ['remote', 'set-url', '--push', 'origin', 'https://github.com/o/other.git']);
        const found = await findRemote({ runner: setup.runner }, setup.git, setup.clone, 'o', 'r');
        assert.deepEqual(found, { ok: false, reason: PUSH_REFUSAL });
    });
});

await describe('verifyRemote', async () => {
    await test('the plain clone verifies', async (t) => {
        const setup = gitSetup(await makeEnv(t), 'git');
        assert.deepEqual(await verifyRemote({ runner: setup.runner }, setup.git, setup.clone, 'origin', 'o', 'r'), {
            ok: true,
        });
    });

    await test('every destination must be the head repository', async (t) => {
        const testEnv = await makeEnv(t);
        const cases: readonly (readonly (readonly string[])[])[] = [
            [['remote', 'set-url', '--push', 'origin', 'https://github.com/o/other.git']],
            [
                ['remote', 'set-url', '--add', '--push', 'origin', 'https://github.com/o/r.git'],
                ['remote', 'set-url', '--add', '--push', 'origin', 'git@github.com:o/r.git'],
            ],
            [['config', 'url.https://github.com/o/other.git.pushInsteadOf', 'https://github.com/o/r.git']],
            [['config', 'url.https://github.com/o/other.git.insteadOf', 'https://github.com/o/r.git']],
        ];
        for (const [index, commands] of cases.entries()) {
            const setup = gitSetup(testEnv, `case-${index}`);
            for (const args of commands) {
                git(setup, args);
            }
            const verified = await verifyRemote({ runner: setup.runner }, setup.git, setup.clone, 'origin', 'o', 'r');
            assert.deepEqual(verified, { ok: false, reason: PUSH_REFUSAL }, JSON.stringify(commands));
        }
    });

    await test('an owner rewrite that keeps the repository verifies', async (t) => {
        const setup = gitSetup(await makeEnv(t), 'git');
        git(setup, ['config', 'url.git@github.com:.insteadOf', 'https://github.com/']);
        assert.equal(git(setup, ['remote', 'get-url', '--push', 'origin']), 'git@github.com:o/r.git');
        const verified = await verifyRemote({ runner: setup.runner }, setup.git, setup.clone, 'origin', 'o', 'r');
        assert.deepEqual(verified, { ok: true });
    });

    await test('the raw URL must be exactly one value naming the head repository', async (t) => {
        const testEnv = await makeEnv(t);
        const cases: readonly (readonly (readonly string[])[])[] = [
            [['remote', 'set-url', 'origin', 'https://github.com/o/other.git']],
            [['config', '--add', 'remote.origin.url', 'https://github.com/o/r.git']],
            [['config', '--add', 'remote.origin.url', '']],
            [['config', 'remote.origin.url', '']],
        ];
        for (const [index, commands] of cases.entries()) {
            const setup = gitSetup(testEnv, `url-${index}`);
            for (const args of commands) {
                git(setup, args);
            }
            const verified = await verifyRemote({ runner: setup.runner }, setup.git, setup.clone, 'origin', 'o', 'r');
            assert.deepEqual(verified, { ok: false, reason: URL_REFUSAL }, JSON.stringify(commands));
        }
    });

    await test('an empty push URL next to a valid one is refused', async (t) => {
        const setup = gitSetup(await makeEnv(t), 'git');
        git(setup, ['config', '--add', 'remote.origin.pushurl', '']);
        git(setup, ['config', '--add', 'remote.origin.pushurl', 'https://github.com/o/r.git']);
        const verified = await verifyRemote({ runner: setup.runner }, setup.git, setup.clone, 'origin', 'o', 'r');
        assert.deepEqual(verified, { ok: false, reason: PUSH_REFUSAL });
    });

    await test('a missing remote is not found', async (t) => {
        const setup = gitSetup(await makeEnv(t), 'git');
        const verified = await verifyRemote({ runner: setup.runner }, setup.git, setup.clone, 'upstream', 'o', 'r');
        assert.deepEqual(verified, { ok: false, reason: 'remote upstream not found' });
    });
});

await describe('currentBranch', async () => {
    await test('a branch shadowed by a tag of the same name keeps its plain name', async (t) => {
        const setup = gitSetup(await makeEnv(t), 'git', 'v1.2');
        git(setup, ['tag', 'v1.2']);
        assert.equal(await currentBranch({ runner: setup.runner }, setup.git, setup.clone), 'v1.2');
        git(setup, ['checkout', '--quiet', '--detach']);
        assert.equal(await currentBranch({ runner: setup.runner }, setup.git, setup.clone), undefined);
    });
});

await describe('runGuards', async () => {
    await test('a clean branch equal to the remote passes with the remote head', async (t) => {
        const setup = await guardSetup(t);
        const result = await guards(setup);
        assert.ok(result.ok);
        assert.match(result.headSha, SHA);
        assert.equal(result.headSha, git(setup, ['rev-parse', 'HEAD']));
    });

    await test('a modified tracked file holds and an untracked file does not', async (t) => {
        const setup = await guardSetup(t);
        fs.writeFileSync(path.join(setup.clone, 'untracked.txt'), 'new\n');
        const untracked = await guards(setup);
        assert.ok(untracked.ok);
        fs.writeFileSync(path.join(setup.clone, 'README.md'), 'changed\n');
        assert.deepEqual(await guards(setup), {
            ok: false,
            reason: 'uncommitted changes to tracked files',
            hint: 'commit or stash them',
        });
    });

    await test('ahead, behind and diverged', async (t) => {
        const setup = await guardSetup(t);
        commitLocal(setup);
        assert.deepEqual(await guards(setup), {
            ok: false,
            reason: 'local branch is ahead of the remote',
            hint: 'push or reset the branch manually',
        });
        git(setup, ['reset', '--quiet', '--hard', 'HEAD~1']);
        const remoteSha = pushRemoteCommit(setup.gitRoot, BRANCH, setup.testEnv.env);
        const behind = await guards(setup);
        assert.deepEqual(behind, { ok: true, headSha: remoteSha });
        commitLocal(setup);
        assert.deepEqual(await guards(setup), {
            ok: false,
            reason: 'local branch has diverged from the remote',
            hint: 'push or reset the branch manually',
        });
    });

    await test('a branch with a same-named tag passes', async (t) => {
        const setup = await guardSetup(t, 'v1.2');
        git(setup, ['tag', 'v1.2']);
        const result = await guards(setup);
        assert.ok(result.ok, JSON.stringify(result));
        assert.equal(result.headSha, git(setup, ['rev-parse', 'refs/heads/v1.2']));
    });

    await test('the fetch always writes FETCH_HEAD, whatever the clone config says', async (t) => {
        const setup = await guardSetup(t);
        git(setup, ['config', 'fetch.writeFetchHEAD', 'false']);
        const first = await guards(setup);
        assert.ok(first.ok);
        const remoteSha = pushRemoteCommit(setup.gitRoot, BRANCH, setup.testEnv.env);
        assert.deepEqual(await guards(setup), { ok: true, headSha: remoteSha });
        const fetches = setup.fake.calls('git').filter((call) => call.key === 'fetch');
        assert.equal(fetches.length, 2);
        for (const call of fetches) {
            assert.deepEqual(call.args, [
                '-C',
                setup.clone,
                '-c',
                'fetch.writeFetchHEAD=true',
                'fetch',
                '--quiet',
                'origin',
                `refs/heads/${BRANCH}`,
            ]);
        }
    });

    await test('a removed remote holds before any fetch', async (t) => {
        const setup = await guardSetup(t);
        git(setup, ['remote', 'remove', 'origin']);
        assert.deepEqual(await guards(setup), {
            ok: false,
            reason: 'remote origin not found',
            hint: "fix the remote's URLs",
        });
        assert.equal(setup.fake.callCount('git', 'fetch'), 0);
    });

    await test('a failing fetch holds', async (t) => {
        const setup = await guardSetup(t);
        fs.rmSync(path.join(setup.gitRoot, 'remote.git'), { recursive: true, force: true });
        assert.deepEqual(await guards(setup), { ok: false, reason: 'fetch failed', hint: '' });
    });

    await test('another branch holds', async (t) => {
        const setup = await guardSetup(t);
        git(setup, ['checkout', '--quiet', 'main']);
        const result = await guards(setup);
        assert.ok(!result.ok);
        assert.ok(result.reason.startsWith('wrong branch'), result.reason);
        assert.equal(result.hint, `git checkout ${BRANCH}`);
    });

    await test('a push URL changed between two calls holds with the remote check reason', async (t) => {
        const setup = await guardSetup(t);
        const before = await guards(setup);
        assert.ok(before.ok);
        git(setup, ['remote', 'set-url', '--push', 'origin', 'https://github.com/o/other.git']);
        assert.deepEqual(await guards(setup), { ok: false, reason: PUSH_REFUSAL, hint: "fix the remote's URLs" });
    });
});
