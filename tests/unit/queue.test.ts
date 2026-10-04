import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { buildQueue, lookupIds } from '../../src/queue.ts';
import type { Logger, LookupEntry, LookupResult, PollComment, PollResult } from '../../src/types.ts';

interface RecordingLogger extends Logger {
    lines: string[];
}

function recordingLogger(): RecordingLogger {
    const lines: string[] = [];
    return {
        lines,
        info: (message) => {
            lines.push(message);
        },
        warn: (message) => {
            lines.push(message);
        },
        error: (message) => {
            lines.push(message);
        },
    };
}

function comment(dbId: number, rocket = true): PollComment {
    return { threadId: `PRRT_${dbId}`, position: 0, nodeId: `PRRC_${dbId}`, dbId, topDbId: dbId, rocket };
}

function poll(comments: PollComment[]): PollResult {
    return {
        prState: 'OPEN',
        viewer: 'me',
        headRef: 'feature',
        rate: { remaining: 4000, resetAt: undefined },
        comments,
    };
}

function entry(dbId: number, rocketAt?: number, editedAt?: number): LookupEntry {
    return {
        nodeId: `PRRC_${dbId}`,
        dbId,
        rocketAt,
        plus1At: undefined,
        eyes: false,
        minus1: false,
        editedAt,
        url: `https://github.com/OWNER/REPO/pull/1#discussion_r${dbId}`,
        author: 'reviewer',
        path: 'src/a.ts',
        line: 1,
        body: 'text',
    };
}

function lookup(entries: LookupEntry[]): LookupResult {
    return { rate: { remaining: 4000, resetAt: undefined }, entries, gone: [] };
}

await describe('lookupIds', async () => {
    await test('rocketed comments plus the in-flight node', () => {
        const result = lookupIds(poll([comment(1), comment(2, false), comment(3)]), ['PRRC_9']);
        assert.deepEqual(result, ['PRRC_1', 'PRRC_3', 'PRRC_9']);
    });

    await test('no rockets and no in-flight node give no ids', () => {
        assert.deepEqual(lookupIds(poll([comment(1, false)])), []);
    });

    await test('an in-flight node that is also rocketed appears once', () => {
        assert.deepEqual(lookupIds(poll([comment(1), comment(2)]), ['PRRC_2']), ['PRRC_1', 'PRRC_2']);
    });
});

await describe('buildQueue', async () => {
    await test('candidates come out in approval order', () => {
        const log = recordingLogger();
        const result = buildQueue(
            poll([comment(1), comment(2), comment(3)]),
            lookup([entry(1, 30), entry(2, 10), entry(3, 20)]),
            [],
            log
        );
        assert.deepEqual(
            result.candidates.map((candidate) => candidate.entry.rocketAt),
            [10, 20, 30]
        );
        assert.deepEqual(
            result.candidates.map((candidate) => candidate.poll.dbId),
            [2, 3, 1]
        );
        assert.deepEqual(result.edited, []);
        assert.deepEqual(result.skippedDbIds, []);
        assert.deepEqual(log.lines, []);
    });

    await test('equal rocket times are ordered by database id', () => {
        const result = buildQueue(
            poll([comment(5), comment(3), comment(4)]),
            lookup([entry(5, 10), entry(3, 10), entry(4, 5)]),
            [],
            recordingLogger()
        );
        assert.deepEqual(
            result.candidates.map((candidate) => candidate.poll.dbId),
            [4, 3, 5]
        );
    });

    await test('an edit at the rocket time is refused, an earlier edit is accepted', () => {
        const result = buildQueue(
            poll([comment(1), comment(2)]),
            lookup([entry(1, 50, 50), entry(2, 60, 59)]),
            [],
            recordingLogger()
        );
        assert.deepEqual(
            result.edited.map((item) => item.dbId),
            [1]
        );
        assert.deepEqual(
            result.candidates.map((candidate) => candidate.poll.dbId),
            [2]
        );
    });

    await test('the oldest approved comment edited after its rocket is never a candidate', () => {
        const result = buildQueue(
            poll([comment(1), comment(2), comment(3)]),
            lookup([entry(1, 10, 15), entry(2, 20), entry(3, 30)]),
            [],
            recordingLogger()
        );
        assert.deepEqual(
            result.edited.map((item) => item.dbId),
            [1]
        );
        assert.ok(!result.candidates.some((candidate) => candidate.poll.dbId === 1));
        assert.equal(result.candidates[0]?.poll.dbId, 2);
    });

    await test('the in-flight node is excluded from candidates and refusals', () => {
        const result = buildQueue(
            poll([comment(1), comment(2)]),
            lookup([entry(1, 10, 15), entry(2, 20)]),
            ['PRRC_1'],
            recordingLogger()
        );
        assert.deepEqual(result.edited, []);
        assert.deepEqual(
            result.candidates.map((candidate) => candidate.poll.dbId),
            [2]
        );
        const unedited = buildQueue(poll([comment(1)]), lookup([entry(1, 10)]), ['PRRC_1'], recordingLogger());
        assert.deepEqual(unedited.candidates, []);
    });

    await test('every node of the batch in flight is excluded', () => {
        const result = buildQueue(
            poll([comment(1), comment(2), comment(3)]),
            lookup([entry(1, 10), entry(2, 20), entry(3, 30)]),
            ['PRRC_1', 'PRRC_3'],
            recordingLogger()
        );
        assert.deepEqual(
            result.candidates.map((candidate) => candidate.poll.dbId),
            [2]
        );
    });

    await test('an undefined rocket time is skipped with a log line', () => {
        const log = recordingLogger();
        const result = buildQueue(poll([comment(1), comment(2)]), lookup([entry(1), entry(2, 20)]), [], log);
        assert.deepEqual(result.skippedDbIds, [1]);
        assert.deepEqual(log.lines, ['comment 1: viewer rocket time not found, skipped']);
        assert.deepEqual(
            result.candidates.map((candidate) => candidate.poll.dbId),
            [2]
        );
    });

    await test('rocketed comments without a lookup entry and unrocketed comments are not candidates', () => {
        const result = buildQueue(poll([comment(1), comment(2, false)]), lookup([entry(2, 20)]), [], recordingLogger());
        assert.deepEqual(result.candidates, []);
        assert.deepEqual(result.edited, []);
        assert.deepEqual(result.skippedDbIds, []);
    });
});
