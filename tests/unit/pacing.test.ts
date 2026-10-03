import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { clockJumped, nextDelay } from '../../src/pacing.ts';

const NOW = 1_790_000_000;
const RESERVE = 500;

await describe('nextDelay', async () => {
    await test('a healthy budget and no failures keep the base interval', () => {
        assert.deepEqual(nextDelay(15, 0, { remaining: 4000, resetAt: NOW + 900 }, NOW, RESERVE), {
            delaySeconds: 15,
            mode: 'normal',
        });
    });

    await test('failures back off exponentially', () => {
        assert.deepEqual(nextDelay(15, 3, { remaining: 4000, resetAt: NOW + 900 }, NOW, RESERVE), {
            delaySeconds: 120,
            mode: 'backoff',
        });
    });

    await test('backoff is capped, also for very large failure counters', () => {
        for (const failures of [10, 100, 10_000]) {
            assert.deepEqual(
                nextDelay(15, failures, { remaining: 4000, resetAt: NOW + 900 }, NOW, RESERVE),
                { delaySeconds: 300, mode: 'backoff' },
                `failures ${failures}`
            );
        }
    });

    await test('a budget below the reserve waits for the reset', () => {
        assert.deepEqual(nextDelay(15, 0, { remaining: 100, resetAt: NOW + 900 }, NOW, RESERVE), {
            delaySeconds: 900,
            mode: 'throttled',
        });
    });

    await test('throttling wins over backoff', () => {
        assert.deepEqual(nextDelay(15, 3, { remaining: 100, resetAt: NOW + 900 }, NOW, RESERVE), {
            delaySeconds: 900,
            mode: 'throttled',
        });
    });

    await test('a reset that already passed throttles for the base interval', () => {
        assert.deepEqual(nextDelay(15, 0, { remaining: 100, resetAt: NOW - 60 }, NOW, RESERVE), {
            delaySeconds: 15,
            mode: 'throttled',
        });
    });

    await test('an unknown reset time throttles for the base interval', () => {
        assert.deepEqual(nextDelay(15, 0, { remaining: 100, resetAt: undefined }, NOW, RESERVE), {
            delaySeconds: 15,
            mode: 'throttled',
        });
    });

    await test('the throttle delay is capped', () => {
        assert.deepEqual(nextDelay(15, 0, { remaining: 0, resetAt: NOW + 86_400 }, NOW, RESERVE), {
            delaySeconds: 3600,
            mode: 'throttled',
        });
    });

    await test('an unknown remaining budget never throttles', () => {
        assert.deepEqual(nextDelay(15, 0, { remaining: undefined, resetAt: NOW + 900 }, NOW, RESERVE), {
            delaySeconds: 15,
            mode: 'normal',
        });
        assert.deepEqual(nextDelay(15, 2, { remaining: undefined, resetAt: undefined }, NOW, RESERVE), {
            delaySeconds: 60,
            mode: 'backoff',
        });
    });

    await test('backoff is never shorter than a base above the cap', () => {
        for (const base of [600, 900, 86_400]) {
            for (const failures of [1, 3, 8, 9, 100]) {
                assert.deepEqual(
                    nextDelay(base, failures, { remaining: 4000, resetAt: NOW + 900 }, NOW, RESERVE),
                    { delaySeconds: base, mode: 'backoff' },
                    `base ${base} failures ${failures}`
                );
            }
        }
    });

    await test('backoff keeps doubling a base below the cap until the cap', () => {
        assert.deepEqual(nextDelay(200, 1, { remaining: 4000, resetAt: NOW + 900 }, NOW, RESERVE), {
            delaySeconds: 300,
            mode: 'backoff',
        });
    });

    await test('throttling is never shorter than the base interval', () => {
        const cases: { base: number; resetIn: number; expected: number }[] = [
            { base: 600, resetIn: 900, expected: 900 },
            { base: 600, resetIn: 300, expected: 600 },
            { base: 600, resetIn: -60, expected: 600 },
            { base: 900, resetIn: 300, expected: 900 },
            { base: 900, resetIn: 86_400, expected: 3600 },
            { base: 86_400, resetIn: 900, expected: 86_400 },
            { base: 86_400, resetIn: 172_800, expected: 86_400 },
        ];
        for (const { base, resetIn, expected } of cases) {
            assert.deepEqual(
                nextDelay(base, 0, { remaining: 100, resetAt: NOW + resetIn }, NOW, RESERVE),
                { delaySeconds: expected, mode: 'throttled' },
                `base ${base} reset in ${resetIn}`
            );
        }
        assert.deepEqual(nextDelay(86_400, 0, { remaining: 100, resetAt: undefined }, NOW, RESERVE), {
            delaySeconds: 86_400,
            mode: 'throttled',
        });
    });

    await test('a budget exactly at the reserve does not throttle', () => {
        assert.deepEqual(nextDelay(15, 0, { remaining: RESERVE, resetAt: NOW + 900 }, NOW, RESERVE), {
            delaySeconds: 15,
            mode: 'normal',
        });
    });
});

await describe('clockJumped', async () => {
    await test('a gap far beyond the planned delay is a clock jump', () => {
        assert.equal(clockJumped(1000, 2000, 15), true);
    });

    await test('a normal gap is not a clock jump', () => {
        assert.equal(clockJumped(1000, 1020, 15), false);
    });

    await test('the threshold is three planned delays plus 30 seconds', () => {
        assert.equal(clockJumped(1000, 1075, 15), false);
        assert.equal(clockJumped(1000, 1076, 15), true);
    });
});
