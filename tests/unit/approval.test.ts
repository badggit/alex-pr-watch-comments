import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, test } from 'node:test';

import {
    approvalFloors,
    clearPermissionCache,
    lookupApproved,
    readConsumed,
    recordConsumed,
} from '../../src/approval.ts';
import type { LookupEntry, LookupResult, RunComment, Session } from '../../src/types.ts';
import { createFakeRunner, type FakeRunner } from '../support/fakeRunner.ts';

interface NodeSpec {
    rockets?: readonly { login: string; at: number }[];
    plus1At?: number;
    minus1?: boolean;
    author?: string;
}

const NOW = 1_800_000_000;
const VIEWER = 'me';
const NODE_ID = 'PRRC_a';
const RESET_AT = '2027-01-15T09:00:00Z';
const NEVER_EDITED: unknown = JSON.parse('null');
const NOT_FOUND = { code: 1, stderr: 'gh: Not Found (HTTP 404)\n' };
const BAD_GATEWAY = { code: 1, stderr: 'HTTP 502: Bad Gateway\n' };
const WRITE = { json: { permission: 'write', role_name: 'write' } };
const READ = { json: { permission: 'read', role_name: 'triage' } };

function iso(epoch: number): string {
    return new Date(epoch * 1000).toISOString();
}

function permissionKey(login: string): string {
    return `api_repos/o/r/collaborators/${login}/permission`;
}

function connection(nodes: readonly { login: string; at: number }[]): unknown {
    return {
        pageInfo: { hasNextPage: false, endCursor: 'C1' },
        nodes: nodes.map((item) => ({ createdAt: iso(item.at), user: { login: item.login } })),
    };
}

function lookupJson(spec: NodeSpec): unknown {
    const plus = spec.plus1At === undefined ? [] : [{ login: VIEWER, at: spec.plus1At }];
    const node = {
        id: NODE_ID,
        databaseId: 7,
        url: 'https://github.com/o/r/pull/12#discussion_r7',
        lastEditedAt: NEVER_EDITED,
        body: 'rename this',
        path: 'src/a.ts',
        line: 3,
        author: { login: spec.author ?? 'reviewer' },
        rocket: connection(spec.rockets ?? []),
        plus: connection(plus),
        reactionGroups: [
            { content: 'ROCKET', viewerHasReacted: (spec.rockets ?? []).some((item) => item.login === VIEWER) },
            { content: 'THUMBS_UP', viewerHasReacted: spec.plus1At !== undefined },
            { content: 'THUMBS_DOWN', viewerHasReacted: spec.minus1 === true },
            { content: 'EYES', viewerHasReacted: false },
        ],
    };
    return { data: { viewer: { login: VIEWER }, rateLimit: { remaining: 4000, resetAt: RESET_AT }, nodes: [node] } };
}

function minusPage(at: number): unknown {
    const reactions = connection([{ login: VIEWER, at }]);
    return { data: { rateLimit: { remaining: 3990, resetAt: RESET_AT }, node: { reactions } } };
}

function session(stateDir = '/path/to/state'): Session {
    return {
        pr: {
            host: 'github.com',
            owner: 'o',
            repo: 'r',
            number: 12,
            prUrl: 'https://github.com/o/r/pull/12',
            prKey: 'o+r+12',
        },
        viewer: VIEWER,
        headRef: 'feature',
        headOwner: 'o',
        headRepo: 'r',
        remote: 'origin',
        dirCanon: '/path/to/project',
        toplevel: '/path/to/project',
        worktreeKey: 'key',
        tools: { node: 'node', git: 'git', gh: '/opt/fake/bin/gh', tmux: 'tmux', claude: 'claude' },
        callerPath: '',
        ghEnv: [],
        tmux: { socket: '', pane: '%1', sessionId: '$1', windowId: '@1' },
        stateDir,
        interval: 15,
        keepPanes: 5,
        batchMax: 5,
        claudeArgs: [],
        once: false,
    };
}

function deps(fake: FakeRunner): { runner: FakeRunner['runner']; nowSeconds: () => number } {
    return { runner: fake.runner, nowSeconds: () => NOW };
}

async function lookup(fake: FakeRunner, spec: NodeSpec, floors?: Map<string, number>): Promise<LookupResult> {
    fake.respond('gh', 'PrwcLookup', { json: lookupJson(spec) });
    const result = await lookupApproved(deps(fake), session(), [NODE_ID], floors);
    assert.equal(result.kind, 'ok');
    assert.ok('result' in result);
    return result.result;
}

function onlyEntry(result: LookupResult): LookupEntry {
    const [entry] = result.entries;
    assert.ok(entry !== undefined);
    return entry;
}

