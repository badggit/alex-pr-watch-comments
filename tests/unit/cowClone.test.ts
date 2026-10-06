import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';

import { cloneCommand, cloneTempName, placeClone, sweepDeadTemps } from '../../src/cowClone.ts';

function makeRoot(t: TestContext): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prwc-cow-'));
    t.after(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });
    return root;
}

function makeTemp(root: string): string {
    const temp = path.join(root, 'area', cloneTempName(1, 1));
    fs.mkdirSync(temp, { recursive: true });
    fs.writeFileSync(path.join(temp, 'pkg.json'), '{}');
    return temp;
}

await describe('cloneTempName', async () => {
    await test('joins the prefix, the PID and the counter', () => {
        assert.equal(cloneTempName(42, 3), 'alex-pr-watch-comments-clone-42-3');
    });
});

await describe('sweepDeadTemps', async () => {
    await test('removes only temps of dead PIDs', (t) => {
        const area = makeRoot(t);
        fs.mkdirSync(path.join(area, 'alex-pr-watch-comments-clone-111-1'));
        fs.writeFileSync(path.join(area, 'alex-pr-watch-comments-clone-111-1', 'f.txt'), 'x');
        fs.writeFileSync(path.join(area, 'alex-pr-watch-comments-clone-222-1'), 'x');
        fs.writeFileSync(path.join(area, 'alex-pr-watch-comments-clone-abc-1'), 'x');
        fs.writeFileSync(path.join(area, 'alex-pr-watch-comments-clone-111-'), 'x');
        fs.writeFileSync(path.join(area, 'alex-pr-watch-comments-clone-111-1x'), 'x');
        fs.writeFileSync(path.join(area, 'xalex-pr-watch-comments-clone-111-1'), 'x');
        fs.writeFileSync(path.join(area, 'HEAD'), 'x');
        fs.writeFileSync(path.join(area, 'gitdir'), 'x');
        sweepDeadTemps(area, (pid) => pid === 222);
        assert.deepEqual(fs.readdirSync(area).toSorted(), [
            'HEAD',
            'alex-pr-watch-comments-clone-111-',
            'alex-pr-watch-comments-clone-111-1x',
            'alex-pr-watch-comments-clone-222-1',
            'alex-pr-watch-comments-clone-abc-1',
            'gitdir',
            'xalex-pr-watch-comments-clone-111-1',
        ]);
    });

    await test('a throwing alive check leaves the entry in place', (t) => {
        const area = makeRoot(t);
        fs.writeFileSync(path.join(area, 'alex-pr-watch-comments-clone-111-1'), 'x');
        assert.doesNotThrow(() => {
            sweepDeadTemps(area, () => {
                throw new Error('probe failed');
            });
        });
        assert.deepEqual(fs.readdirSync(area), ['alex-pr-watch-comments-clone-111-1']);
    });

    await test('a missing temp area is a no-op', (t) => {
        const root = makeRoot(t);
        assert.doesNotThrow(() => {
            sweepDeadTemps(path.join(root, 'missing'), () => false);
        });
    });
});

await describe('cloneCommand', async () => {
    const source = '/src/node_modules';
    const temp = '/tmp/area/alex-pr-watch-comments-clone-1-1';

    await test('darwin uses the absolute BSD cp with clonefile', () => {
        assert.deepEqual(cloneCommand('darwin', source, temp), { file: '/bin/cp', args: ['-c', '-R', source, temp] });
    });

    await test('linux uses GNU cp with a mandatory reflink', () => {
        assert.deepEqual(cloneCommand('linux', source, temp), {
            file: 'cp',
            args: ['-R', '--reflink=always', source, temp],
        });
    });

    await test('other platforms have no clone command', () => {
        assert.equal(cloneCommand('win32', source, temp), undefined);
        assert.equal(cloneCommand('freebsd', source, temp), undefined);
    });
});

