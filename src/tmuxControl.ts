import { gridLayout } from './paneGrid.ts';
import type { CommandResult, Deps, Env, TmuxContext } from './types.ts';
import { isSafeSocketPath, isUintString, safeText } from './validate.ts';

export type TmuxDeps = Pick<Deps, 'runner' | 'env'>;

export type TmuxInitResult = { ok: true; tmux: TmuxContext } | { ok: false; reason: string };

export interface SplitOptions {
    runId: string;
    prKey: string;
    dir: string;
    envItems: readonly string[];
    command: readonly string[];
}

export interface WorkerPane {
    paneId: string;
    panePid: number;
}

export interface WatcherWindow {
    windowId: string;
    paneId: string;
    // The number the tmux status line shows for the window.
    index: string;
}

export type PaneState = 'alive' | 'dead' | 'missing';

const PANE_PID_FORMAT = '#{pane_id} #{pane_pid}';
const WINDOW_PANE_FORMAT = '#{window_id} #{pane_id} #{window_index}';
const PANE_SIZE_FORMAT = '#{pane_id} #{pane_width} #{pane_height}';
const WINDOW_SIZE_FORMAT = '#{window_width} #{window_height}';
// tmux 3.4-3.6 says 'no space for new pane'; 3.7+ says 'no space for a new pane' (3.7 adds a 'size or position' prefix).
const NO_SPACE = /no space for (?:a )?new pane/u;
const PANE_ID = /^%\d+$/u;
const WINDOW_ID = /^@\d+$/u;
const SESSION_ID = /^\$\d+$/u;
const PATH_ITEM = 'PATH=';
export const NOT_IN_TMUX =
    'not running inside tmux: the watcher opens Claude Code in new tmux panes, so start a tmux session first ' +
    '(for example: tmux new -s review), then run this command or the skill from a pane of that session';

// tmux format-expands some arguments (the split-window start directory); doubling # keeps the value literal.
export function tmuxLiteral(value: string): string {
    return value.replaceAll('#', '##');
}

export function parseTmuxEnv(env: Env): { socket: string; pane: string } | undefined {
    const tmux = env.TMUX ?? '';
    const pane = env.TMUX_PANE ?? '';
    const [socket = ''] = tmux.split(',', 1);
    if (socket.length === 0 || pane.length === 0) {
        return;
    }
    return { socket, pane };
}

// tmux's command parser reads an argument that ends in ; as a command separator and turns a trailing \; into ;, so
// one backslash before a trailing ; keeps any value literal (a\; becomes a\\; and round-trips as well).
export function tmuxArg(value: string): string {
    return value.endsWith(';') ? String.raw`${value.slice(0, -1)}\;` : value;
}

// Escapes a value for a tmux format comparison: # starts a format and , and } end its arguments.
export function formatLiteral(value: string): string {
    return value.replaceAll('#', '##').replaceAll(',', '#,').replaceAll('}', '#}');
}

// The only way this program calls tmux: always on an explicit socket, never on a relative or unsafe path. The
// client runs with the runner's base env unless clientEnv replaces it.
export async function tmuxOn(
    deps: TmuxDeps,
    tmuxPath: string,
    socket: string,
    args: readonly string[],
    clientEnv?: Env
): Promise<CommandResult | undefined> {
    if (!isSafeSocketPath(socket)) {
        return;
    }
    return await deps.runner.run({
        file: tmuxPath,
        args: ['-S', socket, ...args.map((arg) => tmuxArg(arg))],
        env: clientEnv,
    });
}

// The two space-separated fields of a one-line tmux output, or undefined when the call failed.
function twoFields(result: CommandResult | undefined): [string, string] | undefined {
    if (result?.code !== 0) {
        return;
    }
    const fields = result.stdout.trim().split(' ');
    const [first, second] = fields;
    if (fields.length !== 2 || first === undefined || second === undefined) {
        return;
    }
    return [first, second];
}

// The non-empty lines of a successful listing, each split on single spaces; empty for a failed call.
function listing(result: CommandResult | undefined): string[][] {
    if (result?.code !== 0) {
        return [];
    }
    return result.stdout
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => line.split(' '));
}

function succeeded(result: CommandResult | undefined): boolean {
    return result?.code === 0;
}

function envArgs(envItems: readonly string[]): string[] {
    return envItems.flatMap((item) => ['-e', item]);
}

