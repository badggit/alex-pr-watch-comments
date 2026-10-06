import fs from 'node:fs';
import path from 'node:path';

import { DEFAULT_STOP_QUIET, ENV_NAMES, GH_TOKEN_VARS, GITHUB_HOST, PS_PATH } from './constants.ts';
import { ghCommand, type GhCli } from './gh.ts';
import { fetchPrInfo } from './githubPoll.ts';
import { currentBranch, findRemote, gitIn } from './guards.ts';
import { syncIgnoredLinks } from './ignoredLinks.ts';
import { getArray, getRecord } from './json.ts';
import { readJsonFile, resolveStateDir, worktreeKey } from './stateStore.ts';
import { parseTmuxEnv, tmuxInit } from './tmuxControl.ts';
import type { CliOptions, Deps, Env, PrInfo, PrRef, Session, TmuxContext, ToolPaths, WatchWorktree } from './types.ts';
import { isSafeAbsPath, isSafeRunPath, isValidBranch, isValidName, readEnvSeconds, safeText } from './validate.ts';
import { prepareWatchWorktree } from './watchWorktree.ts';

export type PreflightDeps = Pick<Deps, 'runner' | 'env' | 'log'>;

export type PreflightResult = { ok: true; session: Session } | { ok: false; reason: string };

type Refusal = { ok: false; reason: string };

type Checked<T> = { ok: true; value: T } | Refusal;

interface Checkout {
    dirCanon: string;
    toplevel: string;
    remote: string;
}

const TOOL_NAMES: readonly (keyof ToolPaths)[] = ['node', 'git', 'gh', 'tmux', 'claude'];

function refuse(reason: string): Refusal {
    return { ok: false, reason };
}

function missingTool(name: string): Refusal {
    return refuse(`missing required tool: ${name}`);
}

function nonEmpty(value: string | undefined): string | undefined {
    return value !== undefined && value.length > 0 ? value : undefined;
}

function isExecutableFile(file: string): boolean {
    try {
        fs.accessSync(file, fs.constants.X_OK);
        return fs.statSync(file).isFile();
    } catch {
        return false;
    }
}

function canonicalPath(file: string): string | undefined {
    try {
        return fs.realpathSync.native(file);
    } catch {
        return;
    }
}

// Spelled like the shell's PATH search (ENTRY/NAME by concatenation, never symlink-resolved), except that the root
// entry gives /NAME where dash prints //NAME, so under the normalized caller PATH it equals `command -v NAME`.
export function resolveExecutable(name: string, pathValue: string): string | undefined {
    for (const dir of pathValue.split(':')) {
        if (path.isAbsolute(dir)) {
            const file = dir === '/' ? `/${name}` : `${dir}/${name}`;
            if (isExecutableFile(file)) {
                return file;
            }
        }
    }
    return;
}

function withoutTrailingSlash(entry: string): string {
    return entry.length > 1 && entry.endsWith('/') ? entry.slice(0, -1) : entry;
}

function normalizeEntry(entry: string): string {
    return withoutTrailingSlash(path.normalize(entry));
}

// The path as given plus its canonical form when it exists, so a symlinked spelling cannot slip past a comparison.
function pathForms(file: string): string[] {
    const canonical = canonicalPath(file);
    return canonical === undefined || canonical === file ? [file] : [file, canonical];
}

function isWithin(file: string, root: string): boolean {
    const relative = path.relative(root, file);
    return relative === '' || (relative !== '..' && !relative.startsWith('../') && !path.isAbsolute(relative));
}

// Drops empty, relative and control-character entries (a relative entry would resolve inside the clone once the
// worker launcher changed into it) and every entry equal to or inside an excluded directory, the project working
// tree whose files the agent can write; the rest are normalized without a trailing slash, the root entry stays /.
export function normalizeCallerPath(pathValue: string, excluded: readonly string[] = []): string {
    const roots = excluded.flatMap((root) => pathForms(normalizeEntry(root)));
    const isExcluded = (entry: string): boolean =>
        pathForms(entry).some((form) => roots.some((root) => isWithin(form, root)));
    return pathValue
        .split(':')
        .filter((entry) => isSafeAbsPath(entry))
        .map((entry) => normalizeEntry(entry))
        .filter((entry) => !isExcluded(entry))
        .join(':');
}

// The nearest directory at or above DIR with a .git entry, found without running git: the git on PATH is not
// trusted until the PATH entries inside the working tree are gone.
function enclosingWorktree(dir: string): string | undefined {
    let current = dir;
    while (!fs.existsSync(path.join(current, '.git'))) {
        const parent = path.dirname(current);
        if (parent === current) {
            return;
        }
        current = parent;
    }
    return current;
}

