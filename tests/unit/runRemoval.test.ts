import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test, type TestContext } from 'node:test';

import { removeRun, sweepTrash } from '../../src/runRemoval.ts';
import { createRun, listRunIds } from '../../src/runStore.ts';
import { initState, runDir, trashDir } from '../../src/stateStore.ts';
import type { Logger } from '../../src/types.ts';
import { createTestEnv } from '../support/testEnv.ts';

const RUN_ID = '20261008120000-1';

interface RecordingLogger extends Logger {
    warnings: string[];
}

function recordingLogger(): RecordingLogger {
    const warnings: string[] = [];
    return {
        warnings,
        info: () => {
            // Info lines are not asserted.
        },
        warn: (message) => {
            warnings.push(message);
        },
        error: (message) => {
            warnings.push(`error: ${message}`);
        },
    };
}

async function newStateDir(t: TestContext): Promise<string> {
    const env = await createTestEnv();
    t.after(() => {
        env.cleanup();
    });
    const result = initState(env.stateDir);
    assert.ok(result.ok);
    return result.stateDir;
}

function createRunWithFiles(stateDir: string): string {
    const rd = createRun(stateDir, RUN_ID);
    fs.writeFileSync(path.join(rd, 'record.json'), '{}\n');
    fs.mkdirSync(path.join(rd, 'nested'));
    fs.writeFileSync(path.join(rd, 'nested', 'events'), 'stop 1\n');
    return rd;
}

function trashEntries(stateDir: string): string[] {
    return fs.readdirSync(trashDir(stateDir));
}

function codedError(code: string): Error {
    return Object.assign(new Error(`simulated ${code}`), { code });
}

function failingRemove(): void {
    throw codedError('EBUSY');
}

await describe('removeRun', async () => {
    await test('removes a run directory with files and leaves the trash area empty', async (t) => {
        const stateDir = await newStateDir(t);
        createRunWithFiles(stateDir);
        assert.deepEqual(listRunIds(stateDir), [RUN_ID]);
        const log = recordingLogger();
        removeRun(stateDir, RUN_ID, log);
        assert.ok(!fs.existsSync(runDir(stateDir, RUN_ID)));
        assert.deepEqual(listRunIds(stateDir), []);
        assert.deepEqual(trashEntries(stateDir), []);
        assert.deepEqual(log.warnings, []);
    });

    await test('a missing run directory is a no-op', async (t) => {
        const stateDir = await newStateDir(t);
        const log = recordingLogger();
        removeRun(stateDir, RUN_ID, log);
        assert.deepEqual(listRunIds(stateDir), []);
        assert.deepEqual(trashEntries(stateDir), []);
        assert.deepEqual(log.warnings, []);
    });

    await test('creates a missing trash child with mode 700 and removes the run', async (t) => {
        const stateDir = await newStateDir(t);
        fs.rmdirSync(trashDir(stateDir));
        createRunWithFiles(stateDir);
        removeRun(stateDir, RUN_ID, recordingLogger());
        const stats = fs.lstatSync(trashDir(stateDir));
        assert.ok(stats.isDirectory());
        assert.equal(stats.mode & 0o777, 0o700);
        assert.ok(!fs.existsSync(runDir(stateDir, RUN_ID)));
        assert.deepEqual(trashEntries(stateDir), []);
    });

    await test('a delete that always fails leaves the entry for a later sweep', async (t) => {
        const stateDir = await newStateDir(t);
        createRunWithFiles(stateDir);
        const log = recordingLogger();
        removeRun(stateDir, RUN_ID, log, { remove: failingRemove });
        assert.ok(!fs.existsSync(runDir(stateDir, RUN_ID)));
        assert.deepEqual(listRunIds(stateDir), []);
        const entries = trashEntries(stateDir);
        assert.equal(entries.length, 1);
        assert.ok(entries[0]?.startsWith(RUN_ID));
        assert.equal(log.warnings.length, 2);
        assert.ok(log.warnings.every((line) => line.includes('EBUSY')));
        const later = recordingLogger();
        sweepTrash(stateDir, later);
        assert.deepEqual(trashEntries(stateDir), []);
        assert.deepEqual(later.warnings, []);
    });

    await test('a delete that fails once is finished by the internal sweep', async (t) => {
        const stateDir = await newStateDir(t);
        createRunWithFiles(stateDir);
        const log = recordingLogger();
        let calls = 0;
        const remove = (target: string): void => {
            calls += 1;
            if (calls === 1) {
                throw codedError('EBUSY');
            }
            fs.rmSync(target, { recursive: true, force: true });
        };
        removeRun(stateDir, RUN_ID, log, { remove });
        assert.equal(calls, 2);
        assert.deepEqual(trashEntries(stateDir), []);
        assert.equal(log.warnings.length, 1);
    });

    await test('a failing rename throws and leaves the run in place', async (t) => {
        const stateDir = await newStateDir(t);
        const rd = createRunWithFiles(stateDir);
        const rename = (): void => {
            throw codedError('EACCES');
        };
        assert.throws(() => {
            removeRun(stateDir, RUN_ID, recordingLogger(), { rename });
        }, /EACCES/u);
        assert.ok(fs.existsSync(path.join(rd, 'nested', 'events')));
        assert.deepEqual(listRunIds(stateDir), [RUN_ID]);
        assert.deepEqual(trashEntries(stateDir), []);
    });

    await test('a rename ENOENT for a run that is gone counts as removed', async (t) => {
        const stateDir = await newStateDir(t);
        createRunWithFiles(stateDir);
        const rename = (from: string): void => {
            fs.rmSync(from, { recursive: true, force: true });
            throw codedError('ENOENT');
        };
        removeRun(stateDir, RUN_ID, recordingLogger(), { rename });
        assert.deepEqual(listRunIds(stateDir), []);
    });

    await test('a rename ENOENT for a run that is still there is thrown', async (t) => {
        const stateDir = await newStateDir(t);
        const rd = createRunWithFiles(stateDir);
        const rename = (): void => {
            throw codedError('ENOENT');
        };
        assert.throws(() => {
            removeRun(stateDir, RUN_ID, recordingLogger(), { rename });
        }, /ENOENT/u);
        assert.ok(fs.existsSync(path.join(rd, 'nested', 'events')));
        assert.deepEqual(listRunIds(stateDir), [RUN_ID]);
    });

    await test('an unsafe trash child refuses the removal without touching the run', async (t) => {
        const stateDir = await newStateDir(t);
        const rd = createRunWithFiles(stateDir);
        fs.chmodSync(trashDir(stateDir), 0o770);
        let renamed = false;
        const rename = (): void => {
            renamed = true;
        };
        assert.throws(() => {
            removeRun(stateDir, RUN_ID, recordingLogger(), { rename });
        }, /trash/u);
        assert.equal(renamed, false);
        assert.ok(fs.existsSync(path.join(rd, 'record.json')));
        assert.deepEqual(listRunIds(stateDir), [RUN_ID]);
    });
});