// tmux gives a pane created by a client that is not attached that client's own PATH, which overrides a -e PATH
// item; a pane-creating call with a PATH item therefore runs the client with that PATH in place of its own, keeping
// the rest of the environment (LANG and LC_* among it).
function clientEnvFor(env: Env, envItems: readonly string[]): Env | undefined {
    const pathItem = envItems.findLast((item) => item.startsWith(PATH_ITEM));
    if (pathItem === undefined) {
        return;
    }
    return { ...env, PATH: pathItem.slice(PATH_ITEM.length) };
}

export async function tmuxInit(deps: TmuxDeps, tmuxPath: string): Promise<TmuxInitResult> {
    const parsed = parseTmuxEnv(deps.env);
    if (parsed === undefined) {
        return { ok: false, reason: NOT_IN_TMUX };
    }
    const result = await tmuxOn(deps, tmuxPath, parsed.socket, [
        'display-message',
        '-p',
        '-t',
        parsed.pane,
        '#{session_id} #{window_id}',
    ]);
    const fields = twoFields(result);
    if (fields === undefined || !SESSION_ID.test(fields[0]) || !WINDOW_ID.test(fields[1])) {
        return { ok: false, reason: `cannot read the tmux session of pane ${safeText(parsed.pane)}` };
    }
    return { ok: true, tmux: { socket: parsed.socket, pane: parsed.pane, sessionId: fields[0], windowId: fields[1] } };
}

function workerPaneOf(result: CommandResult | undefined): WorkerPane | undefined {
    const fields = twoFields(result);
    if (fields === undefined || !PANE_ID.test(fields[0]) || !isUintString(fields[1])) {
        return;
    }
    return { paneId: fields[0], panePid: Number.parseInt(fields[1], 10) };
}

function isNoSpace(result: CommandResult | undefined): boolean {
    return result !== undefined && result.code !== 0 && NO_SPACE.test(result.stderr);
}

// Lays the panes of the target's window out as the pane grid of paneGrid.ts. A window the grid does not fit, or a
// window that is gone, keeps its layout.
export async function arrangeGrid(deps: TmuxDeps, tmuxPath: string, socket: string, target: string): Promise<void> {
    const panes = listing(await tmuxOn(deps, tmuxPath, socket, ['list-panes', '-t', target, '-F', WINDOW_SIZE_FORMAT]));
    const [width = '', height = ''] = panes[0] ?? [];
    if (!isUintString(width) || !isUintString(height)) {
        return;
    }
    const layout = gridLayout(panes.length, Number.parseInt(width, 10), Number.parseInt(height, 10));
    if (layout !== undefined) {
        await tmuxOn(deps, tmuxPath, socket, ['select-layout', '-t', target, layout]);
    }
}

// The last pane of the watcher's window, so new panes follow the old ones in pane index order and fill the grid in
// launch order. It is split across its longer side (a cell is about twice as tall as wide) to make a no-space failure
// less likely; the grid relayout decides the final shape anyway.
async function splitTarget(
    deps: TmuxDeps,
    tmuxPath: string,
    tmux: TmuxContext
): Promise<{ pane: string; direction: '-h' | '-v' }> {
    const panes = listing(
        await tmuxOn(deps, tmuxPath, tmux.socket, ['list-panes', '-t', tmux.pane, '-F', PANE_SIZE_FORMAT])
    );
    const [pane = '', width = '', height = ''] = panes.at(-1) ?? [];
    if (!PANE_ID.test(pane) || !isUintString(width) || !isUintString(height)) {
        return { pane: tmux.pane, direction: '-h' };
    }
    const wide = Number.parseInt(width, 10) >= 2 * Number.parseInt(height, 10);
    return { pane, direction: wide ? '-h' : '-v' };
}

// Creates the worker pane: a split of the last pane in the watcher's window, after a tiled relayout when the window is
// full, and as a last resort a new window tagged @prwc_overflow. The pid comes from the creating call itself, never a
// lookup.
async function createWorkerPane(
    deps: TmuxDeps,
    tmuxPath: string,
    tmux: TmuxContext,
    opts: SplitOptions
): Promise<{ pane: WorkerPane | undefined; overflow: boolean }> {
    const env = envArgs(opts.envItems);
    const clientEnv = clientEnvFor(deps.env, opts.envItems);
    const target = await splitTarget(deps, tmuxPath, tmux);
    const splitArgs = [
        'split-window',
        '-d',
        target.direction,
        '-P',
        '-F',
        PANE_PID_FORMAT,
        '-t',
        target.pane,
        '-c',
        tmuxLiteral(opts.dir),
        ...env,
        ...opts.command,
    ];
    const first = await tmuxOn(deps, tmuxPath, tmux.socket, splitArgs, clientEnv);
    if (!isNoSpace(first)) {
        return { pane: workerPaneOf(first), overflow: false };
    }
    await tmuxOn(deps, tmuxPath, tmux.socket, ['select-layout', '-t', tmux.windowId, 'tiled']);
    const retry = await tmuxOn(deps, tmuxPath, tmux.socket, splitArgs, clientEnv);
    if (!isNoSpace(retry)) {
        return { pane: workerPaneOf(retry), overflow: false };
    }
    const created = await tmuxOn(
        deps,
        tmuxPath,
        tmux.socket,
        ['new-window', '-d', '-P', '-F', PANE_PID_FORMAT, '-t', `${tmux.sessionId}:`, ...env, ...opts.command],
        clientEnv
    );
    return { pane: workerPaneOf(created), overflow: true };
}

