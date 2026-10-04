import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test, type TestContext } from 'node:test';

import { acquireWorktreeLock, worktreeLockHolder } from '../../src/locks.ts';
import { pidAlive } from '../../src/proc.ts';
import {
    attentionHint,
    captureRun,
    commentOutcome,
    decideRun,
    evaluateRun,
    type DecideInput,
} from '../../src/runState.ts';
import { createRun, launchDecision, mergeRecord, readLoggedCursor } from '../../src/runStore.ts';
import { runDir } from '../../src/stateStore.ts';
import type { EventKind, EventsSnapshot, LookupResult } from '../../src/types.ts';
import { safeText } from '../../src/validate.ts';
import {
    answerPaneTag,
    appendEvents,
    baseComment,
    doneMarks,
    eventsFile,
    eyesRemovals,
    FRESH_PLUS1,
    lockExists,
    lookupWith,
    newRunFixture,
    NODE_ID,
    OTHER_KEY,
    recordOf,
    RUN_ID,
    runExists,
    seedRun,
    SESSION_KEY,
    socketOf,
    STALE_PLUS1,
    startClaude,
    startTermReportingClaude,
    thumbsDownAdds,
    tmuxMessages,
    WORKER_SOCKET,
    type RunFixture,
} from '../fixtures/runstate/runFixture.ts';
import { waitUntil } from '../support/testEnv.ts';

const NOW = 1_800_000_000;
const SETTLED: readonly string[] = ['prompt', 'stop'];
const WRITER_SCRIPT = [
    'rd=$1',
    'write_lines() {',
    '    i=$1',
    '    while [ "$i" -le "$2" ]; do',
    '        if [ $((i % 2)) -eq 1 ]; then kind=prompt; else kind=stop; fi',
    String.raw`        printf '%s %s\n' "$kind" "$i" >> "$rd/events"`,
    '        i=$((i + 1))',
    '    done',
    '}',
    'write_lines 1 200',
    ': > "$rd/half.ready"',
    'n=0',
    'while [ ! -e "$rd/half.go" ] && [ "$n" -lt 1200 ]; do',
    '    sleep 0.05',
    '    n=$((n + 1))',
    'done',
    'write_lines 201 400',
    ': > "$rd/done"',
    '',
].join('\n');

function snapshot(kinds: readonly EventKind[], lastAt: number): EventsSnapshot {
    return {
        lastEvent: kinds.at(-1) ?? 'none',
        lastEventAt: kinds.length > 0 ? lastAt : undefined,
        hasPrompt: kinds.includes('prompt'),
        count: kinds.length,
        kinds: [...kinds],
    };
}

function decideInput(patch?: Partial<DecideInput>): DecideInput {
    return {
        alive: true,
        comments: ['open'],
        events: snapshot(['prompt', 'stop'], NOW - 60),
        startedAt: NOW - 200,
        now: NOW,
        startTimeout: 120,
        stopQuiet: 10,
        ...patch,
    };
}

function liveSignal(): AbortSignal {
    return new AbortController().signal;
}

async function evaluate(fixture: RunFixture, lookup: LookupResult, stop?: AbortSignal) {
    const capture = captureRun(fixture.stateDir, RUN_ID);
    return await evaluateRun(fixture.deps, fixture.session, RUN_ID, capture, lookup, stop ?? liveSignal());
}

function eventLog(fixture: RunFixture): string[] {
    return fixture.deps.logLines.filter((line) => line.includes(' event '));
}

function recordText(fixture: RunFixture): string {
    return fs.readFileSync(path.join(runDir(fixture.stateDir, RUN_ID), 'record.json'), 'utf8');
}

function assertConsistent(events: EventsSnapshot, previous: number): void {
    assert.equal(events.kinds.length, events.count);
    assert.equal(events.lastEvent === 'prompt', events.count % 2 === 1);
    assert.equal(events.hasPrompt, events.count > 0);
    assert.equal(events.lastEventAt !== undefined, events.count > 0);
    assert.ok(events.count >= previous, `count went back from ${previous} to ${events.count}`);
}

// Spies on process.kill (calls go through) so a test can prove that no TERM was ever sent to a pid.
function spyKills(t: TestContext): () => number[] {
    const kill = t.mock.method(process, 'kill');
    return () =>
        kill.mock.calls.filter((call) => call.arguments[1] === 'SIGTERM').map((call) => Number(call.arguments[0]));
}

// Makes every read of a claude.pid file fail with code, as a disk error or a permission problem would.
function failClaudePidReads(t: TestContext, code: string): void {
    const original = fs.readFileSync;
    t.mock.method(fs, 'readFileSync', (target: fs.PathOrFileDescriptor, options: BufferEncoding) => {
        if (String(target).endsWith(`${path.sep}claude.pid`)) {
            throw Object.assign(new Error(`${code}: claude.pid cannot be read`), { code });
        }
        return original(target, options);
    });
}

function breakRecord(fixture: RunFixture): void {
    fs.writeFileSync(path.join(runDir(fixture.stateDir, RUN_ID), 'record.json'), '{"format": 1, "state": "runn');
}

// Lets every lock rename under the worktrees directory fail like a full disk, so a lock release cannot complete.
function failLockRenames(t: TestContext): void {
    const original = fs.renameSync;
    const marker = `${path.sep}worktrees${path.sep}`;
    t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
        if (String(to).includes(marker)) {
            throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
        }
        original(from, to);
    });
}