function projectRoots(dir: string): string[] {
    const canonical = canonicalPath(dir) ?? dir;
    const worktrees = [enclosingWorktree(dir), enclosingWorktree(canonical)].filter((root) => root !== undefined);
    return [dir, canonical, ...worktrees];
}

// The directory gh itself reads its login from.
export function effectiveGhConfigDir(env: Env, cwd: string): string | undefined {
    const explicit = nonEmpty(env.GH_CONFIG_DIR);
    if (explicit !== undefined) {
        return path.resolve(cwd, explicit);
    }
    const xdg = nonEmpty(env.XDG_CONFIG_HOME);
    if (xdg !== undefined) {
        return path.resolve(cwd, xdg, 'gh');
    }
    const home = nonEmpty(env.HOME);
    return home === undefined ? undefined : path.resolve(cwd, home, '.config', 'gh');
}

function hasStopHooks(settings: unknown): boolean {
    const stop = getArray(getRecord(settings, 'hooks'), 'Stop');
    return stop !== undefined && stop.length > 0;
}

// Labels of the owner's Claude settings files that declare Stop hooks; a missing or unparsable file has none.
export function ownerStopHookSources(home: string | undefined, toplevel: string): string[] {
    const homeDir = nonEmpty(home);
    const sources: readonly [string, string | undefined][] = [
        ['user', homeDir === undefined ? undefined : path.join(homeDir, '.claude', 'settings.json')],
        ['project', path.join(toplevel, '.claude', 'settings.json')],
        ['local', path.join(toplevel, '.claude', 'settings.local.json')],
    ];
    return sources.filter(([, file]) => file !== undefined && hasStopHooks(readJsonFile(file))).map(([label]) => label);
}

async function checkTmux(deps: PreflightDeps, callerPath: string): Promise<Checked<TmuxContext>> {
    const tmuxPath = resolveExecutable('tmux', callerPath);
    if (tmuxPath === undefined && parseTmuxEnv(deps.env) !== undefined) {
        return missingTool('tmux');
    }
    // Without TMUX, tmuxInit refuses before it runs anything, so the fallback name is never executed.
    const init = await tmuxInit(deps, tmuxPath ?? 'tmux');
    return init.ok ? { ok: true, value: init.tmux } : refuse(init.reason);
}

function resolveClaude(claude: string | undefined, cwd: string, callerPath: string): Checked<string> {
    if (claude === undefined) {
        const found = resolveExecutable('claude', callerPath);
        return found === undefined ? missingTool('claude') : { ok: true, value: found };
    }
    const absolute = path.resolve(cwd, claude);
    if (!isExecutableFile(absolute)) {
        return refuse(`missing required tool: claude (not an executable file: ${safeText(absolute)})`);
    }
    return { ok: true, value: absolute };
}

function resolveTools(
    options: CliOptions,
    cwd: string,
    callerPath: string,
    nodePath: string,
    psPath: string
): Checked<ToolPaths> {
    const git = resolveExecutable('git', callerPath);
    if (git === undefined) {
        return missingTool('git');
    }
    const gh = resolveExecutable('gh', callerPath);
    if (gh === undefined) {
        return missingTool('gh');
    }
    const tmux = resolveExecutable('tmux', callerPath);
    if (tmux === undefined) {
        return missingTool('tmux');
    }
    const claude = resolveClaude(options.claude, cwd, callerPath);
    if (!claude.ok) {
        return claude;
    }
    if (!isExecutableFile(psPath)) {
        return missingTool(`ps (${safeText(psPath)})`);
    }
    const tools: ToolPaths = { node: nodePath, git, gh, tmux, claude: claude.value };
    const unusable = TOOL_NAMES.find((name) => !isSafeAbsPath(tools[name]));
    if (unusable !== undefined) {
        return refuse(`unusable tool path for ${unusable}: it must be absolute with no control characters`);
    }
    return { ok: true, value: tools };
}

function loginCommand(host: string): string {
    return host === GITHUB_HOST ? 'gh auth login' : `gh auth login --hostname ${host}`;
}

function sameTools(left: ToolPaths, right: ToolPaths): boolean {
    return TOOL_NAMES.every((name) => left[name] === right[name]);
}

