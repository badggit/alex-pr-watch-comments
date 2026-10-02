// Pure checks on captured tmux pane text for the live smoke, kept apart from liveSmoke.ts so tests can import them
// without running the smoke.

const TRUST_CHOICE = 'trust this folder';
const TRUST_HEADINGS: readonly string[] = ['quick safety check', 'accessing workspace'];

// Claude Code's folder trust dialog: its "Yes, I trust this folder" choice together with one of its headings, so a
// pane that only quotes the choice (a comment body, say) does not match. Whitespace is collapsed first, since a
// narrow pane wraps the phrases.
export function trustDialogShown(paneText: string): boolean {
    const text = paneText.replaceAll(/\s+/gu, ' ').toLowerCase();
    return text.includes(TRUST_CHOICE) && TRUST_HEADINGS.some((heading) => text.includes(heading));
}