await describe('decideRun', async () => {
    await test('dead worker gives exited', () => {
        assert.deepEqual(decideRun(decideInput({ alive: false, comments: ['done'] })), {
            state: 'exited',
            reason: 'claude-exited',
        });
    });

    await test('deleted comment needs attention', () => {
        assert.deepEqual(decideRun(decideInput({ comments: ['gone'] })), {
            state: 'needs_attention',
            reason: 'comment-deleted',
        });
    });

    await test('a permission prompt needs attention', () => {
        const events = snapshot(['prompt', 'permission'], NOW - 60);
        assert.deepEqual(decideRun(decideInput({ events })), {
            state: 'needs_attention',
            reason: 'waiting-for-permission',
        });
    });

    await test('settled stop with a fresh +1 completes', () => {
        assert.deepEqual(decideRun(decideInput({ comments: ['done'] })), { state: 'completed', reason: 'done' });
    });

    await test('settled stop without +1 and with EYES gone fails', () => {
        assert.deepEqual(decideRun(decideInput({ comments: ['failed'] })), {
            state: 'failed',
            reason: 'claude-took-failure-path',
        });
    });

    await test('settled stop with an open comment needs attention', () => {
        assert.deepEqual(decideRun(decideInput({ comments: ['open'] })), {
            state: 'needs_attention',
            reason: 'idle-without-done-marker',
        });
    });

    await test('a batch completes only when every comment is done or deleted', () => {
        assert.deepEqual(decideRun(decideInput({ comments: ['done', 'gone', 'done'] })), {
            state: 'completed',
            reason: 'done',
        });
        assert.deepEqual(decideRun(decideInput({ comments: ['done', 'failed'] })), {
            state: 'failed',
            reason: 'claude-took-failure-path',
        });
        assert.deepEqual(decideRun(decideInput({ comments: ['done', 'open', 'failed'] })), {
            state: 'needs_attention',
            reason: 'idle-without-done-marker',
        });
    });

    await test('a batch with one deleted comment goes on; only an all-deleted batch needs attention', () => {
        const events = snapshot(['prompt', 'tool'], NOW - 60);
        assert.deepEqual(decideRun(decideInput({ events, comments: ['gone', 'open'] })), {
            state: 'running',
            reason: 'working',
        });
        assert.deepEqual(decideRun(decideInput({ events, comments: ['gone', 'gone'] })), {
            state: 'needs_attention',
            reason: 'comment-deleted',
        });
    });

    await test('commentOutcome reads done, failed, open and gone from the lookup', () => {
        const comment = baseComment();
        const entry = lookupWith().entries[0];
        assert.ok(entry !== undefined);
        assert.equal(commentOutcome(comment, undefined, false), 'gone');
        assert.equal(commentOutcome(comment, entry, true), 'gone');
        assert.equal(commentOutcome(comment, { ...entry, plus1At: FRESH_PLUS1 }, false), 'done');
        assert.equal(commentOutcome(comment, { ...entry, plus1At: STALE_PLUS1, eyes: false }, false), 'failed');
        assert.equal(commentOutcome(comment, { ...entry, eyes: true }, false), 'open');
        assert.equal(commentOutcome(baseComment({ eyesAdded: false }), { ...entry, eyes: false }, false), 'open');
    });

    await test('no prompt 121 seconds after the start: claude did not start', () => {
        const events = snapshot([], NOW);
        assert.deepEqual(decideRun(decideInput({ events, startedAt: NOW - 121 })), {
            state: 'needs_attention',
            reason: 'claude-did-not-start',
        });
    });

    await test('claude-did-not-start carries a plain ASCII hint about a waiting dialog', () => {
        const hint = attentionHint('claude-did-not-start');
        assert.ok(hint.length > 0);
        assert.equal(safeText(hint), hint);
        // The longest run id: a 14-digit timestamp, a dash and a 15-digit comment database id.
        const notice = `alex-pr-watch-comments: run 20261002233613-${'9'.repeat(15)} needs attention: claude-did-not-start, ${hint}`;
        assert.equal(safeText(notice), notice, 'the whole notice must survive safeText without being cut');
        assert.ok(hint.includes('worker pane'));
        assert.ok(hint.includes('trust'));
        assert.equal(attentionHint('waiting-for-permission'), '');
        assert.equal(attentionHint('unknown-reason'), '');
    });

    await test('a prompt without a stop is still working', () => {
        const events = snapshot(['prompt'], NOW - 60);
        assert.deepEqual(decideRun(decideInput({ events })), { state: 'running', reason: 'working' });
    });

    await test('a fresh +1 while the last event is a prompt is still working', () => {
        const events = snapshot(['prompt', 'stop', 'prompt'], NOW - 60);
        assert.deepEqual(decideRun(decideInput({ events, comments: ['done'] })), {
            state: 'running',
            reason: 'working',
        });
    });
});

await describe('owner Stop hook blocked (C8)', async () => {
    await test('a stop inside the quiet period is settling, after it completed', () => {
        const young = snapshot(['prompt', 'stop'], NOW - 5);
        assert.deepEqual(decideRun(decideInput({ events: young, comments: ['done'], stopQuiet: 10 })), {
            state: 'running',
            reason: 'settling',
        });
        const old = snapshot(['prompt', 'stop'], NOW - 11);
        assert.deepEqual(decideRun(decideInput({ events: old, comments: ['done'], stopQuiet: 10 })), {
            state: 'completed',
            reason: 'done',
        });
    });

    await test('tool activity after a stop is working', () => {
        const events = snapshot(['prompt', 'stop', 'tool'], NOW - 60);
        assert.deepEqual(decideRun(decideInput({ events, comments: ['done'] })), {
            state: 'running',
            reason: 'working',
        });
    });

    await test('a stop without a recorded prompt is neither completion nor failure', () => {
        const events = snapshot(['stop'], NOW - 60);
        for (const outcome of ['done', 'failed'] as const) {
            const decision = decideRun(decideInput({ events, comments: [outcome] }));
            assert.notEqual(decision.state, 'completed');
            assert.notEqual(decision.state, 'failed');
        }
    });

    await test('a tool event appended after the capture defers without a signal', async (t) => {
        const fixture = await newRunFixture(t);
        await seedRun(fixture, { events: SETTLED });
        const claude = await startClaude(fixture, 'cooperative');
        const capture = captureRun(fixture.stateDir, RUN_ID);
        appendEvents(fixture, ['tool'], 0);
        const lookup = lookupWith({ plus1At: FRESH_PLUS1 });
        const result = await evaluateRun(fixture.deps, fixture.session, RUN_ID, capture, lookup, liveSignal());
        assert.equal(result.state, 'deferred');
        assert.equal(fixture.fake.calls('other').length, 0);
        assert.ok(pidAlive(claude));
        assert.equal(worktreeLockHolder(fixture.stateDir, SESSION_KEY), RUN_ID);
        assert.ok(runExists(fixture));
    });
});

