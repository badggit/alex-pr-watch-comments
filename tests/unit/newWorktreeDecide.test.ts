import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';

import { decideManualWorktree } from '../../src/newWorktreeDecide.ts';
import type { ManualDecision, RegisteredWorktree, TargetFacts } from '../../src/newWorktreeDecide.ts';

const ROOT = path.join(tmpdir(), 'decide-root');
const TARGET = path.join(ROOT, 'feature-x');
const BRANCH = 'feature/x';

function facts(overrides: Partial<TargetFacts>): TargetFacts {
    return {
        target: TARGET,
        branch: BRANCH,
        baseGiven: false,
        targetIsOwnTree: false,
        targetState: 'absent',
        registered: undefined,
        holder: undefined,
        localBranch: false,
        remoteMatches: [],
        ...overrides,
    };
}

function registered(overrides: Partial<RegisteredWorktree>): RegisteredWorktree {
    return {
        path: TARGET,
        folderName: 'feature-x',
        branch: BRANCH,
        detached: false,
        locked: false,
        missing: false,
        ...overrides,
    };
}

function reasonOf(decision: ManualDecision): string {
    if (decision.kind !== 'refuse') {
        throw new Error(`expected refuse, got ${decision.kind}`);
    }
    return decision.reason;
}

await describe('decideManualWorktree outcomes', async () => {
    await test('baseline creates a new branch', () => {
        assert.deepEqual(decideManualWorktree(facts({})), { kind: 'create' });
    });

    await test('an existing local branch is checked out', () => {
        assert.deepEqual(decideManualWorktree(facts({ localBranch: true })), { kind: 'checkout' });
    });

    await test('one remote match is tracked from that remote', () => {
        assert.deepEqual(decideManualWorktree(facts({ remoteMatches: [`origin/${BRANCH}`] })), {
            kind: 'track',
            remote: 'origin',
        });
    });

    await test('several remote matches refuse and list every candidate', () => {
        const reason = reasonOf(
            decideManualWorktree(facts({ remoteMatches: [`origin/${BRANCH}`, `upstream/${BRANCH}`] }))
        );
        assert.ok(reason.includes(`origin/${BRANCH}`));
        assert.ok(reason.includes(`upstream/${BRANCH}`));
    });

    await test('a registered worktree on the branch is reused', () => {
        assert.deepEqual(decideManualWorktree(facts({ registered: registered({}), targetState: 'present' })), {
            kind: 'reuse',
        });
    });
});

await describe('decideManualWorktree refusals', async () => {
    await test('own tree refuses before anything else', () => {
        const reason = reasonOf(decideManualWorktree(facts({ targetIsOwnTree: true, registered: registered({}) })));
        assert.ok(reason.includes('main working tree'));
        assert.ok(reason.includes('run new-worktree from the main clone'));
        assert.ok(reason.includes(TARGET));
    });

    await test('a symlink refuses even when registered is set', () => {
        const reason = reasonOf(decideManualWorktree(facts({ targetState: 'symlink', registered: registered({}) })));
        assert.ok(reason.includes('symlink'));
    });

    await test('a watcher worktree folder refuses', () => {
        const reason = reasonOf(
            decideManualWorktree(facts({ registered: registered({ folderName: 'alex-pr-watch-comments-pr-7' }) }))
        );
        assert.ok(reason.includes('watcher'));
    });

    await test('a missing registered worktree refuses with a prune hint', () => {
        const reason = reasonOf(decideManualWorktree(facts({ registered: registered({ missing: true }) })));
        assert.ok(reason.includes('git worktree prune'));
    });

    await test('a locked registered worktree refuses', () => {
        const reason = reasonOf(decideManualWorktree(facts({ registered: registered({ locked: true }) })));
        assert.ok(reason.includes('locked'));
    });

    await test('a detached registered worktree refuses', () => {
        const reason = reasonOf(
            decideManualWorktree(facts({ registered: registered({ detached: true, branch: undefined }) }))
        );
        assert.ok(reason.includes('detached'));
    });

    await test('a registered worktree on another branch refuses and names it', () => {
        const reason = reasonOf(decideManualWorktree(facts({ registered: registered({ branch: 'other-branch' }) })));
        assert.ok(reason.includes('other-branch'));
    });

    await test('something present at the target refuses', () => {
        const reason = reasonOf(decideManualWorktree(facts({ targetState: 'present' })));
        assert.ok(reason.includes(`something already exists at ${TARGET}`));
    });

    await test('an unreadable target refuses', () => {
        const reason = reasonOf(decideManualWorktree(facts({ targetState: 'unreadable' })));
        assert.ok(reason.includes(`cannot read ${TARGET}`));
    });

    await test('an unreadable target refuses even when a reusable worktree is registered there', () => {
        const reason = reasonOf(decideManualWorktree(facts({ targetState: 'unreadable', registered: registered({}) })));
        assert.ok(reason.includes(`cannot read ${TARGET}`));
    });

    await test('a watcher folder refuses before the missing check', () => {
        const watcher = registered({ folderName: 'alex-pr-watch-comments-pr-7', missing: true });
        const reason = reasonOf(decideManualWorktree(facts({ registered: watcher })));
        assert.ok(reason.includes('watcher'));
        assert.ok(!reason.includes('git worktree prune'));
    });

    await test('a missing worktree refuses before the locked check', () => {
        const reason = reasonOf(
            decideManualWorktree(facts({ registered: registered({ missing: true, locked: true }) }))
        );
        assert.ok(reason.includes('git worktree prune'));
        assert.ok(!reason.includes('locked'));
    });

    await test('a remote match that does not end with the branch refuses instead of guessing', () => {
        const reason = reasonOf(decideManualWorktree(facts({ remoteMatches: ['origin/feature/y'] })));
        assert.ok(reason.includes('cannot tell the remote of origin/feature/y'));
    });

    await test('a remote whose name contains a slash is tracked by the branch suffix', () => {
        assert.deepEqual(decideManualWorktree(facts({ remoteMatches: [`team/fork/${BRANCH}`] })), {
            kind: 'track',
            remote: 'team/fork',
        });
    });

    await test('a branch held by another worktree refuses and names the holder', () => {
        const holder = path.join(ROOT, 'holder-tree');
        const reason = reasonOf(decideManualWorktree(facts({ holder, localBranch: true })));
        assert.ok(reason.includes(holder));
    });

    await test('--base refuses with reuse, checkout and track', () => {
        const cases = [
            facts({ baseGiven: true, registered: registered({}) }),
            facts({ baseGiven: true, localBranch: true }),
            facts({ baseGiven: true, remoteMatches: [`origin/${BRANCH}`] }),
        ];
        for (const item of cases) {
            assert.ok(reasonOf(decideManualWorktree(item)).includes('--base applies only to a new branch'));
        }
    });

    await test('shown text passes through safeText', () => {
        const reason = reasonOf(decideManualWorktree(facts({ target: `${TARGET}\u001B[31m`, targetState: 'present' })));
        assert.ok(!reason.includes('\u001B'));
    });
});