// Token variables never authenticate anything (the runner strips them); they are only named, never printed.
async function checkGh(deps: PreflightDeps, gh: GhCli, cwd: string): Promise<Checked<string[]>> {
    const envHost = nonEmpty(deps.env.GH_HOST);
    if (envHost !== undefined && envHost.toLowerCase() !== gh.host) {
        return refuse(`GH_HOST is set to another host than the PR host ${gh.host} (unset GH_HOST)`);
    }
    const configDir = effectiveGhConfigDir(deps.env, cwd);
    if (configDir === undefined || !isSafeAbsPath(configDir)) {
        return refuse('cannot determine the gh config directory (set GH_CONFIG_DIR)');
    }
    const tokens = GH_TOKEN_VARS.filter((name) => nonEmpty(deps.env[name]) !== undefined);
    const auth = await ghCommand(deps, gh, ['auth', 'status', '--hostname', gh.host]);
    if (auth.kind !== 'ok') {
        const ignored =
            tokens.length > 0
                ? `; ${tokens.join(', ')} is set but ignored: alex-pr-watch-comments uses only the gh login stored for ${gh.host}`
                : '';
        return refuse(`gh is not authenticated for ${gh.host} (run: ${loginCommand(gh.host)})${ignored}`);
    }
    for (const name of tokens) {
        deps.log.warn(
            `${name} is set: alex-pr-watch-comments ignores it; the watcher and worker panes use the gh login stored for ${gh.host}`
        );
    }
    return { ok: true, value: [`GH_CONFIG_DIR=${configDir}`, `GH_HOST=${gh.host}`] };
}

async function checkPr(deps: PreflightDeps, gh: GhCli, pr: PrRef): Promise<Checked<PrInfo>> {
    const fetched = await fetchPrInfo(deps, gh, pr);
    if (fetched.kind !== 'ok') {
        return refuse(`cannot read the pull request: ${safeText(fetched.message)}`);
    }
    const { info } = fetched;
    if (info.state !== 'OPEN') {
        return refuse(`pull request is ${info.state}`);
    }
    if (!info.canPush) {
        return refuse('no push access to the PR head');
    }
    if (!isValidBranch(info.headRef)) {
        return refuse(`unsupported head branch name: ${safeText(info.headRef)}`);
    }
    if (!isValidName(info.headOwner) || !isValidName(info.headRepo)) {
        return refuse(`unsupported head repository name: ${safeText(`${info.headOwner}/${info.headRepo}`)}`);
    }
    return { ok: true, value: info };
}

// The clone the watcher was started for: a git working tree with a verified remote for the PR head repository.
async function checkClone(
    deps: PreflightDeps,
    gitPath: string,
    dir: string,
    pr: PrRef,
    info: PrInfo
): Promise<Checked<Checkout>> {
    const dirCanon = canonicalPath(dir);
    if (dirCanon === undefined) {
        return refuse(`cannot open directory ${safeText(dir)}`);
    }
    const top = await gitIn(deps, gitPath, dirCanon, ['rev-parse', '--show-toplevel']);
    const [topLine = ''] = top.stdout.split('\n', 1);
    const toplevel = top.code === 0 && topLine.length > 0 ? canonicalPath(topLine) : undefined;
    if (toplevel === undefined) {
        return refuse(`not a git repository: ${safeText(dirCanon)}`);
    }
    const found = await findRemote(deps, gitPath, dirCanon, {
        host: pr.host,
        owner: info.headOwner,
        repo: info.headRepo,
    });
    if (!found.ok) {
        return found;
    }
    return { ok: true, value: { dirCanon, toplevel, remote: found.remote } };
}

async function checkCheckout(
    deps: PreflightDeps,
    gitPath: string,
    dir: string,
    pr: PrRef,
    info: PrInfo
): Promise<Checked<Checkout>> {
    const clone = await checkClone(deps, gitPath, dir, pr, info);
    if (!clone.ok) {
        return clone;
    }
    const branch = await currentBranch(deps, gitPath, clone.value.dirCanon);
    if (branch !== info.headRef) {
        const shown = branch === undefined ? 'a detached HEAD' : safeText(branch);
        return refuse(`${shown} is checked out, not ${info.headRef} (switch with: gh pr checkout ${pr.number})`);
    }
    return clone;
}

