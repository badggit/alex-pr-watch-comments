import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test, type TestContext } from 'node:test';

import { attachCommand, openGhosttyTab, type AttachTarget } from '../../src/ghosttyTab.ts';
import type { CommandRequest, CommandResult, CommandRunner } from '../../src/types.ts';

const TARGET: AttachTarget = {
    tmuxPath: '/opt/homebrew/bin/tmux',
    socket: '/tmp/tmux-501/default',
    sessionName: 'prwc-r-12',
};

function recordingRunner(code: number): { runner: CommandRunner; requests: CommandRequest[] } {
    const requests: CommandRequest[] = [];
    const runner: CommandRunner = {
        run: (request) => {
            requests.push(request);
            const result: CommandResult = { code, stdout: '', stderr: '' };
            return Promise.resolve(result);
        },
    };
    return { runner, requests };
}

// A home directory holding ~/Applications/Ghostty.app, so the bundle check passes without a real install.
function homeWithGhostty(t: TestContext): string {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'prwc-ghostty-'));
    t.after(() => {
        fs.rmSync(home, { recursive: true, force: true });
    });
    fs.mkdirSync(path.join(home, 'Applications', 'Ghostty.app'), { recursive: true });
    return home;
}

await describe('openGhosttyTab', async () => {
    await test('passes the attach command to osascript as an argument, never inside the script', async (t) => {
        const { runner, requests } = recordingRunner(0);
        const result = await openGhosttyTab(runner, TARGET, { platform: 'darwin', home: homeWithGhostty(t) });
        assert.equal(result, 'opened');
        assert.equal(requests.length, 1);
        const [request] = requests;
        assert.ok(request !== undefined);
        assert.equal(request.file, '/usr/bin/osascript');
        assert.equal(
            request.args.at(-1),
            '/opt/homebrew/bin/tmux -S /tmp/tmux-501/default attach-session -t =prwc-r-12'
        );
        const script = request.args.slice(0, -1).filter((arg) => arg !== '-e');
        assert.ok(script.includes('set command of cfg to item 1 of argv'));
        assert.ok(!script.some((line) => line.includes('prwc-r-12')));
    });

    await test('a failing osascript is reported as failed', async (t) => {
        const { runner } = recordingRunner(1);
        const result = await openGhosttyTab(runner, TARGET, { platform: 'darwin', home: homeWithGhostty(t) });
        assert.equal(result, 'failed');
    });

    await test('another platform or a missing app bundle runs nothing', async (t) => {
        const { runner, requests } = recordingRunner(0);
        assert.equal(
            await openGhosttyTab(runner, TARGET, { platform: 'linux', home: homeWithGhostty(t) }),
            'unavailable'
        );
        const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'prwc-ghostty-'));
        t.after(() => {
            fs.rmSync(bare, { recursive: true, force: true });
        });
        if (!fs.existsSync('/Applications/Ghostty.app')) {
            assert.equal(await openGhosttyTab(runner, TARGET, { platform: 'darwin', home: bare }), 'unavailable');
        }
        assert.equal(requests.length, 0);
    });

    await test('a word that would need quoting is refused before osascript runs', async (t) => {
        const { runner, requests } = recordingRunner(0);
        const target = { ...TARGET, tmuxPath: '/Applications/My Tools/tmux' };
        const result = await openGhosttyTab(runner, target, { platform: 'darwin', home: homeWithGhostty(t) });
        assert.equal(result, 'failed');
        assert.equal(requests.length, 0);
    });

    await test('attachCommand targets the session by exact name', () => {
        assert.deepEqual(attachCommand(TARGET), [
            '/opt/homebrew/bin/tmux',
            '-S',
            '/tmp/tmux-501/default',
            'attach-session',
            '-t',
            '=prwc-r-12',
        ]);
    });
});
