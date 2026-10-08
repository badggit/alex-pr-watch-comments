import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test, type TestContext } from 'node:test';

import { createCloner, type Cloner } from '../../src/cowClone.ts';
import type { NewWorktreeArgs } from '../../src/newWorktreeArgs.ts';
import { runNewWorktree, type NewWorktreeOutcome } from '../../src/newWorktreeCommand.ts';
import { createProcessRunner } from '../../src/proc.ts';
import type { CommandResult, CommandRunner, Env } from '../../src/types.ts';
import { gitSync } from '../support/gitRepo.ts';
import { createTestEnv, type TestDeps } from '../support/testEnv.ts';
import { headOf, mainClone } from '../support/worktreeRepo.ts';

const IGNORE_RULES = ['node_modules/', '.env', ''].join('\n');
const NO_ARGS: NewWorktreeArgs = { name: undefined, task: undefined, branch: undefined, base: undefined };

interface Setup {
    env: Env;
    root: string;
    clone: string;
    parent: string;
    deps: TestDeps;
}

interface RunOptions {
    cwd?: string;
    env?: Env;
    emulateCp?: boolean;
    cloner?: Cloner;
    // Wraps every runner the handler gets, for fault injection.
    wrap?: (_inner: CommandRunner) => CommandRunner;
}

interface Run {
    outcome: NewWorktreeOutcome;
    envs: Env[];
    cpCalls: string[][];
    // Requests for a bare or absolute cp, counted before emulation, so they also count when real cp runs.
    cpRuns: number;
}

async function setUp(t: TestContext): Promise<Setup> {
    const testEnv = await createTestEnv();
    t.after(() => {
        testEnv.cleanup();
    });
    const clone = mainClone(path.join(testEnv.root, 'git'), testEnv.env);
    return {
        env: testEnv.env,
        root: testEnv.root,
        clone,
        parent: path.dirname(clone),
        deps: testEnv.deps(createProcessRunner(testEnv.env)),
    };
}

function git(setup: Setup, dir: string, args: readonly string[]): string {
    return gitSync(setup.env, ['-C', dir, ...args]);
}

