import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test, type TestContext } from 'node:test';

import { checkTools, discoverTreesByFs } from '../../src/newWorktreeTools.ts';

const SYSTEM_PATH = '/usr/bin:/bin';
const NO_TREES = { current: undefined, main: undefined, commonDir: undefined };

function tempRoot(t: TestContext): string {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'prwc-nwt-')));
    t.after(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });
    return root;
}

function git(args: readonly string[]): void {
    execFileSync('git', [...args], { encoding: 'utf8', stdio: 'pipe' });
}

// A clone with one commit, so that linked worktrees can be added to it.
function makeClone(root: string): string {
    const clone = path.join(root, 'clone');
    git(['init', '--quiet', '--initial-branch=main', clone]);
    fs.writeFileSync(path.join(clone, 'README.md'), 'main\n');
    git(['-C', clone, 'add', '--', 'README.md']);
    git(['-C', clone, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '--quiet', '-m', 'init']);
    return clone;
}

function writeExecutable(file: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
}

// A tools directory with fake git and cp, so a PATH made of it alone passes the tool check.
function writeTools(dir: string): void {
    writeExecutable(path.join(dir, 'git'));
    writeExecutable(path.join(dir, 'cp'));
}

function symlinkTool(dir: string, name: string, target: string): void {
    fs.mkdirSync(dir, { recursive: true });
    fs.symlinkSync(target, path.join(dir, name));
}

function entries(pathValue: string): string[] {
    return pathValue.split(':');
}

// A main tree and a current tree, each holding a .git folder and a bin with fake tools, plus a cwd inside current.
function makeTrees(root: string): { main: string; current: string } {
    const main = path.join(root, 'main');
    const current = path.join(root, 'current');
    for (const tree of [main, current]) {
        fs.mkdirSync(path.join(tree, '.git'), { recursive: true });
        writeTools(path.join(tree, 'bin'));
    }
    return { main, current };
}

await describe('discoverTreesByFs', async () => {
    await test('a normal clone and its subdirectory', (t) => {
        const clone = makeClone(tempRoot(t));
        const sub = path.join(clone, 'a', 'b');
        fs.mkdirSync(sub, { recursive: true });
        const expected = { current: clone, main: clone, commonDir: path.join(clone, '.git') };
        assert.deepEqual(discoverTreesByFs(clone), expected);
        assert.deepEqual(discoverTreesByFs(sub), expected);
    });

    await test('a linked worktree points back at the main clone', (t) => {
        const root = tempRoot(t);
        const clone = makeClone(root);
        const linked = path.join(root, 'linked');
        git(['-C', clone, 'worktree', 'add', '--quiet', '-b', 'side', linked]);
        assert.deepEqual(discoverTreesByFs(linked), {
            current: linked,
            main: clone,
            commonDir: path.join(clone, '.git'),
        });
    });

    await test('a plain directory has no trees', (t) => {
        assert.deepEqual(discoverTreesByFs(tempRoot(t)), NO_TREES);
    });

    await test('a .git file with garbage content does not throw', (t) => {
        const root = tempRoot(t);
        fs.writeFileSync(path.join(root, '.git'), 'garbage\n');
        assert.deepEqual(discoverTreesByFs(root), { ...NO_TREES, current: root });
    });

    await test('a separate git dir outside a .git folder leaves main undefined', (t) => {
        const root = tempRoot(t);
        const work = path.join(root, 'work');
        const store = path.join(root, 'store');
        fs.mkdirSync(work);
        fs.mkdirSync(store);
        fs.writeFileSync(path.join(work, '.git'), `gitdir: ${store}\n`);
        assert.deepEqual(discoverTreesByFs(work), { current: work, main: undefined, commonDir: store });
    });

    await test('a relative gitdir resolves against the folder holding the .git file', (t) => {
        const root = tempRoot(t);
        const work = path.join(root, 'work');
        const store = path.join(root, 'store');
        fs.mkdirSync(work);
        fs.mkdirSync(store);
        fs.writeFileSync(path.join(work, '.git'), 'gitdir: ../store\r\n');
        assert.deepEqual(discoverTreesByFs(work), { current: work, main: undefined, commonDir: store });
    });

    await test('spaces inside the gitdir value are kept', (t) => {
        const root = tempRoot(t);
        const work = path.join(root, 'work');
        const store = path.join(root, 'store ');
        fs.mkdirSync(work);
        fs.mkdirSync(store);
        fs.writeFileSync(path.join(work, '.git'), `gitdir: ${store}\n`);
        assert.equal(discoverTreesByFs(work).commonDir, store);
    });

    await test('a gitdir line without the space after the colon is malformed', (t) => {
        const root = tempRoot(t);
        const store = path.join(root, 'store');
        fs.mkdirSync(store);
        fs.writeFileSync(path.join(root, '.git'), `gitdir:${store}\n`);
        assert.deepEqual(discoverTreesByFs(root), { ...NO_TREES, current: root });
    });

    await test('a .git file with more than one line is malformed', (t) => {
        const root = tempRoot(t);
        const store = path.join(root, 'store');
        fs.mkdirSync(store);
        fs.writeFileSync(path.join(root, '.git'), `gitdir: ${store}\nextra\n`);
        assert.deepEqual(discoverTreesByFs(root), { ...NO_TREES, current: root });
    });

    await test('a commondir with more than one line is malformed', (t) => {
        const root = tempRoot(t);
        const clone = makeClone(root);
        const linked = path.join(root, 'linked');
        git(['-C', clone, 'worktree', 'add', '--quiet', '-b', 'side', linked]);
        fs.writeFileSync(path.join(clone, '.git', 'worktrees', 'linked', 'commondir'), '../..\n../..\n');
        assert.deepEqual(discoverTreesByFs(linked), { ...NO_TREES, current: linked });
    });

    await test('an unreadable commondir leaves the common dir and main undefined', (t) => {
        const root = tempRoot(t);
        const work = path.join(root, 'work');
        const store = path.join(root, 'store');
        fs.mkdirSync(work);
        // A directory in place of the file fails the read with EISDIR, for root too, unlike a chmod.
        fs.mkdirSync(path.join(store, 'commondir'), { recursive: true });
        fs.writeFileSync(path.join(work, '.git'), `gitdir: ${store}\n`);
        assert.deepEqual(discoverTreesByFs(work), { ...NO_TREES, current: work });
    });

    await test('a .git symlink to a directory counts as a .git directory', (t) => {
        const root = tempRoot(t);
        const work = path.join(root, 'work');
        const store = path.join(root, 'store', '.git');
        fs.mkdirSync(work);
        fs.mkdirSync(store, { recursive: true });
        fs.symlinkSync(store, path.join(work, '.git'));
        assert.deepEqual(discoverTreesByFs(work), { current: work, main: work, commonDir: path.join(work, '.git') });
    });
});

