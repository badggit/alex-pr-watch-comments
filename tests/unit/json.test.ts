import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
    getArray,
    getBoolean,
    getNumber,
    getPath,
    getRecord,
    getString,
    isoToEpoch,
    isRecord,
    parseJson,
} from '../../src/json.ts';

await describe('json', async () => {
    await test('parseJson returns undefined on a syntax error', () => {
        assert.equal(parseJson('{'), undefined);
        assert.deepEqual(parseJson('{"a":1}'), { a: 1 });
    });

    await test('isRecord accepts plain objects only', () => {
        assert.ok(isRecord({ a: 1 }));
        assert.ok(isRecord(parseJson('{"a":1}')));
        assert.ok(!isRecord([]));
        assert.ok(!isRecord(parseJson('null')));
        assert.ok(!isRecord(parseJson('{')));
        assert.ok(!isRecord('x'));
        assert.ok(!isRecord(new Date()));
        assert.ok(!isRecord(new Map()));
        assert.ok(!isRecord(new Set()));
        assert.ok(!isRecord(/x/u));
        assert.ok(!isRecord(new (class Thing {})()));
    });

    await test('isRecord accepts an object without a prototype', () => {
        const bare: unknown = Object.create(null);
        assert.ok(isRecord(bare));
    });

    await test('typed getters narrow by type', () => {
        const value = parseJson('{"s":"x","n":3,"b":true,"a":[1,"y"],"r":{"k":1}}');
        assert.equal(getString(value, 's'), 'x');
        assert.equal(getString(value, 'n'), undefined);
        assert.equal(getNumber(value, 'n'), 3);
        assert.equal(getNumber(value, 's'), undefined);
        assert.equal(getBoolean(value, 'b'), true);
        assert.equal(getBoolean(value, 'n'), undefined);
        assert.deepEqual(getArray(value, 'a'), [1, 'y']);
        assert.equal(getArray(value, 'r'), undefined);
        assert.deepEqual(getRecord(value, 'r'), { k: 1 });
        assert.equal(getRecord(value, 'a'), undefined);
        assert.equal(getString('not an object', 's'), undefined);
        assert.equal(getRecord(value, 'constructor'), undefined);
    });

    await test('getPath walks nested objects and arrays', () => {
        const value = parseJson('{"a":{"b":[{"c":"deep"}]}}');
        assert.equal(getPath(value, 'a', 'b', 0, 'c'), 'deep');
        assert.equal(getPath(value, 'a', 'missing', 'c'), undefined);
        assert.equal(getPath(value, 'a', 0), undefined);
        assert.equal(getPath(value, 'a', 'b', 5), undefined);
        assert.equal(getPath(value, '__proto__'), undefined);
        assert.equal(getPath(value), value);
    });

    await test('isoToEpoch converts ISO strings to whole seconds', () => {
        assert.equal(isoToEpoch('2026-10-02T12:00:00Z'), 1_790_942_400);
        assert.equal(isoToEpoch('2026-10-02T12:00:00.999Z'), 1_790_942_400);
        assert.equal(isoToEpoch('nope'), undefined);
        assert.equal(isoToEpoch(1_790_942_400), undefined);
        assert.equal(isoToEpoch('2026-13-45T12:00:00Z'), undefined);
        assert.equal(isoToEpoch('2026-10-02T14:00:00+02:00'), 1_790_942_400);
    });

    await test('isoToEpoch refuses dates that do not exist instead of rolling them over', () => {
        for (const bad of [
            '2026-02-31T12:00:00Z',
            '2026-02-29T12:00:00Z',
            '1900-02-29T12:00:00Z',
            '2026-04-31T12:00:00Z',
            '2026-13-01T12:00:00Z',
            '2026-00-10T12:00:00Z',
            '2026-10-00T12:00:00Z',
            '2026-10-02T24:00:00Z',
            '2026-10-02T12:60:00Z',
            '2026-10-02T12:00:60Z',
            '2026-10-02T12:00:00+24:00',
            '2026-10-02T12:00:00+02:60',
        ]) {
            assert.equal(isoToEpoch(bad), undefined, bad);
        }
    });

    await test('isoToEpoch accepts real leap days and month ends', () => {
        assert.equal(isoToEpoch('2028-02-29T00:00:00Z'), 1_835_395_200);
        assert.equal(isoToEpoch('2000-02-29T00:00:00Z'), 951_782_400);
        assert.equal(isoToEpoch('2026-12-31T23:59:59Z'), 1_798_761_599);
    });
});