function seedIgnored(setup: Setup): void {
    const { clone } = setup;
    fs.writeFileSync(path.join(clone, '.git', 'info', 'exclude'), IGNORE_RULES);
    fs.mkdirSync(path.join(clone, 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(clone, 'node_modules', 'pkg', 'index.js'), 'kept\n');
    fs.writeFileSync(path.join(clone, '.env'), 'KEY=value\n');
}

function addLinked(setup: Setup, name: string, branch: string): string {
    const linked = path.join(setup.parent, name);
    git(setup, setup.clone, ['worktree', 'add', '--quiet', linked, branch]);
    return fs.realpathSync.native(linked);
}

// Copies every cp call with fs.cpSync and forwards everything else, so copy-on-write works on any file system.
function emulatedRunner(inner: CommandRunner, calls: string[][]): CommandRunner {
    return {
        async run(request) {
            if (request.file !== 'cp') {
                return inner.run(request);
            }
            calls.push([...request.args]);
            const source = request.args.at(-2);
            const target = request.args.at(-1);
            assert.ok(source);
            assert.ok(target);
            fs.cpSync(source, target, { recursive: true, verbatimSymlinks: true });
            return { code: 0, stdout: '', stderr: '' };
        },
    };
}

function countingRunner(inner: CommandRunner, onCp: () => void): CommandRunner {
    return {
        run(request) {
            if (request.file === 'cp' || request.file.endsWith('/cp')) {
                onCp();
            }
            return inner.run(request);
        },
    };
}

async function run(setup: Setup, args: Partial<NewWorktreeArgs>, options: RunOptions = {}): Promise<Run> {
    const envs: Env[] = [];
    const cpCalls: string[][] = [];
    let cpRuns = 0;
    const emulateCp = options.emulateCp ?? true;
    const outcome = await runNewWorktree(
        {
            env: options.env ?? setup.env,
            log: setup.deps.log,
            makeRunner: (env) => {
                envs.push(env);
                const inner = createProcessRunner(env);
                const base = emulateCp ? emulatedRunner(inner, cpCalls) : inner;
                const counted = countingRunner(base, () => {
                    cpRuns += 1;
                });
                return options.wrap === undefined ? counted : options.wrap(counted);
            },
            cloner: options.cloner ?? createCloner({ platform: 'linux' }),
        },
        { ...NO_ARGS, ...args },
        options.cwd ?? setup.clone
    );
    return { outcome, envs, cpCalls, cpRuns };
}

function okPath(outcome: NewWorktreeOutcome): string {
    assert.equal(outcome.kind, 'ok', JSON.stringify(outcome));
    assert.ok(outcome.kind === 'ok');
    return outcome.path;
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

function branchExists(setup: Setup, branch: string): boolean {
    return git(setup, setup.clone, ['branch', '--list', branch]).trim().length > 0;
}

function writeMarkerTool(dir: string, name: string, marker: string): void {
    fs.mkdirSync(dir, { recursive: true });
    const script = ['#!/bin/sh', `echo "${name} $0" >> '${marker}'`, 'exit 1', ''].join('\n');
    fs.writeFileSync(path.join(dir, name), script, { mode: 0o755 });
}

function pathEntries(env: Env): string[] {
    return (env.PATH ?? '').split(':');
}

// Answers every check-ref-format call with RESULT and forwards everything else.
function refRunner(result: CommandResult): (_inner: CommandRunner) => CommandRunner {
    return (inner) => ({
        run: (request) => (request.args.includes('check-ref-format') ? Promise.resolve(result) : inner.run(request)),
    });
}

await describe('runNewWorktree', async () => {
    await test('--task from the main clone creates a branch at HEAD with a cloned node_modules', async (t) => {
        const setup = await setUp(t);
        seedIgnored(setup);
        const result = await run(setup, { task: 'abc-123' });
        const created = okPath(result.outcome);
        assert.equal(created, path.join(setup.parent, 'clone-abc-123'));
        assert.equal(git(setup, created, ['branch', '--show-current']).trim(), 'abc-123');
        assert.equal(headOf(setup.env, created), headOf(setup.env, setup.clone));
        const modules = fs.lstatSync(path.join(created, 'node_modules'));
        assert.ok(modules.isDirectory() && !modules.isSymbolicLink());
        assert.equal(fs.readFileSync(path.join(created, 'node_modules', 'pkg', 'index.js'), 'utf8'), 'kept\n');
        assert.equal(linkText(path.join(created, '.env')), path.join(setup.clone, '.env'));
        const exclude = fs.readFileSync(path.join(setup.clone, '.git', 'info', 'exclude'), 'utf8');
        assert.ok(exclude.split('\n').includes('/node_modules'));
        assert.equal(git(setup, created, ['status', '--porcelain']), '');
        assert.ok(setup.deps.logLines.includes('info name based on main working tree folder clone'));
    });

    await test('from a linked worktree the name and links come from the main clone, the start from HEAD', async (t) => {
        const setup = await setUp(t);
        seedIgnored(setup);
        const linked = addLinked(setup, 'linked', 'feature');
        assert.notEqual(headOf(setup.env, linked), headOf(setup.env, setup.clone));
        const result = await run(setup, { task: 't2' }, { cwd: linked });
        const created = okPath(result.outcome);
        assert.equal(created, path.join(setup.parent, 'clone-t2'));
        assert.equal(headOf(setup.env, created), headOf(setup.env, linked));
        assert.equal(linkText(path.join(created, '.env')), path.join(setup.clone, '.env'));
        assert.ok(fs.lstatSync(path.join(created, 'node_modules')).isDirectory());
    });

    await test('--base main starts the new branch at main', async (t) => {
        const setup = await setUp(t);
        const linked = addLinked(setup, 'linked', 'feature');
        const result = await run(setup, { name: 'hot', base: 'main' }, { cwd: linked });
        const created = okPath(result.outcome);
        assert.equal(created, path.join(setup.parent, 'hot'));
        assert.equal(git(setup, created, ['branch', '--show-current']).trim(), 'hot');
        assert.equal(headOf(setup.env, created), git(setup, setup.clone, ['rev-parse', 'main']).trim());
    });

    await test('a second run with the same arguments reuses the worktree without cloning again', async (t) => {
        const setup = await setUp(t);
        seedIgnored(setup);
        const first = await run(setup, { task: 'again' });
        const created = okPath(first.outcome);
        assert.ok(first.cpCalls.length > 0, 'the first run clones');
        const inode = fs.statSync(path.join(created, 'node_modules')).ino;
        const second = await run(setup, { task: 'again' });
        assert.equal(okPath(second.outcome), created);
        assert.ok(setup.deps.logLines.some((line) => line.includes('reusing')));
        assert.equal(second.cpCalls.length, 0);
        assert.equal(fs.statSync(path.join(created, 'node_modules')).ino, inode);
    });

    await test('the new worktree can be removed without --force right after creation', async (t) => {
        const setup = await setUp(t);
        seedIgnored(setup);
        const result = await run(setup, { task: 'gone' });
        const created = okPath(result.outcome);
        git(setup, setup.clone, ['worktree', 'remove', created]);
        assert.ok(!exists(created));
    });

    await test('no git or cp from the project trees runs, also when the run is refused', async (t) => {
        const setup = await setUp(t);
        seedIgnored(setup);
        const linked = addLinked(setup, 'linked', 'feature');
        const marker = path.join(setup.root, 'marker');
        const cloneBin = path.join(setup.clone, 'bin');
        const linkedBin = path.join(linked, 'bin');
        writeMarkerTool(cloneBin, 'git', marker);
        writeMarkerTool(cloneBin, 'cp', marker);
        writeMarkerTool(linkedBin, 'cp', marker);
        const env: Env = { ...setup.env, PATH: [cloneBin, linkedBin, setup.env.PATH ?? ''].join(':') };
        // On Linux the cloner and its probe run a bare cp looked up on PATH; elsewhere the platform default applies.
        const cloner = process.platform === 'linux' ? createCloner({ platform: 'linux' }) : createCloner();
        const options: RunOptions = { cwd: linked, env, emulateCp: false, cloner };
        const ok = await run(setup, { task: 'clean' }, options);
        okPath(ok.outcome);
        assert.ok(ok.envs.length > 0);
        for (const used of ok.envs) {
            const entries = pathEntries(used);
            assert.ok(!entries.includes(cloneBin) && !entries.includes(linkedBin), used.PATH);
        }
        assert.ok(!exists(marker), 'no fake tool ran');
        if (process.platform === 'linux') {
            assert.ok(ok.cpRuns > 0, 'the sync ran cp through the cleaned runner');
        }
        // An empty folder at the target is foreign, so this run is refused before anything is created.
        fs.mkdirSync(path.join(setup.parent, 'clone-foreign'));
        const refused = await run(setup, { task: 'foreign' }, options);
        assert.equal(refused.outcome.kind, 'refused');
        for (const used of refused.envs) {
            const entries = pathEntries(used);
            assert.ok(!entries.includes(cloneBin) && !entries.includes(linkedBin), used.PATH);
        }
        assert.ok(!exists(marker), 'no fake tool ran on refusal');
    });

    await test('a derived name over the length limit is a usage error', async (t) => {
        const setup = await setUp(t);
        const result = await run(setup, { task: 'x'.repeat(100) });
        assert.equal(result.outcome.kind, 'usage');
        assert.ok(!exists(path.join(setup.parent, `clone-${'x'.repeat(100)}`)));
    });

    await test('a foreign folder at the target is refused and nothing is created', async (t) => {
        const setup = await setUp(t);
        const target = path.join(setup.parent, 'clone-foreign');
        fs.mkdirSync(target);
        fs.writeFileSync(path.join(target, 'mine.txt'), 'mine\n');
        const before = git(setup, setup.clone, ['worktree', 'list', '--porcelain']);
        const result = await run(setup, { task: 'foreign' });
        assert.equal(result.outcome.kind, 'refused');
        assert.deepEqual(fs.readdirSync(target), ['mine.txt']);
        assert.ok(!branchExists(setup, 'foreign'));
        assert.equal(git(setup, setup.clone, ['worktree', 'list', '--porcelain']), before);
    });

    await test('--base with an unknown commit is refused for a new branch', async (t) => {
        const setup = await setUp(t);
        const result = await run(setup, { name: 'newer', base: 'nope' });
        assert.equal(result.outcome.kind, 'refused');
        assert.ok(result.outcome.kind === 'refused' && result.outcome.reason.includes('unknown commit'));
        assert.ok(!branchExists(setup, 'newer'));
        assert.ok(!exists(path.join(setup.parent, 'newer')));
    });

    await test('an empty PATH is refused before any runner exists', async (t) => {
        const setup = await setUp(t);
        const result = await run(setup, { task: 'nopath' }, { env: { ...setup.env, PATH: '' } });
        assert.deepEqual(result.outcome, { kind: 'refused', reason: 'missing required tool: git' });
        assert.equal(result.envs.length, 0);
    });

    await test('a branch name git rejects is a usage error', async (t) => {
        const setup = await setUp(t);
        const wrap = refRunner({ code: 1, stdout: '', stderr: '' });
        const result = await run(setup, { task: 'rejected' }, { wrap });
        assert.deepEqual(result.outcome, { kind: 'usage', message: 'invalid branch name: rejected' });
        assert.ok(!exists(path.join(setup.parent, 'clone-rejected')));
    });

    await test('a branch name check that cannot run is refused, not a usage error', async (t) => {
        const setup = await setUp(t);
        const spawn = refRunner({ code: 127, stdout: '', stderr: '', spawnError: 'ENOENT' });
        const spawned = await run(setup, { task: 'spawn' }, { wrap: spawn });
        assert.deepEqual(spawned.outcome, { kind: 'refused', reason: 'cannot check branch name spawn: ENOENT' });
        const fatal = refRunner({ code: 128, stdout: '', stderr: 'fatal: broken\n' });
        const failed = await run(setup, { task: 'fatal' }, { wrap: fatal });
        assert.deepEqual(failed.outcome, { kind: 'refused', reason: 'cannot check branch name fatal: fatal: broken' });
        assert.ok(!exists(path.join(setup.parent, 'clone-spawn')) && !exists(path.join(setup.parent, 'clone-fatal')));
    });

    await test('a sync that throws is a warning and the worktree is still returned', async (t) => {
        const setup = await setUp(t);
        seedIgnored(setup);
        const cloner: Cloner = {
            cloneDependency: () => Promise.reject(new Error('probe cleanup failed')),
        };
        const result = await run(setup, { task: 'thrown' }, { cloner });
        assert.equal(okPath(result.outcome), path.join(setup.parent, 'clone-thrown'));
        assert.ok(
            setup.deps.logLines.includes('warn cannot sync ignored paths into the worktree: probe cleanup failed'),
            setup.deps.logLines.join('\n')
        );
    });

    await test('a linked worktree of a separate-git-dir repository names the target after itself', async (t) => {
        const setup = await setUp(t);
        const repo = path.join(setup.root, 'separate');
        gitSync(setup.env, ['init', '--quiet', `--separate-git-dir=${path.join(setup.root, 'G')}`, repo]);
        fs.writeFileSync(path.join(repo, 'file.txt'), 'x\n');
        git(setup, repo, ['add', 'file.txt']);
        git(setup, repo, ['commit', '--quiet', '-m', 'one']);
        const linked = path.join(setup.root, 'separate-linked');
        git(setup, repo, ['worktree', 'add', '--quiet', '-b', 'side', linked]);
        const result = await run(setup, { task: 'sep' }, { cwd: linked });
        const created = okPath(result.outcome);
        assert.equal(created, path.join(fs.realpathSync.native(setup.root), 'separate-linked-sep'));
        assert.ok(setup.deps.logLines.includes('info name based on current working tree folder separate-linked'));
    });
});
