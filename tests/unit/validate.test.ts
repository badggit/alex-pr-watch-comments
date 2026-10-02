import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { describe, test } from 'node:test';

import {
    isSafeAbsPath,
    isSafeRunPath,
    isSafeSocketPath,
    isUintString,
    isValidBranch,
    isValidName,
    isValidNodeId,
    isValidSha,
    readEnvSeconds,
    safeText,
    shQuote,
} from '../../src/validate.ts';

await describe('validate', async () => {
    await test('shQuote survives a real POSIX shell', () => {
        const value = "it's a $(echo x); rm -rf /nonexistent; `id` | cat & end";
        const output = execFileSync('/bin/sh', ['-c', `printf %s ${shQuote(value)}`], { encoding: 'utf8' });
        assert.equal(output, value);
        assert.equal(shQuote("a'b"), String.raw`'a'\''b'`);
    });

    await test('isValidName accepts GitHub names and rejects unsafe ones', () => {
        assert.ok(isValidName('owner-1'));
        assert.ok(isValidName('repo.name_x'));
        assert.ok(!isValidName('-x'));
        assert.ok(!isValidName('.hidden'));
        assert.ok(!isValidName('re po'));
        assert.ok(!isValidName('re%20po'));
        assert.ok(!isValidName(''));
    });

    await test('isValidBranch accepts plain branches and rejects unsafe ones', () => {
        assert.ok(isValidBranch('feature/x-1'));
        assert.ok(isValidBranch('main'));
        for (const bad of ['a..b', '-x', 'x;rm', 'x/', 'x.lock', '/x', '']) {
            assert.ok(!isValidBranch(bad), bad);
        }
    });

    await test('isValidNodeId, isValidSha and isUintString', () => {
        assert.ok(isValidNodeId('PRRC_kwDOabc-12='));
        assert.ok(!isValidNodeId("PRRC'x"));
        assert.ok(!isValidNodeId(''));
        assert.ok(isValidSha('a'.repeat(40)));
        assert.ok(!isValidSha('A'.repeat(40)));
        assert.ok(!isValidSha('a'.repeat(39)));
        assert.ok(isUintString('0'));
        assert.ok(isUintString('42'));
        assert.ok(!isUintString('-1'));
        assert.ok(!isUintString('1.5'));
        assert.ok(!isUintString(''));
    });

    await test('safeText replaces unsafe characters and truncates', () => {
        assert.equal(safeText('a#b\u001Bc'), 'a?b?c');
        assert.equal(safeText('ok (x=1): a/b, c+d_e.f-g'), 'ok (x=1): a/b, c+d_e.f-g');
        assert.equal(safeText('x'.repeat(300)).length, 200);
        assert.equal(safeText('line\nbreak'), 'line?break');
    });

    await test('isSafeRunPath accepts plain absolute paths only', () => {
        assert.ok(isSafeRunPath('/tmp/state_dir_x/runs/1-2'));
        assert.ok(!isSafeRunPath('tmp/state'));
        assert.ok(!isSafeRunPath('/tmp/state dir'));
        assert.ok(!isSafeRunPath('/tmp/state;x'));
        assert.ok(!isSafeRunPath('/opt/homebrew/opt/node@22/bin/node'));
    });

    await test('isSafeSocketPath accepts plain absolute paths only', () => {
        assert.ok(isSafeSocketPath('/tmp/tmux_dir/default'));
        assert.ok(!isSafeSocketPath('relative/sock'));
        assert.ok(!isSafeSocketPath('/tmp/a+b'));
    });

    await test('isSafeAbsPath allows printable characters but no control characters', () => {
        assert.ok(isSafeAbsPath('/opt/homebrew/opt/node@22/bin/node'));
        assert.ok(isSafeAbsPath('/Applications/My Tools/claude'));
        assert.ok(!isSafeAbsPath('bin/node'));
        assert.ok(!isSafeAbsPath('/bin/no\nde'));
        assert.ok(!isSafeAbsPath('/bin/no\tde'));
        assert.ok(!isSafeAbsPath('/bin/no\u007Fde'));
        assert.ok(!isSafeAbsPath(''));
    });

    await test('readEnvSeconds reads positive integers only', () => {
        assert.equal(readEnvSeconds({ X: 'abc' }, 'X', 9), 9);
        assert.equal(readEnvSeconds({ X: '0' }, 'X', 9), 9);
        assert.equal(readEnvSeconds({ X: '-3' }, 'X', 9), 9);
        assert.equal(readEnvSeconds({}, 'X', 9), 9);
        assert.equal(readEnvSeconds({ X: '7' }, 'X', 9), 7);
    });

    await test('readEnvSeconds treats values beyond the timer limit as invalid', () => {
        assert.equal(readEnvSeconds({ X: '2147483' }, 'X', 9), 2_147_483);
        assert.equal(readEnvSeconds({ X: '2147484' }, 'X', 9), 9);
        assert.equal(readEnvSeconds({ X: '999999999999999' }, 'X', 9), 9);
    });
});
