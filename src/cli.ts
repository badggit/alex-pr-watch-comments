import path from 'node:path';

import { DEFAULT_BATCH_MAX, DEFAULT_INTERVAL, DEFAULT_KEEP_PANES, GITHUB_HOST, MAX_BATCH } from './constants.ts';
import type { CliMode, CliOptions, PrRef } from './types.ts';
import { HOST_PATTERN, isUintString, isValidName, safeText } from './validate.ts';

export type ParseResult = { kind: 'ok'; options: CliOptions } | { kind: 'help' } | { kind: 'error'; message: string };

interface Draft {
    background: boolean;
    list: boolean;
    once: boolean;
    stop: string | undefined;
    positionals: string[];
    dir: string;
    interval: number;
    keepPanes: number;
    batchMax: number;
    claude: string | undefined;
    claudeArgs: string[];
}

const PR_URL = new RegExp(
    String.raw`^https://(${HOST_PATTERN})/([^/?#]+)/([^/?#]+)/pull/([1-9]\d{0,9})(?:[/?#].*)?$`,
    'iu'
);
const LINE_BREAK = /[\n\r]/u;
const FLAG_OPTIONS: ReadonlySet<string> = new Set(['--background', '--list', '--once']);
const VALUE_OPTIONS: ReadonlySet<string> = new Set([
    '--stop',
    '--dir',
    '--interval',
    '--claude',
    '--claude-arg',
    '--keep-panes',
    '--batch-max',
]);
// One day; also keeps the sleep far below the 2^31-1 ms limit above which Node timers fire at once.
const MAX_INTERVAL = 86_400;

// Accepts https://HOST/OWNER/REPO/pull/NUMBER plus an optional suffix starting with /, ? or #, where HOST is
// github.com or a GitHub Enterprise Server host.
export function parsePrUrl(url: string): PrRef | undefined {
    const match = PR_URL.exec(url);
    if (match === null) {
        return;
    }
    const [, rawHost = '', rawOwner = '', rawRepo = '', digits = ''] = match;
    if (!isValidName(rawOwner) || !isValidName(rawRepo)) {
        return;
    }
    const host = rawHost.toLowerCase();
    const owner = rawOwner.toLowerCase();
    const repo = rawRepo.toLowerCase();
    const number = Number.parseInt(digits, 10);
    const key = `${owner}+${repo}+${number}`;
    return {
        host,
        owner,
        repo,
        number,
        prUrl: `https://${host}/${owner}/${repo}/pull/${number}`,
        prKey: host === GITHUB_HOST ? key : `${host}+${key}`,
    };
}

function failure(message: string): ParseResult {
    return { kind: 'error', message };
}

