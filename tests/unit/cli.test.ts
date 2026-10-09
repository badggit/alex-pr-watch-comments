import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { parseArgs, parsePrUrl, usageText } from '../../src/cli.ts';
import type { CliOptions } from '../../src/types.ts';

const CWD = '/path/to/project';
const PR_URL = 'https://github.com/o/r/pull/12';
const PLAIN_HTTP_PR_URL = PR_URL.replace('https://', 'http://');

function okOptions(argv: readonly string[]): CliOptions {
    const result = parseArgs(argv, CWD);
    if (result.kind !== 'ok') {
        throw new Error(`expected ok for ${argv.join(' ')}, got ${JSON.stringify(result)}`);
    }
    return result.options;
}

function errorMessage(argv: readonly string[]): string {
    const result = parseArgs(argv, CWD);
    if (result.kind !== 'error') {
        throw new Error(`expected error for ${argv.join(' ')}, got ${result.kind}`);
    }
    return result.message;
}

await describe('parsePrUrl', async () => {
    await test('URL variants parse to the same PrRef', () => {
        const expected = { host: 'github.com', owner: 'o', repo: 'r', number: 12, prUrl: PR_URL, prKey: 'o+r+12' };
        for (const variant of [PR_URL, `${PR_URL}/files`, `${PR_URL}#discussion_r99`, `${PR_URL}?x=1`]) {
            assert.deepEqual(parsePrUrl(variant), expected, variant);
        }
    });

    await test('owner and repo are lowercased into a canonical identity', () => {
        const upper = parsePrUrl('https://github.com/Owner/Repo/pull/12');
        const lower = parsePrUrl('https://github.com/owner/repo/pull/12');
        assert.ok(upper);
        assert.deepEqual(upper, lower);
        assert.equal(upper.prKey, 'owner+repo+12');
        assert.equal(upper.prUrl, 'https://github.com/owner/repo/pull/12');
        assert.equal(upper.owner, 'owner');
        assert.equal(upper.repo, 'repo');
    });

    await test('a GitHub Enterprise Server URL keeps its host in the identity', () => {
        const pr = parsePrUrl('https://Git.Example.com/Owner/Repo/pull/7/files');
        assert.deepEqual(pr, {
            host: 'git.example.com',
            owner: 'owner',
            repo: 'repo',
            number: 7,
            prUrl: 'https://git.example.com/owner/repo/pull/7',
            prKey: 'git.example.com+owner+repo+7',
        });
    });

    await test('malformed hosts, bad numbers and bad names are rejected', () => {
        for (const bad of [
            'https://localhost/o/r/pull/1',
            'https://git.example.com:8443/o/r/pull/1',
            'https://user@github.com/o/r/pull/1',
            'https://-git.example.com/o/r/pull/1',
            'https://github.com/o/r/pull/x',
            'https://github.com/o/re%20po/pull/1',
            'https://github.com/o/r/pull/0',
            'https://github.com/o/r/pull/12x',
            'https://github.com/o/r/issues/12',
            PLAIN_HTTP_PR_URL,
            'https://github.com/-o/r/pull/12',
            'https://github.com/o/r/pull/12\n',
        ]) {
            assert.equal(parsePrUrl(bad), undefined, bad);
        }
    });
});