await describe('captureRun', async () => {
    await test('captures stay consistent while a writer appends (C7)', async (t) => {
        const fixture = await newRunFixture(t);
        const rd = createRun(fixture.stateDir, RUN_ID);
        const script = path.join(fixture.env.root, 'writer.sh');
        fs.writeFileSync(script, WRITER_SCRIPT);
        fixture.env.spawnOrphan('/bin/sh', [script, rd]);
        assert.ok(await waitUntil(60_000, () => fs.existsSync(path.join(rd, 'half.ready'))), 'writer never paused');
        let previous = 0;
        for (let index = 0; index < 50; index += 1) {
            const capture = captureRun(fixture.stateDir, RUN_ID);
            assert.equal(capture.events.count, 200);
            assertConsistent(capture.events, previous);
            previous = capture.events.count;
        }
        fs.writeFileSync(path.join(rd, 'half.go'), '');
        const take = (): number => {
            const capture = captureRun(fixture.stateDir, RUN_ID);
            assertConsistent(capture.events, previous);
            previous = capture.events.count;
            return previous;
        };
        // Synchronous loops, so the captures run back to back while the writer appends its second half.
        const deadline = performance.now() + 60_000;
        let resumed = false;
        while (!resumed && performance.now() < deadline) {
            resumed = take() > 200;
        }
        assert.ok(resumed, 'writer never resumed');
        const done = path.join(rd, 'done');
        while (!fs.existsSync(done) && performance.now() < deadline) {
            take();
        }
        assert.ok(fs.existsSync(done), 'writer never finished');
        const final = captureRun(fixture.stateDir, RUN_ID);
        assertConsistent(final.events, previous);
        assert.equal(final.events.count, 400);
        assert.equal(final.alive, false);
    });

    await test('a capture reads the events file once, so a line appended between reads cannot mix in', async (t) => {
        const fixture = await newRunFixture(t);
        createRun(fixture.stateDir, RUN_ID);
        const file = eventsFile(fixture);
        fs.writeFileSync(file, 'prompt 1\nstop 2\n');
        const original = fs.readFileSync;
        let reads = 0;
        const spy = t.mock.method(fs, 'readFileSync', (target: fs.PathOrFileDescriptor, options: BufferEncoding) => {
            if (target === file) {
                reads += 1;
                return reads === 1 ? 'prompt 1\nstop 2\n' : 'prompt 1\nstop 2\nprompt 3\n';
            }
            return original(target, options);
        });
        const capture = captureRun(fixture.stateDir, RUN_ID);
        spy.mock.restore();
        assert.equal(reads, 1);
        assertConsistent(capture.events, 0);
        assert.equal(capture.events.count, 2);
        assert.equal(capture.events.lastEvent, 'stop');
    });
});

await describe('evaluateRun event log', async () => {
    await test('logs every event since the cursor once, the first tool use only', async (t) => {
        const fixture = await newRunFixture(t);
        await seedRun(fixture, { events: ['prompt', 'tool', 'stop'] });
        await startClaude(fixture, 'cooperative');
        const lookup = lookupWith({ eyes: true });
        await evaluate(fixture, lookup);
        assert.deepEqual(eventLog(fixture), [
            `info run ${RUN_ID} event prompt`,
            `info run ${RUN_ID} event tool`,
            `info run ${RUN_ID} event stop`,
        ]);
        await evaluate(fixture, lookup);
        assert.equal(eventLog(fixture).length, 3);
        appendEvents(
            fixture,
            Array.from({ length: 10 }, () => 'tool')
        );
        await evaluate(fixture, lookup);
        assert.equal(eventLog(fixture).length, 3);

        const restarted: RunFixture = { ...fixture, deps: fixture.env.deps(fixture.fake.runner) };
        await evaluate(restarted, lookup);
        assert.deepEqual(eventLog(restarted), []);
        appendEvents(fixture, ['permission']);
        await evaluate(restarted, lookup);
        assert.deepEqual(eventLog(restarted), [`info run ${RUN_ID} event permission`]);
        await evaluate(restarted, lookup);
        assert.equal(eventLog(restarted).length, 1);
        assert.equal(readLoggedCursor(fixture.stateDir, RUN_ID), 14);
    });
});

