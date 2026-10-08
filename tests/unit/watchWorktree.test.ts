import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { anchoredPattern, isDependencyDir, isLinkExcluded } from '../../src/ignoredLinks.ts';
import { parseWorktreeList, watchWorktreePath } from '../../src/watchWorktree.ts';

await describe('watchWorktreePath', async () => {
    await test('a sibling of the clone named after the PR number', () => {
        assert.equal(watchWorktreePath('/path/to/project', 7), '/path/to/alex-pr-watch-comments-pr-7');
    });
});

await describe('parseWorktreeList', async () => {
    await test('reads the main, linked, detached, bare and prunable entries', () => {
        const text = [
            'worktree /repo',
            'HEAD 1111111111111111111111111111111111111111',
            'branch refs/heads/main',
            '',
            'worktree /alex-pr-watch-comments-pr-7',
            'HEAD 2222222222222222222222222222222222222222',
            'branch refs/heads/feature/x',
            'locked',
            '',
            'worktree /detached',
            'HEAD 3333333333333333333333333333333333333333',
            'detached',
            '',
            'worktree /gone',
            'HEAD 4444444444444444444444444444444444444444',
            'branch refs/heads/old',
            'prunable gitdir file points to non-existent location',
            '',
            'worktree /bare.git',
            'bare',
            '',
        ].join('\n');
        assert.deepEqual(parseWorktreeList(text), [
            { path: '/repo', branch: 'main', bare: false, prunable: false },
            { path: '/alex-pr-watch-comments-pr-7', branch: 'feature/x', bare: false, prunable: false },
            { path: '/detached', branch: undefined, bare: false, prunable: false },
            { path: '/gone', branch: 'old', bare: false, prunable: true },
            { path: '/bare.git', branch: undefined, bare: true, prunable: false },
        ]);
    });

    await test('an empty listing has no entries', () => {
        assert.deepEqual(parseWorktreeList(''), []);
    });
});

await describe('isLinkExcluded', async () => {
    await test('build and cache outputs stay per working tree, everything else is linked', () => {
        for (const rel of ['dist', 'build', 'out', '.next', 'coverage', '.turbo', '.cache', '.eslintcache']) {
            assert.equal(isLinkExcluded(rel), true, rel);
        }
        assert.equal(isLinkExcluded('packages/app/dist'), true);
        assert.equal(isLinkExcluded('tsconfig.tsbuildinfo'), true);
        for (const rel of ['node_modules', '.env', 'CLAUDE.local.md', 'docs.local', 'packages/app/node_modules']) {
            assert.equal(isLinkExcluded(rel), false, rel);
        }
    });
});

await describe('isDependencyDir', async () => {
    await test('only a node_modules folder at any depth is a dependency folder', () => {
        assert.equal(isDependencyDir('node_modules'), true);
        assert.equal(isDependencyDir('packages/app/node_modules'), true);
        const others = [
            '.venv',
            'venv',
            'node_modules_backup',
            'my_node_modules',
            'alex-pr-watch-comments-clone-1-1',
            '.env',
            '',
        ];
        for (const rel of others) {
            assert.equal(isDependencyDir(rel), false, rel);
        }
    });
});

await describe('anchoredPattern', async () => {
    await test('anchors the path and escapes glob characters and a trailing space', () => {
        assert.equal(anchoredPattern('node_modules'), '/node_modules');
        assert.equal(anchoredPattern('pkg/a*b?[c]'), String.raw`/pkg/a\*b\?\[c]`);
        assert.equal(anchoredPattern(String.raw`odd\name `), String.raw`/odd\\name\ `);
    });
});
