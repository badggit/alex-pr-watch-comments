import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';

import type { CommandResult } from '../../src/types.ts';
import { createFakeRunner } from '../support/fakeRunner.ts';
import { routingKey, toolName } from '../support/stubRouting.ts';

const FIXTURES = path.join(import.meta.dirname, '..', 'fixtures', 'harness');

function readFixture(name: string): unknown {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
    return parsed;
}

function parseStdout(result: CommandResult): unknown {
    const parsed: unknown = JSON.parse(result.stdout);
    return parsed;
}

function graphqlBody(query: string): string {
    return JSON.stringify({ query, variables: { owner: 'o' } });
}

const GRAPHQL_ARGS = ['api', 'graphql', '--hostname', 'github.com', '--input', '-'];

await describe('createFakeRunner', async () => {
    await test('returns queued responses in order and repeats the last one', async () => {
        const fake = createFakeRunner();
        const first = readFixture('pollFirst.json');
        const second = readFixture('pollSecond.json');
        fake.respond('gh', 'PrwcPoll', { json: first });
        fake.respond('gh', 'PrwcPoll', { json: second });
        const request = { file: 'gh', args: GRAPHQL_ARGS, input: graphqlBody('query PrwcPoll($owner: String!) { x }') };
        const results = [
            await fake.runner.run(request),
            await fake.runner.run(request),
            await fake.runner.run(request),
        ];
        assert.deepEqual(
            results.map((result) => parseStdout(result)),
            [first, second, second]
        );
        assert.equal(fake.callCount('gh', 'PrwcPoll'), 3);
    });

    await test('resolves 143 early when the request signal aborts during a delay', async () => {
        const fake = createFakeRunner();
        fake.respond('tmux', 'split-window', { stdout: 'late', delayMs: 5000 });
        const started = Date.now();
        const result = await fake.runner.run({
            file: 'tmux',
            args: ['split-window'],
            signal: AbortSignal.timeout(100),
        });
        assert.equal(result.code, 143);
        assert.ok(Date.now() - started < 2000);
    });

    await test('answers code 0 with empty output for a key with no queue', async () => {
        const fake = createFakeRunner();
        const result = await fake.runner.run({ file: '/usr/bin/git', args: ['status'] });
        assert.deepEqual(result, { code: 0, stdout: '', stderr: '' });
        assert.equal(fake.calls('git').length, 1);
        assert.equal(fake.calls('git')[0]?.key, 'status');
    });

    await test('still delivers the stdout of a failing response', async () => {
        const fake = createFakeRunner();
        const body = readFixture('errorBody.json');
        fake.respond('gh', 'PrwcLookup', { code: 1, json: body, stderr: 'gh: failed\n' });
        const result = await fake.runner.run({
            file: 'gh',
            args: GRAPHQL_ARGS,
            input: graphqlBody('query PrwcLookup($ids: [ID!]!) { x }'),
        });
        assert.equal(result.code, 1);
        assert.equal(result.stderr, 'gh: failed\n');
        assert.deepEqual(parseStdout(result), body);
    });

    await test('calls a function response once per call with the recorded call', async () => {
        const fake = createFakeRunner();
        const seen: string[][] = [];
        fake.respond('tmux', 'new-window', (call) => {
            seen.push(call.args);
            return { stdout: `@${call.args.length}\n` };
        });
        const first = await fake.runner.run({ file: 'tmux', args: ['-S', '/x', 'new-window', '-d'] });
        const second = await fake.runner.run({ file: 'tmux', args: ['new-window'] });
        assert.equal(first.stdout, '@4\n');
        assert.equal(second.stdout, '@1\n');
        assert.deepEqual(seen, [['-S', '/x', 'new-window', '-d'], ['new-window']]);
    });

    await test('rejects the call when a function response throws', async () => {
        const fake = createFakeRunner();
        fake.respond('gh', 'auth_status', () => {
            throw new Error('boom');
        });
        await assert.rejects(fake.runner.run({ file: 'gh', args: ['auth', 'status'] }), { message: 'boom' });
        assert.equal(fake.callCount('gh', 'auth_status'), 1);
    });

    await test('delegates and records a passthrough call', async () => {
        const inner = createFakeRunner();
        inner.respond('git', 'rev-parse', { stdout: 'abc\n' });
        const fake = createFakeRunner({ passthrough: { git: inner.runner } });
        const result = await fake.runner.run({ file: 'git', args: ['-C', '/x', 'rev-parse', 'HEAD'], cwd: '/x' });
        assert.equal(result.stdout, 'abc\n');
        assert.equal(inner.callCount('git', 'rev-parse'), 1);
        assert.equal(fake.callCount('git', 'rev-parse'), 1);
        assert.deepEqual(fake.calls('git')[0]?.args, ['-C', '/x', 'rev-parse', 'HEAD']);
        assert.equal(fake.calls('git')[0]?.cwd, '/x');
        assert.equal(fake.calls().length, 1);
    });
});

await describe('routingKey', async () => {
    await test('routes gh graphql calls by the operation name in the stdin body', () => {
        const input = graphqlBody('query PrwcLookup($ids: [ID!]!) { nodes(ids: $ids) { id } }');
        assert.equal(routingKey('gh', GRAPHQL_ARGS, input), 'PrwcLookup');
        const mutation = graphqlBody('mutation PrwcAddReaction($id: ID!) { x }');
        assert.equal(routingKey('gh', GRAPHQL_ARGS, mutation), 'PrwcAddReaction');
    });

    await test('routes other gh calls by their first two arguments', () => {
        assert.equal(routingKey('gh', ['auth', 'status']), 'auth_status');
    });

    await test('routes tmux and git calls by their subcommand', () => {
        assert.equal(routingKey('tmux', ['-S', '/x', 'split-window', '-h']), 'split-window');
        assert.equal(routingKey('tmux', ['-L', 'n', '-f', '/dev/null', 'new-session']), 'new-session');
        assert.equal(routingKey('git', ['-C', '/x', 'rev-parse', 'HEAD']), 'rev-parse');
        assert.equal(routingKey('git', ['-c', 'a=b', 'fetch', 'origin']), 'fetch');
        assert.equal(routingKey('claude', ['-p', 'x']), 'claude');
    });

    await test('derives the tool from the basename', () => {
        assert.equal(toolName('/usr/bin/gh'), 'gh');
        assert.equal(toolName('tmux'), 'tmux');
        assert.equal(toolName('/bin/ps'), 'ps');
        assert.equal(toolName('/path/to/claude'), 'claude');
        assert.equal(toolName('/bin/sh'), 'other');
    });
});