await describe('sweepTrash', async () => {
    await test('removes an entry left by a crash between rename and delete', async (t) => {
        const stateDir = await newStateDir(t);
        const leftover = path.join(trashDir(stateDir), `${RUN_ID}.tmp.1-2`);
        fs.mkdirSync(leftover, { mode: 0o700 });
        fs.writeFileSync(path.join(leftover, 'record.json'), '{}\n');
        assert.deepEqual(listRunIds(stateDir), []);
        const log = recordingLogger();
        sweepTrash(stateDir, log);
        assert.deepEqual(trashEntries(stateDir), []);
        assert.deepEqual(listRunIds(stateDir), []);
        assert.deepEqual(log.warnings, []);
    });

    await test('a missing trash area is not an error', async (t) => {
        const stateDir = await newStateDir(t);
        fs.rmdirSync(trashDir(stateDir));
        const log = recordingLogger();
        sweepTrash(stateDir, log);
        assert.deepEqual(log.warnings, []);
        assert.ok(!fs.existsSync(trashDir(stateDir)));
    });

    await test('a trash path that is a regular file logs one warning', async (t) => {
        const stateDir = await newStateDir(t);
        fs.rmdirSync(trashDir(stateDir));
        fs.writeFileSync(trashDir(stateDir), 'not a directory\n');
        const log = recordingLogger();
        sweepTrash(stateDir, log);
        assert.equal(log.warnings.length, 1);
        assert.ok(log.warnings[0]?.includes(trashDir(stateDir)));
        assert.equal(fs.readFileSync(trashDir(stateDir), 'utf8'), 'not a directory\n');
    });

    await test('a failing entry is logged and the others are still removed', async (t) => {
        const stateDir = await newStateDir(t);
        const names = ['a.tmp.1-1', 'b.tmp.1-2', 'c.tmp.1-3'];
        for (const name of names) {
            fs.mkdirSync(path.join(trashDir(stateDir), name));
        }
        const log = recordingLogger();
        const remove = (target: string): void => {
            if (path.basename(target) === 'b.tmp.1-2') {
                throw codedError('ENOTEMPTY');
            }
            fs.rmSync(target, { recursive: true, force: true });
        };
        sweepTrash(stateDir, log, { remove });
        assert.deepEqual(trashEntries(stateDir), ['b.tmp.1-2']);
        assert.equal(log.warnings.length, 1);
        assert.ok(log.warnings[0]?.includes('ENOTEMPTY'));
    });
});