export async function splitWorker(
    deps: TmuxDeps,
    tmuxPath: string,
    tmux: TmuxContext,
    opts: SplitOptions
): Promise<WorkerPane | undefined> {
    const { pane, overflow } = await createWorkerPane(deps, tmuxPath, tmux, opts);
    if (pane === undefined) {
        return;
    }
    if (overflow) {
        await tmuxOn(deps, tmuxPath, tmux.socket, [
            'set-option',
            '-w',
            '-t',
            pane.paneId,
            '@prwc_overflow',
            opts.prKey,
        ]);
    }
    // Without both tags the pane cannot be found or recovered later, so an untagged pane counts as a failed split.
    const tags = [
        ['@prwc_run', opts.runId],
        ['@prwc_pr', opts.prKey],
    ] as const;
    for (const [option, value] of tags) {
        const tagged = await tmuxOn(deps, tmuxPath, tmux.socket, [
            'set-option',
            '-p',
            '-t',
            pane.paneId,
            option,
            value,
        ]);
        if (!succeeded(tagged)) {
            await tmuxOn(deps, tmuxPath, tmux.socket, ['kill-pane', '-t', pane.paneId]);
            return;
        }
    }
    await arrangeGrid(deps, tmuxPath, tmux.socket, pane.paneId);
    return pane;
}

export async function paneForRun(
    deps: TmuxDeps,
    tmuxPath: string,
    socket: string,
    runId: string
): Promise<string | undefined> {
    const result = await tmuxOn(deps, tmuxPath, socket, ['list-panes', '-a', '-F', '#{pane_id} #{@prwc_run}']);
    const match = listing(result).find(([, tag]) => tag === runId);
    return match?.[0];
}

// Shows text in the watcher's tmux client; # is dropped because display-message format-expands its message, and
// -- ends the options so a message starting with - is not read as a flag. Resolves to whether tmux exited 0.
export async function tmuxMessage(deps: TmuxDeps, tmuxPath: string, tmux: TmuxContext, text: string): Promise<boolean> {
    const message = safeText(text.replaceAll('#', ''));
    return succeeded(await tmuxOn(deps, tmuxPath, tmux.socket, ['display-message', '-t', tmux.pane, '--', message]));
}

// Pane ids are reused after a pane dies, so the pane is marked only while it still carries this run's tag.
export async function markPaneDone(
    deps: TmuxDeps,
    tmuxPath: string,
    socket: string,
    pane: string,
    runId: string,
    epoch: number
): Promise<boolean> {
    const tag = await tmuxOn(deps, tmuxPath, socket, ['display-message', '-p', '-t', pane, '#{@prwc_run}']);
    if (tag?.code !== 0 || tag.stdout.trim() !== runId) {
        return false;
    }
    const result = await tmuxOn(deps, tmuxPath, socket, ['set-option', '-p', '-t', pane, '@prwc_done', String(epoch)]);
    return succeeded(result);
}

// Kills the finished panes of the PR beyond the newest keep, oldest @prwc_done first, then lays the windows they
// were in out as the grid again.
export async function capDonePanes(
    deps: TmuxDeps,
    tmuxPath: string,
    socket: string,
    prKey: string,
    keep: number
): Promise<void> {
    const result = await tmuxOn(deps, tmuxPath, socket, [
        'list-panes',
        '-a',
        '-F',
        '#{pane_id} #{@prwc_pr} #{@prwc_done} #{window_id}',
    ]);
    const done = listing(result)
        .map((fields) => ({ pane: fields[0] ?? '', pr: fields[1], epoch: fields[2] ?? '', window: fields[3] ?? '' }))
        .filter((entry) => entry.pr === prKey && isUintString(entry.epoch))
        .map((entry) => ({ pane: entry.pane, epoch: Number.parseInt(entry.epoch, 10), window: entry.window }))
        .toSorted((a, b) => a.epoch - b.epoch);
    const excess = done.length - Math.max(keep, 0);
    const windows = new Set<string>();
    for (const entry of done.slice(0, Math.max(excess, 0))) {
        if (succeeded(await tmuxOn(deps, tmuxPath, socket, ['kill-pane', '-t', entry.pane]))) {
            windows.add(entry.window);
        }
    }
    for (const window of windows) {
        if (WINDOW_ID.test(window)) {
            await arrangeGrid(deps, tmuxPath, socket, window);
        }
    }
}

