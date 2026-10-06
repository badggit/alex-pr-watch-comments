import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';

import { cloneCommand, cloneTempName, createCloner, placeClone, sweepDeadTemps } from '../../src/cowClone.ts';
import type { CloneDeps } from '../../src/cowGate.ts';
import type { CommandRequest, CommandResult } from '../../src/types.ts';

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

interface CloneFixture {
    source: string;
    target: string;
    tempArea: string;
    own: string;
    dest: string;
}

function cloneFixture(t: TestContext): CloneFixture {
    const root = makeRoot(t);
    const source = path.join(root, 'source');
    const target = path.join(root, 'target');
    const tempArea = path.join(root, 'private-git-dir');
    const own = path.join(source, 'node_modules');
    const dest = path.join(target, 'node_modules');
    fs.mkdirSync(path.join(own, 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(own, 'pkg', 'index.js'), 'export const value = 42;');
    fs.symlinkSync('pkg/index.js', path.join(own, 'linked.js'));
    fs.mkdirSync(target);
    fs.mkdirSync(tempArea);
    return { source, target, tempArea, own, dest };
}

function cloneRecordingDeps(
    fixture: CloneFixture,
    override?: (_request: CommandRequest) => CommandResult | Promise<CommandResult> | undefined
): { deps: CloneDeps; calls: CommandRequest[]; logs: string[] } {
    const calls: CommandRequest[] = [];
    const logs: string[] = [];
    return {
        calls,
        logs,
        deps: {
            runner: {
                run(request) {
                    calls.push(request);
                    const overridden = override?.(request);
                    if (overridden !== undefined) {
                        return Promise.resolve(overridden);
                    }
                    if (request.args.includes('--absolute-git-dir')) {
                        return Promise.resolve({ code: 0, stdout: `${fixture.tempArea}\n`, stderr: '' });
                    }
                    if (request.file === '/bin/df') {
                        return Promise.resolve({
                            code: 0,
                            stdout: 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk3s5 100 1 99 1% /Volumes/Data\n',
                            stderr: '',
                        });
                    }
                    if (request.file === '/sbin/mount') {
                        return Promise.resolve({
                            code: 0,
                            stdout: '/dev/disk3s5 on /Volumes/Data (apfs, local)\n',
                            stderr: '',
                        });
                    }
                    const from = request.args.at(-2);
                    const to = request.args.at(-1);
                    assert.ok(from);
                    assert.ok(to);
                    fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true });
                    return Promise.resolve({ code: 0, stdout: '', stderr: '' });
                },
            },
            log: {
                info(message) {
                    logs.push(`info ${message}`);
                },
                warn(message) {
                    logs.push(`warn ${message}`);
                },
                error(message) {
                    logs.push(`error ${message}`);
                },
            },
        },
    };
}

function clock(): () => number {
    let value = 1000;
    return () => {
        const current = value;
        value = 3500;
        return current;
    };
}

function assertNoCloneTemps(tempArea: string): void {
    assert.deepEqual(
        fs.readdirSync(tempArea).filter((entry) => entry.startsWith('alex-pr-watch-comments-clone-')),
        []
    );
}