await describe('evaluateRun decisions and effects', async () => {
    await test('a +1 older than the rocket is not completion', async (t) => {
        const fixture = await newRunFixture(t);
        await seedRun(fixture, { events: SETTLED });
        const claude = await startClaude(fixture, 'cooperative');
        const result = await evaluate(fixture, lookupWith({ plus1At: STALE_PLUS1, eyes: true }));
        assert.deepEqual(result, { state: 'needs_attention', reason: 'idle-without-done-marker' });
        assert.ok(pidAlive(claude));
        assert.ok(runExists(fixture));
    });

    await test('a delayed launch keeps running until the launcher records its exit', async (t) => {
        const fixture = await newRunFixture(t);
        const panePid = fixture.env.spawnOrphan('sleep', ['300']);
        await seedRun(fixture, { patch: { panePid, startedAt: Math.floor(Date.now() / 1000) } });
        const first = await evaluate(fixture, lookupWith());
        assert.equal(first.state, 'running');
        assert.equal(worktreeLockHolder(fixture.stateDir, SESSION_KEY), RUN_ID);
        fs.writeFileSync(path.join(runDir(fixture.stateDir, RUN_ID), 'exit_status'), 'cancelled');
        const second = await evaluate(fixture, lookupWith());
        assert.equal(second.state, 'exited');
        assert.ok(pidAlive(panePid));
        assert.equal(lockExists(fixture, SESSION_KEY), false);
        assert.equal(runExists(fixture), false);
    });

    await test('completed while the fallback shell is alive ends claude and frees the slot', async (t) => {
        const fixture = await newRunFixture(t);
        const panePid = fixture.env.spawnOrphan('sleep', ['300']);
        await seedRun(fixture, { patch: { panePid }, events: SETTLED });
        const claude = await startClaude(fixture, 'cooperative');
        fs.writeFileSync(path.join(runDir(fixture.stateDir, RUN_ID), 'exit_status'), '0');
        answerPaneTag(fixture);
        const result = await evaluate(fixture, lookupWith({ plus1At: FRESH_PLUS1 }));
        assert.deepEqual(result, { state: 'completed', reason: 'done' });
        assert.equal(pidAlive(claude), false);
        assert.equal(lockExists(fixture, SESSION_KEY), false);
        assert.equal(runExists(fixture), false);
    });

    await test('completed: TERM reaches claude, the pane is marked done, the slot is freed', async (t) => {
        const fixture = await newRunFixture(t);
        await seedRun(fixture, { events: SETTLED });
        const claude = await startClaude(fixture, 'cooperative');
        answerPaneTag(fixture);
        const result = await evaluate(fixture, lookupWith({ plus1At: FRESH_PLUS1 }));
        assert.deepEqual(result, { state: 'completed', reason: 'done' });
        assert.equal(pidAlive(claude), false);
        const tmuxCalls = fixture.fake.calls('tmux');
        const tagRead = tmuxCalls.findIndex((call) => call.key === 'display-message' && call.args.includes('-p'));
        const mark = tmuxCalls.findIndex((call) => call.key === 'set-option' && call.args.includes('@prwc_done'));
        assert.equal(doneMarks(fixture).length, 1);
        assert.ok(tagRead !== -1 && mark > tagRead, 'the pane was marked before its tag was read');
        assert.equal(lockExists(fixture, SESSION_KEY), false);
        assert.equal(runExists(fixture), false);
        assert.equal(tmuxMessages(fixture).length, 0);
    });

    await test('a reused claude pid is never signalled (C9)', async (t) => {
        const fixture = await newRunFixture(t);
        await seedRun(fixture, { events: SETTLED });
        const claude = await startClaude(fixture, 'cooperative');
        fs.writeFileSync(path.join(runDir(fixture.stateDir, RUN_ID), 'claude.start'), 'Mon Jan  1 00:00:00 2001\n');
        const terms = spyKills(t);
        const result = await evaluate(fixture, lookupWith({ plus1At: FRESH_PLUS1 }));
        assert.deepEqual(result, { state: 'needs_attention', reason: 'claude-pid-reused' });
        assert.deepEqual(terms(), []);
        assert.equal(fixture.fake.calls('other').length, 1);
        assert.ok(pidAlive(claude));
        const record = recordOf(fixture);
        assert.equal(record.state, 'needs_attention');
        assert.equal(record.reason, 'claude-pid-reused');
        assert.equal(worktreeLockHolder(fixture.stateDir, SESSION_KEY), RUN_ID);
        assert.equal(tmuxMessages(fixture).length, 1);
    });

    await test('a missing claude.start records claude-pid-reused', async (t) => {
        const fixture = await newRunFixture(t);
        await seedRun(fixture, { events: SETTLED });
        const claude = await startClaude(fixture, 'cooperative');
        fs.rmSync(path.join(runDir(fixture.stateDir, RUN_ID), 'claude.start'));
        const result = await evaluate(fixture, lookupWith({ plus1At: FRESH_PLUS1 }));
        assert.deepEqual(result, { state: 'needs_attention', reason: 'claude-pid-reused' });
        assert.ok(pidAlive(claude));
        assert.equal(fixture.fake.calls('other').length, 0);
    });

    await test('an event during the identity check vetoes the signal', async (t) => {
        const fixture = await newRunFixture(t, { psPassthrough: false });
        await seedRun(fixture, { events: SETTLED });
        const claude = await startClaude(fixture, 'cooperative');
        const start = fs.readFileSync(path.join(runDir(fixture.stateDir, RUN_ID), 'claude.start'), 'utf8');
        fixture.fake.respond('other', 'other', () => {
            fs.appendFileSync(eventsFile(fixture), 'tool 1\n');
            return { stdout: start, delayMs: 500 };
        });
        const terms = spyKills(t);
        const result = await evaluate(fixture, lookupWith({ plus1At: FRESH_PLUS1 }));
        assert.equal(result.state, 'deferred');
        assert.equal(fixture.fake.calls('other').length, 1);
        assert.deepEqual(terms(), []);
        assert.ok(pidAlive(claude));
        assert.equal(worktreeLockHolder(fixture.stateDir, SESSION_KEY), RUN_ID);
        assert.ok(runExists(fixture));
    });

    await test('an unreadable start time of a live claude defers', async (t) => {
        const fixture = await newRunFixture(t, { psPassthrough: false });
        await seedRun(fixture, { events: SETTLED });
        const claude = await startClaude(fixture, 'cooperative');
        fixture.fake.respond('other', 'other', { code: 1, stdout: '' });
        const result = await evaluate(fixture, lookupWith({ plus1At: FRESH_PLUS1 }));
        assert.equal(result.state, 'deferred');
        assert.ok(fixture.deps.logLines.some((line) => line.includes(`could not verify claude pid for run ${RUN_ID}`)));
        assert.ok(pidAlive(claude));
        assert.equal(worktreeLockHolder(fixture.stateDir, SESSION_KEY), RUN_ID);
        assert.ok(runExists(fixture));
    });

    await test('a stop request during the TERM wait returns at once', async (t) => {
        const fixture = await newRunFixture(t, { env: { PRWC_TERM_WAIT: '30' } });
        await seedRun(fixture, { events: SETTLED });
        const termFile = path.join(fixture.env.root, 'claude.term');
        const claude = await startTermReportingClaude(fixture, termFile);
        const terms = spyKills(t);
        const controller = new AbortController();
        const pending = evaluate(fixture, lookupWith({ plus1At: FRESH_PLUS1 }), controller.signal);
        assert.ok(await waitUntil(10_000, () => fs.existsSync(termFile)), 'the TERM never reached claude');
        assert.deepEqual(terms(), [claude]);
        const aborted = performance.now();
        controller.abort();
        const result = await pending;
        assert.deepEqual(result, { state: 'deferred', reason: 'stop-requested' });
        assert.ok(performance.now() - aborted < 3000, `took ${performance.now() - aborted} ms after the abort`);
        assert.ok(pidAlive(claude));
        assert.equal(recordOf(fixture).state, 'running');
        assert.equal(worktreeLockHolder(fixture.stateDir, SESSION_KEY), RUN_ID);
        assert.equal(doneMarks(fixture).length, 0);
    });

    await test('failed: claude ends, the pane is marked, the slot is freed, one message', async (t) => {
        const fixture = await newRunFixture(t);
        await seedRun(fixture, { events: SETTLED });
        const claude = await startClaude(fixture, 'cooperative');
        answerPaneTag(fixture);
        const result = await evaluate(fixture, lookupWith({ eyes: false }));
        assert.deepEqual(result, { state: 'failed', reason: 'claude-took-failure-path' });
        assert.equal(pidAlive(claude), false);
        assert.equal(thumbsDownAdds(fixture).length, 1);
        assert.equal(eyesRemovals(fixture).length, 0);
        assert.equal(doneMarks(fixture).length, 1);
        assert.equal(lockExists(fixture, SESSION_KEY), false);
        assert.equal(runExists(fixture), false);
        assert.equal(tmuxMessages(fixture).length, 1);
    });

    await test('a TERM-ignoring claude keeps the slot and needs attention', async (t) => {
        const fixture = await newRunFixture(t, { env: { PRWC_TERM_WAIT: '1' } });
        await seedRun(fixture, { events: SETTLED });
        const claude = await startClaude(fixture, 'ignoring');
        answerPaneTag(fixture);
        const result = await evaluate(fixture, lookupWith({ plus1At: FRESH_PLUS1 }));
        assert.deepEqual(result, { state: 'needs_attention', reason: 'claude-did-not-exit' });
        assert.ok(pidAlive(claude));
        assert.equal(worktreeLockHolder(fixture.stateDir, SESSION_KEY), RUN_ID);
        const record = recordOf(fixture);
        assert.equal(record.state, 'needs_attention');
        assert.equal(record.reason, 'claude-did-not-exit');
        assert.equal(doneMarks(fixture).length, 0);
        assert.equal(tmuxMessages(fixture).length, 1);
    });

    await test('events that arrived during the lookup defer the decision', async (t) => {
        const fixture = await newRunFixture(t);
        await seedRun(fixture, { events: SETTLED });
        const claude = await startClaude(fixture, 'cooperative');
        const before = recordText(fixture);
        const capture = captureRun(fixture.stateDir, RUN_ID);
        appendEvents(fixture, ['prompt'], 0);
        const lookup = lookupWith({ plus1At: FRESH_PLUS1 });
        const result = await evaluateRun(fixture.deps, fixture.session, RUN_ID, capture, lookup, liveSignal());
        assert.equal(result.state, 'deferred');
        assert.ok(pidAlive(claude));
        assert.equal(worktreeLockHolder(fixture.stateDir, SESSION_KEY), RUN_ID);
        assert.equal(recordText(fixture), before);
        assert.equal(fixture.fake.calls().length, 0);
    });

    await test('a requested stop defers and sends no signal', async (t) => {
        const fixture = await newRunFixture(t);
        await seedRun(fixture, { events: SETTLED });
        const claude = await startClaude(fixture, 'cooperative');
        const controller = new AbortController();
        controller.abort();
        const result = await evaluate(fixture, lookupWith({ plus1At: FRESH_PLUS1 }), controller.signal);
        assert.equal(result.state, 'deferred');
        assert.equal(fixture.fake.calls('other').length, 0);
        assert.ok(pidAlive(claude));
        assert.ok(runExists(fixture));
    });

    await test('a preparing record is never evaluated', async (t) => {
        const fixture = await newRunFixture(t);
        await seedRun(fixture, { patch: { state: 'preparing' }, events: SETTLED });
        const before = recordText(fixture);
        const result = await evaluate(fixture, lookupWith({ plus1At: FRESH_PLUS1 }));
        assert.equal(result.state, 'preparing');
        assert.equal(fixture.fake.calls().length, 0);
        assert.equal(recordText(fixture), before);
        assert.ok(runExists(fixture));
    });
});

