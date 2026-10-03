import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';

import type { Env } from '../../src/types.ts';

interface Outcome {
    code: number | null;
    stdout: string;
    stderr: string;
}

const ROOT = fs.realpathSync.native(path.resolve(import.meta.dirname, '..', '..'));
const LAUNCHER = path.join(ROOT, 'bin', 'pr-watch-comments');
const FAKE_NODE = path.join(ROOT, 'tests', 'fixtures', 'core', 'fakeNode.sh');
const MAIN_TS = path.join(ROOT, 'src', 'main.ts');
const NODE_PATH = `${path.dirname(process.execPath)}:/usr/bin:/bin`;
const TEMP = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'prwc-entry-')));

function runLauncher(script: string, args: readonly string[], env: Env, cwd = ROOT): Outcome {
    const result = spawnSync('/bin/sh', [script, ...args], { cwd, env, encoding: 'utf8', timeout: 60_000 });
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function fakeNodeEnv(version: string, argsFile: string): Env {
    return { PATH: '/usr/bin:/bin', PRWC_NODE: FAKE_NODE, FAKE_NODE_VERSION: version, FAKE_NODE_ARGS_FILE: argsFile };
}

await describe('entry launcher', async () => {
    after(() => {
        fs.rmSync(TEMP, { recursive: true, force: true });
    });

    await test('--help with the real node prints the usage', () => {
        const outcome = runLauncher(LAUNCHER, ['--help'], { PATH: NODE_PATH });
        assert.equal(outcome.code, 0, outcome.stderr);
        assert.match(outcome.stdout, /--background/u);
    });

    await test('no arguments exits 2 with the usage on stderr', () => {
        const outcome = runLauncher(LAUNCHER, [], { PATH: NODE_PATH });
        assert.equal(outcome.code, 2);
        assert.match(outcome.stderr, /PR URL/u);
        assert.match(outcome.stderr, /--background/u);
        assert.equal(outcome.stdout, '');
    });

    await test('a symlinked launcher resolves its real directory from a foreign working directory', () => {
        const direct = path.join(TEMP, 'direct-link');
        fs.symlinkSync(LAUNCHER, direct);
        const linkDir = path.join(TEMP, 'links');
        fs.mkdirSync(linkDir);
        const chained = path.join(linkDir, 'chained-link');
        fs.symlinkSync(path.join('..', 'direct-link'), chained);
        const expected = runLauncher(LAUNCHER, ['--help'], { PATH: NODE_PATH });
        assert.equal(expected.code, 0, expected.stderr);
        // Run from outside the repository, so a resolver that relied on the working directory would fail.
        for (const link of [direct, chained, 'direct-link', path.join('links', 'chained-link')]) {
            const outcome = runLauncher(link, ['--help'], { PATH: NODE_PATH }, TEMP);
            assert.equal(outcome.code, 0, `${link}: ${outcome.stderr}`);
            assert.equal(outcome.stdout, expected.stdout, link);
        }
    });

    await test('old Node versions are refused', () => {
        const argsFile = path.join(TEMP, 'refused-args');
        for (const version of [
            '22.17.1',
            '20.11.0',
            '23.0.0',
            '23.5.1',
            '22.18.0junk',
            '22.18',
            '22.18.0.1',
            'v24.0.0',
        ]) {
            const outcome = runLauncher(LAUNCHER, ['--help'], fakeNodeEnv(version, argsFile));
            assert.equal(outcome.code, 1, version);
            assert.match(outcome.stderr, /22\.18 or newer/u);
            assert.ok(outcome.stderr.includes(`found ${version}`), outcome.stderr);
            assert.ok(!fs.existsSync(argsFile), version);
        }
    });

    await test('supported Node versions exec main.ts with the arguments', () => {
        for (const version of ['22.18.0', '23.6.0', '24.0.0', '22.100.0', '123456789012.0.0']) {
            const argsFile = path.join(TEMP, `args-${version}`);
            const outcome = runLauncher(LAUNCHER, ['--help'], fakeNodeEnv(version, argsFile));
            assert.equal(outcome.code, 42, `${version}: ${outcome.stderr}`);
            assert.equal(fs.readFileSync(argsFile, 'utf8'), `${MAIN_TS}\n--help\n`);
        }
    });

    await test('a missing node is reported', () => {
        const outcome = runLauncher(LAUNCHER, ['--help'], { PATH: '/nonexistent' });
        assert.equal(outcome.code, 1);
        assert.match(outcome.stderr, /node not found/u);
    });
});