function parseCount(value: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number | undefined {
    if (!isUintString(value)) {
        return;
    }
    const count = Number.parseInt(value, 10);
    return count >= minimum && count <= maximum ? count : undefined;
}

// Returns an error message, or undefined when the value was applied.
function applyValue(draft: Draft, name: string, value: string, cwd: string): string | undefined {
    switch (name) {
        case '--stop': {
            if (draft.stop !== undefined) {
                return '--stop can be given only once';
            }
            draft.stop = value;
            return;
        }
        case '--dir': {
            if (value.length === 0) {
                return 'missing value for --dir';
            }
            draft.dir = path.resolve(cwd, value);
            return;
        }
        case '--interval': {
            const interval = parseCount(value, 1, MAX_INTERVAL);
            if (interval === undefined) {
                return `--interval needs a whole number of seconds from 1 to ${MAX_INTERVAL}`;
            }
            draft.interval = interval;
            return;
        }
        case '--keep-panes': {
            const keepPanes = parseCount(value, 0);
            if (keepPanes === undefined) {
                return '--keep-panes needs a whole number, 0 or more';
            }
            draft.keepPanes = keepPanes;
            return;
        }
        case '--batch-max': {
            const batchMax = parseCount(value, 1, MAX_BATCH);
            if (batchMax === undefined) {
                return `--batch-max needs a whole number from 1 to ${MAX_BATCH}`;
            }
            draft.batchMax = batchMax;
            return;
        }
        case '--claude': {
            if (value.length === 0) {
                return 'missing value for --claude';
            }
            draft.claude = value;
            return;
        }
        case '--claude-arg': {
            if (LINE_BREAK.test(value)) {
                return '--claude-arg values cannot contain a newline or carriage return';
            }
            draft.claudeArgs.push(value);
            return;
        }
        default: {
            return `unknown option: ${safeText(name)}`;
        }
    }
}

function applyFlag(draft: Draft, name: string): void {
    switch (name) {
        case '--background': {
            draft.background = true;
            break;
        }
        case '--list': {
            draft.list = true;
            break;
        }
        case '--once': {
            draft.once = true;
            break;
        }
    }
}

function findConflict(draft: Draft): string | undefined {
    const stop = draft.stop !== undefined;
    if (draft.list && stop) {
        return '--list cannot be combined with --stop';
    }
    if (draft.background && (draft.list || stop)) {
        return '--background cannot be combined with --list or --stop';
    }
    if (draft.once && draft.background) {
        return '--once cannot be combined with --background';
    }
    if (draft.list && draft.positionals.length > 0) {
        return '--list does not take a PR URL';
    }
    return;
}

function selectMode(draft: Draft): CliMode {
    if (draft.stop !== undefined) {
        return 'stop';
    }
    if (draft.list) {
        return 'list';
    }
    return draft.background ? 'background' : 'watch';
}

function toResult(draft: Draft, mode: CliMode, pr?: PrRef): ParseResult {
    return {
        kind: 'ok',
        options: {
            mode,
            pr,
            dir: draft.dir,
            interval: draft.interval,
            claude: draft.claude,
            claudeArgs: draft.claudeArgs,
            keepPanes: draft.keepPanes,
            batchMax: draft.batchMax,
            once: draft.once,
        },
    };
}

function finish(draft: Draft): ParseResult {
    const conflict = findConflict(draft);
    if (conflict !== undefined) {
        return failure(conflict);
    }
    const mode = selectMode(draft);
    if (mode === 'list') {
        return toResult(draft, mode);
    }
    const [first, second] = draft.positionals;
    const url = mode === 'stop' ? draft.stop : first;
    const extra = mode === 'stop' ? first : second;
    if (extra !== undefined) {
        return failure(`unexpected argument: ${safeText(extra)}`);
    }
    if (url === undefined) {
        return failure('missing PR URL');
    }
    const pr = parsePrUrl(url);
    if (pr === undefined) {
        return failure(`invalid PR URL: ${safeText(url)} (expected https://HOST/OWNER/REPO/pull/NUMBER)`);
    }
    return toResult(draft, mode, pr);
}

export function parseArgs(argv: readonly string[], cwd: string): ParseResult {
    const draft: Draft = {
        background: false,
        list: false,
        once: false,
        stop: undefined,
        positionals: [],
        dir: cwd,
        interval: DEFAULT_INTERVAL,
        keepPanes: DEFAULT_KEEP_PANES,
        batchMax: DEFAULT_BATCH_MAX,
        claude: undefined,
        claudeArgs: [],
    };
    const queue = [...argv];
    for (let arg = queue.shift(); arg !== undefined; arg = queue.shift()) {
        if (arg === '--help') {
            return { kind: 'help' };
        }
        if (VALUE_OPTIONS.has(arg)) {
            const value = queue.shift();
            if (value === undefined) {
                return failure(`missing value for ${arg}`);
            }
            const message = applyValue(draft, arg, value, cwd);
            if (message !== undefined) {
                return failure(message);
            }
        } else if (FLAG_OPTIONS.has(arg)) {
            applyFlag(draft, arg);
        } else if (arg.startsWith('-')) {
            return failure(`unknown option: ${safeText(arg)}`);
        } else {
            draft.positionals.push(arg);
        }
    }
    return finish(draft);
}

export function usageText(): string {
    return [
        'Usage:',
        '  alex-pr-watch-comments <PR URL> [options]               watch in the foreground of the current tmux pane',
        '  alex-pr-watch-comments <PR URL> --background [options]  watch in a detached tmux window',
        '  alex-pr-watch-comments --list                           list watchers and runs',
        '  alex-pr-watch-comments --stop <PR URL>                  stop the watcher for a PR (a running worker is kept)',
        '  alex-pr-watch-comments --help                           show this help',
        '',
        'Options:',
        '  --dir <path>          project directory (default: current directory)',
        `  --interval <seconds>  how often to look for new rockets, 1 to ${MAX_INTERVAL} (default ${DEFAULT_INTERVAL})`,
        '  --claude <path>       claude executable (default: found on PATH at start)',
        '  --claude-arg <arg>    extra claude argument, repeatable, passed literally',
        `  --keep-panes <n>      finished worker panes to keep (default ${DEFAULT_KEEP_PANES})`,
        `  --batch-max <n>       approved comments per run, 1 to ${MAX_BATCH} (default ${DEFAULT_BATCH_MAX})`,
        '  --once                one polling pass, then exit (not with --background)',
        '',
    ].join('\n');
}
