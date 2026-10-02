import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { GRAPHQL_OPS, MIN_NODE_VERSION, STATE_FORMAT } from '../../src/constants.ts';

function majorMinor(version: string): [number, number] {
    const [major = '0', minor = '0'] = version.split('.');
    return [Number.parseInt(major, 10), Number.parseInt(minor, 10)];
}

await describe('toolchain', async () => {
    await test('runs on a Node at least as new as MIN_NODE_VERSION', () => {
        const [runMajor, runMinor] = majorMinor(process.versions.node);
        const [minMajor, minMinor] = majorMinor(MIN_NODE_VERSION);
        assert.ok(runMajor > minMajor || (runMajor === minMajor && runMinor >= minMinor));
    });

    await test('loads the shared constants through type stripping', () => {
        assert.equal(STATE_FORMAT, 1);
        assert.equal(GRAPHQL_OPS.poll, 'PrwcPoll');
    });
});
