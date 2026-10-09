import fs from 'node:fs';
import path from 'node:path';

import type { CommandRunner, Env } from './types.ts';

export interface AttachTarget {
    tmuxPath: string;
    socket: string;
    sessionName: string;
}

export interface GhosttyHost {
    platform: NodeJS.Platform;
    home: string | undefined;
}

// unavailable: not macOS, or no Ghostty app bundle; failed: osascript ran but did not open the tab.
export type GhosttyTabResult = 'opened' | 'unavailable' | 'failed';

const OSASCRIPT = '/usr/bin/osascript';
const OSASCRIPT_ENV: Env = { LC_ALL: 'C', PATH: '/usr/bin:/bin' };
// The first call may wait on the macOS automation permission prompt.
const OSASCRIPT_TIMEOUT_MS = 60_000;
const APP_BUNDLE = 'Ghostty.app';
// Every word of the tab command must match this, so it reads the same whether Ghostty runs it through a shell or
// directly, and no quoting is ever needed.
const PLAIN_WORD = /^[\w./=-]+$/u;
// The command reaches AppleScript as an argument, never as script text. Ghostty 1.3 added AppleScript; an older
// Ghostty fails to compile the script and the result is 'failed'.
const SCRIPT = [
    'on run argv',
    'tell application id "com.mitchellh.ghostty"',
    'set cfg to new surface configuration',
    'set command of cfg to item 1 of argv',
    'if (count of windows) > 0 then',
    'new tab in front window with configuration cfg',
    'else',
    'new window with configuration cfg',
    'end if',
    'end tell',
    'end run',
];

// A missing app must be caught before osascript runs: AppleScript asks the user to locate an unknown application.
function ghosttyInstalled(host: GhosttyHost): boolean {
    const dirs = ['/Applications', ...(host.home === undefined ? [] : [path.join(host.home, 'Applications')])];
    return dirs.some((dir) => fs.existsSync(path.join(dir, APP_BUNDLE)));
}

export function attachCommand(target: AttachTarget): string[] {
    return [target.tmuxPath, '-S', target.socket, 'attach-session', '-t', `=${target.sessionName}`];
}

// Opens a Ghostty tab (a window when Ghostty has none) that attaches to the watcher's tmux session.
export async function openGhosttyTab(
    runner: CommandRunner,
    target: AttachTarget,
    host: GhosttyHost
): Promise<GhosttyTabResult> {
    if (host.platform !== 'darwin' || !ghosttyInstalled(host)) {
        return 'unavailable';
    }
    const words = attachCommand(target);
    if (!words.every((word) => PLAIN_WORD.test(word))) {
        return 'failed';
    }
    const result = await runner.run({
        file: OSASCRIPT,
        args: [...SCRIPT.flatMap((line) => ['-e', line]), words.join(' ')],
        env: OSASCRIPT_ENV,
        timeoutMs: OSASCRIPT_TIMEOUT_MS,
    });
    return result.code === 0 ? 'opened' : 'failed';
}
