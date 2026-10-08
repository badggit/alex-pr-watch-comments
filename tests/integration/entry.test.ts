import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { makePrClone } from '../support/gitRepo.ts';
import { stubCallCount, stubRespond } from '../support/stubQueue.ts';
import { createTestEnv, type ObservedResult, type TestEnv } from '../support/testEnv.ts';
import { mainClone } from '../support/worktreeRepo.ts';

const ROOT = fs.realpathSync.native(path.resolve(import.meta.dirname, '..', '..'));
const LAUNCHER = path.join(ROOT, 'bin', 'alex-pr-watch-comments');
const MAIN_TS = path.join(ROOT, 'src', 'main.ts');
const FIXTURES = path.join(ROOT, 'tests', 'fixtures');
const TIMEOUT = 'timeout';
const EXIT_MS = 60_000;
const PR_URL = 'https://github.com/o/r/pull/12';
const IGNORE_RULES = ['node_modules/', '.env', ''].join('\n');

interface WorktreeSetup {
    testEnv: TestEnv;
    clone: string;
    parent: string;
    // The caller environment with PATH set to exactly the isolated tool directory.
    env: TestEnv['env'];
    tools: string;
}

function readFixture(...parts: readonly string[]): unknown {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(FIXTURES, ...parts), 'utf8'));
    return parsed;
}

async function within<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
    const controller = new AbortController();
    const timer = delay<typeof TIMEOUT>(ms, TIMEOUT, { signal: controller.signal }).catch(
        (): typeof TIMEOUT => TIMEOUT
    );
    try {
        return await Promise.race([promise, timer]);
    } finally {
        controller.abort();
    }
}

async function makeEnv(t: TestContext): Promise<TestEnv> {
    const testEnv = await createTestEnv();
    t.after(() => {
        testEnv.cleanup();
    });
    return testEnv;
}

async function runEntry(testEnv: TestEnv, args: readonly string[]): Promise<ObservedResult> {
    const observed = testEnv.spawnObserved('/bin/sh', [LAUNCHER, ...args], { cwd: testEnv.root });
    const result = await within(observed.result, EXIT_MS);
    assert.ok(result !== TIMEOUT, `${args.join(' ')} did not exit within ${EXIT_MS} ms`);
    return result;
}

function findTool(name: string): string {
    const found = (process.env.PATH ?? '')
        .split(':')
        .filter((dir) => path.isAbsolute(dir))
        .map((dir) => path.join(dir, name))
        .find((file) => fs.existsSync(file));
    assert.ok(found !== undefined, `${name} is not on PATH`);
    return found;
}

// A tool directory holding only node, git and cp, so no gh, tmux or claude stub and no system directory is reachable.
async function setUpWorktree(t: TestContext): Promise<WorktreeSetup> {
    const testEnv = await makeEnv(t);
    const clone = mainClone(path.join(testEnv.root, 'git'), testEnv.env);
    const tools = path.join(testEnv.root, 'isolated');
    fs.mkdirSync(tools);
    fs.symlinkSync(process.execPath, path.join(tools, 'node'));
    fs.symlinkSync(testEnv.tools.git, path.join(tools, 'git'));
    fs.symlinkSync(findTool('cp'), path.join(tools, 'cp'));
    return { testEnv, clone, parent: path.dirname(clone), env: { ...testEnv.env, PATH: tools }, tools };
}

function seedIgnored(clone: string): void {
    fs.writeFileSync(path.join(clone, '.git', 'info', 'exclude'), IGNORE_RULES);
    fs.mkdirSync(path.join(clone, 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(clone, 'node_modules', 'pkg', 'index.js'), 'kept\n');
    fs.writeFileSync(path.join(clone, '.env'), 'KEY=value\n');
}

function writeScript(file: string, lines: readonly string[]): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, ['#!/bin/sh', ...lines, ''].join('\n'), { mode: 0o755 });
}

function lstatOrUndefined(file: string): fs.Stats | undefined {
    try {
        return fs.lstatSync(file);
    } catch {
        return;
    }
}

async function runNewWorktreeEntry(
    setup: WorktreeSetup,
    args: readonly string[],
    env?: TestEnv['env']
): Promise<ObservedResult> {
    const observed = setup.testEnv.spawnObserved('/bin/sh', [LAUNCHER, 'new-worktree', ...args], {
        cwd: setup.clone,
        env: env ?? setup.env,
    });
    const result = await within(observed.result, EXIT_MS);
    assert.ok(result !== TIMEOUT, `new-worktree ${args.join(' ')} did not exit within ${EXIT_MS} ms`);
    return result;
}

