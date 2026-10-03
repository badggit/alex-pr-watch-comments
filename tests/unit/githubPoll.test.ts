import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';

import { fetchPrInfo, pollPr } from '../../src/githubPoll.ts';
import { getRecord, getString, isRecord, parseJson } from '../../src/json.ts';
import type { PollComment, PrRef } from '../../src/types.ts';
import { createFakeRunner, type FakeRunner, type RecordedCall } from '../support/fakeRunner.ts';

const FIXTURES = path.join(import.meta.dirname, '..', 'fixtures', 'poll');
const GH = '/opt/fake/bin/gh';
const PR: PrRef = {
    owner: 'owner',
    repo: 'repo',
    number: 7,
    prUrl: 'https://github.com/owner/repo/pull/7',
    prKey: 'owner+repo+7',
};
const RESET_AT = Date.parse('2026-10-02T13:00:00Z') / 1000;
const PAGE1_CURSOR = 'Y3Vyc29yOnYyOpK0MQ==';
const PAGE2_CURSOR = 'Y3Vyc29yOnYyOpK0Mg==';
const OVERFLOW_THREAD = 'PRRT_kwDOAbCdEf5aAAB1';
const OVERFLOW_CURSOR = 'Y3Vyc29yOnYyOpHOAAAAZA==';
const FOLLOW_UP_CURSOR = 'Y3Vyc29yOnYyOpHOAAAAyA==';
const JSON_NULL: unknown = JSON.parse('null');
const GONE_STDERR = "gh: Could not resolve to a node with the global id of 'PRRT_kwDOAbCdEf5aAAA1'\n";

function readFixture(name: string): unknown {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
    return parsed;
}

// Returns a copy of value with the object member at keys replaced.
function withValue(value: unknown, keys: readonly string[], replacement: unknown): unknown {
    const [key, ...rest] = keys;
    if (key === undefined) {
        return replacement;
    }
    if (!isRecord(value)) {
        throw new Error(`fixture member ${key} is not inside an object`);
    }
    return { ...value, [key]: withValue(value[key], rest, replacement) };
}

function requestBody(call: RecordedCall): { query: string; variables: Record<string, unknown> } {
    const body = parseJson(call.input ?? '');
    const query = getString(body, 'query');
    const variables = getRecord(body, 'variables');
    assert.ok(query !== undefined && variables !== undefined, 'request body has a query and variables');
    return { query, variables };
}

function ghCalls(fake: FakeRunner, key: string): RecordedCall[] {
    return fake.calls('gh').filter((call) => call.key === key);
}

function comment(
    threadId: string,
    position: number,
    nodeId: string,
    dbId: number,
    topDbId: number,
    rocket: boolean
): PollComment {
    return { threadId, position, nodeId, dbId, topDbId, rocket };
}

const REPOSITORY = ['data', 'repository'];
const PULL = [...REPOSITORY, 'pullRequest'];