// The watch worktree next to the clone, created when missing, checked like an in-place clone and with the clone's
// ignored paths linked into it.
async function checkWorktree(
    deps: PreflightDeps,
    gitPath: string,
    dir: string,
    pr: PrRef,
    info: PrInfo
): Promise<Checked<{ checkout: Checkout; worktree: WatchWorktree }>> {
    const clone = await checkClone(deps, gitPath, dir, pr, info);
    if (!clone.ok) {
        return clone;
    }
    const prepared = await prepareWatchWorktree(deps, {
        gitPath,
        sourceToplevel: clone.value.toplevel,
        prNumber: pr.number,
        remote: clone.value.remote,
        branch: info.headRef,
    });
    if (!prepared.ok) {
        return prepared;
    }
    const { worktree } = prepared;
    if (prepared.created) {
        deps.log.warn(
            `created the watch worktree ${safeText(worktree.path)}: if Claude Code has not trusted it yet, run claude there once and accept the folder trust dialog`
        );
    }
    const checkout = await checkCheckout(deps, gitPath, worktree.path, pr, info);
    if (!checkout.ok) {
        return checkout;
    }
    await syncIgnoredLinks(deps, gitPath, worktree.source, worktree.path);
    return { ok: true, value: { checkout: checkout.value, worktree } };
}

function warnStopHooks(deps: PreflightDeps, toplevel: string): void {
    const labels = ownerStopHookSources(deps.env.HOME, toplevel);
    if (labels.length === 0) {
        return;
    }
    const quiet = readEnvSeconds(deps.env, ENV_NAMES.stopQuiet, DEFAULT_STOP_QUIET);
    deps.log.warn(
        `owner Stop hooks found (${labels.join(', ')}): completion waits for ${ENV_NAMES.stopQuiet} (${quiet} s) ` +
            'without hook activity; completed Claude and its lock stay open until you close Claude'
    );
}

// Start-up checks in a fixed order, first failure wins. Nothing here changes anything on GitHub or in the owner's
// working tree; in --worktree mode it creates or reuses the watch worktree and links ignored paths into it.
export async function preflight(
    deps: PreflightDeps,
    options: CliOptions,
    cwd: string,
    nodePath: string,
    psPath = PS_PATH
): Promise<PreflightResult> {
    const { pr } = options;
    if (pr === undefined) {
        return refuse('missing PR URL');
    }
    const dir = path.resolve(cwd, options.dir);
    const roots = projectRoots(dir);
    const callerPath = normalizeCallerPath(deps.env.PATH ?? '', roots);
    const tmux = await checkTmux(deps, callerPath);
    if (!tmux.ok) {
        return tmux;
    }
    const stateDir = resolveStateDir(deps.env, cwd);
    if (!isSafeRunPath(stateDir)) {
        return refuse(
            `state directory path has a character the worker kit does not allow (set ${ENV_NAMES.stateDir} to a path without spaces)`
        );
    }
    const tools = resolveTools(options, cwd, callerPath, nodePath, psPath);
    if (!tools.ok) {
        return tools;
    }
    const gh: GhCli = { path: tools.value.gh, host: pr.host };
    const ghEnv = await checkGh(deps, gh, cwd);
    if (!ghEnv.ok) {
        return ghEnv;
    }
    const info = await checkPr(deps, gh, pr);
    if (!info.ok) {
        return info;
    }
    let checkout: Checkout;
    let worktree: WatchWorktree | undefined;
    if (options.inPlace) {
        const inPlace = await checkCheckout(deps, tools.value.git, dir, pr, info.value);
        if (!inPlace.ok) {
            return inPlace;
        }
        checkout = inPlace.value;
    } else {
        const prepared = await checkWorktree(deps, tools.value.git, dir, pr, info.value);
        if (!prepared.ok) {
            return prepared;
        }
        ({ checkout, worktree } = prepared.value);
    }
    const { dirCanon, toplevel, remote } = checkout;
    const workerPath = normalizeCallerPath(callerPath, [toplevel]);
    if (workerPath !== callerPath) {
        const recheck = resolveTools(options, cwd, workerPath, nodePath, psPath);
        if (!recheck.ok || !sameTools(recheck.value, tools.value)) {
            return refuse(`a required tool resolves inside the working tree ${safeText(toplevel)} through PATH`);
        }
    }
    warnStopHooks(deps, toplevel);
    const { viewer, headRef, headOwner, headRepo } = info.value;
    return {
        ok: true,
        session: {
            pr,
            viewer,
            headRef,
            headOwner,
            headRepo,
            remote,
            dirCanon,
            toplevel,
            worktreeKey: worktreeKey(toplevel),
            tools: tools.value,
            callerPath: workerPath,
            ghEnv: ghEnv.value,
            tmux: tmux.value,
            stateDir,
            interval: options.interval,
            keepPanes: options.keepPanes,
            batchMax: options.batchMax,
            claudeArgs: options.claudeArgs,
            once: options.once,
            ...(worktree === undefined ? {} : { worktree }),
        },
    };
}