await describe('evaluateRun other effects', async () => {
    await test('two evaluations with the same attention reason send one message', async (t) => {
        const fixture = await newRunFixture(t);
        await seedRun(fixture, { events: ['prompt', 'permission'] });
        await startClaude(fixture, 'cooperative');
        const first = await evaluate(fixture, lookupWith());
        const second = await evaluate(fixture, lookupWith());
        assert.deepEqual(first, { state: 'needs_attention', reason: 'waiting-for-permission' });
        assert.deepEqual(second, first);
        assert.equal(tmuxMessages(fixture).length, 1);
        assert.equal(recordOf(fixture).reason, 'waiting-for-permission');
    });

    await test('claude-did-not-start notifies the owner once with its hint', async (t) => {
        const fixture = await newRunFixture(t);
        const startedAt = Math.floor(Date.now() / 1000) - 200;
        await seedRun(fixture, { patch: { startedAt }, events: [] });
        await startClaude(fixture, 'cooperative');
        const first = await evaluate(fixture, lookupWith());
        const second = await evaluate(fixture, lookupWith());
        assert.deepEqual(first, { state: 'needs_attention', reason: 'claude-did-not-start' });
        assert.deepEqual(second, first);
        const messages = tmuxMessages(fixture);
        assert.equal(messages.length, 1);
        const text = messages[0]?.args.join(' ') ?? '';
        assert.ok(text.includes('needs attention: claude-did-not-start'), text);
        assert.ok(text.includes(attentionHint('claude-did-not-start')), text);
    });

    await test('a comment reported gone by the lookup needs attention', async (t) => {
        const fixture = await newRunFixture(t);
        await seedRun(fixture, { events: SETTLED });
        const claude = await startClaude(fixture, 'cooperative');
        const lookup: LookupResult = { rate: { remaining: 10, resetAt: undefined }, entries: [], gone: [NODE_ID] };
        const result = await evaluate(fixture, lookup);
        assert.deepEqual(result, { state: 'needs_attention', reason: 'comment-deleted' });
        assert.ok(pidAlive(claude));
        assert.equal(worktreeLockHolder(fixture.stateDir, SESSION_KEY), RUN_ID);
    });

    await test('exited with EYES on removes EYES once, adds -1 and caps panes on the record socket', async (t) => {
        const fixture = await newRunFixture(t);
        await seedRun(fixture, { patch: { socket: WORKER_SOCKET }, events: ['prompt'] });
        const result = await evaluate(fixture, lookupWith({ eyes: true }));
        assert.deepEqual(result, { state: 'exited', reason: 'claude-exited' });
        assert.equal(eyesRemovals(fixture).length, 1);
        assert.equal(thumbsDownAdds(fixture).length, 1);
        const listing = fixture.fake
            .calls('tmux')
            .find((call) => call.key === 'list-panes' && call.args.some((arg) => arg.includes('@prwc_done')));
        assert.equal(socketOf(listing), WORKER_SOCKET);
        assert.equal(lockExists(fixture, SESSION_KEY), false);
        assert.equal(runExists(fixture), false);
    });

    await test('exited with EYES off only adds the -1', async (t) => {
        const fixture = await newRunFixture(t);
        await seedRun(fixture, { events: ['prompt'] });
        const result = await evaluate(fixture, lookupWith({ eyes: false }));
        assert.equal(result.state, 'exited');
        assert.equal(fixture.fake.calls('gh').length, 1);
        assert.equal(thumbsDownAdds(fixture).length, 1);
        assert.equal(runExists(fixture), false);
    });

    await test('exited after a fresh +1 or a new rocket adds no -1', async (t) => {
        const fixture = await newRunFixture(t);
        await seedRun(fixture, { events: ['prompt'] });
        const done = await evaluate(fixture, lookupWith({ eyes: false, plus1At: FRESH_PLUS1 }));
        assert.equal(done.state, 'exited');
        assert.equal(fixture.fake.calls('gh').length, 0);
        const again = await newRunFixture(t);
        await seedRun(again, { events: ['prompt'] });
        const approved = await evaluate(again, lookupWith({ eyes: true, rocketAt: FRESH_PLUS1 }));
        assert.equal(approved.state, 'exited');
        assert.equal(again.fake.calls('gh').length, 0);
    });

    await test('a batch with one done and one failed comment marks only the failed one', async (t) => {
        const fixture = await newRunFixture(t);
        const second = baseComment({
            nodeId: 'PRRC_kwDOAbc457',
            dbId: 457,
            url: 'https://github.com/o/r/pull/12#discussion_r457',
        });
        await seedRun(fixture, { patch: { comments: [baseComment(), second] }, events: SETTLED });
        await startClaude(fixture, 'cooperative');
        answerPaneTag(fixture);
        const [first] = lookupWith({ plus1At: FRESH_PLUS1 }).entries;
        assert.ok(first !== undefined);
        const lookup: LookupResult = {
            ...lookupWith(),
            entries: [first, { ...first, nodeId: second.nodeId, dbId: 457, plus1At: undefined, eyes: false }],
        };
        const result = await evaluate(fixture, lookup);
        assert.deepEqual(result, { state: 'failed', reason: 'claude-took-failure-path' });
        const marked = thumbsDownAdds(fixture);
        assert.equal(marked.length, 1);
        assert.ok((marked[0]?.input ?? '').includes(second.nodeId));
        assert.ok(tmuxMessages(fixture).some((call) => call.args.some((arg) => arg.includes('comments 457'))));
    });

    await test('completed marks the pane on the record socket and frees the slot when marking fails', async (t) => {
        const fixture = await newRunFixture(t);
        await seedRun(fixture, { patch: { socket: WORKER_SOCKET }, events: SETTLED });
        await startClaude(fixture, 'cooperative');
        answerPaneTag(fixture);
        fixture.fake.respond('tmux', 'set-option', { code: 1, stderr: 'no such pane\n' });
        const result = await evaluate(fixture, lookupWith({ plus1At: FRESH_PLUS1 }));
        assert.equal(result.state, 'completed');
        const marks = doneMarks(fixture);
        assert.equal(marks.length, 1);
        assert.equal(socketOf(marks[0]), WORKER_SOCKET);
        assert.equal(lockExists(fixture, SESSION_KEY), false);
        assert.equal(runExists(fixture), false);
    });

    await test("the record's worktree key is released, not the session's", async (t) => {
        const fixture = await newRunFixture(t);
        const now = Math.floor(Date.now() / 1000);
        const otherRun = '20261002110000-1';
        assert.ok(acquireWorktreeLock(fixture.stateDir, SESSION_KEY, otherRun, process.pid, fixture.deps.log, now));
        await seedRun(fixture, { patch: { worktreeKey: OTHER_KEY }, events: SETTLED });
        await startClaude(fixture, 'cooperative');
        answerPaneTag(fixture);
        const result = await evaluate(fixture, lookupWith({ plus1At: FRESH_PLUS1 }));
        assert.equal(result.state, 'completed');
        assert.equal(lockExists(fixture, OTHER_KEY), false);
        assert.equal(worktreeLockHolder(fixture.stateDir, SESSION_KEY), otherRun);
    });
});