await describe('fetchPrInfo', async () => {
    await test('an open same-repository PR with WRITE can be pushed', async () => {
        const fake = createFakeRunner();
        fake.respond('gh', 'PrwcPrInfo', { json: readFixture('prInfoOpen.json') });
        const result = await fetchPrInfo({ runner: fake.runner }, GH, PR);
        assert.deepEqual(result, {
            kind: 'ok',
            info: {
                viewer: 'reviewer',
                state: 'OPEN',
                headRef: 'feature/fix-parser',
                headOwner: 'owner',
                headRepo: 'repo',
                isCross: false,
                canPush: true,
            },
        });
        const [call] = ghCalls(fake, 'PrwcPrInfo');
        assert.ok(call);
        assert.equal(call.file, GH);
        const body = requestBody(call);
        assert.deepEqual(body.variables, { owner: 'owner', repo: 'repo', number: 7 });
        assert.ok(body.query.includes('rateLimit { remaining resetAt }'));
    });

    await test('a fork with READ on head, maintainerCanModify and WRITE on base can be pushed', async () => {
        const fake = createFakeRunner();
        fake.respond('gh', 'PrwcPrInfo', { json: readFixture('prInfoFork.json') });
        const result = await fetchPrInfo({ runner: fake.runner }, GH, PR);
        assert.ok(result.kind === 'ok');
        assert.equal(result.info.isCross, true);
        assert.equal(result.info.canPush, true);
        assert.equal(result.info.headOwner, 'contributor');
        assert.equal(result.info.headRepo, 'repo-fork');
    });

    await test('a fork without maintainerCanModify cannot be pushed', async () => {
        const fake = createFakeRunner();
        const fixture = withValue(readFixture('prInfoFork.json'), [...PULL, 'maintainerCanModify'], false);
        fake.respond('gh', 'PrwcPrInfo', { json: fixture });
        const result = await fetchPrInfo({ runner: fake.runner }, GH, PR);
        assert.ok(result.kind === 'ok');
        assert.equal(result.info.canPush, false);
    });

    await test('a fork with only READ on base cannot be pushed', async () => {
        const fake = createFakeRunner();
        const fixture = withValue(
            readFixture('prInfoFork.json'),
            [...PULL, 'baseRepository', 'viewerPermission'],
            'READ'
        );
        fake.respond('gh', 'PrwcPrInfo', { json: fixture });
        const result = await fetchPrInfo({ runner: fake.runner }, GH, PR);
        assert.ok(result.kind === 'ok');
        assert.equal(result.info.canPush, false);
    });

    await test('a response without pullRequest is transient', async () => {
        const fake = createFakeRunner();
        fake.respond('gh', 'PrwcPrInfo', { json: withValue(readFixture('prInfoOpen.json'), REPOSITORY, {}) });
        const result = await fetchPrInfo({ runner: fake.runner }, GH, PR);
        assert.deepEqual(result, { kind: 'transient', message: 'unexpected PrwcPrInfo response' });
    });

    await test('a mistyped field is transient', async () => {
        const fake = createFakeRunner();
        const fixture = withValue(readFixture('prInfoOpen.json'), [...PULL, 'isCrossRepository'], 'no');
        fake.respond('gh', 'PrwcPrInfo', { json: fixture });
        const result = await fetchPrInfo({ runner: fake.runner }, GH, PR);
        assert.deepEqual(result, { kind: 'transient', message: 'unexpected PrwcPrInfo response' });
    });

    await test('a deleted head repository is transient with its own message', async () => {
        const fake = createFakeRunner();
        const fixture = withValue(readFixture('prInfoFork.json'), [...PULL, 'headRepository'], JSON_NULL);
        fake.respond('gh', 'PrwcPrInfo', { json: fixture });
        const result = await fetchPrInfo({ runner: fake.runner }, GH, PR);
        assert.deepEqual(result, { kind: 'transient', message: 'head repository deleted' });
    });

    await test('the head owner and repository are lowercased', async () => {
        const fake = createFakeRunner();
        fake.respond('gh', 'PrwcPrInfo', { json: readFixture('prInfoMixedCase.json') });
        const result = await fetchPrInfo({ runner: fake.runner }, GH, PR);
        assert.ok(result.kind === 'ok');
        assert.equal(result.info.headOwner, 'owner');
        assert.equal(result.info.headRepo, 'repo');
        assert.equal(result.info.canPush, true);
    });

    await test('an authentication failure is returned as auth', async () => {
        const fake = createFakeRunner();
        fake.respond('gh', 'PrwcPrInfo', { code: 1, stderr: 'HTTP 401: Bad credentials\n' });
        const result = await fetchPrInfo({ runner: fake.runner }, GH, PR);
        assert.equal(result.kind, 'auth');
    });
});

