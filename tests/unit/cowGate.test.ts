import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test, type TestContext } from 'node:test';

import { findSampleFile, isApfsMount, parseDfMount } from '../../src/cowGate.ts';

const DF_HEADER = 'Filesystem 1024-blocks Used Available Capacity Mounted on';
const DATA_MOUNT = { device: '/dev/disk3s5', mountPoint: '/System/Volumes/Data' };

function tempDir(t: TestContext): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prwc-cow-'));
    t.after(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });
    return dir;
}

await describe('parseDfMount', async () => {
    await test('reads the device and the mount point from the second line', () => {
        const stdout = `${DF_HEADER}\n/dev/disk3s5 488245288 1 2 52% /System/Volumes/Data\n`;
        assert.deepEqual(parseDfMount(stdout), DATA_MOUNT);
    });

    await test('keeps a mount point that holds a space', () => {
        const stdout = `${DF_HEADER}\n/dev/disk4s1   100  1  2   3%   /Volumes/My Disk\n`;
        assert.deepEqual(parseDfMount(stdout), { device: '/dev/disk4s1', mountPoint: '/Volumes/My Disk' });
    });

    await test('empty input, a header only and a line without a capacity field give undefined', () => {
        assert.equal(parseDfMount(''), undefined);
        assert.equal(parseDfMount(`${DF_HEADER}\n`), undefined);
        assert.equal(parseDfMount(`${DF_HEADER}\n/dev/disk3s5 488245288 1 2 52 /System/Volumes/Data\n`), undefined);
    });

    await test('a mount point that is not absolute gives undefined', () => {
        assert.equal(parseDfMount(`${DF_HEADER}\n/dev/disk3s5 488245288 1 2 52% Volumes\n`), undefined);
    });
});

await describe('isApfsMount', async () => {
    await test('an apfs line for the device and mount point is accepted', () => {
        const mountStdout = [
            '/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)',
            '/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse)',
            'devfs on /dev (devfs, local, nobrowse)',
        ].join('\n');
        assert.equal(isApfsMount(mountStdout, DATA_MOUNT), true);
    });

    await test('an hfs volume is rejected', () => {
        const mount = { device: '/dev/disk4s2', mountPoint: '/Volumes/Ext' };
        assert.equal(isApfsMount('/dev/disk4s2 on /Volumes/Ext (hfs, local, journaled)\n', mount), false);
    });

    await test('an smb share is rejected', () => {
        const mount = { device: '//guest@server/share', mountPoint: '/Volumes/share' };
        assert.equal(isApfsMount('//guest@server/share on /Volumes/share (smbfs, nodev, nosuid)\n', mount), false);
    });

    await test('unrelated text and an apfs line for another device are rejected', () => {
        assert.equal(isApfsMount('not a mount table', DATA_MOUNT), false);
        assert.equal(isApfsMount('/dev/disk9s1 on /System/Volumes/Data (apfs, local, journaled)\n', DATA_MOUNT), false);
    });
});

await describe('findSampleFile', async () => {
    await test('returns a nested regular file and skips symlinks and empty folders', (t) => {
        const root = tempDir(t);
        fs.mkdirSync(path.join(root, 'empty'));
        fs.mkdirSync(path.join(root, 'pkg'));
        fs.writeFileSync(path.join(root, 'pkg', 'index.js'), 'x');
        fs.symlinkSync(path.join(root, 'pkg', 'index.js'), path.join(root, 'link.js'));
        assert.equal(findSampleFile(root), path.join(root, 'pkg', 'index.js'));
    });

    await test('a tree with only directories and symlinks gives undefined', (t) => {
        const root = tempDir(t);
        const outside = tempDir(t);
        fs.writeFileSync(path.join(outside, 'real.js'), 'x');
        fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
        fs.symlinkSync(path.join(outside, 'real.js'), path.join(root, 'a', 'file-link.js'));
        fs.symlinkSync(outside, path.join(root, 'dir-link'));
        assert.equal(findSampleFile(root), undefined);
    });

    await test('stops after the entry limit', (t) => {
        const root = tempDir(t);
        fs.mkdirSync(path.join(root, 'a', 'b', 'c'), { recursive: true });
        fs.writeFileSync(path.join(root, 'a', 'b', 'c', 'index.js'), 'x');
        assert.equal(findSampleFile(root, 2), undefined);
        assert.equal(findSampleFile(root), path.join(root, 'a', 'b', 'c', 'index.js'));
    });

    await test('a missing directory gives undefined without throwing', (t) => {
        const root = tempDir(t);
        assert.equal(findSampleFile(path.join(root, 'missing')), undefined);
    });
});
