import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { classifyGhFailure, ghCommand, ghGraphql } from '../../src/gh.ts';
import { getRecord, parseJson } from '../../src/json.ts';
import type { CommandRequest, CommandResult, CommandRunner } from '../../src/types.ts';

const GH = { path: '/opt/fake/bin/gh', host: 'github.com' };

interface FakeRunner {
    runner: CommandRunner;
    requests: CommandRequest[];
}

function fakeRunner(result: CommandResult): FakeRunner {
    const requests: CommandRequest[] = [];
    return {
        requests,
        runner: {
            run(request) {
                requests.push(request);
                return Promise.resolve(result);
            },
        },
    };
}

function onlyRequest(fake: FakeRunner): CommandRequest {
    assert.equal(fake.requests.length, 1);
    const [request] = fake.requests;
    assert.ok(request);
    return request;
}

await describe('ghGraphql', async () => {
    await test('success pins the host, sends a JSON body and returns data', async () => {
        const fake = fakeRunner({ code: 0, stdout: '{"data":{"viewer":{"login":"me"}}}', stderr: '' });
        const result = await ghGraphql({ runner: fake.runner }, GH, 'query PrwcPoll { viewer { login } }', {
            owner: 'o',
            number: 12,
        });
        const request = onlyRequest(fake);
        assert.equal(request.file, GH.path);
        assert.deepEqual(request.args, ['api', 'graphql', '--hostname', 'github.com', '--input', '-']);
        const body = parseJson(request.input ?? '');
        assert.deepEqual(body, { query: 'query PrwcPoll { viewer { login } }', variables: { owner: 'o', number: 12 } });
        assert.deepEqual(result, { kind: 'ok', data: { viewer: { login: 'me' } } });
    });

    await test('exit 0 with unparsable output is transient', async () => {
        const fake = fakeRunner({ code: 0, stdout: 'not json', stderr: '' });
        const result = await ghGraphql({ runner: fake.runner }, GH, 'query X { a }', {});
        assert.equal(result.kind, 'transient');
    });

    await test('exit 0 with JSON that is not an object is transient', async () => {
        for (const stdout of ['[{"data":{}}]', '42', 'null', '"text"']) {
            const fake = fakeRunner({ code: 0, stdout, stderr: '' });
            const result = await ghGraphql({ runner: fake.runner }, GH, 'query X { a }', {});
            assert.equal(result.kind, 'transient', stdout);
        }
    });

    await test('auth failures', async () => {
        const fake = fakeRunner({
            code: 1,
            stdout: '',
            stderr: 'HTTP 401: Bad credentials (https://api.github.com)\n',
        });
        const result = await ghGraphql({ runner: fake.runner }, GH, 'query X { a }', {});
        assert.deepEqual(result, { kind: 'auth', message: 'HTTP 401: Bad credentials (https://api.github.com)' });
    });

    await test('a deleted node is gone with its id', async () => {
        const fake = fakeRunner({
            code: 1,
            stdout: '{"data":null}',
            stderr: "gh: Could not resolve to a node with the global id of 'PRRC_abc'\n",
        });
        const result = await ghGraphql({ runner: fake.runner }, GH, 'query X { a }', {});
        assert.deepEqual(result, {
            kind: 'gone',
            ids: ['PRRC_abc'],
            message: "gh: Could not resolve to a node with the global id of 'PRRC_abc'",
        });
    });

    await test('a non-zero exit never parses stdout', async () => {
        const fake = fakeRunner({ code: 1, stdout: '{"data":{"viewer":{"login":"me"}}}', stderr: 'connection reset' });
        const result = await ghGraphql({ runner: fake.runner }, GH, 'query X { a }', {});
        assert.deepEqual(result, { kind: 'transient', offline: true, message: 'connection reset' });
        assert.equal(getRecord(result, 'data'), undefined);
    });

    await test('a spawn failure with empty stderr is transient with a message', async () => {
        const fake = fakeRunner({ code: 127, stdout: '', stderr: '', spawnError: 'ENOENT' });
        const result = await ghGraphql({ runner: fake.runner }, GH, 'query X { a }', {});
        assert.deepEqual(result, { kind: 'transient', message: 'gh could not be started: ENOENT' });
    });
});

await describe('ghCommand', async () => {
    await test('passes the arguments through and carries no data', async () => {
        const fake = fakeRunner({ code: 0, stdout: 'Logged in', stderr: '' });
        const args = ['auth', 'status', '--hostname', 'github.com'];
        const result = await ghCommand({ runner: fake.runner }, GH, args);
        const request = onlyRequest(fake);
        assert.equal(request.file, GH.path);
        assert.deepEqual(request.args, args);
        assert.deepEqual(result, { kind: 'ok', data: undefined });
    });

    await test('a failure is classified', async () => {
        const fake = fakeRunner({ code: 1, stdout: '', stderr: 'To get started with GitHub CLI, run: gh auth login' });
        const result = await ghCommand({ runner: fake.runner }, GH, ['auth', 'status', '--hostname', 'github.com']);
        assert.equal(result.kind, 'auth');
    });
});

await describe('classifyGhFailure', async () => {
    await test('classifies by stderr', () => {
        assert.equal(classifyGhFailure('Bad credentials').kind, 'auth');
        assert.equal(classifyGhFailure('HTTP 502: Bad Gateway').kind, 'transient');
        const gone = classifyGhFailure(
            "Could not resolve to a node with the global id of 'A_1'.\n" +
                "Could not resolve to a node with the global id of 'bad id;'.\n" +
                "Could not resolve to a node with the global id of 'B_2'."
        );
        assert.deepEqual(gone.kind === 'gone' ? gone.ids : [], ['A_1', 'B_2']);
    });

    await test('network errors are transient and offline', () => {
        const texts = [
            'error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com',
            'Post "https://api.github.com/graphql": dial tcp: lookup api.github.com: no such host',
            'Get "https://ghe.example/api/v3/rate_limit": net/http: TLS handshake timeout',
            'read tcp 10.0.0.2:5000->140.82.112.6:443: read: connection reset by peer',
            'dial tcp 140.82.112.6:443: i/o timeout',
            'connect: Network is unreachable',
            'lookup api.github.com on 127.0.0.53:53: server misbehaving',
            'Temporary failure in name resolution',
            'net/http: request canceled (Client.Timeout exceeded while awaiting headers)',
            'dial tcp 127.0.0.1:443: connect: connection refused',
        ];
        for (const text of texts) {
            const failure = classifyGhFailure(text);
            assert.ok(failure.kind === 'transient' && failure.offline === true, text);
        }
    });

    await test('an offline text with an auth marker is offline, never auth', () => {
        const failure = classifyGhFailure('error connecting to api.github.com\nTo authenticate, run: gh auth login');
        assert.deepEqual(failure.kind === 'transient' ? failure.offline : undefined, true);
    });

    await test('an HTTP error is plain transient', () => {
        assert.deepEqual(classifyGhFailure('HTTP 502: Bad Gateway'), {
            kind: 'transient',
            message: 'HTTP 502: Bad Gateway',
        });
    });

    await test('a call cut off at its timeout is offline', async () => {
        const fake = fakeRunner({ code: 143, stdout: '', stderr: '', timedOut: true });
        const result = await ghGraphql({ runner: fake.runner }, GH, 'query X { a }', {});
        assert.deepEqual(result, { kind: 'transient', offline: true, message: 'gh timed out' });
    });

    await test('trims and truncates the message', () => {
        const failure = classifyGhFailure(`  ${'x'.repeat(600)}  `);
        assert.equal(failure.message, 'x'.repeat(500));
    });
});