// The name a background watcher window shows in the tmux status line.
export function watcherWindowName(prNumber: number): string {
    return `prwc-${prNumber}`;
}

// The window is named so it can be found in the status line; a window created with -n keeps that name, as tmux
// turns automatic-rename off for it. The started command must wait for its launch-ready marker: it may not act
// before both options are set.
export async function newWatcherWindow(
    deps: TmuxDeps,
    tmuxPath: string,
    tmux: TmuxContext,
    target: { prKey: string; name: string },
    envItems: readonly string[],
    command: readonly string[]
): Promise<WatcherWindow | undefined> {
    const { prKey, name } = target;
    const created = await tmuxOn(
        deps,
        tmuxPath,
        tmux.socket,
        [
            'new-window',
            '-d',
            '-P',
            '-F',
            WINDOW_PANE_FORMAT,
            '-n',
            name,
            '-t',
            `${tmux.sessionId}:`,
            ...envArgs(envItems),
            ...command,
        ],
        clientEnvFor(deps.env, envItems)
    );
    const [windowId = '', paneId = '', index = '', ...rest] =
        created?.code === 0 ? created.stdout.trim().split(' ') : [];
    if (rest.length > 0 || !WINDOW_ID.test(windowId) || !PANE_ID.test(paneId) || !isUintString(index)) {
        return;
    }
    const tagged = await tmuxOn(deps, tmuxPath, tmux.socket, [
        'set-option',
        '-w',
        '-t',
        windowId,
        '@prwc_watcher',
        prKey,
    ]);
    const kept =
        succeeded(tagged) &&
        succeeded(
            await tmuxOn(deps, tmuxPath, tmux.socket, ['set-option', '-p', '-t', paneId, 'remain-on-exit', 'on'])
        );
    if (!kept) {
        await tmuxOn(deps, tmuxPath, tmux.socket, ['kill-window', '-t', windowId]);
        return;
    }
    return { windowId, paneId, index };
}

export async function paneState(deps: TmuxDeps, tmuxPath: string, socket: string, pane: string): Promise<PaneState> {
    const result = await tmuxOn(deps, tmuxPath, socket, ['list-panes', '-a', '-F', '#{pane_id} #{pane_dead}']);
    const match = listing(result).find(([id]) => id === pane);
    if (match === undefined) {
        return 'missing';
    }
    return match[1] === '1' ? 'dead' : 'alive';
}

export async function killPane(deps: TmuxDeps, tmuxPath: string, socket: string, pane: string): Promise<boolean> {
    const result = await tmuxOn(deps, tmuxPath, socket, ['kill-pane', '-t', pane]);
    return succeeded(result);
}

// A pane's format resolves the window option @prwc_watcher set by newWatcherWindow.
export async function paneWatcherTag(
    deps: TmuxDeps,
    tmuxPath: string,
    socket: string,
    pane: string
): Promise<string | undefined> {
    const result = await tmuxOn(deps, tmuxPath, socket, ['display-message', '-p', '-t', pane, '#{@prwc_watcher}']);
    if (result?.code !== 0) {
        return;
    }
    const tag = result.stdout.trim();
    if (tag.length === 0) {
        return;
    }
    return tag;
}

// Kills the pane only while it is dead and still carries the watcher tag of prKey, checked by the tmux server in the
// same command, so a pane respawned or reused in between is never killed. True when the conditional command ran,
// whether or not it killed the pane.
export async function killDeadWatcherPane(
    deps: TmuxDeps,
    tmuxPath: string,
    socket: string,
    pane: string,
    prKey: string
): Promise<boolean> {
    if (!PANE_ID.test(pane)) {
        return false;
    }
    const condition = `#{&&:#{pane_dead},#{==:#{@prwc_watcher},${formatLiteral(prKey)}}}`;
    const result = await tmuxOn(deps, tmuxPath, socket, [
        'if-shell',
        '-F',
        '-t',
        pane,
        condition,
        `kill-pane -t ${pane}`,
    ]);
    return succeeded(result);
}