await describe('entry wiring', async () => {
    await test('a foreground --once run polls once and exits 0', async (t) => {
        const testEnv = await makeEnv(t);
        const clone = makePrClone(path.join(testEnv.root, 'git'), 'feature', 'o/r', testEnv.env);
        stubRespond(testEnv.stubDir, 'tmux', 'display-message', { stdout: '$1 @1\n' });
        stubRespond(testEnv.stubDir, 'gh', 'PrwcPrInfo', { json: readFixture('preflight', 'prInfoOpen.json') });
        stubRespond(testEnv.stubDir, 'gh', 'PrwcPoll', { json: readFixture('watcher', 'pollOpen.json') });
        const result = await runEntry(testEnv, [PR_URL, '--once', '--in-place', '--dir', clone]);
        assert.equal(result.code, 0, `${result.stdout}${result.stderr}`);
        assert.equal(stubCallCount(testEnv.stubDir, 'gh', 'PrwcPoll'), 1);
    });

    await test('--once with --background is a usage error', async (t) => {
        const testEnv = await makeEnv(t);
        const result = await runEntry(testEnv, [PR_URL, '--background', '--once']);
        assert.equal(result.code, 2);
        assert.ok(result.stderr.includes('--once cannot be combined with --background'), result.stderr);
    });

    await test('--list on an empty state directory prints no watchers', async (t) => {
        const testEnv = await makeEnv(t);
        const result = await runEntry(testEnv, ['--list']);
        assert.equal(result.code, 0, result.stderr);
        assert.equal(result.stdout, 'no watchers\n');
    });

    await test('main.ts loads the watcher and the control module statically', () => {
        const imports = fs
            .readFileSync(MAIN_TS, 'utf8')
            .split('\n')
            .filter((line) => line.startsWith('import {'));
        for (const imported of ['./watcher.ts', './control.ts']) {
            assert.ok(
                imports.some((line) => line.endsWith(` from '${imported}';`)),
                imported
            );
        }
    });

    await test('new-worktree --task prints exactly the created path and logs to stderr', async (t) => {
        const setup = await setUpWorktree(t);
        seedIgnored(setup.clone);
        const result = await runNewWorktreeEntry(setup, ['--task', 'abc-123']);
        const created = path.join(setup.parent, 'clone-abc-123');
        assert.equal(result.code, 0, result.stderr);
        assert.equal(result.stdout, `${created}\n`);
        assert.ok(fs.statSync(created).isDirectory());
        assert.ok(result.stderr.includes(' info name based on main working tree folder clone\n'), result.stderr);
        assert.ok(lstatOrUndefined(path.join(created, '.env'))?.isSymbolicLink() === true);
    });

    await test('new-worktree refuses an existing target folder with exit 1 and empty stdout', async (t) => {
        const setup = await setUpWorktree(t);
        fs.mkdirSync(path.join(setup.parent, 'clone-taken'));
        const result = await runNewWorktreeEntry(setup, ['--task', 'taken']);
        assert.equal(result.code, 1, result.stderr);
        assert.equal(result.stdout, '');
        assert.ok(/^alex-pr-watch-comments: \S/mu.test(result.stderr), result.stderr);
        assert.ok(result.stderr.includes('clone-taken'), result.stderr);
    });

    await test('new-worktree fails without a sync when the post-checkout hook fails', async (t) => {
        const setup = await setUpWorktree(t);
        seedIgnored(setup.clone);
        writeScript(path.join(setup.clone, '.git', 'hooks', 'post-checkout'), ['exit 1']);
        const result = await runNewWorktreeEntry(setup, ['--task', 'hooked']);
        const target = path.join(setup.parent, 'clone-hooked');
        assert.equal(result.code, 1, result.stderr);
        assert.equal(result.stdout, '');
        assert.ok(result.stderr.includes('alex-pr-watch-comments: the worktree exists at '), result.stderr);
        assert.ok(fs.statSync(target).isDirectory());
        assert.equal(lstatOrUndefined(path.join(target, '.env')), undefined);
        assert.equal(lstatOrUndefined(path.join(target, 'node_modules')), undefined);
    });

    await test('new-worktree still prints the path when the sync can only warn', async (t) => {
        if (process.getuid?.() === 0) {
            t.skip('root ignores file modes');
            return;
        }
        const setup = await setUpWorktree(t);
        seedIgnored(setup.clone);
        fs.chmodSync(path.join(setup.clone, '.git', 'info', 'exclude'), 0o444);
        const result = await runNewWorktreeEntry(setup, ['--task', 'warned']);
        assert.equal(result.code, 0, result.stderr);
        assert.equal(result.stdout, `${path.join(setup.parent, 'clone-warned')}\n`);
        assert.ok(/ warn cannot update \S*info\/exclude/u.test(result.stderr), result.stderr);
    });

    await test('new-worktree without a NAME is a usage error', async (t) => {
        const setup = await setUpWorktree(t);
        const result = await runNewWorktreeEntry(setup, []);
        assert.equal(result.code, 2);
        assert.equal(result.stdout, '');
        assert.ok(result.stderr.includes('give a NAME or --task SLUG'), result.stderr);
        assert.ok(result.stderr.includes('Usage'), result.stderr);
    });

    await test('new-worktree maps a derived name that is too long to a usage error', async (t) => {
        const setup = await setUpWorktree(t);
        const result = await runNewWorktreeEntry(setup, ['--task', 'a'.repeat(100)]);
        assert.equal(result.code, 2, result.stderr);
        assert.equal(result.stdout, '');
        assert.ok(result.stderr.includes('Usage'), result.stderr);
    });

    await test('new-worktree never runs a git from the project PATH entry', async (t) => {
        const setup = await setUpWorktree(t);
        const marker = path.join(setup.testEnv.root, 'marker');
        writeScript(path.join(setup.clone, 'bin', 'git'), [`echo "git $0" >> '${marker}'`, 'exit 1']);
        const env = { ...setup.env, PATH: `${path.join(setup.clone, 'bin')}:${setup.tools}` };
        const result = await runNewWorktreeEntry(setup, ['--task', 'clean'], env);
        assert.equal(result.code, 0, result.stderr);
        assert.equal(result.stdout, `${path.join(setup.parent, 'clone-clean')}\n`);
        assert.equal(fs.existsSync(marker), false);
    });
});