await describe('parseArgs', async () => {
    await test('defaults', () => {
        const options = okOptions([PR_URL]);
        assert.equal(options.mode, 'watch');
        assert.equal(options.pr?.prKey, 'o+r+12');
        assert.equal(options.dir, CWD);
        assert.equal(options.interval, 120);
        assert.equal(options.keepPanes, 5);
        assert.equal(options.batchMax, 5);
        assert.equal(options.claude, undefined);
        assert.deepEqual(options.claudeArgs, []);
        assert.equal(options.once, false);
        assert.equal(options.inPlace, true);
    });

    await test('value options', () => {
        const options = okOptions([
            PR_URL,
            '--dir',
            'sub/dir',
            '--interval',
            '30',
            '--keep-panes',
            '0',
            '--claude',
            '/opt/claude',
            '--once',
        ]);
        assert.equal(options.dir, '/path/to/project/sub/dir');
        assert.equal(options.interval, 30);
        assert.equal(options.keepPanes, 0);
        assert.equal(options.claude, '/opt/claude');
        assert.equal(options.once, true);
        assert.equal(okOptions(['--dir', '/abs', PR_URL]).dir, '/abs');
        assert.equal(okOptions([PR_URL, '--interval', '86400']).interval, 86_400);
        assert.equal(okOptions([PR_URL, '--interval', '1']).interval, 1);
        assert.equal(okOptions([PR_URL, '--batch-max', '1']).batchMax, 1);
        assert.equal(okOptions([PR_URL, '--batch-max', '50']).batchMax, 50);
    });

    await test('--claude-arg values are kept literally', () => {
        const options = okOptions([PR_URL, '--claude-arg', '--model x', '--claude-arg', 'a b', '--claude-arg', '*']);
        assert.deepEqual(options.claudeArgs, ['--model x', 'a b', '*']);
    });

    await test('modes', () => {
        assert.equal(okOptions([PR_URL, '--background']).mode, 'background');
        const list = okOptions(['--list']);
        assert.equal(list.mode, 'list');
        assert.equal(list.pr, undefined);
        const stop = okOptions(['--stop', PR_URL]);
        assert.equal(stop.mode, 'stop');
        assert.equal(stop.pr?.prKey, 'o+r+12');
        assert.equal(okOptions([PR_URL, '--once']).once, true);
        assert.equal(okOptions([PR_URL, '--in-place']).inPlace, true);
        assert.equal(okOptions([PR_URL, '--background', '--in-place']).inPlace, true);
        assert.equal(okOptions([PR_URL, '--worktree']).inPlace, false);
        assert.equal(okOptions([PR_URL, '--background', '--worktree']).inPlace, false);
    });

    await test('--no-attach turns off the terminal tab of a background start', () => {
        assert.equal(okOptions([PR_URL, '--background']).attach, true);
        assert.equal(okOptions([PR_URL, '--background', '--no-attach']).attach, false);
        assert.deepEqual(parseArgs([PR_URL, '--no-attach'], CWD), {
            kind: 'error',
            message: '--no-attach needs --background',
        });
    });

    await test('repeating the same working-tree option keeps that mode', () => {
        assert.equal(okOptions([PR_URL]).inPlace, true);
        assert.equal(okOptions([PR_URL, '--in-place', '--in-place']).inPlace, true);
        assert.equal(okOptions([PR_URL, '--worktree', '--worktree']).inPlace, false);
    });

    await test('--help', () => {
        assert.deepEqual(parseArgs(['--help'], CWD), { kind: 'help' });
        assert.deepEqual(parseArgs([PR_URL, '--help'], CWD), { kind: 'help' });
        assert.equal(okOptions([PR_URL, '--claude-arg', '--help']).claudeArgs[0], '--help');
    });

    await test('errors', () => {
        assert.match(errorMessage([PR_URL, '--claude-arg', 'a\nb']), /newline/u);
        assert.match(errorMessage([PR_URL, '--claude-arg', 'a\rb']), /carriage return/u);
        assert.match(errorMessage([PR_URL, '--interval', '0']), /--interval/u);
        assert.match(errorMessage([PR_URL, '--interval', 'abc']), /--interval/u);
        assert.match(
            errorMessage([PR_URL, '--interval', '86401']),
            /--interval needs a whole number of seconds from 1 to 86400/u
        );
        assert.match(errorMessage([PR_URL, '--interval', '2147484']), /--interval/u);
        assert.match(errorMessage([PR_URL, '--keep-panes', '-1']), /--keep-panes/u);
        for (const value of ['0', '51', 'x']) {
            assert.equal(errorMessage([PR_URL, '--batch-max', value]), '--batch-max needs a whole number from 1 to 50');
        }
        assert.match(errorMessage([PR_URL, '--bogus']), /unknown option/u);
        assert.match(errorMessage([PR_URL, '--interval']), /missing value/u);
        assert.match(errorMessage(['--list', PR_URL]), /--list/u);
        assert.match(errorMessage(['--stop']), /missing value/u);
        assert.match(errorMessage(['--list', '--stop', PR_URL]), /--list/u);
        assert.match(errorMessage([PR_URL, '--background', '--list']), /--background/u);
        assert.match(errorMessage(['--background', '--stop', PR_URL]), /--background/u);
        assert.equal(errorMessage([PR_URL, '--background', '--once']), '--once cannot be combined with --background');
        assert.equal(
            errorMessage([PR_URL, '--in-place', '--worktree']),
            '--in-place cannot be combined with --worktree'
        );
        assert.equal(
            errorMessage([PR_URL, '--worktree', '--in-place']),
            '--in-place cannot be combined with --worktree'
        );
        assert.equal(
            errorMessage([PR_URL, '--in-place', '--worktree', '--in-place']),
            '--in-place cannot be combined with --worktree'
        );
        assert.equal(
            errorMessage([PR_URL, '--worktree', '--in-place', '--worktree']),
            '--in-place cannot be combined with --worktree'
        );
        assert.equal(
            errorMessage(['--worktree', '--in-place', '--list', '--stop', PR_URL]),
            '--in-place cannot be combined with --worktree'
        );
        assert.equal(errorMessage([PR_URL, '--worktree', '--bogus', '--in-place']), 'unknown option: --bogus');
        assert.match(errorMessage([]), /PR URL/u);
        assert.match(errorMessage(['--background']), /PR URL/u);
        assert.match(errorMessage(['https://localhost/o/r/pull/1']), /invalid PR URL/u);
        assert.match(errorMessage(['--stop', 'https://github.com/o/r/pull/x']), /invalid PR URL/u);
        assert.match(errorMessage([PR_URL, 'https://github.com/o/r/pull/13']), /unexpected argument/u);
    });

    await test('usageText mentions every option', () => {
        const usage = usageText();
        for (const option of [
            '--background',
            '--list',
            '--stop',
            '--dir',
            '--interval',
            '--claude',
            '--claude-arg',
            '--keep-panes',
            '--batch-max',
            '--once',
            '--in-place',
            '--worktree',
            '--help',
        ]) {
            assert.ok(usage.includes(option), option);
        }
        assert.match(usage, /default 120/u);
        assert.match(usage, /default 5/u);
    });
});

