import type { Env } from './types.ts';

const NAME = /^[\w.-]+$/u;
const BRANCH = /^[\w./-]+$/u;
const NODE_ID = /^[\w=-]+$/u;
const SHA = /^[\da-f]{40}$/u;
const UINT = /^\d{1,15}$/u;
const HOST_LABEL = String.raw`[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?`;
// A lowercase DNS name with at least two labels: github.com or a GitHub Enterprise Server host. No port, no user.
export const HOST_PATTERN = String.raw`${HOST_LABEL}(?:\.${HOST_LABEL})+`;
const HOST = new RegExp(`^${HOST_PATTERN}$`, 'u');
const URL_HOST = new RegExp(`^https://(${HOST_PATTERN})/`, 'u');
const RUN_PATH = /^\/[\w./+-]*$/u;
const SOCKET_PATH = /^\/[\w./-]*$/u;
const UNSAFE_TEXT = /[^\w .,:/+()=-]/gu;
const SAFE_TEXT_LIMIT = 200;
const FIRST_PRINTABLE = 32;
const DELETE = 127;
// Node timers overflow above 2^31-1 milliseconds and then fire after 1 ms, so larger values would spin a loop.
const MAX_ENV_SECONDS = 2_147_483;

// Owner, repository and remote names.
export function isValidName(value: string): boolean {
    return NAME.test(value) && !value.startsWith('-') && !value.startsWith('.');
}

export function isValidHost(value: string): boolean {
    return HOST.test(value);
}

// The host of an https:// URL already in canonical (lowercase) form, else undefined.
export function urlHost(url: string): string | undefined {
    return URL_HOST.exec(url)?.[1];
}

export function isValidBranch(value: string): boolean {
    return (
        BRANCH.test(value) &&
        !value.includes('..') &&
        !value.startsWith('-') &&
        !value.startsWith('/') &&
        !value.endsWith('/') &&
        !value.endsWith('.lock')
    );
}

export function isValidNodeId(value: string): boolean {
    return NODE_ID.test(value);
}

export function isValidSha(value: string): boolean {
    return SHA.test(value);
}

export function isUintString(value: string): boolean {
    return UINT.test(value);
}

// For the state and run directories: their paths go unquoted into hook commands and permission rules.
export function isSafeRunPath(value: string): boolean {
    return RUN_PATH.test(value);
}

// For tool paths and the gh config directory, which only travel as literal arguments or quoted words.
export function isSafeAbsPath(value: string): boolean {
    if (!value.startsWith('/')) {
        return false;
    }
    for (const character of value) {
        const code = character.codePointAt(0) ?? 0;
        if (code < FIRST_PRINTABLE || code === DELETE) {
            return false;
        }
    }
    return true;
}

export function isSafeSocketPath(value: string): boolean {
    return SOCKET_PATH.test(value);
}

// Makes any text that is not a validated identifier safe to show in tmux, logs or --list.
export function safeText(value: string): string {
    return value.replaceAll(UNSAFE_TEXT, '?').slice(0, SAFE_TEXT_LIMIT);
}

// One POSIX single-quoted shell word.
export function shQuote(value: string): string {
    return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}

// A positive integer from the environment no larger than MAX_ENV_SECONDS, else the fallback.
export function readEnvSeconds(env: Env, name: string, fallback: number): number {
    const value = env[name];
    if (value === undefined || !isUintString(value)) {
        return fallback;
    }
    const seconds = Number.parseInt(value, 10);
    return seconds > 0 && seconds <= MAX_ENV_SECONDS ? seconds : fallback;
}