function permissionCalls(fake: FakeRunner): number {
    return fake.calls('gh').filter((call) => call.key.startsWith('api_repos/')).length;
}

await describe('lookupApproved', async () => {
    beforeEach(() => {
        clearPermissionCache();
    });

    await test('a rocket of a user with write access approves the comment', async () => {
        const fake = createFakeRunner();
        fake.respond('gh', permissionKey('carol'), WRITE);
        const entry = onlyEntry(await lookup(fake, { rockets: [{ login: 'carol', at: NOW - 50 }] }));
        assert.equal(entry.rocketAt, NOW - 50);
        assert.equal(entry.othersRocketAt, NOW - 50);
        assert.equal(entry.viewerRocketAt, undefined);
        const call = fake.calls('gh').find((item) => item.key === permissionKey('carol'));
        assert.deepEqual(call?.args, ['api', 'repos/o/r/collaborators/carol/permission', '--hostname', 'github.com']);
    });

    await test('the comment author with push access may approve their own comment', async () => {
        const fake = createFakeRunner();
        fake.respond('gh', permissionKey('reviewer'), { json: { permission: 'admin', role_name: 'admin' } });
        const spec = { author: 'reviewer', rockets: [{ login: 'reviewer', at: NOW - 30 }] };
        assert.equal(onlyEntry(await lookup(fake, spec)).rocketAt, NOW - 30);
    });

    await test('a maintain role counts as push access', async () => {
        const fake = createFakeRunner();
        fake.respond('gh', permissionKey('dave'), { json: { permission: 'write', role_name: 'maintain' } });
        assert.equal(onlyEntry(await lookup(fake, { rockets: [{ login: 'dave', at: NOW - 5 }] })).rocketAt, NOW - 5);
    });

    await test('rockets of users without push access are ignored', async () => {
        const fake = createFakeRunner();
        fake.respond('gh', permissionKey('eve'), READ);
        fake.respond('gh', permissionKey('mallory'), NOT_FOUND);
        const spec = {
            rockets: [
                { login: 'eve', at: NOW - 10 },
                { login: 'mallory', at: NOW - 20 },
            ],
        };
        const entry = onlyEntry(await lookup(fake, spec));
        assert.equal(entry.rocketAt, undefined);
        assert.equal(entry.othersRocketAt, undefined);
    });

    await test('the newest rocket with push access wins and the older ones are not checked', async () => {
        const fake = createFakeRunner();
        fake.respond('gh', permissionKey('eve'), READ);
        fake.respond('gh', permissionKey('carol'), WRITE);
        const spec = {
            rockets: [
                { login: 'bob', at: NOW - 90 },
                { login: 'carol', at: NOW - 40 },
                { login: 'eve', at: NOW - 10 },
            ],
        };
        assert.equal(onlyEntry(await lookup(fake, spec)).rocketAt, NOW - 40);
        assert.equal(fake.callCount('gh', permissionKey('bob')), 0);
    });

    await test('the viewer rocket and a newer rocket of another user give the newer time', async () => {
        const fake = createFakeRunner();
        fake.respond('gh', permissionKey('carol'), WRITE);
        const spec = {
            rockets: [
                { login: VIEWER, at: NOW - 100 },
                { login: 'carol', at: NOW - 10 },
            ],
        };
        const entry = onlyEntry(await lookup(fake, spec));
        assert.equal(entry.viewerRocketAt, NOW - 100);
        assert.equal(entry.rocketAt, NOW - 10);
    });

    await test('a permission answer is cached, also a 404', async () => {
        const fake = createFakeRunner();
        fake.respond('gh', permissionKey('mallory'), NOT_FOUND);
        const spec = { rockets: [{ login: 'mallory', at: NOW - 10 }] };
        await lookup(fake, spec);
        await lookup(fake, spec);
        assert.equal(permissionCalls(fake), 1);
    });

    await test('a failed permission check fails the lookup and is not cached', async () => {
        const fake = createFakeRunner();
        fake.respond('gh', 'PrwcLookup', { json: lookupJson({ rockets: [{ login: 'carol', at: NOW - 10 }] }) });
        fake.respond('gh', permissionKey('carol'), BAD_GATEWAY);
        const failed = await lookupApproved(deps(fake), session(), [NODE_ID]);
        assert.equal(failed.kind, 'transient');
        assert.equal(failed.kind === 'transient' ? failed.rate?.remaining : undefined, 4000);
        fake.respond('gh', permissionKey('carol'), WRITE);
        assert.equal(onlyEntry(await lookup(fake, { rockets: [{ login: 'carol', at: NOW - 10 }] })).rocketAt, NOW - 10);
    });

    await test('a rocket not newer than the viewer +1 was consumed and needs no permission check', async () => {
        const fake = createFakeRunner();
        const spec = { rockets: [{ login: 'carol', at: NOW - 60 }], plus1At: NOW - 60 };
        assert.equal(onlyEntry(await lookup(fake, spec)).rocketAt, undefined);
        assert.equal(permissionCalls(fake), 0);
    });

    await test('a rocket not newer than the floor of a run in flight does not count', async () => {
        const fake = createFakeRunner();
        fake.respond('gh', permissionKey('carol'), WRITE);
        const spec = { rockets: [{ login: 'carol', at: NOW - 60 }] };
        assert.equal(onlyEntry(await lookup(fake, spec, new Map([[NODE_ID, NOW - 60]]))).rocketAt, undefined);
        assert.equal(onlyEntry(await lookup(fake, spec, new Map([[NODE_ID, NOW - 61]]))).rocketAt, NOW - 60);
    });

    await test('a viewer -1 consumes older rockets and is read only when needed', async () => {
        const fake = createFakeRunner();
        fake.respond('gh', permissionKey('carol'), WRITE);
        fake.respond('gh', 'PrwcReactions', { json: minusPage(NOW - 30) });
        fake.respond('gh', 'PrwcReactions', { json: minusPage(NOW - 30) });
        const older = { rockets: [{ login: 'carol', at: NOW - 40 }], minus1: true };
        assert.equal(onlyEntry(await lookup(fake, older)).rocketAt, undefined);
        const newer = { rockets: [{ login: 'carol', at: NOW - 20 }], minus1: true };
        assert.equal(onlyEntry(await lookup(fake, newer)).rocketAt, NOW - 20);
        assert.equal(fake.callCount('gh', 'PrwcReactions'), 2);
        await lookup(fake, { minus1: true });
        assert.equal(fake.callCount('gh', 'PrwcReactions'), 2);
    });

    await test('a bot login never counts and is never checked', async () => {
        const fake = createFakeRunner();
        const entry = onlyEntry(await lookup(fake, { rockets: [{ login: 'helper[bot]', at: NOW - 10 }] }));
        assert.equal(entry.rocketAt, undefined);
        assert.equal(permissionCalls(fake), 0);
    });
});

