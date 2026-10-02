import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test, type TestContext } from 'node:test';

import {
    initState,
    readJsonFile,
    readStateFormat,
    resolveStateDir,
    worktreeKey,
    writeJsonAtomic,
    writeTextAtomic,
} from '../../src/stateStore.ts';
import { createTestEnv, type TestEnv } from '../support/testEnv.ts';

const FIXED_CHILDREN = ['runs', 'watchers', 'worktrees'];

async function newEnv(t: TestContext): Promise<TestEnv> {
    const env = await createTestEnv();
    t.after(() => {
        env.cleanup();
    });
    return env;
}

function modeOf(file: string): number {
    return fs.statSync(file).mode & 0o777;
}

function makeDir(dir: string, mode: number): string {
    fs.mkdirSync(dir, { recursive: true });
    fs.chmodSync(dir, mode);
    return dir;
}

function readableDespiteMode(file: string): boolean {
    try {
        fs.readFileSync(file);
        return true;
    } catch {
        return false;
    }
}

function unsafeReason(stateDir: string): string {
    const result = initState(stateDir);
    assert.equal(result.ok, false);
    assert.ok('kind' in result && result.kind === 'unsafe', `expected unsafe, got ${JSON.stringify(result)}`);
    assert.ok(result.reason.startsWith('unsafe state directory: '), result.reason);
    return result.reason;
}

await describe('initState', async () => {
    await test('creates the owner-only tree with format 1 and returns the canonical path', async (t) => {
        const env = await newEnv(t);
        const result = initState(env.stateDir);
        assert.ok(result.ok);
        assert.equal(result.stateDir, fs.realpathSync.native(env.stateDir));
        assert.equal(modeOf(env.stateDir), 0o700);
        for (const child of FIXED_CHILDREN) {
            assert.equal(modeOf(path.join(env.stateDir, child)), 0o700, child);
        }
        assert.equal(fs.readFileSync(path.join(env.stateDir, 'format'), 'utf8').trim(), '1');
        assert.equal(readStateFormat(env.stateDir), '1');
        assert.deepEqual(fs.readdirSync(env.stateDir).toSorted(), ['format', ...FIXED_CHILDREN]);
    });

    await test('a second run on an initialized directory succeeds again', async (t) => {
        const env = await newEnv(t);
        assert.ok(initState(env.stateDir).ok);
        assert.ok(initState(env.stateDir).ok);
    });

    await test('reports another format and leaves it untouched', async (t) => {
        const env = await newEnv(t);
        makeDir(env.stateDir, 0o700);
        fs.writeFileSync(path.join(env.stateDir, 'format'), '2\n');
        assert.deepEqual(initState(env.stateDir), { ok: false, kind: 'format', found: '2' });
        assert.equal(fs.readFileSync(path.join(env.stateDir, 'format'), 'utf8'), '2\n');
    });

    await test('refuses an unreadable format file and leaves it untouched', async (t) => {
        const env = await newEnv(t);
        makeDir(env.stateDir, 0o700);
        const format = path.join(env.stateDir, 'format');
        fs.writeFileSync(format, '2\n');
        fs.chmodSync(format, 0o000);
        if (readableDespiteMode(format)) {
            // Root reads a mode 000 file, so a symlink loop stands in for another non-ENOENT read error.
            fs.rmSync(format);
            fs.symlinkSync('format', format);
        }
        const reason = unsafeReason(env.stateDir);
        assert.ok(reason.includes(`${format} cannot be read`), reason);
        assert.ok(reason.includes('PRWC_STATE_DIR'), reason);
        assert.equal(fs.existsSync(path.join(env.stateDir, 'runs')), false);
        if (fs.lstatSync(format).isFile()) {
            fs.chmodSync(format, 0o600);
            assert.equal(fs.readFileSync(format, 'utf8'), '2\n');
        } else {
            assert.equal(fs.readlinkSync(format), 'format');
        }
    });

    await test('refuses a format entry that is a directory', async (t) => {
        const env = await newEnv(t);
        makeDir(env.stateDir, 0o700);
        const format = makeDir(path.join(env.stateDir, 'format'), 0o700);
        const reason = unsafeReason(env.stateDir);
        assert.ok(reason.includes(`${format} cannot be read`), reason);
        assert.ok(fs.statSync(format).isDirectory());
        assert.equal(fs.existsSync(path.join(env.stateDir, 'runs')), false);
    });

    await test('refuses an existing state directory with mode 755 and writes no format file', async (t) => {
        const env = await newEnv(t);
        makeDir(env.stateDir, 0o755);
        const reason = unsafeReason(env.stateDir);
        assert.ok(reason.includes('mode 755'), reason);
        assert.ok(reason.includes(`chmod 700 ${env.stateDir}`), reason);
        assert.ok(reason.includes('PRWC_STATE_DIR'), reason);
        assert.equal(fs.existsSync(path.join(env.stateDir, 'format')), false);
        assert.equal(fs.existsSync(path.join(env.stateDir, 'runs')), false);
    });

    await test('refuses a group-writable ancestor and accepts it once it is owner-only', async (t) => {
        const env = await newEnv(t);
        const ancestor = makeDir(path.join(env.root, 'local'), 0o775);
        const stateDir = path.join(ancestor, 'state', 'pr-watch-comments');
        const reason = unsafeReason(stateDir);
        assert.ok(reason.includes(ancestor), reason);
        assert.ok(reason.includes(`chmod go-w ${ancestor}`), reason);
        assert.ok(reason.includes('PRWC_STATE_DIR'), reason);
        assert.equal(fs.existsSync(path.join(ancestor, 'state')), false);
        fs.chmodSync(ancestor, 0o700);
        assert.ok(initState(stateDir).ok);
    });

    await test('refuses an existing state directory below a group-writable ancestor', async (t) => {
        const env = await newEnv(t);
        const ancestor = makeDir(path.join(env.root, 'local'), 0o700);
        const stateDir = path.join(ancestor, 'state');
        assert.ok(initState(stateDir).ok);
        fs.chmodSync(ancestor, 0o775);
        assert.ok(unsafeReason(stateDir).includes(ancestor));
    });

    await test('refuses a fixed child replaced by a symlink', async (t) => {
        const env = await newEnv(t);
        assert.ok(initState(env.stateDir).ok);
        const other = makeDir(path.join(env.root, 'other'), 0o700);
        fs.rmSync(path.join(env.stateDir, 'runs'), { recursive: true });
        fs.symlinkSync(other, path.join(env.stateDir, 'runs'));
        assert.ok(unsafeReason(env.stateDir).includes('is a symlink'));
    });

    await test('refuses a child with group permissions with a chmod 700 hint', async (t) => {
        const env = await newEnv(t);
        assert.ok(initState(env.stateDir).ok);
        fs.chmodSync(path.join(env.stateDir, 'watchers'), 0o750);
        const reason = unsafeReason(env.stateDir);
        assert.ok(reason.includes(`chmod 700 ${path.join(env.stateDir, 'watchers')}`), reason);
    });

    await test('refuses a world-writable ancestor without the sticky bit and accepts it with the sticky bit', async (t) => {
        const env = await newEnv(t);
        const ancestor = makeDir(path.join(env.root, 'open'), 0o777);
        const stateDir = path.join(ancestor, 'state');
        assert.ok(unsafeReason(stateDir).includes(ancestor));
        fs.chmodSync(ancestor, 0o1777);
        const result = initState(stateDir);
        assert.ok(result.ok, JSON.stringify(result));
    });

    await test('accepts a symlink to a safe directory and returns the target', async (t) => {
        const env = await newEnv(t);
        const target = makeDir(path.join(env.root, 'real-state'), 0o700);
        const link = path.join(env.root, 'link-state');
        fs.symlinkSync(target, link);
        const result = initState(link);
        assert.ok(result.ok, JSON.stringify(result));
        assert.equal(result.stateDir, fs.realpathSync.native(target));
        assert.ok(fs.existsSync(path.join(target, 'format')));
    });

    await test('refuses a canonical path the worker kit cannot carry', async (t) => {
        const env = await newEnv(t);
        const reason = unsafeReason(path.join(env.root, 'with space', 'state'));
        assert.ok(reason.includes('PRWC_STATE_DIR'), reason);
        assert.equal(fs.existsSync(path.join(env.root, 'with space')), false);
    });
});