await describe('pollPr pages', async () => {
    await test('two thread pages give one comment per comment with thread positions', async () => {
        const fake = createFakeRunner();
        fake.respond('gh', 'PrwcPoll', { json: readFixture('pollPage1.json') });
        fake.respond('gh', 'PrwcPoll', { json: readFixture('pollPage2.json') });
        const result = await pollPr({ runner: fake.runner }, GH, PR);
        assert.ok(result.kind === 'ok');
        assert.deepEqual(result.result.comments, [
            comment('PRRT_kwDOAbCdEf5aAAA1', 0, 'PRRC_kwDOAbCdEf6AAAA1', 2_101_000_001, 2_101_000_001, true),
            comment('PRRT_kwDOAbCdEf5aAAA1', 1, 'PRRC_kwDOAbCdEf6AAAA2', 2_101_000_002, 2_101_000_001, false),
            comment('PRRT_kwDOAbCdEf5aAAA2', 0, 'PRRC_kwDOAbCdEf6AAAA3', 2_101_000_003, 2_101_000_003, false),
            comment('PRRT_kwDOAbCdEf5aAAA3', 0, 'PRRC_kwDOAbCdEf6AAAA4', 2_101_000_004, 2_101_000_004, false),
            comment('PRRT_kwDOAbCdEf5aAAA3', 1, 'PRRC_kwDOAbCdEf6AAAA5', 2_101_000_005, 2_101_000_004, true),
        ]);
        assert.equal(result.result.viewer, 'reviewer');
        assert.equal(result.result.headRef, 'feature/fix-parser');
        assert.equal(fake.calls().length, 2);
    });

    await test('the first page carries no endCursor and the second carries page 1 endCursor', async () => {
        const fake = createFakeRunner();
        fake.respond('gh', 'PrwcPoll', { json: readFixture('pollPage1.json') });
        fake.respond('gh', 'PrwcPoll', { json: readFixture('pollPage2.json') });
        await pollPr({ runner: fake.runner }, GH, PR);
        const calls = ghCalls(fake, 'PrwcPoll');
        assert.equal(calls.length, 2);
        const [first, second] = calls.map((call) => requestBody(call).variables);
        assert.deepEqual(first, { owner: 'owner', repo: 'repo', number: 7 });
        assert.deepEqual(second, { owner: 'owner', repo: 'repo', number: 7, endCursor: PAGE1_CURSOR });
    });

    await test('rate and PR state come from the last page', async () => {
        const fake = createFakeRunner();
        fake.respond('gh', 'PrwcPoll', { json: readFixture('pollPage1.json') });
        fake.respond('gh', 'PrwcPoll', {
            json: withValue(readFixture('pollPage2.json'), [...PULL, 'state'], 'MERGED'),
        });
        const result = await pollPr({ runner: fake.runner }, GH, PR);
        assert.ok(result.kind === 'ok');
        assert.equal(result.result.prState, 'MERGED');
        assert.deepEqual(result.result.rate, { remaining: 4997, resetAt: RESET_AT });
    });

    await test('a closed PR is reported with its comments', async () => {
        const fake = createFakeRunner();
        fake.respond('gh', 'PrwcPoll', { json: readFixture('pollClosed.json') });
        const result = await pollPr({ runner: fake.runner }, GH, PR);
        assert.ok(result.kind === 'ok');
        assert.equal(result.result.prState, 'CLOSED');
        assert.equal(result.result.comments.length, 1);
        assert.deepEqual(result.result.rate, { remaining: 4990, resetAt: RESET_AT });
    });

    await test('rocket is true only where the viewer reacted with ROCKET', async () => {
        const othersOnly = {
            data: {
                viewer: { login: 'reviewer' },
                rateLimit: { remaining: 4900, resetAt: '2026-10-02T13:00:00Z' },
                repository: {
                    pullRequest: {
                        state: 'OPEN',
                        headRefName: 'feature/fix-parser',
                        reviewThreads: {
                            pageInfo: { hasNextPage: false, endCursor: PAGE1_CURSOR },
                            nodes: [
                                {
                                    id: 'PRRT_kwDOAbCdEf5aAAC1',
                                    comments: {
                                        pageInfo: { hasNextPage: false, endCursor: 'Y3Vyc29yOnYyOpHOAAAAAQ==' },
                                        nodes: [
                                            {
                                                id: 'PRRC_kwDOAbCdEf6AAAC1',
                                                databaseId: 2_103_000_001,
                                                reactionGroups: [
                                                    { content: 'THUMBS_UP', viewerHasReacted: true },
                                                    { content: 'THUMBS_DOWN', viewerHasReacted: false },
                                                    { content: 'LAUGH', viewerHasReacted: false },
                                                    { content: 'HOORAY', viewerHasReacted: false },
                                                    { content: 'CONFUSED', viewerHasReacted: false },
                                                    { content: 'HEART', viewerHasReacted: false },
                                                    // Other users rocketed this comment, the viewer did not.
                                                    {
                                                        content: 'ROCKET',
                                                        viewerHasReacted: false,
                                                        reactors: { totalCount: 3 },
                                                    },
                                                    { content: 'EYES', viewerHasReacted: true },
                                                ],
                                            },
                                        ],
                                    },
                                },
                            ],
                        },
                    },
                },
            },
        };
        const fake = createFakeRunner();
        fake.respond('gh', 'PrwcPoll', { json: othersOnly });
        const result = await pollPr({ runner: fake.runner }, GH, PR);
        assert.ok(result.kind === 'ok');
        assert.deepEqual(
            result.result.comments.map((item) => item.rocket),
            [false]
        );
    });

    await test('a page that repeats the previous endCursor is transient and makes no further call', async () => {
        const fake = createFakeRunner();
        fake.respond('gh', 'PrwcPoll', { json: readFixture('pollPage1.json') });
        fake.respond('gh', 'PrwcPoll', {
            json: withValue(readFixture('pollPage2.json'), [...PULL, 'reviewThreads', 'pageInfo'], {
                hasNextPage: true,
                endCursor: PAGE1_CURSOR,
            }),
        });
        const result = await pollPr({ runner: fake.runner }, GH, PR);
        assert.equal(result.kind, 'transient');
        assert.equal(fake.callCount('gh', 'PrwcPoll'), 2);
        assert.equal(fake.calls().length, 2);
    });

    await test('a cursor cycle across thread pages is transient and makes no further call', async () => {
        const fake = createFakeRunner();
        fake.respond('gh', 'PrwcPoll', { json: readFixture('pollPage1.json') });
        fake.respond('gh', 'PrwcPoll', {
            json: withValue(readFixture('pollPage2.json'), [...PULL, 'reviewThreads', 'pageInfo'], {
                hasNextPage: true,
                endCursor: PAGE2_CURSOR,
            }),
        });
        fake.respond('gh', 'PrwcPoll', {
            json: withValue(readFixture('pollPage2.json'), [...PULL, 'reviewThreads', 'pageInfo'], {
                hasNextPage: true,
                endCursor: PAGE1_CURSOR,
            }),
        });
        const result = await pollPr({ runner: fake.runner }, GH, PR);
        assert.equal(result.kind, 'transient');
        const variables = ghCalls(fake, 'PrwcPoll').map((call) => requestBody(call).variables.endCursor);
        assert.deepEqual(variables, [undefined, PAGE1_CURSOR, PAGE2_CURSOR]);
        assert.equal(fake.calls().length, 3);
    });

    await test('a response without pullRequest is transient and carries its own rate', async () => {
        const fake = createFakeRunner();
        fake.respond('gh', 'PrwcPoll', { json: withValue(readFixture('pollPage1.json'), REPOSITORY, {}) });
        const result = await pollPr({ runner: fake.runner }, GH, PR);
        assert.deepEqual(result, {
            kind: 'transient',
            message: 'unexpected PrwcPoll response',
            rate: { remaining: 4998, resetAt: RESET_AT },
        });
    });

    await test('a malformed later page carries its own newer rate', async () => {
        const fake = createFakeRunner();
        fake.respond('gh', 'PrwcPoll', {
            json: withValue(readFixture('pollPage1.json'), ['data', 'rateLimit', 'remaining'], 4000),
        });
        const malformed = withValue(readFixture('pollPage2.json'), REPOSITORY, {});
        fake.respond('gh', 'PrwcPoll', { json: withValue(malformed, ['data', 'rateLimit', 'remaining'], 9) });
        const result = await pollPr({ runner: fake.runner }, GH, PR);
        assert.deepEqual(result, {
            kind: 'transient',
            message: 'unexpected PrwcPoll response',
            rate: { remaining: 9, resetAt: RESET_AT },
        });
    });

    await test('a malformed later page without a rate keeps the previous rate', async () => {
        const fake = createFakeRunner();
        fake.respond('gh', 'PrwcPoll', {
            json: withValue(readFixture('pollPage1.json'), ['data', 'rateLimit', 'remaining'], 4000),
        });
        fake.respond('gh', 'PrwcPoll', { json: { data: JSON_NULL } });
        const result = await pollPr({ runner: fake.runner }, GH, PR);
        assert.deepEqual(result, {
            kind: 'transient',
            message: 'unexpected PrwcPoll response',
            rate: { remaining: 4000, resetAt: RESET_AT },
        });
    });
});