await describe('checkTools', async () => {
    await test('resolves git through the given PATH', (t) => {
        const root = tempRoot(t);
        const tools = path.join(root, 'tools');
        writeExecutable(path.join(tools, 'git'));
        const cwd = path.join(root, 'cwd');
        fs.mkdirSync(cwd);
        const result = checkTools(`${tools}:${SYSTEM_PATH}`, cwd, []);
        assert.ok(result.ok);
        assert.equal(result.git, path.join(tools, 'git'));
        assert.equal(result.pathValue, `${tools}:${SYSTEM_PATH}`);
    });

    await test('a git planted inside the project is dropped from PATH', (t) => {
        const root = tempRoot(t);
        const project = path.join(root, 'project');
        fs.mkdirSync(path.join(project, '.git'), { recursive: true });
        writeExecutable(path.join(project, 'bin', 'git'));
        const other = path.join(root, 'other');
        writeExecutable(path.join(other, 'git'));
        const result = checkTools(`${project}/bin:${other}:${SYSTEM_PATH}`, project, []);
        assert.ok(result.ok);
        assert.equal(result.git, path.join(other, 'git'));
        assert.ok(!entries(result.pathValue).includes(`${project}/bin`));
    });

    await test('a git planted below a subdirectory cwd is dropped through the enclosing worktree', (t) => {
        const root = tempRoot(t);
        const project = path.join(root, 'project');
        const sub = path.join(project, 'sub');
        fs.mkdirSync(path.join(project, '.git'), { recursive: true });
        fs.mkdirSync(sub);
        writeExecutable(path.join(project, 'bin', 'git'));
        const other = path.join(root, 'other');
        writeTools(other);
        const result = checkTools(`${project}/bin:${other}`, sub, []);
        assert.ok(result.ok);
        assert.equal(result.git, path.join(other, 'git'));
    });

    await test('a root given through a symlinked spelling is removed too', (t) => {
        const root = tempRoot(t);
        const main = path.join(root, 'main');
        writeExecutable(path.join(main, 'bin', 'git'));
        const alias = path.join(root, 'alias');
        fs.symlinkSync(main, alias);
        const other = path.join(root, 'other');
        writeTools(other);
        const cwd = path.join(root, 'cwd');
        fs.mkdirSync(cwd);
        const result = checkTools(`${main}/bin:${other}`, cwd, [alias]);
        assert.ok(result.ok);
        assert.equal(result.git, path.join(other, 'git'));
        assert.ok(!entries(result.pathValue).includes(`${main}/bin`));
    });

    await test('a target root that does not exist yet removes PATH entries below it', (t) => {
        const root = tempRoot(t);
        const target = path.join(root, 'target');
        const other = path.join(root, 'other');
        writeTools(other);
        const cwd = path.join(root, 'cwd');
        fs.mkdirSync(cwd);
        const result = checkTools(`${target}/bin:${other}`, cwd, [target]);
        assert.ok(result.ok);
        assert.deepEqual(entries(result.pathValue), [other]);
    });

    await test('a .git directory in the parent of the clone keeps tool entries in the parent', (t) => {
        const outer = tempRoot(t);
        const parent = path.join(outer, 'parent');
        fs.mkdirSync(path.join(parent, '.git'), { recursive: true });
        const clone = makeClone(parent);
        const tools = path.join(parent, 'tools');
        writeExecutable(path.join(tools, 'git'));
        const result = checkTools(`${tools}:${SYSTEM_PATH}`, clone, [clone]);
        assert.ok(result.ok);
        assert.equal(result.git, path.join(tools, 'git'));
        assert.equal(result.pathValue, `${tools}:${SYSTEM_PATH}`);
    });

    await test('an external git symlinked into the main tree is refused', (t) => {
        const root = tempRoot(t);
        const { main, current } = makeTrees(root);
        const ext = path.join(root, 'ext');
        symlinkTool(ext, 'git', path.join(main, 'bin', 'git'));
        const result = checkTools(`${ext}:${SYSTEM_PATH}`, current, [main, current]);
        assert.deepEqual(result, {
            ok: false,
            reason: `git resolves into the project: ${path.join(main, 'bin', 'git')}`,
        });
    });

    await test('an external git symlinked into the current tree is refused', (t) => {
        const root = tempRoot(t);
        const { main, current } = makeTrees(root);
        const ext = path.join(root, 'ext');
        symlinkTool(ext, 'git', path.join(current, 'bin', 'git'));
        const result = checkTools(`${ext}:${SYSTEM_PATH}`, current, [main]);
        assert.deepEqual(result, {
            ok: false,
            reason: `git resolves into the project: ${path.join(current, 'bin', 'git')}`,
        });
    });

    await test('an external cp symlinked into the main or the current tree is refused', (t) => {
        const root = tempRoot(t);
        const { main, current } = makeTrees(root);
        for (const tree of [main, current]) {
            const ext = path.join(root, `ext-${path.basename(tree)}`);
            writeExecutable(path.join(ext, 'git'));
            symlinkTool(ext, 'cp', path.join(tree, 'bin', 'cp'));
            const result = checkTools(`${ext}:${SYSTEM_PATH}`, current, [main]);
            assert.deepEqual(result, {
                ok: false,
                reason: `cp resolves into the project: ${path.join(tree, 'bin', 'cp')}`,
            });
        }
    });

    await test('an external git symlinked outside the project passes', (t) => {
        const root = tempRoot(t);
        const { main, current } = makeTrees(root);
        writeExecutable(path.join(root, 'store', 'git-real'));
        const ext = path.join(root, 'ext');
        symlinkTool(ext, 'git', path.join(root, 'store', 'git-real'));
        const result = checkTools(`${ext}:${SYSTEM_PATH}`, current, [main, current]);
        assert.ok(result.ok);
        assert.equal(result.git, path.join(ext, 'git'));
    });

    await test('a PATH without git is refused', (t) => {
        const root = tempRoot(t);
        const empty = path.join(root, 'empty');
        fs.mkdirSync(empty);
        const result = checkTools(empty, root, []);
        assert.deepEqual(result, { ok: false, reason: 'missing required tool: git' });
    });

    await test('a PATH without cp is refused', (t) => {
        const root = tempRoot(t);
        const tools = path.join(root, 'tools');
        writeExecutable(path.join(tools, 'git'));
        const cwd = path.join(root, 'cwd');
        fs.mkdirSync(cwd);
        const result = checkTools(tools, cwd, []);
        assert.deepEqual(result, { ok: false, reason: 'missing required tool: cp' });
    });
});