await describe('evaluateRun fail-closed cleanup', async () => {
    await test('an unreadable record keeps the slot and the lock and tells the owner once', async (t) => {
        const fixture = await newRunFixture(t);
        await seedRun(fixture, { events: SETTLED });
        const claude = await startClaude(fixture, 'cooperative');
        breakRecord(fixture);
        const terms = spyKills(t);
        const first = await evaluate(fixture, lookupWith({ plus1At: FRESH_PLUS1 }));
        const second = await evaluate(fixture, lookupWith({ plus1At: FRESH_PLUS1 }));
        assert.deepEqual(first, { state: 'needs_attention', reason: 'record-unreadable' });
        assert.deepEqual(second, first);
        assert.equal(tmuxMessages(fixture).length, 1);
        assert.deepEqual(terms(), []);
        assert.ok(pidAlive(claude));
        assert.ok(runExists(fixture));
        assert.equal(worktreeLockHolder(fixture.stateDir, SESSION_KEY), RUN_ID);
    });

    await test('a missing run directory keeps the lock and needs attention', async (t) => {
        const fixture = await newRunFixture(t);
        await seedRun(fixture, { events: SETTLED });
        const capture = captureRun(fixture.stateDir, RUN_ID);
        fs.rmSync(runDir(fixture.stateDir, RUN_ID), { recursive: true });
        const lookup = lookupWith({ plus1At: FRESH_PLUS1 });
        const result = await evaluateRun(fixture.deps, fixture.session, RUN_ID, capture, lookup, liveSignal());
        assert.deepEqual(result, { state: 'needs_attention', reason: 'run-missing' });
        assert.equal(worktreeLockHolder(fixture.stateDir, SESSION_KEY), RUN_ID);
        assert.equal(tmuxMessages(fixture).length, 1);
    });

    await test('a lock release that fails keeps the record, and the next evaluation retries', async (t) => {
        const fixture = await newRunFixture(t);
        await seedRun(fixture, { events: ['prompt'] });
        failLockRenames(t);
        const first = await evaluate(fixture, lookupWith({ eyes: false }));
        assert.deepEqual(first, { state: 'deferred', reason: 'lock-release-failed' });
        assert.ok(runExists(fixture));
        assert.equal(worktreeLockHolder(fixture.stateDir, SESSION_KEY), RUN_ID);
        assert.ok(fixture.deps.logLines.some((line) => line.includes('could not release the worktree lock')));
        t.mock.restoreAll();
        const second = await evaluate(fixture, lookupWith({ eyes: false }));
        assert.deepEqual(second, { state: 'exited', reason: 'claude-exited' });
        assert.equal(lockExists(fixture, SESSION_KEY), false);
        assert.equal(runExists(fixture), false);
    });

    await test('a stop during the EYES removal keeps record and lock', async (t) => {
        const fixture = await newRunFixture(t);
        await seedRun(fixture, { events: ['prompt'] });
        const controller = new AbortController();
        fixture.fake.respond('gh', 'PrwcRemoveReaction', () => {
            controller.abort();
            return { code: 143 };
        });
        const result = await evaluate(fixture, lookupWith({ eyes: true }), controller.signal);
        assert.deepEqual(result, { state: 'deferred', reason: 'stop-requested' });
        assert.equal(eyesRemovals(fixture).length, 1);
        assert.equal(fixture.fake.calls('tmux').length, 0);
        assert.ok(runExists(fixture));
        assert.equal(worktreeLockHolder(fixture.stateDir, SESSION_KEY), RUN_ID);
    });

    await test('a stop during the tmux pane marking keeps record and lock', async (t) => {
        const fixture = await newRunFixture(t);
        await seedRun(fixture, { events: ['prompt'] });
        const controller = new AbortController();
        fixture.fake.respond('tmux', 'display-message', () => {
            controller.abort();
            return { stdout: `${RUN_ID}\n` };
        });
        const result = await evaluate(fixture, lookupWith({ eyes: false }), controller.signal);
        assert.deepEqual(result, { state: 'deferred', reason: 'stop-requested' });
        const listings = fixture.fake.calls('tmux').filter((call) => call.key === 'list-panes');
        assert.equal(listings.length, 0);
        assert.equal(doneMarks(fixture).length, 0);
        assert.ok(runExists(fixture));
        assert.equal(worktreeLockHolder(fixture.stateDir, SESSION_KEY), RUN_ID);
    });

    await test('a claude.pid without a pid needs attention and signals nothing', async (t) => {
        const fixture = await newRunFixture(t);
        const panePid = fixture.env.spawnOrphan('sleep', ['300']);
        await seedRun(fixture, { patch: { panePid }, events: SETTLED });
        fs.writeFileSync(path.join(runDir(fixture.stateDir, RUN_ID), 'claude.pid'), 'garbage\n');
        const terms = spyKills(t);
        const result = await evaluate(fixture, lookupWith({ plus1At: FRESH_PLUS1 }));
        assert.deepEqual(result, { state: 'needs_attention', reason: 'claude-pid-unreadable' });
        assert.deepEqual(terms(), []);
        assert.ok(pidAlive(panePid));
        assert.equal(worktreeLockHolder(fixture.stateDir, SESSION_KEY), RUN_ID);
    });

    await test('an EIO on claude.pid of a live worker needs attention and signals nothing', async (t) => {
        const fixture = await newRunFixture(t);
        const panePid = fixture.env.spawnOrphan('sleep', ['300']);
        await seedRun(fixture, { patch: { panePid }, events: SETTLED });
        await startClaude(fixture, 'cooperative');
        failClaudePidReads(t, 'EIO');
        const terms = spyKills(t);
        const result = await evaluate(fixture, lookupWith({ plus1At: FRESH_PLUS1 }));
        assert.deepEqual(result, { state: 'needs_attention', reason: 'claude-pid-unreadable' });
        assert.deepEqual(terms(), []);
        assert.equal(worktreeLockHolder(fixture.stateDir, SESSION_KEY), RUN_ID);
    });

    await test('a claude.pid naming the pane process is never signalled', async (t) => {
        const fixture = await newRunFixture(t);
        await seedRun(fixture, { events: SETTLED });
        const claude = await startClaude(fixture, 'cooperative');
        mergeRecord(fixture.stateDir, RUN_ID, { panePid: claude });
        const terms = spyKills(t);
        const result = await evaluate(fixture, lookupWith({ plus1At: FRESH_PLUS1 }));
        assert.deepEqual(result, { state: 'needs_attention', reason: 'claude-pid-reused' });
        assert.deepEqual(terms(), []);
        assert.ok(pidAlive(claude));
        assert.equal(worktreeLockHolder(fixture.stateDir, SESSION_KEY), RUN_ID);
    });

    await test('an abandoned run is cleared once its worker is gone and its lock released', async (t) => {
        const fixture = await newRunFixture(t);
        const panePid = fixture.env.spawnOrphan('sleep', ['300']);
        await seedRun(fixture, {
            patch: { state: 'abandoned', reason: 'lock-release-failed', panePid },
            decision: 'none',
        });
        const alive = await evaluate(fixture, lookupWith());
        assert.deepEqual(alive, { state: 'deferred', reason: 'abandoned-worker-alive' });
        assert.equal(worktreeLockHolder(fixture.stateDir, SESSION_KEY), RUN_ID);
        fs.writeFileSync(path.join(runDir(fixture.stateDir, RUN_ID), 'exit_status'), 'cancelled');
        failLockRenames(t);
        const failing = await evaluate(fixture, lookupWith());
        assert.deepEqual(failing, { state: 'deferred', reason: 'lock-release-failed' });
        assert.ok(runExists(fixture));
        assert.equal(worktreeLockHolder(fixture.stateDir, SESSION_KEY), RUN_ID);
        t.mock.restoreAll();
        const finished = await evaluate(fixture, lookupWith());
        assert.deepEqual(finished, { state: 'exited', reason: 'abandoned' });
        assert.equal(lockExists(fixture, SESSION_KEY), false);
        assert.equal(runExists(fixture), false);
        assert.equal(fixture.fake.calls().length, 0);
    });

    await test('an abandoned run whose lock already belongs to another run is cleared', async (t) => {
        const fixture = await newRunFixture(t);
        await seedRun(fixture, { patch: { state: 'abandoned', reason: 'lock-release-failed' }, lock: false });
        const otherRun = '20261002110000-1';
        const now = Math.floor(Date.now() / 1000);
        assert.ok(acquireWorktreeLock(fixture.stateDir, SESSION_KEY, otherRun, process.pid, fixture.deps.log, now));
        const result = await evaluate(fixture, lookupWith());
        assert.deepEqual(result, { state: 'exited', reason: 'abandoned' });
        assert.equal(runExists(fixture), false);
        assert.equal(worktreeLockHolder(fixture.stateDir, SESSION_KEY), otherRun);
    });
});