await describe('atomic files', async () => {
    await test('writeJsonAtomic leaves no temp file and writes mode 600', async (t) => {
        const env = await newEnv(t);
        const dir = makeDir(path.join(env.root, 'files'), 0o700);
        const file = path.join(dir, 'value.json');
        writeJsonAtomic(file, { a: 1, b: ['x'] });
        writeJsonAtomic(file, { a: 2 });
        assert.deepEqual(fs.readdirSync(dir), ['value.json']);
        assert.equal(modeOf(file), 0o600);
        assert.deepEqual(readJsonFile(file), { a: 2 });
    });

    await test('writeTextAtomic replaces the content and leaves no temp file', async (t) => {
        const env = await newEnv(t);
        const dir = makeDir(path.join(env.root, 'files'), 0o700);
        const file = path.join(dir, 'text');
        writeTextAtomic(file, 'one\n');
        writeTextAtomic(file, 'two\n');
        assert.equal(fs.readFileSync(file, 'utf8'), 'two\n');
        assert.deepEqual(fs.readdirSync(dir), ['text']);
        assert.equal(modeOf(file), 0o600);
    });

    await test('readJsonFile is undefined for a missing or unparsable file', async (t) => {
        const env = await newEnv(t);
        const dir = makeDir(path.join(env.root, 'files'), 0o700);
        fs.writeFileSync(path.join(dir, 'bad.json'), '{not json');
        assert.equal(readJsonFile(path.join(dir, 'missing.json')), undefined);
        assert.equal(readJsonFile(path.join(dir, 'bad.json')), undefined);
    });
});

await describe('keys and paths', async () => {
    await test('worktreeKey is stable per path and differs between paths', () => {
        const first = worktreeKey('/path/to/project');
        assert.equal(worktreeKey('/path/to/project'), first);
        assert.notEqual(worktreeKey('/path/to/other'), first);
        assert.match(first, /^[\da-f]{16}$/u);
    });

    await test('resolveStateDir makes a relative PRWC_STATE_DIR absolute', () => {
        const env = { PRWC_STATE_DIR: 'rel/state', HOME: '/path/to/user' };
        assert.equal(resolveStateDir(env, '/path/to/project'), '/path/to/project/rel/state');
        assert.equal(resolveStateDir({ PRWC_STATE_DIR: '/abs/state' }, '/path/to/project'), '/abs/state');
    });

    await test('resolveStateDir defaults to HOME/.local/state/pr-watch-comments', () => {
        assert.equal(
            resolveStateDir({ HOME: '/path/to/user' }, '/path/to/project'),
            '/path/to/user/.local/state/pr-watch-comments'
        );
    });

    await test('resolveStateDir treats an empty HOME as unset', () => {
        const expected = path.join(os.homedir(), '.local', 'state', 'pr-watch-comments');
        assert.equal(resolveStateDir({ HOME: '' }, '/path/to/project'), expected);
        assert.equal(resolveStateDir({ HOME: '', PRWC_STATE_DIR: '' }, '/path/to/project'), expected);
        assert.ok(path.isAbsolute(expected));
    });
});
