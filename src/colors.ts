import type { Env, LogTone } from './types.ts';

export type LogLevel = 'info' | 'warn' | 'error';

export type PaintKind = 'time' | LogLevel | LogTone;

const CSI = '\u001B[';
const RESET = `${CSI}0m`;

// SGR parameters: 1 bold, 2 dim, 4 underline, 31 red, 32 green, 33 yellow, 34 blue, 35 magenta, 36 cyan.
const SGR: Readonly<Record<PaintKind, string>> = {
    time: '2',
    info: '36',
    warn: '33',
    error: '1;31',
    author: '1;35',
    link: '4;34',
    path: '36',
    run: '1',
    ok: '32',
    bad: '31',
    muted: '2',
    strong: '1',
};

// NO_COLOR (https://no-color.org) wins over everything, FORCE_COLOR wins over the terminal checks; otherwise colors
// need a terminal that is not dumb.
export function colorEnabled(stream: { isTTY?: boolean }, env: Env): boolean {
    const noColor = env.NO_COLOR;
    if (noColor !== undefined && noColor.length > 0) {
        return false;
    }
    const force = env.FORCE_COLOR;
    if (force !== undefined) {
        return force !== '0' && force !== 'false';
    }
    if (env.TERM === 'dumb') {
        return false;
    }
    return stream.isTTY === true;
}

export function paint(kind: PaintKind, text: string): string {
    return text.length === 0 ? text : `${CSI}${SGR[kind]}m${text}${RESET}`;
}
