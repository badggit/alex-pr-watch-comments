import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { colorEnabled, paint } from '../../src/colors.ts';

const TTY = { isTTY: true };
const PIPE = { isTTY: false };

await describe('colorEnabled', async () => {
    await test('a terminal gets colors, a pipe or a stream without isTTY does not', () => {
        assert.equal(colorEnabled(TTY, {}), true);
        assert.equal(colorEnabled(PIPE, {}), false);
        assert.equal(colorEnabled({}, {}), false);
    });

    await test('a non-empty NO_COLOR turns colors off, even with FORCE_COLOR', () => {
        assert.equal(colorEnabled(TTY, { NO_COLOR: '1' }), false);
        assert.equal(colorEnabled(TTY, { NO_COLOR: '1', FORCE_COLOR: '1' }), false);
        assert.equal(colorEnabled(TTY, { NO_COLOR: '' }), true);
    });

    await test('FORCE_COLOR wins over the terminal checks; 0 and false turn colors off', () => {
        assert.equal(colorEnabled(PIPE, { FORCE_COLOR: '1' }), true);
        assert.equal(colorEnabled(PIPE, { FORCE_COLOR: '' }), true);
        assert.equal(colorEnabled(PIPE, { FORCE_COLOR: '3', TERM: 'dumb' }), true);
        assert.equal(colorEnabled(TTY, { FORCE_COLOR: '0' }), false);
        assert.equal(colorEnabled(TTY, { FORCE_COLOR: 'false' }), false);
    });

    await test('a dumb terminal gets no colors', () => {
        assert.equal(colorEnabled(TTY, { TERM: 'dumb' }), false);
        assert.equal(colorEnabled(TTY, { TERM: 'xterm-256color' }), true);
    });
});

await describe('paint', async () => {
    await test('wraps text in one SGR code and a reset; empty text stays empty', () => {
        assert.equal(paint('ok', 'done'), '\u001B[32mdone\u001B[0m');
        assert.equal(paint('link', ''), '');
    });
});
