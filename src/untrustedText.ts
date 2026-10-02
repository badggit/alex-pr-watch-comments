const TAB = 0x09;
const FIRST_PRINTABLE = 0x20;
const DELETE = 0x7f;
const LAST_C1 = 0x9f;
const BACKSLASH = '\\';
const HEX_WIDTH = 4;

// Every character that some reader (Unicode line breaking, Python splitlines, terminals) ends a line on.
const LINE_BREAKS: ReadonlySet<string> = new Set([
    '\n',
    '\u000B',
    '\f',
    '\r',
    '\u001C',
    '\u001D',
    '\u001E',
    '\u0085',
    '\u2028',
    '\u2029',
]);

// Bidi marks, embeddings, overrides and isolates: they reorder how the surrounding text is displayed.
const FORMAT_CONTROLS: ReadonlySet<string> = new Set([
    '\u061C',
    '\u200E',
    '\u200F',
    '\u202A',
    '\u202B',
    '\u202C',
    '\u202D',
    '\u202E',
    '\u2066',
    '\u2067',
    '\u2068',
    '\u2069',
]);

function needsEscape(character: string, code: number): boolean {
    if (code < FIRST_PRINTABLE) {
        return code !== TAB;
    }
    return (code >= DELETE && code <= LAST_C1) || LINE_BREAKS.has(character) || FORMAT_CONTROLS.has(character);
}

function escapeCharacter(character: string): string {
    const code = character.codePointAt(0) ?? 0;
    return needsEscape(character, code)
        ? `${BACKSLASH}u${code.toString(16).toUpperCase().padStart(HEX_WIDTH, '0')}`
        : character;
}

// Replaces every control, line break and bidi format character with a visible \uXXXX escape; TAB stays.
export function visibleText(value: string): string {
    let text = '';
    for (const character of value) {
        text += escapeCharacter(character);
    }
    return text;
}

// The lines of untrusted text: CRLF and every character of LINE_BREAKS end a line.
function splitLines(value: string): string[] {
    const lines: string[] = [];
    let current = '';
    for (const character of value.replaceAll('\r\n', '\n')) {
        if (LINE_BREAKS.has(character)) {
            lines.push(current);
            current = '';
        } else {
            current += escapeCharacter(character);
        }
    }
    lines.push(current);
    return lines;
}

// Every line is quoted with "> " (an empty line with ">") and holds no raw control, so untrusted text can neither
// forge a frame line under any line-splitting rule nor send terminal escape sequences.
export function quoteUntrusted(value: string): string[] {
    return splitLines(value).map((line) => (line.length === 0 ? '>' : `> ${line}`));
}

// One-line form of an untrusted value: a JSON string whose remaining raw controls are escaped as well.
export function inlineUntrusted(value: string): string {
    return visibleText(JSON.stringify(value));
}