await describe('pollPr thread overflow', async () => {
    await test('a thread with more comments is continued with one PrwcThreadComments call', async () => {
        const fake = createFakeRunner();
        fake.respond('gh', 'PrwcPoll', { json: readFixture('threadOverflow.json') });
        fake.respond('gh', 'PrwcThreadComments', { json: readFixture('threadComments2.json') });
        const result = await pollPr({ runner: fake.runner }, GH, PR);
        assert.ok(result.kind === 'ok');
        const followUps = ghCalls(fake, 'PrwcThreadComments');
        assert.equal(followUps.length, 1);
        const [followUp] = followUps;
        assert.ok(followUp);
        assert.deepEqual(requestBody(followUp).variables, { id: OVERFLOW_THREAD, endCursor: OVERFLOW_CURSOR });
        assert.deepEqual(result.result.comments, [
            comment(OVERFLOW_THREAD, 0, 'PRRC_kwDOAbCdEf6AAAB1', 2_102_000_001, 2_102_000_001, false),
            comment(OVERFLOW_THREAD, 1, 'PRRC_kwDOAbCdEf6AAAB2', 2_102_000_002, 2_102_000_001, true),
            comment(OVERFLOW_THREAD, 2, 'PRRC_kwDOAbCdEf6AAAB3', 2_102_000_003, 2_102_000_001, true),
            comment(OVERFLOW_THREAD, 3, 'PRRC_kwDOAbCdEf6AAAB4', 2_102_000_004, 2_102_000_001, false),
            comment('PRRT_kwDOAbCdEf5aAAB2', 0, 'PRRC_kwDOAbCdEf6AAAB5', 2_102_000_005, 2_102_000_005, false),
        ]);
        const dbIds = result.result.comments.map((item) => item.dbId);
        assert.equal(new Set(dbIds).size, dbIds.length);
    });

    await test('the rate of a successful follow-up is the newest rate', async () => {
        const fake = createFakeRunner();
        fake.respond('gh', 'PrwcPoll', { json: readFixture('threadOverflow.json') });
        fake.respond('gh', 'PrwcThreadComments', { json: readFixture('threadComments2.json') });
        const result = await pollPr({ runner: fake.runner }, GH, PR);
        assert.ok(result.kind === 'ok');
        assert.deepEqual(result.result.rate, { remaining: 100, resetAt: RESET_AT });
    });

    await test('a failing follow-up is transient and carries the poll page rate', async () => {
        const fake = createFakeRunner();
        fake.respond('gh', 'PrwcPoll', { json: readFixture('threadOverflow.json') });
        fake.respond('gh', 'PrwcThreadComments', { code: 1, stderr: 'connection reset\n' });
        const result = await pollPr({ runner: fake.runner }, GH, PR);
        assert.deepEqual(result, {
            kind: 'transient',
            message: 'connection reset',
            rate: { remaining: 4000, resetAt: RESET_AT },
        });
    });

    await test('a gone thread in the follow-up is transient', async () => {
        const fake = createFakeRunner();
        fake.respond('gh', 'PrwcPoll', { json: readFixture('threadOverflow.json') });
        fake.respond('gh', 'PrwcThreadComments', { code: 1, stderr: GONE_STDERR });
        const result = await pollPr({ runner: fake.runner }, GH, PR);
        assert.equal(result.kind, 'transient');
    });

    await test('a follow-up page that repeats its cursor is transient and makes no further call', async () => {
        const fake = createFakeRunner();
        fake.respond('gh', 'PrwcPoll', { json: readFixture('threadOverflow.json') });
        fake.respond('gh', 'PrwcThreadComments', {
            json: withValue(readFixture('threadComments2.json'), ['data', 'node', 'comments', 'pageInfo'], {
                hasNextPage: true,
                endCursor: OVERFLOW_CURSOR,
            }),
        });
        const result = await pollPr({ runner: fake.runner }, GH, PR);
        assert.equal(result.kind, 'transient');
        assert.equal(fake.callCount('gh', 'PrwcThreadComments'), 1);
    });

    await test('a cursor cycle across follow-up pages is transient and makes no further call', async () => {
        const fake = createFakeRunner();
        const pageInfo = ['data', 'node', 'comments', 'pageInfo'];
        fake.respond('gh', 'PrwcPoll', { json: readFixture('threadOverflow.json') });
        fake.respond('gh', 'PrwcThreadComments', {
            json: withValue(readFixture('threadComments2.json'), pageInfo, {
                hasNextPage: true,
                endCursor: FOLLOW_UP_CURSOR,
            }),
        });
        fake.respond('gh', 'PrwcThreadComments', {
            json: withValue(readFixture('threadComments2.json'), pageInfo, {
                hasNextPage: true,
                endCursor: OVERFLOW_CURSOR,
            }),
        });
        const result = await pollPr({ runner: fake.runner }, GH, PR);
        assert.equal(result.kind, 'transient');
        const cursors = ghCalls(fake, 'PrwcThreadComments').map((call) => requestBody(call).variables.endCursor);
        assert.deepEqual(cursors, [OVERFLOW_CURSOR, FOLLOW_UP_CURSOR]);
        assert.equal(fake.calls().length, 3);
    });
});

