import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, test } from 'node:test';

import {
    deriveTarget,
    isBranchName,
    isSafeSegment,
    MAX_SEGMENT,
    parseNewWorktreeArgs,
    type NewWorktreeArgs,
    type WorktreeTarget,
} from '../../src/newWorktreeArgs.ts';

const PARENT = '/path/to';
const MAIN_TREE = path.join(PARENT, 'app');
const NO_ARGS: NewWorktreeArgs = { name: undefined, task: undefined, branch: undefined, base: undefined };

function okArgs(argv: readonly string[]): NewWorktreeArgs {
    const result = parseNewWorktreeArgs(argv);
    if (result.kind !== 'ok') {
        throw new Error(`expected ok for ${argv.join(' ')}, got ${JSON.stringify(result)}`);
    }
    return result.args;
}

function errorMessage(argv: readonly string[]): string {
    const result = parseNewWorktreeArgs(argv);
    if (result.kind !== 'error') {
        throw new Error(`expected error for ${argv.join(' ')}, got ${result.kind}`);
    }
    return result.message;
}

function okTarget(args: NewWorktreeArgs, mainTree: string): WorktreeTarget {
    const result = deriveTarget(args, mainTree);
    if (!result.ok) {
        throw new Error(`expected a target, got ${result.message}`);
    }
    return result.target;
}

function targetError(args: NewWorktreeArgs, mainTree: string): string {
    const result = deriveTarget(args, mainTree);
    if (result.ok) {
        throw new Error(`expected a failure, got ${JSON.stringify(result.target)}`);
    }
    return result.message;
}

await describe('parseNewWorktreeArgs', async () => {
    await test('a positional NAME', () => {
        assert.deepEqual(okArgs(['app-hotfix']), { ...NO_ARGS, name: 'app-hotfix' });
    });

    await test('--task, --branch and --base fill their fields', () => {
        assert.deepEqual(okArgs(['--task', 'abc-123', '--branch', 'feat/x', '--base', 'main']), {
            name: undefined,
            task: 'abc-123',
            branch: 'feat/x',
            base: 'main',
        });
    });

    await test('--help anywhere returns help', () => {
        assert.deepEqual(parseNewWorktreeArgs(['--help']), { kind: 'help' });
        assert.deepEqual(parseNewWorktreeArgs(['x', '--help']), { kind: 'help' });
    });

    await test('argument shape errors', () => {
        assert.match(errorMessage([]), /NAME or --task/u);
        assert.match(errorMessage(['app', '--task', 'abc']), /not both/u);
        assert.match(errorMessage(['one', 'two']), /only one NAME/u);
        assert.match(errorMessage(['--task', 'a', '--task', 'b']), /--task can be given only once/u);
        assert.match(errorMessage(['app', '--branch', 'a', '--branch', 'b']), /--branch can be given only once/u);
        assert.match(errorMessage(['app', '--base', 'main', '--base', 'dev']), /--base can be given only once/u);
        assert.match(errorMessage(['app', '--base']), /missing value for --base/u);
        assert.match(errorMessage(['app', '--bogus']), /unknown option: --bogus/u);
    });

    await test('NAME errors', () => {
        assert.match(errorMessage(['.hidden']), /name must be/u);
        assert.match(errorMessage(['-x']), /unknown option: -x/u);
        assert.match(errorMessage(['a/b']), /name must be/u);
        assert.match(errorMessage(['a'.repeat(MAX_SEGMENT + 1)]), /name must be 1 to 100/u);
        assert.match(errorMessage(['alex-pr-watch-comments-pr-7']), /reserved prefix alex-pr-watch-comments-pr-/u);
    });

    await test('--task errors', () => {
        assert.match(errorMessage(['--task', '.x']), /--task must be/u);
    });

    await test('--branch errors', () => {
        for (const branch of ['@{-1}', '-x', 'refs/heads/x', 'a..b', 'x.lock', 'a b', '@']) {
            assert.match(errorMessage(['app', '--branch', branch]), /not a valid branch name/u, branch);
        }
    });

    await test('--base errors', () => {
        assert.match(errorMessage(['app', '--base', '-x']), /--base must not start with "-"/u);
        assert.match(errorMessage(['app', '--base', '']), /missing value for --base/u);
        assert.match(errorMessage(['app', '--base', 'ma\u0001in']), /control characters/u);
    });

    await test('user text in messages passes through safeText', () => {
        assert.match(errorMessage(['--bo\u001Bgus']), /unknown option: --bo\?gus/u);
    });
});