await describe('createCloner', async () => {
    await test('avoids occupied temp names for a live or reused PID without deleting them', async (t) => {
        const fixture = cloneFixture(t);
        const staleDir = path.join(fixture.tempArea, cloneTempName(42, 1));
        const staleFile = path.join(fixture.tempArea, cloneTempName(42, 2));
        const staleLink = path.join(fixture.tempArea, cloneTempName(42, 3));
        fs.mkdirSync(staleDir);
        fs.writeFileSync(path.join(staleDir, 'old.txt'), 'keep directory');
        fs.writeFileSync(staleFile, 'keep file');
        fs.symlinkSync('missing-temp-target', staleLink);
        const { deps, calls } = cloneRecordingDeps(fixture);
        const cloner = createCloner({ platform: 'linux', pid: 42, alive: () => true });
        assert.deepEqual(await cloner.cloneDependency(deps, 'git', fixture.source, fixture.target, 'node_modules'), {
            kind: 'cloned',
        });
        assert.equal(calls[1]?.args.at(-1), path.join(fixture.tempArea, cloneTempName(42, 4)));
        assert.equal(calls[2]?.args.at(-1), path.join(fixture.tempArea, cloneTempName(42, 5)));
        assert.equal(fs.readFileSync(path.join(staleDir, 'old.txt'), 'utf8'), 'keep directory');
        assert.equal(fs.readFileSync(staleFile, 'utf8'), 'keep file');
        assert.equal(fs.readlinkSync(staleLink), 'missing-temp-target');
        assert.deepEqual(fs.readdirSync(fixture.tempArea).toSorted(), [
            cloneTempName(42, 1),
            cloneTempName(42, 2),
            cloneTempName(42, 3),
        ]);
        assert.equal(fs.readFileSync(path.join(fixture.dest, 'pkg', 'index.js'), 'utf8'), 'export const value = 42;');
    });

    await test('clones an absent destination via a separate temp and preserves source symlinks', async (t) => {
        const fixture = cloneFixture(t);
        const { deps, calls, logs } = cloneRecordingDeps(fixture);
        const cloner = createCloner({ platform: 'linux', pid: 42, nowMs: clock() });
        assert.deepEqual(await cloner.cloneDependency(deps, 'git', fixture.source, fixture.target, 'node_modules'), {
            kind: 'cloned',
        });
        assert.ok(fs.lstatSync(fixture.dest).isDirectory());
        assert.equal(fs.lstatSync(fixture.dest).isSymbolicLink(), false);
        assert.equal(fs.readFileSync(path.join(fixture.dest, 'pkg', 'index.js'), 'utf8'), 'export const value = 42;');
        assert.equal(fs.readlinkSync(path.join(fixture.dest, 'linked.js')), 'pkg/index.js');
        assertNoCloneTemps(fixture.tempArea);
        assert.deepEqual(calls[0], {
            file: 'git',
            args: ['-C', fixture.target, 'rev-parse', '--absolute-git-dir'],
        });
        assert.deepEqual(calls.at(-1), {
            file: 'cp',
            args: ['-R', '--reflink=always', fixture.own, path.join(fixture.tempArea, cloneTempName(42, 2))],
            timeoutMs: 600_000,
        });
        assert.deepEqual(logs, [
            'info cloning node_modules into the watch worktree with copy-on-write',
            'info cloned node_modules into the watch worktree in 2.5 s',
        ]);
        fs.writeFileSync(path.join(fixture.dest, 'pkg', 'index.js'), 'private edit');
        assert.equal(fs.readFileSync(path.join(fixture.own, 'pkg', 'index.js'), 'utf8'), 'export const value = 42;');
    });

    await test('converts an own link to a real cloned directory', async (t) => {
        const fixture = cloneFixture(t);
        fs.symlinkSync(fixture.own, fixture.dest);
        const { deps } = cloneRecordingDeps(fixture);
        const cloner = createCloner({ platform: 'linux' });
        assert.deepEqual(await cloner.cloneDependency(deps, 'git', fixture.source, fixture.target, 'node_modules'), {
            kind: 'cloned',
        });
        assert.ok(fs.lstatSync(fixture.dest).isDirectory());
        assert.equal(fs.lstatSync(fixture.dest).isSymbolicLink(), false);
    });

    await test('skips a foreign real directory without calling the runner', async (t) => {
        const fixture = cloneFixture(t);
        fs.mkdirSync(fixture.dest);
        fs.writeFileSync(path.join(fixture.dest, 'mine'), 'keep');
        const { deps, calls, logs } = cloneRecordingDeps(fixture);
        const cloner = createCloner({ platform: 'linux' });
        assert.deepEqual(await cloner.cloneDependency(deps, 'git', fixture.source, fixture.target, 'node_modules'), {
            kind: 'skipped',
        });
        assert.deepEqual(calls, []);
        assert.deepEqual(logs, []);
        assert.equal(fs.readFileSync(path.join(fixture.dest, 'mine'), 'utf8'), 'keep');
    });

    await test('sweeps a dead PID temp before cloning', async (t) => {
        const fixture = cloneFixture(t);
        const deadTemp = path.join(fixture.tempArea, cloneTempName(999, 1));
        fs.mkdirSync(deadTemp);
        fs.writeFileSync(path.join(deadTemp, 'partial'), 'unfinished');
        const { deps } = cloneRecordingDeps(fixture);
        const cloner = createCloner({ platform: 'linux', alive: (pid) => pid !== 999 });
        assert.deepEqual(await cloner.cloneDependency(deps, 'git', fixture.source, fixture.target, 'node_modules'), {
            kind: 'cloned',
        });
        assert.equal(fs.existsSync(deadTemp), false);
        assertNoCloneTemps(fixture.tempArea);
    });

    await test('keeps an own link on gate rejection, caches the gate and does not memo the destination', async (t) => {
        const fixture = cloneFixture(t);
        fs.symlinkSync(fixture.own, fixture.dest);
        const { deps, calls, logs } = cloneRecordingDeps(fixture, (request) => {
            if (request.file === 'cp') {
                return { code: 1, stdout: '', stderr: 'Operation not supported' };
            }
        });
        const cloner = createCloner({ platform: 'linux' });
        const unavailable = { kind: 'unavailable', reason: 'no copy-on-write between the clone and the worktree' };
        assert.deepEqual(
            await cloner.cloneDependency(deps, 'git', fixture.source, fixture.target, 'node_modules'),
            unavailable
        );
        assert.equal(fs.readlinkSync(fixture.dest), fixture.own);
        assert.deepEqual(
            await cloner.cloneDependency(deps, 'git', fixture.source, fixture.target, 'node_modules'),
            unavailable
        );
        const copies = calls.filter((request) => request.file === 'cp');
        assert.equal(copies.length, 1);
        assert.equal(copies[0]?.args.includes('-R'), false);
        assert.equal(calls.length, 3);
        assert.deepEqual(logs, []);
        assertNoCloneTemps(fixture.tempArea);
    });

    await test('cleans a failed partial clone, keeps the own link and memos the destination', async (t) => {
        const fixture = cloneFixture(t);
        fs.symlinkSync(fixture.own, fixture.dest);
        const { deps, calls, logs } = cloneRecordingDeps(fixture, (request) => {
            if (request.args.includes('-R')) {
                const temp = request.args.at(-1);
                assert.ok(temp);
                fs.mkdirSync(temp);
                fs.writeFileSync(path.join(temp, 'partial'), 'unfinished');
                return { code: 1, stdout: '', stderr: 'cp: cannot create\nextra detail' };
            }
        });
        const cloner = createCloner({ platform: 'linux' });
        assert.deepEqual(await cloner.cloneDependency(deps, 'git', fixture.source, fixture.target, 'node_modules'), {
            kind: 'failed',
            reason: 'cp exited with 1: cp: cannot create',
        });
        assert.equal(fs.readlinkSync(fixture.dest), fixture.own);
        assertNoCloneTemps(fixture.tempArea);
        const count = calls.length;
        assert.deepEqual(await cloner.cloneDependency(deps, 'git', fixture.source, fixture.target, 'node_modules'), {
            kind: 'skipped',
        });
        assert.equal(calls.length, count);
        assert.deepEqual(logs, ['info cloning node_modules into the watch worktree with copy-on-write']);
    });

    await test('memos failure when git cannot resolve the private directory', async (t) => {
        const fixture = cloneFixture(t);
        const { deps, calls } = cloneRecordingDeps(fixture, () => ({
            code: 128,
            stdout: '',
            stderr: 'not a repository',
        }));
        const cloner = createCloner({ platform: 'linux' });
        assert.deepEqual(await cloner.cloneDependency(deps, 'git', fixture.source, fixture.target, 'node_modules'), {
            kind: 'failed',
            reason: 'cannot find the git directory of the worktree',
        });
        assert.equal(fs.existsSync(fixture.dest), false);
        assert.deepEqual(await cloner.cloneDependency(deps, 'git', fixture.source, fixture.target, 'node_modules'), {
            kind: 'skipped',
        });
        assert.equal(calls.length, 1);
    });

    await test('uses the absolute BSD cp on an APFS darwin volume', async (t) => {
        const fixture = cloneFixture(t);
        const { deps, calls } = cloneRecordingDeps(fixture);
        const cloner = createCloner({ platform: 'darwin', deviceOf: () => 5, pid: 42 });
        assert.deepEqual(await cloner.cloneDependency(deps, 'git', fixture.source, fixture.target, 'node_modules'), {
            kind: 'cloned',
        });
        assert.deepEqual(calls.at(-1), {
            file: '/bin/cp',
            args: ['-c', '-R', fixture.own, path.join(fixture.tempArea, cloneTempName(42, 2))],
            timeoutMs: 600_000,
        });
        assertNoCloneTemps(fixture.tempArea);
    });

    await test('skips a foreign symlink and preserves its exact text', async (t) => {
        const fixture = cloneFixture(t);
        const foreign = path.join(fixture.source, 'other');
        fs.symlinkSync(foreign, fixture.dest);
        const { deps, calls } = cloneRecordingDeps(fixture);
        const cloner = createCloner({ platform: 'linux' });
        assert.deepEqual(await cloner.cloneDependency(deps, 'git', fixture.source, fixture.target, 'node_modules'), {
            kind: 'skipped',
        });
        assert.equal(fs.readlinkSync(fixture.dest), foreign);
        assert.deepEqual(calls, []);
    });

    await test('rejects a non-absolute git directory and memos the destination', async (t) => {
        const fixture = cloneFixture(t);
        const { deps, calls } = cloneRecordingDeps(fixture, () => ({ code: 0, stdout: '.git\n', stderr: '' }));
        const cloner = createCloner({ platform: 'linux' });
        assert.deepEqual(await cloner.cloneDependency(deps, 'git', fixture.source, fixture.target, 'node_modules'), {
            kind: 'failed',
            reason: 'cannot find the git directory of the worktree',
        });
        assert.deepEqual(await cloner.cloneDependency(deps, 'git', fixture.source, fixture.target, 'node_modules'), {
            kind: 'skipped',
        });
        assert.equal(calls.length, 1);
        assert.equal(fs.existsSync(fixture.dest), false);
    });

    for (const failure of [
        { code: 127, stdout: '', stderr: '', spawnError: 'ENOENT' },
        { code: 143, stdout: '', stderr: '' },
    ]) {
        await test(`preserves the own link after cp status ${failure.code} and forwards the timeout`, async (t) => {
            const fixture = cloneFixture(t);
            fs.symlinkSync(fixture.own, fixture.dest);
            const { deps, calls } = cloneRecordingDeps(fixture, (request) =>
                request.args.includes('-R') ? failure : undefined
            );
            const cloner = createCloner({ platform: 'linux', timeoutMs: 20_000 });
            assert.deepEqual(
                await cloner.cloneDependency(deps, 'git', fixture.source, fixture.target, 'node_modules'),
                {
                    kind: 'failed',
                    reason: failure.spawnError ?? `cp exited with ${failure.code}`,
                }
            );
            assert.equal(calls.at(-1)?.timeoutMs, 20_000);
            assert.equal(fs.readlinkSync(fixture.dest), fixture.own);
            assertNoCloneTemps(fixture.tempArea);
            const count = calls.length;
            assert.deepEqual(
                await cloner.cloneDependency(deps, 'git', fixture.source, fixture.target, 'node_modules'),
                {
                    kind: 'skipped',
                }
            );
            assert.equal(calls.length, count);
        });
    }

    await test('cleans a partial temp if the runner rejects', async (t) => {
        const fixture = cloneFixture(t);
        fs.symlinkSync(fixture.own, fixture.dest);
        const { deps } = cloneRecordingDeps(fixture, (request) => {
            if (request.args.includes('-R')) {
                const temp = request.args.at(-1);
                assert.ok(temp);
                fs.mkdirSync(temp);
                return Promise.reject(new Error('runner rejected'));
            }
        });
        const cloner = createCloner({ platform: 'linux' });
        assert.deepEqual(await cloner.cloneDependency(deps, 'git', fixture.source, fixture.target, 'node_modules'), {
            kind: 'failed',
            reason: 'runner rejected',
        });
        assert.equal(fs.readlinkSync(fixture.dest), fixture.own);
        assertNoCloneTemps(fixture.tempArea);
    });

    await test('refuses a foreign destination appearing during the copy and memos it', async (t) => {
        const fixture = cloneFixture(t);
        const { deps, calls } = cloneRecordingDeps(fixture, (request) => {
            if (request.args.includes('-R')) {
                fs.mkdirSync(fixture.dest);
                fs.writeFileSync(path.join(fixture.dest, 'mine'), 'keep');
            }
        });
        const cloner = createCloner({ platform: 'linux' });
        assert.deepEqual(await cloner.cloneDependency(deps, 'git', fixture.source, fixture.target, 'node_modules'), {
            kind: 'failed',
            reason: 'cannot place the clone (EEXIST)',
        });
        assert.equal(fs.readFileSync(path.join(fixture.dest, 'mine'), 'utf8'), 'keep');
        assertNoCloneTemps(fixture.tempArea);
        const count = calls.length;
        assert.deepEqual(await cloner.cloneDependency(deps, 'git', fixture.source, fixture.target, 'node_modules'), {
            kind: 'skipped',
        });
        assert.equal(calls.length, count);
    });

    for (const output of ['symlink', 'file', 'missing']) {
        await test(`refuses successful cp with ${output} output and preserves the own link`, async (t) => {
            const fixture = cloneFixture(t);
            if (output === 'symlink') {
                const linkedDeps = path.join(fixture.source, 'linked-deps');
                fs.renameSync(fixture.own, linkedDeps);
                fs.symlinkSync(linkedDeps, fixture.own);
            }
            fs.symlinkSync(fixture.own, fixture.dest);
            const { deps, calls } = cloneRecordingDeps(fixture, (request) => {
                if (request.args.includes('-R') && output !== 'symlink') {
                    if (output === 'file') {
                        const temp = request.args.at(-1);
                        assert.ok(temp);
                        fs.writeFileSync(temp, 'unexpected file');
                    }
                    return { code: 0, stdout: '', stderr: '' };
                }
            });
            const cloner = createCloner({ platform: 'linux' });
            assert.deepEqual(
                await cloner.cloneDependency(deps, 'git', fixture.source, fixture.target, 'node_modules'),
                {
                    kind: 'failed',
                    reason: 'cp did not create a directory',
                }
            );
            assert.equal(fs.readlinkSync(fixture.dest), fixture.own);
            assert.equal(
                fs.readFileSync(path.join(fixture.own, 'pkg', 'index.js'), 'utf8'),
                'export const value = 42;'
            );
            assertNoCloneTemps(fixture.tempArea);
            const count = calls.length;
            assert.deepEqual(
                await cloner.cloneDependency(deps, 'git', fixture.source, fixture.target, 'node_modules'),
                {
                    kind: 'skipped',
                }
            );
            assert.equal(calls.length, count);
        });
    }
});