await describe('consumed approvals', async () => {
    await test('a rocket not newer than its recorded dispatch never counts again', async (t) => {
        clearPermissionCache();
        const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prwc-consumed-'));
        t.after(() => {
            fs.rmSync(stateDir, { recursive: true, force: true });
        });
        const comment: RunComment = {
            nodeId: NODE_ID,
            dbId: 7,
            url: '',
            threadId: 'T',
            topDbId: 7,
            rocketAt: NOW - 60,
            eyesAdded: false,
        };
        recordConsumed(stateDir, 'o+r+12', [comment]);
        recordConsumed(stateDir, 'o+r+12', [{ ...comment, rocketAt: NOW - 90 }]);
        assert.deepEqual(readConsumed(stateDir, 'o+r+12'), new Map([[NODE_ID, NOW - 60]]));
        const fake = createFakeRunner();
        fake.respond('gh', permissionKey('carol'), WRITE);
        const run = async (at: number): Promise<number | undefined> => {
            fake.respond('gh', 'PrwcLookup', { json: lookupJson({ rockets: [{ login: 'carol', at }] }) });
            const result = await lookupApproved(deps(fake), session(stateDir), [NODE_ID]);
            assert.ok(result.kind === 'ok');
            return result.result.entries[0]?.rocketAt;
        };
        assert.equal(await run(NOW - 60), undefined);
        assert.equal(await run(NOW - 10), NOW - 10);
    });

    await test('a missing or malformed file reads as empty', (t) => {
        const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prwc-consumed-'));
        t.after(() => {
            fs.rmSync(stateDir, { recursive: true, force: true });
        });
        assert.deepEqual(readConsumed(stateDir, 'o+r+12'), new Map());
        fs.mkdirSync(path.join(stateDir, 'watchers', 'o+r+12'), { recursive: true });
        fs.writeFileSync(path.join(stateDir, 'watchers', 'o+r+12', 'consumed.json'), '[1, 2]');
        assert.deepEqual(readConsumed(stateDir, 'o+r+12'), new Map());
    });
});

await describe('approvalFloors', async () => {
    await test('maps every comment of the run to its approval time', () => {
        const comment = (nodeId: string, rocketAt: number): RunComment => ({
            nodeId,
            dbId: 1,
            url: '',
            threadId: 'T',
            topDbId: 1,
            rocketAt,
            eyesAdded: true,
        });
        assert.deepEqual(
            approvalFloors([comment('PRRC_a', 10), comment('PRRC_b', 20)]),
            new Map([
                ['PRRC_a', 10],
                ['PRRC_b', 20],
            ])
        );
    });
});