await describe('parseArgs new-worktree', async () => {
    await test('a leading new-worktree routes to the new-worktree parser', () => {
        assert.deepEqual(parseArgs(['new-worktree', '--task', 'abc-123'], CWD), {
            kind: 'newWorktree',
            args: { name: undefined, task: 'abc-123', branch: undefined, base: undefined },
        });
    });

    await test('help and errors of the new-worktree parser pass through', () => {
        assert.deepEqual(parseArgs(['new-worktree', '--help'], CWD), { kind: 'help' });
        const message = errorMessage(['new-worktree']);
        assert.match(message, /NAME/u);
        assert.match(message, /--task/u);
        assert.equal(errorMessage(['new-worktree', '--bogus']), 'unknown option: --bogus');
    });

    await test('new-worktree in any other position keeps its old meaning', () => {
        assert.equal(errorMessage([PR_URL, 'new-worktree']), 'unexpected argument: new-worktree');
    });

    await test('usageText lists both new-worktree forms', () => {
        const usage = usageText();
        assert.ok(usage.includes('alex-pr-watch-comments new-worktree NAME [--branch BRANCH] [--base REF]'));
        assert.ok(usage.includes('alex-pr-watch-comments new-worktree --task SLUG [--branch BRANCH] [--base REF]'));
        assert.ok(usage.includes('create or reuse a worktree next to the main clone and print its path'));
    });
});