await describe('isSafeSegment', async () => {
    await test('accepts plain segments up to the limit', () => {
        for (const value of ['a', 'app-hotfix', 'A_1.b', 'a'.repeat(MAX_SEGMENT)]) {
            assert.ok(isSafeSegment(value), value);
        }
    });

    await test('refuses empty, long, dotted, dashed and slashed values', () => {
        for (const value of ['', 'a'.repeat(MAX_SEGMENT + 1), '.a', '-a', 'a/b', 'a b', 'a\u00E9']) {
            assert.ok(!isSafeSegment(value), value);
        }
    });
});

await describe('isBranchName', async () => {
    await test('accepts ordinary branch names and non-ASCII letters', () => {
        for (const value of ['feature/x', 'abc-123', 'pr-42', 'login-form', 'caf\u00E9']) {
            assert.ok(isBranchName(value), value);
        }
    });

    await test('refuses names git check-ref-format refuses', () => {
        const refused = [
            '',
            '@',
            'HEAD',
            'a\u0001b',
            'a\u007Fb',
            'a b',
            'a~b',
            'a^b',
            'a:b',
            'a?b',
            'a*b',
            'a[b',
            String.raw`a\b`,
            'a..b',
            'a@{b',
            'a//b',
            '/a',
            'a/',
            'a.',
            '.a',
            'a/.b',
            'a.lock',
            'a.lock/b',
            '-a',
            'refs/heads/a',
        ];
        for (const value of refused) {
            assert.ok(!isBranchName(value), value);
        }
    });
});

await describe('deriveTarget', async () => {
    await test('--task builds the name from the main folder', () => {
        assert.deepEqual(okTarget({ ...NO_ARGS, task: 'abc-123' }, MAIN_TREE), {
            name: 'app-abc-123',
            path: path.join(PARENT, 'app-abc-123'),
            branch: 'abc-123',
        });
    });

    await test('NAME is used as is and is the default branch', () => {
        assert.deepEqual(okTarget({ ...NO_ARGS, name: 'app-hotfix' }, MAIN_TREE), {
            name: 'app-hotfix',
            path: path.join(PARENT, 'app-hotfix'),
            branch: 'app-hotfix',
        });
    });

    await test('--branch overrides the NAME and SLUG defaults', () => {
        assert.equal(okTarget({ ...NO_ARGS, name: 'app-hotfix', branch: 'other' }, MAIN_TREE).branch, 'other');
        assert.equal(okTarget({ ...NO_ARGS, task: 'abc-123', branch: 'other' }, MAIN_TREE).branch, 'other');
    });

    await test('a NAME that is a safe segment but not a branch fails', () => {
        assert.match(targetError({ ...NO_ARGS, name: 'a..b' }, MAIN_TREE), /not a valid branch name: a\.\.b/u);
    });

    await test('a long main folder pushes a --task name over the limit', () => {
        const mainTree = path.join(PARENT, 'm'.repeat(95));
        assert.match(targetError({ ...NO_ARGS, task: 'abc-123' }, mainTree), /name must be 1 to 100/u);
    });

    await test('a main folder with the reserved prefix fails for --task', () => {
        const mainTree = path.join(PARENT, 'alex-pr-watch-comments-pr-7');
        assert.match(targetError({ ...NO_ARGS, task: 'x' }, mainTree), /reserved prefix/u);
    });

    await test('neither NAME nor --task fails', () => {
        assert.match(targetError(NO_ARGS, MAIN_TREE), /NAME or --task/u);
    });
});
