import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createLogger } from '../../src/log.ts';

await describe('log', async () => {
    await test('writes UTC lines with a level', () => {
        const lines: string[] = [];
        const logger = createLogger(
            (line) => {
                lines.push(line);
            },
            () => new Date('2026-10-02T12:00:00.250Z')
        );
        logger.info('msg');
        logger.warn('careful');
        logger.error('broken');
        assert.deepEqual(lines, [
            '2026-10-02T12:00:00Z info msg',
            '2026-10-02T12:00:00Z warn careful',
            '2026-10-02T12:00:00Z error broken',
        ]);
    });
});
