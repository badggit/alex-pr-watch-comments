import type { LogMessage, LogPart, LogTone } from './types.ts';

export function toned(tone: LogTone, text: string): LogPart {
    return { text, tone };
}

function partText(part: LogPart): string {
    return typeof part === 'string' ? part : part.text;
}

// The text a reader sees, without any highlighting.
export function plainText(message: LogMessage): string {
    return typeof message === 'string' ? message : message.map((part) => partText(part)).join('');
}
