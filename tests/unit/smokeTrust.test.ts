import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { trustDialogShown } from '../../scripts/smoke/paneChecks.ts';

// A sanitized capture of the Claude Code folder trust dialog: the workspace path is a placeholder and the
// non-ASCII glyphs of the real screen are written as escapes.
const TRUST_DIALOG = [
    ' Accessing workspace:',
    ' /path/to/project',
    " Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not, take a moment to review what's in this",
    ' folder first.',
    " Claude Code'll be able to read, edit, and execute files here.",
    ' Security guide',
    ' \u276F No, exit',
    '   Yes, I trust this folder',
    ' Enter to confirm \u00B7 Esc to cancel',
    '',
].join('\n');

const WORKING_PANE = [
    '> Resolve the inline review comment below.',
    '',
    '\u23FA Update(smoke/scratch.txt)',
    '  Updated smoke/scratch.txt with 1 addition and 1 removal',
    '\u23FA Bash(git status --short)',
    '  M smoke/scratch.txt',
    '',
].join('\n');

const STUB_PANE = [
    'ran: gh api -X POST repos/o/r/pulls/12/comments/456/replies --hostname github.com -F body=@reply.md',
    'ran: gh api graphql --hostname github.com -F query=@gql/remove-eyes.graphql',
    'ran: gh api graphql --hostname github.com -F query=@gql/add-plus1.graphql',
    '',
].join('\n');

await describe('trustDialogShown', async () => {
    await test('detects the folder trust dialog', () => {
        assert.equal(trustDialogShown(TRUST_DIALOG), true);
    });

    await test('detects the dialog when a narrow pane wrapped its lines', () => {
        const wrapped = TRUST_DIALOG.replace('Quick safety', 'Quick\nsafety').replace('trust this', 'trust\nthis');
        assert.equal(trustDialogShown(wrapped), true);
    });

    await test('detects the dialog by its workspace heading alone', () => {
        const withoutCheck = TRUST_DIALOG.replace('Quick safety check:', 'Check:');
        assert.equal(trustDialogShown(withoutCheck), true);
    });

    await test('ignores a working claude pane', () => {
        assert.equal(trustDialogShown(WORKING_PANE), false);
    });

    await test('ignores the stub claude output', () => {
        assert.equal(trustDialogShown(STUB_PANE), false);
    });

    await test('ignores the trust phrase without a dialog heading', () => {
        assert.equal(trustDialogShown(`${WORKING_PANE}A comment that says: Yes, I trust this folder.\n`), false);
    });

    await test('ignores an empty pane', () => {
        assert.equal(trustDialogShown(''), false);
    });
});