await describe('placeClone', async () => {
    await test('nothing at dest: the temp is renamed into place', (t) => {
        const root = makeRoot(t);
        const temp = makeTemp(root);
        const dest = path.join(root, 'node_modules');
        assert.deepEqual(placeClone(temp, dest, '/clone/node_modules'), { kind: 'placed' });
        assert.ok(fs.lstatSync(dest).isDirectory());
        assert.equal(fs.readFileSync(path.join(dest, 'pkg.json'), 'utf8'), '{}');
        assert.equal(fs.existsSync(temp), false);
    });

    await test('an own link at dest is replaced by the clone', (t) => {
        const root = makeRoot(t);
        const temp = makeTemp(root);
        const dest = path.join(root, 'node_modules');
        const own = path.join(root, 'clone', 'node_modules');
        fs.symlinkSync(own, dest);
        assert.deepEqual(placeClone(temp, dest, own), { kind: 'placed' });
        const stat = fs.lstatSync(dest);
        assert.ok(stat.isDirectory());
        assert.equal(stat.isSymbolicLink(), false);
        assert.equal(fs.existsSync(temp), false);
    });

    await test('a foreign link at dest is refused and kept', (t) => {
        const root = makeRoot(t);
        const temp = makeTemp(root);
        const dest = path.join(root, 'node_modules');
        fs.symlinkSync('/elsewhere', dest);
        assert.deepEqual(placeClone(temp, dest, path.join(root, 'clone', 'node_modules')), {
            kind: 'refused',
            code: 'EEXIST',
        });
        assert.equal(fs.readlinkSync(dest), '/elsewhere');
        assert.equal(fs.existsSync(temp), false);
    });

    await test('a real directory at dest is refused and untouched', (t) => {
        const root = makeRoot(t);
        const temp = makeTemp(root);
        const dest = path.join(root, 'node_modules');
        fs.mkdirSync(dest);
        fs.writeFileSync(path.join(dest, 'mine.txt'), 'mine');
        assert.deepEqual(placeClone(temp, dest, path.join(root, 'clone', 'node_modules')), {
            kind: 'refused',
            code: 'EEXIST',
        });
        assert.deepEqual(fs.readdirSync(dest), ['mine.txt']);
        assert.equal(fs.readFileSync(path.join(dest, 'mine.txt'), 'utf8'), 'mine');
        assert.equal(fs.existsSync(temp), false);
    });

    await test('a failing rename restores the own link', (t) => {
        const root = makeRoot(t);
        const temp = makeTemp(root);
        const dest = path.join(root, 'node_modules');
        const own = path.join(root, 'clone', 'node_modules');
        fs.symlinkSync(own, dest);
        const failingRename = (): void => {
            throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' });
        };
        assert.deepEqual(placeClone(temp, dest, own, failingRename), { kind: 'refused', code: 'EXDEV' });
        assert.ok(fs.lstatSync(dest).isSymbolicLink());
        assert.equal(fs.readlinkSync(dest), own);
        assert.equal(fs.existsSync(temp), false);
    });

    await test('a failing link restore still removes temp and reports the rename error', (t) => {
        const root = makeRoot(t);
        const temp = makeTemp(root);
        const parent = path.join(root, 'worktree');
        fs.mkdirSync(parent);
        const dest = path.join(parent, 'node_modules');
        const own = path.join(root, 'clone', 'node_modules');
        fs.symlinkSync(own, dest);
        const renameThatDropsParent = (): void => {
            // Without the parent directory the restoring symlink call fails with ENOENT.
            fs.rmSync(parent, { recursive: true, force: true });
            throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' });
        };
        assert.deepEqual(placeClone(temp, dest, own, renameThatDropsParent), { kind: 'refused', code: 'EXDEV' });
        assert.equal(fs.existsSync(parent), false);
        assert.equal(fs.existsSync(temp), false);
    });

    await test('a path re-created at dest after a failed rename is left untouched', (t) => {
        const root = makeRoot(t);
        const temp = makeTemp(root);
        const dest = path.join(root, 'node_modules');
        const own = path.join(root, 'clone', 'node_modules');
        fs.symlinkSync(own, dest);
        const renameRacedByOwner = (): void => {
            fs.mkdirSync(dest);
            fs.writeFileSync(path.join(dest, 'mine.txt'), 'mine');
            throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' });
        };
        assert.deepEqual(placeClone(temp, dest, own, renameRacedByOwner), { kind: 'refused', code: 'EXDEV' });
        const stat = fs.lstatSync(dest);
        assert.ok(stat.isDirectory());
        assert.equal(stat.isSymbolicLink(), false);
        assert.deepEqual(fs.readdirSync(dest), ['mine.txt']);
        assert.equal(fs.existsSync(temp), false);
    });

    await test('an error without a string code is reported as unknown', (t) => {
        const root = makeRoot(t);
        const temp = makeTemp(root);
        const dest = path.join(root, 'node_modules');
        const renameWithoutCode = (): void => {
            throw new Error('no code');
        };
        assert.deepEqual(placeClone(temp, dest, '/clone/node_modules', renameWithoutCode), {
            kind: 'refused',
            code: 'unknown',
        });
        assert.equal(fs.existsSync(dest), false);
        assert.equal(fs.existsSync(temp), false);
    });
});