async function brokenRun(t: TestContext, options?: { psPassthrough?: boolean; decision?: 'go' | 'none' }) {
    const fixture = await newRunFixture(t, { psPassthrough: options?.psPassthrough });
    await seedRun(fixture, { events: ['prompt'], decision: options?.decision ?? 'go' });
    return fixture;
}

function assertRecovered(fixture: RunFixture, result: { state: string; reason: string }): void {
    assert.deepEqual(result, { state: 'exited', reason: 'record-unreadable' });
    assert.equal(lockExists(fixture, SESSION_KEY), false);
    assert.equal(runExists(fixture), false);
    assert.ok(fixture.deps.logLines.some((line) => line.includes(`run ${RUN_ID} with an unreadable record`)));
}

function assertKept(
    fixture: RunFixture,
    result: { state: string; reason: string },
    reason = 'record-unreadable'
): void {
    assert.deepEqual(result, { state: 'needs_attention', reason });
    assert.ok(runExists(fixture));
    assert.equal(worktreeLockHolder(fixture.stateDir, SESSION_KEY), RUN_ID);
}

await describe('unreadable record recovery', async () => {
    await test('a dead claude without a tagged pane is finished', async (t) => {
        const fixture = await brokenRun(t);
        const claude = await startClaude(fixture, 'cooperative');
        process.kill(claude, 'SIGKILL');
        assert.ok(await waitUntil(5000, () => !pidAlive(claude)), 'the fake claude did not die');
        breakRecord(fixture);
        assertRecovered(fixture, await evaluate(fixture, lookupWith()));
        assert.equal(tmuxMessages(fixture).length, 0);
    });

    await test('a live claude pid with another start time keeps the slot and is never signalled', async (t) => {
        const fixture = await brokenRun(t);
        const claude = await startClaude(fixture, 'cooperative');
        fs.writeFileSync(path.join(runDir(fixture.stateDir, RUN_ID), 'claude.start'), 'Mon Jan  1 00:00:00 2001\n');
        breakRecord(fixture);
        const terms = spyKills(t);
        assertKept(fixture, await evaluate(fixture, lookupWith()), 'claude-pid-mismatch');
        assert.deepEqual(terms(), []);
        assert.ok(pidAlive(claude));
        assert.equal(tmuxMessages(fixture).length, 1);
    });

    await test('an EIO on claude.pid is not absence: the slot stays and no launch is cancelled', async (t) => {
        const fixture = await brokenRun(t, { decision: 'none' });
        breakRecord(fixture);
        failClaudePidReads(t, 'EIO');
        assertKept(fixture, await evaluate(fixture, lookupWith()));
        assert.equal(launchDecision(fixture.stateDir, RUN_ID), 'none');
    });

    await test('an EACCES on claude.pid of a dead claude keeps the slot', async (t) => {
        const fixture = await brokenRun(t, { decision: 'none' });
        const claude = await startClaude(fixture, 'cooperative');
        process.kill(claude, 'SIGKILL');
        assert.ok(await waitUntil(5000, () => !pidAlive(claude)), 'the fake claude did not die');
        breakRecord(fixture);
        failClaudePidReads(t, 'EACCES');
        assertKept(fixture, await evaluate(fixture, lookupWith()));
        assert.equal(launchDecision(fixture.stateDir, RUN_ID), 'none');
    });

    await test('a claude that never started is finished once its launch is cancelled', async (t) => {
        const fixture = await brokenRun(t, { decision: 'none' });
        breakRecord(fixture);
        assertRecovered(fixture, await evaluate(fixture, lookupWith()));
    });

    await test('with decision go and no claude.pid, only a recorded exit_status proves that claude never started', async (t) => {
        const fixture = await brokenRun(t);
        breakRecord(fixture);
        assertKept(fixture, await evaluate(fixture, lookupWith()));
        fs.writeFileSync(path.join(runDir(fixture.stateDir, RUN_ID), 'exit_status'), '1');
        assertRecovered(fixture, await evaluate(fixture, lookupWith()));
    });

    await test('a live claude keeps the slot', async (t) => {
        const fixture = await brokenRun(t);
        const claude = await startClaude(fixture, 'cooperative');
        breakRecord(fixture);
        assertKept(fixture, await evaluate(fixture, lookupWith()));
        assert.ok(pidAlive(claude));
    });

    await test('an unverifiable claude pid keeps the slot', async (t) => {
        const fixture = await brokenRun(t, { psPassthrough: false });
        await startClaude(fixture, 'cooperative');
        fixture.fake.respond('other', 'other', { code: 1, stdout: '' });
        breakRecord(fixture);
        assertKept(fixture, await evaluate(fixture, lookupWith()));
    });

    await test('a pane tagged with the run keeps the slot although claude is gone', async (t) => {
        const fixture = await brokenRun(t, { decision: 'none' });
        fixture.fake.respond('tmux', 'list-panes', { stdout: `%3 other-run\n%7 ${RUN_ID}\n` });
        breakRecord(fixture);
        assertKept(fixture, await evaluate(fixture, lookupWith()));
        assert.equal(launchDecision(fixture.stateDir, RUN_ID), 'none');
    });

    await test('a failed pane listing keeps the slot', async (t) => {
        const fixture = await brokenRun(t, { decision: 'none' });
        fixture.fake.respond('tmux', 'list-panes', { code: 1, stderr: 'no server running\n' });
        breakRecord(fixture);
        assertKept(fixture, await evaluate(fixture, lookupWith()));
    });

    await test('a stop during the pane listing defers with record and lock in place', async (t) => {
        const fixture = await brokenRun(t, { decision: 'none' });
        const controller = new AbortController();
        fixture.fake.respond('tmux', 'list-panes', () => {
            controller.abort();
            return { stdout: '' };
        });
        breakRecord(fixture);
        const result = await evaluate(fixture, lookupWith(), controller.signal);
        assert.deepEqual(result, { state: 'deferred', reason: 'stop-requested' });
        assert.ok(runExists(fixture));
        assert.equal(worktreeLockHolder(fixture.stateDir, SESSION_KEY), RUN_ID);
        assert.equal(launchDecision(fixture.stateDir, RUN_ID), 'none');
    });

    await test('a recovery whose lock release fails is retried', async (t) => {
        const fixture = await brokenRun(t, { decision: 'none' });
        breakRecord(fixture);
        failLockRenames(t);
        const first = await evaluate(fixture, lookupWith());
        assert.deepEqual(first, { state: 'deferred', reason: 'lock-release-failed' });
        assert.ok(runExists(fixture));
        t.mock.restoreAll();
        assertRecovered(fixture, await evaluate(fixture, lookupWith()));
    });
});
