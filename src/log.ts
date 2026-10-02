import type { Logger } from './types.ts';

type Level = 'info' | 'warn' | 'error';

function formatTime(date: Date): string {
    return `${date.toISOString().slice(0, 19)}Z`;
}

// Lines look like 2026-10-02T12:00:00Z info message (UTC, whole seconds).
export function createLogger(write: (_line: string) => void, clock: () => Date): Logger {
    const emit = (level: Level, message: string): void => {
        write(`${formatTime(clock())} ${level} ${message}`);
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
