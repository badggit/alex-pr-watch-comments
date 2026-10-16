import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createLogger, type LoggerOptions } from '../../src/log.ts';
import { plainText, toned } from '../../src/logParts.ts';
import type { Logger, LogPart } from '../../src/types.ts';

const ESC = '\u001B';
const SGR_TAIL = /^\[[\d;]*m/u;
const TIME = '2026-10-02T12:00:00Z';

// Removes every SGR sequence; the split keeps the control character out of the regular expression.
function stripSgr(line: string): string {
    return line
        .split(ESC)
        .map((piece, index) => (index === 0 ? piece : piece.replace(SGR_TAIL, '')))
        .join('');
}

function recorder(options?: LoggerOptions): { logger: Logger; lines: string[] } {
    const lines: string[] = [];
    const logger = createLogger(
        (line) => {
            lines.push(line);
        },
        () => new Date('2026-10-02T12:00:00.250Z'),
        options
    );
    return { logger, lines };
}

const DISPATCH_LINE: readonly LogPart[] = [
    '  ',
    toned('author', '@carol'),
    ' on ',
    toned('path', 'src/app.ts:7'),
    ', approved by ',
    toned('author', '@dave'),
    ': ',
    toned('link', 'https://github.com/o/r/pull/12#discussion_r103'),
];

await describe('log', async () => {
    await test('writes UTC lines with a level', () => {
        const { logger, lines } = recorder();
        logger.info('msg');
        logger.warn('careful');
        logger.error('broken');
        assert.deepEqual(lines, [`${TIME} info msg`, `${TIME} warn careful`, `${TIME} error broken`]);
    });

    await test('without color, parts print as their plain text', () => {
        const { logger, lines } = recorder({ color: false });
        logger.info(DISPATCH_LINE);
        assert.deepEqual(lines, [
            `${TIME} info   @carol on src/app.ts:7, approved by @dave: https://github.com/o/r/pull/12#discussion_r103`,
        ]);
    });

    await test('with color, time, level and tones get their SGR codes', () => {
        const { logger, lines } = recorder({ color: true });
        const time = `\u001B[2m${TIME}\u001B[0m`;
        logger.info('msg');
        logger.warn('careful');
        logger.error([toned('bad', 'failed'), ' ', toned('ok', 'done'), ' ', toned('muted', 'quiet')]);
        logger.info([toned('run', 'run 1'), ' ', toned('strong', '2 comments')]);
        assert.deepEqual(lines, [
            `${time} \u001B[36minfo\u001B[0m msg`,
            `${time} \u001B[33mwarn\u001B[0m careful`,
            `${time} \u001B[1;31merror\u001B[0m \u001B[31mfailed\u001B[0m \u001B[32mdone\u001B[0m \u001B[2mquiet\u001B[0m`,
            `${time} \u001B[36minfo\u001B[0m \u001B[1mrun 1\u001B[0m \u001B[1m2 comments\u001B[0m`,
        ]);
    });

    await test('author, path and link tones, and the visible text equals the plain line', () => {
        const colored = recorder({ color: true });
        const plain = recorder();
        colored.logger.info(DISPATCH_LINE);
        plain.logger.info(DISPATCH_LINE);
        const [line] = colored.lines;
        assert.ok(line !== undefined);
        assert.ok(line.includes('\u001B[1;35m@carol\u001B[0m'));
        assert.ok(line.includes('\u001B[36msrc/app.ts:7\u001B[0m'));
        assert.ok(line.includes('\u001B[4;34mhttps://github.com/o/r/pull/12#discussion_r103\u001B[0m'));
        assert.deepEqual(
            colored.lines.map((item) => stripSgr(item)),
            plain.lines
        );
    });

    await test('plainText joins the parts and keeps a string as it is', () => {
        assert.equal(plainText('a b'), 'a b');
        assert.equal(plainText(['run ', toned('run', '7'), ' ok']), 'run 7 ok');
    });
});
