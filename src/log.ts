import { paint, type LogLevel } from './colors.ts';
import { plainText } from './logParts.ts';
import type { LogMessage, LogPart, Logger } from './types.ts';

export interface LoggerOptions {
    color?: boolean;
}

function formatTime(date: Date): string {
    return `${date.toISOString().slice(0, 19)}Z`;
}

function paintPart(part: LogPart): string {
    return typeof part === 'string' ? part : paint(part.tone, part.text);
}

function paintMessage(message: LogMessage): string {
    return typeof message === 'string' ? message : message.map((part) => paintPart(part)).join('');
}

// Lines look like 2026-10-02T12:00:00Z info message (UTC, whole seconds). With color the same text gets SGR
// escapes around its parts, so stripping them gives the uncolored line.
export function createLogger(write: (_line: string) => void, clock: () => Date, options?: LoggerOptions): Logger {
    const color = options?.color === true;
    const emit = (level: LogLevel, message: LogMessage): void => {
        const time = formatTime(clock());
        write(
            color
                ? `${paint('time', time)} ${paint(level, level)} ${paintMessage(message)}`
                : `${time} ${level} ${plainText(message)}`
        );
    };
    return {
        info: (message) => {
            emit('info', message);
        },
        warn: (message) => {
            emit('warn', message);
        },
        error: (message) => {
            emit('error', message);
        },
    };
}