await describe('pollPr failures', async () => {
    await test('a failed call is transient and its stdout is never decoded', async () => {
        const fake = createFakeRunner();
        fake.respond('gh', 'PrwcPoll', {
            code: 1,
            stderr: 'connection reset\n',
            json: readFixture('pollPage1.json'),
        });
        const result = await pollPr({ runner: fake.runner }, GH, PR);
        assert.deepEqual(result, { kind: 'transient', message: 'connection reset' });
        assert.equal(fake.calls().length, 1);
    });

    await test('HTTP 401 is auth', async () => {
        const fake = createFakeRunner();
        fake.respond('gh', 'PrwcPoll', { code: 1, stderr: 'HTTP 401: Bad credentials\n' });
        const result = await pollPr({ runner: fake.runner }, GH, PR);
        assert.equal(result.kind, 'auth');
    });

    await test('a gone failure is transient for the poll', async () => {
        const fake = createFakeRunner();
        fake.respond('gh', 'PrwcPoll', { code: 1, stderr: GONE_STDERR });
        const result = await pollPr({ runner: fake.runner }, GH, PR);
        assert.equal(result.kind, 'transient');
    });

    await test('a failing second page carries the rate of the first page', async () => {
        const fake = createFakeRunner();
        fake.respond('gh', 'PrwcPoll', {
            json: withValue(readFixture('pollPage1.json'), ['data', 'rateLimit', 'remaining'], 300),
        });
        fake.respond('gh', 'PrwcPoll', { code: 1, stderr: 'connection reset\n' });
        const result = await pollPr({ runner: fake.runner }, GH, PR);
        assert.ok(result.kind === 'transient');
        assert.deepEqual(result.rate, { remaining: 300, resetAt: RESET_AT });
    });
});

await describe('pollPr query text', async () => {
    await test('poll and follow-up queries select no reactions or bodies and select rateLimit', async () => {
        const fake = createFakeRunner();
        fake.respond('gh', 'PrwcPoll', { json: readFixture('threadOverflow.json') });
        fake.respond('gh', 'PrwcThreadComments', { json: readFixture('threadComments2.json') });
        await pollPr({ runner: fake.runner }, GH, PR);
        const calls = [...ghCalls(fake, 'PrwcPoll'), ...ghCalls(fake, 'PrwcThreadComments')];
        assert.equal(calls.length, 2);
        for (const call of calls) {
            const { query } = requestBody(call);
            assert.ok(!query.includes('reactions('), call.key);
            assert.ok(!query.includes('body'), call.key);
            assert.match(query, /\$endCursor: String(?!!)/u, call.key);
            assert.ok(query.includes('rateLimit { remaining resetAt }'), call.key);
        }
    });
});
