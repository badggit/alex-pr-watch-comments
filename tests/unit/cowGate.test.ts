import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test, type TestContext } from 'node:test';

import {
    createCloneGate,
    findSampleFile,
    isApfsMount,
    parseDfMount,
    type CloneDeps,
    type GateRequest,
} from '../../src/cowGate.ts';
import type { CommandRequest, CommandResult } from '../../src/types.ts';

const DF_HEADER = 'Filesystem 1024-blocks Used Available Capacity Mounted on';
const DATA_MOUNT = { device: '/dev/disk3s5', mountPoint: '/System/Volumes/Data' };

function tempDir(t: TestContext): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prwc-cow-'));
    t.after(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });
    return dir;
}

function gateRequest(t: TestContext): GateRequest {
    const root = tempDir(t);
    const sourceRoot = path.join(root, 'source');
    const target = path.join(root, 'target');
    const tempArea = path.join(root, 'temp');
    fs.mkdirSync(path.join(sourceRoot, 'node_modules'), { recursive: true });
    fs.mkdirSync(target);
    fs.mkdirSync(tempArea);
    return { sourceRoot, target, rel: 'node_modules', tempArea, probePath: path.join(tempArea, 'probe') };
}

function recordingDeps(reply: (_request: CommandRequest) => CommandResult | Promise<CommandResult>): {
    deps: CloneDeps;
    calls: CommandRequest[];
    logs: string[];
} {
    const calls: CommandRequest[] = [];
    const logs: string[] = [];
    return {
        calls,
        logs,
        deps: {
            runner: {
                run(request) {
                    calls.push(request);
                    return Promise.resolve(reply(request));
                },
            },
            log: {
                info(message) {
                    logs.push(`info: ${message}`);
                },
                warn(message) {
                    logs.push(`warn: ${message}`);
                },
                error(message) {
                    logs.push(`error: ${message}`);
                },
            },
        },
    };
}

function darwinReply(request: CommandRequest): CommandResult {
    return {
        code: 0,
        stdout:
            request.file === '/bin/df'
                ? `${DF_HEADER}\n/dev/disk3s5 488245288 1 2 52% /System/Volumes/Data\n`
                : '/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse)\n',
        stderr: '',
    };
}

