import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { EXCLUDE_HEADER, hasControlCharacter, LEGACY_EXCLUDE_HEADER } from '../../src/ignoredLinks.ts';

await describe('ignoredLinks', async () => {
    await test('hasControlCharacter finds line breaks, escapes and delete', () => {
        for (const rel of ['a\nb', 'a\rb', 'a\u001Bb', 'a\u007Fb', '\tlead', 'trail\u0000']) {
            assert.ok(hasControlCharacter(rel), JSON.stringify(rel));
        }
    });

    await test('hasControlCharacter accepts ordinary names', () => {
        for (const rel of ['node_modules', 'docs.local', 'with space', 'caf\u00E9', 'dir/sub name', '']) {
            assert.ok(!hasControlCharacter(rel), JSON.stringify(rel));
        }
    });

    await test('the exclude headers are distinct comment lines', () => {
        assert.notEqual(EXCLUDE_HEADER, LEGACY_EXCLUDE_HEADER);
        for (const header of [EXCLUDE_HEADER, LEGACY_EXCLUDE_HEADER]) {
            assert.ok(header.startsWith('# alex-pr-watch-comments: '), header);
            assert.ok(!hasControlCharacter(header), header);
        }
    });
});