function copyReply(request: CommandRequest): CommandResult {
    const [, sample, probe] = request.args;
    assert.ok(sample);
    assert.ok(probe);
    fs.copyFileSync(sample, probe);
    return { code: 0, stdout: '', stderr: '' };
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

await describe('createCloneGate', async () => {
    await test('darwin checks APFS with a controlled environment and caches each source-target pair', async (t) => {
        const request = gateRequest(t);
        const { deps, calls } = recordingDeps(darwinReply);
        const gate = createCloneGate({ platform: 'darwin', deviceOf: () => 1 });
        assert.deepEqual(await gate.check(deps, request), { kind: 'available' });
        assert.deepEqual(calls, [
            {
                file: '/bin/df',
                args: ['-P', request.target],
                env: { LC_ALL: 'C', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
            },
            { file: '/sbin/mount', args: [], env: { LC_ALL: 'C', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' } },
        ]);
        assert.deepEqual(await gate.check(deps, request), { kind: 'available' });
        assert.equal(calls.length, 2);
        await gate.check(deps, { ...request, target: path.join(request.target, 'other') });
        assert.equal(calls.length, 4);
        const otherGate = createCloneGate({ platform: 'darwin', deviceOf: () => 1 });
        await otherGate.check(deps, request);
        assert.equal(calls.length, 6);
    });

    for (const mountOutput of [
        '/dev/disk3s5 on /System/Volumes/Data (hfs, local, journaled)',
        '/dev/disk3s5 on /System/Volumes/Data (smbfs, nodev, nosuid)',
        'not a mount table',
    ]) {
        await test(`darwin rejects mount output: ${mountOutput}`, async (t) => {
            const request = gateRequest(t);
            const { deps, calls } = recordingDeps((command) =>
                command.file === '/bin/df' ? darwinReply(command) : { code: 0, stdout: mountOutput, stderr: '' }
            );
            const gate = createCloneGate({ platform: 'darwin', deviceOf: () => 1 });
            const first = await gate.check(deps, request);
            assert.equal(first.kind, 'unavailable');
            const cached = await gate.check(deps, request);
            assert.equal(cached.kind, 'unavailable');
            assert.equal(calls.length, 2);
        });
    }

    for (const failingTool of ['/bin/df', '/sbin/mount']) {
        await test(`darwin rejects ${failingTool} failure`, async (t) => {
            const { deps } = recordingDeps((command) =>
                command.file === failingTool ? { code: 1, stdout: '', stderr: 'failed' } : darwinReply(command)
            );
            const gate = createCloneGate({ platform: 'darwin', deviceOf: () => 1 });
            assert.deepEqual(await gate.check(deps, gateRequest(t)), {
                kind: 'unavailable',
                reason: 'cannot read the volume type',
            });
        });
    }

    await test('darwin rejects malformed df output', async (t) => {
        const { deps } = recordingDeps((command) =>
            command.file === '/bin/df' ? { code: 0, stdout: DF_HEADER, stderr: '' } : darwinReply(command)
        );
        const gate = createCloneGate({ platform: 'darwin', deviceOf: () => 1 });
        assert.deepEqual(await gate.check(deps, gateRequest(t)), {
            kind: 'unavailable',
            reason: 'cannot read the volume type',
        });
    });

    await test('darwin fails closed when the runner rejects', async (t) => {
        const { deps } = recordingDeps(() => Promise.reject(new Error('runner failed')));
        const gate = createCloneGate({ platform: 'darwin', deviceOf: () => 1 });
        assert.deepEqual(await gate.check(deps, gateRequest(t)), {
            kind: 'unavailable',
            reason: 'cannot read the volume type',
        });
    });

    await test('darwin checks every device even after caching and never caches a mismatch', async (t) => {
        const request = gateRequest(t);
        const source = path.join(request.sourceRoot, request.rel);
        let sourceDevice: number | undefined = 2;
        const stats: string[] = [];
        const { deps, calls } = recordingDeps(darwinReply);
        const gate = createCloneGate({
            platform: 'darwin',
            deviceOf(file) {
                stats.push(file);
                return file === source ? sourceDevice : 1;
            },
        });
        const mismatch = { kind: 'unavailable', reason: 'the clone and the worktree are on different volumes' };
        assert.deepEqual(await gate.check(deps, request), mismatch);
        assert.deepEqual(stats, [source, request.target, request.tempArea]);
        assert.equal(calls.length, 0);
        sourceDevice = 1;
        assert.deepEqual(await gate.check(deps, request), { kind: 'available' });
        assert.equal(calls.length, 2);
        sourceDevice = undefined;
        assert.deepEqual(await gate.check(deps, request), mismatch);
        assert.equal(calls.length, 2);
        assert.equal(stats.length, 9);
    });

    await test('linux probes a nested regular file, removes the probe and caches success', async (t) => {
        const request = gateRequest(t);
        const sample = path.join(request.sourceRoot, request.rel, 'pkg', 'index.js');
        fs.mkdirSync(path.dirname(sample));
        fs.writeFileSync(sample, 'module');
        const { deps, calls } = recordingDeps(copyReply);
        const gate = createCloneGate({ platform: 'linux' });
        assert.deepEqual(await gate.check(deps, request), { kind: 'available' });
        assert.deepEqual(calls, [{ file: 'cp', args: ['--reflink=always', sample, request.probePath] }]);
        assert.equal(fs.existsSync(request.probePath), false);
        assert.deepEqual(await gate.check(deps, request), { kind: 'available' });
        assert.equal(calls.length, 1);
    });

    await test('linux removes a failed probe and caches unavailable', async (t) => {
        const request = gateRequest(t);
        fs.writeFileSync(path.join(request.sourceRoot, request.rel, 'index.js'), 'module');
        const { deps, calls } = recordingDeps(() => {
            fs.writeFileSync(request.probePath, 'partial');
            return { code: 1, stdout: '', stderr: 'cp: failed to clone: Operation not supported' };
        });
        const gate = createCloneGate({ platform: 'linux' });
        const unavailable = { kind: 'unavailable', reason: 'no copy-on-write between the clone and the worktree' };
        assert.deepEqual(await gate.check(deps, request), unavailable);
        assert.equal(fs.existsSync(request.probePath), false);
        assert.deepEqual(await gate.check(deps, request), unavailable);
        assert.equal(calls.length, 1);
    });

    await test('linux handles spawn errors and removes the probe', async (t) => {
        const request = gateRequest(t);
        fs.writeFileSync(path.join(request.sourceRoot, request.rel, 'index.js'), 'module');
        const { deps } = recordingDeps(() => ({ code: 127, stdout: '', stderr: '', spawnError: 'ENOENT' }));
        const gate = createCloneGate({ platform: 'linux' });
        assert.deepEqual(await gate.check(deps, request), {
            kind: 'unavailable',
            reason: 'no copy-on-write between the clone and the worktree',
        });
        assert.equal(fs.existsSync(request.probePath), false);
    });

    await test('linux fails closed when the runner rejects and removes a partial probe', async (t) => {
        const request = gateRequest(t);
        fs.writeFileSync(path.join(request.sourceRoot, request.rel, 'index.js'), 'module');
        const { deps, calls } = recordingDeps(() => {
            fs.writeFileSync(request.probePath, 'partial');
            return Promise.reject(new Error('runner failed'));
        });
        const gate = createCloneGate({ platform: 'linux' });
        const unavailable = { kind: 'unavailable', reason: 'no copy-on-write between the clone and the worktree' };
        assert.deepEqual(await gate.check(deps, request), unavailable);
        assert.equal(fs.existsSync(request.probePath), false);
        assert.deepEqual(await gate.check(deps, request), unavailable);
        assert.equal(calls.length, 1);
    });

    await test('linux does not cache the absence of sample files', async (t) => {
        const request = gateRequest(t);
        fs.mkdirSync(path.join(request.sourceRoot, request.rel, 'empty'));
        const { deps, calls } = recordingDeps(copyReply);
        const gate = createCloneGate({ platform: 'linux' });
        assert.deepEqual(await gate.check(deps, request), { kind: 'available' });
        assert.equal(calls.length, 0);
        fs.writeFileSync(path.join(request.sourceRoot, request.rel, 'index.js'), 'module');
        assert.deepEqual(await gate.check(deps, request), { kind: 'available' });
        assert.equal(calls.length, 1);
        assert.equal(fs.existsSync(request.probePath), false);
    });

    await test('win32 is unavailable without runner calls', async (t) => {
        const { deps, calls } = recordingDeps(darwinReply);
        const gate = createCloneGate({ platform: 'win32' });
        assert.deepEqual(await gate.check(deps, gateRequest(t)), {
            kind: 'unavailable',
            reason: 'copy-on-write clones are not supported on this platform',
        });
        assert.equal(calls.length, 0);
    });
});
