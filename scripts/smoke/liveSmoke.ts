// Live smoke of the whole command: a scratch branch and draft PR on this repository's GitHub remote, an isolated
// tmux server, the real background watcher and either a stub claude (stub mode) or the real claude (real mode).
// It changes things on GitHub, so it runs only once the owner confirmed it with PRWC_SMOKE_CONFIRMED=1.
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { GH_STRIP_VARS, GH_TOKEN_VARS, GITHUB_HOST, REPLY_TAG } from '../../src/constants.ts';
import { ghGraphql } from '../../src/gh.ts';
import { getArray, getBoolean, getNumber, getPath, getString, parseJson } from '../../src/json.ts';
import { normalizeCallerPath, resolveExecutable } from '../../src/preflight.ts';
import { createProcessRunner } from '../../src/proc.ts';
import { readStatus, workerAlive } from '../../src/runStore.ts';
import { runDir, worktreeKey } from '../../src/stateStore.ts';
import type { CommandRequest, CommandResult, CommandRunner, Env } from '../../src/types.ts';
import { visibleText } from '../../src/untrustedText.ts';
import { isValidBranch, isValidName, safeText } from '../../src/validate.ts';

import { trustDialogShown } from './paneChecks.ts';

type Mode = 'stub' | 'real';

type Check = [failed: boolean, message: string];

interface Options {
    mode: Mode;
    keep: boolean;
}

interface Tools {
    gh: string;
    git: string;
    tmux: string;
    claude: string;
}

interface Identity {
    name: string;
    email: string;
}

interface Repo {
    owner: string;
    repo: string;
    defaultBranch: string;
}

interface Pr {
    number: number;
    url: string;
    key: string;
}

interface ReviewComment {
    id: number;
    nodeId: string;
}

interface RecordState {
    runId: string;
    state: string;
    outcome: string;
    reason: string;
}

interface WorkerPane {
    pane: string;
    runId: string;
    dead: boolean;
}

type PaneLookup = { kind: 'found'; pane: string; dead: boolean } | { kind: 'absent' } | { kind: 'unknown' };

interface Observation {
    log: string;
    watcherGone: boolean;
    watcherState: string;
    records: RecordState[];
    lockGone: boolean;
    kitRunIds: string[];
    liveRunIds: string[];
    visibleRunIds: string[];
}

// Everything created so far, so cleanup knows what to stop, close, remove or report as kept.
interface Trace {
    branch: string;
    serverName: string;
    tools?: Tools;
    repo?: Repo;
    workArea?: string;
    pr?: Pr;
    callerPath?: string;
    stateDir?: string;
    socketPath?: string;
    serverStarted: boolean;
    watcherStarted: boolean;
}

interface Ctx {
    options: Options;
    runner: CommandRunner;
    signal: AbortSignal;
    trace: Trace;
}

// Cleanup state: runner is aborted by a signal received during cleanup, killRunner never is.
interface Cleanup {
    trace: Trace;
    runner: CommandRunner;
    killRunner: CommandRunner;
    stop: AbortSignal;
    problems: string[];
    prClosed: boolean;
    branchDeleted: boolean;
}

interface Signals {
    name(): string;
    run: AbortSignal;
    cleanup: AbortSignal;
    enterCleanup(): void;
    dispose(): void;
}

interface Target {
    mode: Mode;
    tools: Tools;
    repo: Repo;
    pr: Pr;
    branch: string;
    serverName: string;
    headSha: string;
    clone: string;
    workArea: string;
    stateDir: string;
    callerPath: string;
    commentA: ReviewComment;
    commentB: ReviewComment | undefined;
}

type PrTarget = Pick<Target, 'repo' | 'pr' | 'headSha'>;

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const BIN = path.join(ROOT, 'bin', 'alex-pr-watch-comments');
const STUB_CLAUDE = path.join(ROOT, 'scripts', 'smoke', 'stubClaude.sh');
const SMOKE_CACHE = path.join(ROOT, '.cache', 'smoke');
const CLAUDE_PATH_FILE = path.join(SMOKE_CACHE, 'last-claude-path.txt');
const CONFIRM_VAR = 'PRWC_SMOKE_CONFIRMED';
const USAGE = 'usage: node scripts/smoke/liveSmoke.ts --mode stub|real [--keep]';
const GATE_REFUSAL =
    'refusing: this smoke pushes a scratch branch and opens and closes a scratch PR on the GitHub remote; set PRWC_SMOKE_CONFIRMED=1 after the owner confirms';
const HOST_REFUSAL = 'refusing: GH_HOST must be unset or github.com';
const IDENTITY_REFUSAL =
    'refusing: this repository has no local git user.name and user.email; set both with git config --local, the scratch commits are pushed to the remote';
const MODES: ReadonlySet<string> = new Set(['stub', 'real']);
const PR_TITLE = 'Scratch PR for alex-pr-watch-comments smoke test';
const PR_BODY =
    'Temporary draft pull request opened by the alex-pr-watch-comments live smoke test. The test closes it and deletes its branch when it passes.';
const COMMIT_MESSAGE = 'Add a scratch file for the alex-pr-watch-comments smoke test';
const SCRATCH_FILE = 'smoke/scratch.txt';
const SCRATCH_TEXT = ['1 one', '2 alpha', '3 three', '4 four', '5 five', ''].join('\n');
const LINE_A = 2;
const LINE_B = 4;
const BODY_A: Readonly<Record<Mode, string>> = {
    stub: 'Smoke test comment A.',
    real: 'Please change the word alpha to beta on this line.',
};
const BODY_B = 'Smoke test comment B.';
const BODY_B_EDITED = 'Smoke test comment B, edited after its rocket.';
const RUN_WAIT_SECONDS: Readonly<Record<Mode, number>> = { stub: 180, real: 900 };
const BACKGROUND_WAIT_MS = 180_000;
const FILE_POLL_MS = 500;
const RUN_POLL_MS = 2000;
const EDIT_DELAY_MS = 2000;
const WATCHER_INTERVAL = '5';
const SESSION = 'smoke';
const SERVER_PATH = '/usr/bin:/bin';
// These would override the repository's local git identity in every commit of the smoke, the watcher and claude.
const IDENTITY_VARS: readonly string[] = [
    'GIT_AUTHOR_NAME',
    'GIT_AUTHOR_EMAIL',
    'GIT_COMMITTER_NAME',
    'GIT_COMMITTER_EMAIL',
    'EMAIL',
];
const RUNNER_DROPPED: ReadonlySet<string> = new Set(IDENTITY_VARS);
const SERVER_DROPPED: ReadonlySet<string> = new Set([
    'TMUX',
    'TMUX_PANE',
    'GH_HOST',
    'PRWC_STATE_DIR',
    CONFIRM_VAR,
    ...GH_STRIP_VARS,
    ...IDENTITY_VARS,
]);
const HANDLED_SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
// tmux's answer when no server listens on the socket or the socket file is gone.
const NO_SERVER = /^(?:no server running on .+|error connecting to .+ \(No such file or directory\))$/mu;
const DEADLINE_CODE = 124;
const CLEANUP_TMUX_TIMEOUT_MS = 30_000;
const KILL_ATTEMPTS = 3;
const KILL_RETRY_MS = 1000;
const WATCHING = /^watching \S+ in tmux session (prwc-[\w-]+)$/mu;
const TRUST_FAILURE =
    'trust dialog: trust .cache/smoke/clone in Claude Code (run claude once in it and choose Yes, I trust this folder), then rerun';
// The first pane runs the background start and keeps its output and exit code in the work area.
const PANE_SCRIPT = [
    'out=$1',
    'code=$2',
    'shift 2',
    '"$@" >"$out" 2>&1',
    String.raw`printf '%s\n' "$?" >"$code.tmp" && /bin/mv -f "$code.tmp" "$code"`,
].join('\n');
const THREADS_QUERY = `query PrwcSmokeThreads($owner: String!, $repo: String!, $number: Int!) {
    rateLimit { remaining resetAt }
    repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
            reviewThreads(first: 100) {
                nodes { comments(first: 100) { nodes { databaseId reactionGroups { content viewerHasReacted } } } }
            }
        }
    }
}`;

// Every printed line goes through visibleText, so no path, message or remote text can add a line or a terminal escape.
function say(text: string): void {
    process.stdout.write(`${visibleText(text)}\n`);
}

function errorCode(error: unknown): string | undefined {
    if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
        return error.code;
    }
    return;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : 'unknown error';
}

function isMode(value: string | undefined): value is Mode {
    return value !== undefined && MODES.has(value);
}

function isList(value: unknown): value is unknown[] {
    return Array.isArray(value);
}

function parseOptions(args: readonly string[]): Options | undefined {
    const rest = [...args];
    let mode: Mode | undefined;
    let keep = false;
    while (rest.length > 0) {
        const arg = rest.shift();
        switch (arg) {
            case '--keep': {
                keep = true;
                break;
            }
            case '--mode': {
                const value = rest.shift();
                if (!isMode(value)) {
                    return;
                }
                mode = value;
                break;
            }
            default: {
                return;
            }
        }
    }
    return mode === undefined ? undefined : { mode, keep };
}

function setTokenNames(env: Env): string[] {
    return GH_TOKEN_VARS.filter((name) => (env[name] ?? '').length > 0);
}

function hostAllowed(env: Env): boolean {
    const host = env.GH_HOST ?? '';
    return host.length === 0 || host.toLowerCase() === GITHUB_HOST;
}

function utcStamp(date: Date): string {
    return date.toISOString().slice(0, 19).replaceAll('-', '').replaceAll(':', '').replaceAll('T', '');
}

function withoutNames(env: Env, dropped: ReadonlySet<string>): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [name, value] of Object.entries(env)) {
        if (value !== undefined && !dropped.has(name)) {
            result[name] = value;
        }
    }
    return result;
}

// The smoke's own gh and git calls: the runner removes the token variables, GH_HOST pins every gh call to
// github.com, git never prompts for credentials and no identity variable overrides the configured one.
function runnerEnv(env: Env): Env {
    return { ...withoutNames(env, RUNNER_DROPPED), GH_HOST: GITHUB_HOST, GIT_TERMINAL_PROMPT: '0' };
}

// The isolated server starts with only the system PATH, so a worker that inherited the server PATH instead of the
// caller's would show it.
function serverEnv(env: Env): Env {
    return { ...withoutNames(env, SERVER_DROPPED), PATH: SERVER_PATH };
}

function readText(file: string): string | undefined {
    try {
        return fs.readFileSync(file, 'utf8');
    } catch {
        return;
    }
}

function pathAbsent(file: string): boolean {
    try {
        fs.lstatSync(file);
        return false;
    } catch (error) {
        return errorCode(error) === 'ENOENT';
    }
}

function isSocket(file: string): boolean {
    try {
        return fs.lstatSync(file).isSocket();
    } catch {
        return false;
    }
}

function listDir(dir: string): string[] {
    try {
        return fs.readdirSync(dir);
    } catch (error) {
        if (errorCode(error) === 'ENOENT') {
            return [];
        }
        throw error;
    }
}

function describeFailure(result: CommandResult): string {
    const text = [result.stderr, result.stdout].map((part) => part.trim()).find((part) => part.length > 0);
    if (text !== undefined) {
        return safeText(text);
    }
    return result.spawnError === undefined ? `exit code ${result.code}` : `not started: ${result.spawnError}`;
}

async function pause(ctx: Ctx, ms: number): Promise<void> {
    try {
        await delay(ms, undefined, { signal: ctx.signal });
    } catch (error) {
        if (!ctx.signal.aborted) {
            throw error;
        }
    }
    if (ctx.signal.aborted) {
        throw new Error('interrupted');
    }
}

async function runChecked(ctx: Ctx, label: string, request: CommandRequest): Promise<string> {
    const result = await ctx.runner.run(request);
    if (result.code !== 0) {
        throw new Error(`${label} failed: ${describeFailure(result)}`);
    }
    return result.stdout;
}

async function git(ctx: Ctx, tools: Tools, dir: string, args: readonly string[]): Promise<string> {
    return await runChecked(ctx, `git ${args[0] ?? ''}`, { file: tools.git, args: ['-C', dir, ...args] });
}

// gh api request options: -X METHOD, -f NAME=VALUE for string fields and -F NAME=VALUE for typed ones.
function requestArgs(
    method: string,
    strings: Readonly<Record<string, string>>,
    typed?: Readonly<Record<string, string>>
): string[] {
    const fields = (flag: string, values: Readonly<Record<string, string>>): string[] =>
        Object.entries(values).flatMap(([key, value]) => [flag, `${key}=${value}`]);
    return ['-X', method, ...fields('-f', strings), ...fields('-F', typed ?? {})];
}

function ghApiArgs(endpoint: string, args: readonly string[]): string[] {
    return ['api', endpoint, '--hostname', GITHUB_HOST, ...args];
}

async function ghApi(ctx: Ctx, tools: Tools, endpoint: string, args: readonly string[] = []): Promise<unknown> {
    const stdout = await runChecked(ctx, `gh api ${endpoint}`, { file: tools.gh, args: ghApiArgs(endpoint, args) });
    return parseJson(stdout);
}

function repoPath(repo: Repo): string {
    return `repos/${repo.owner}/${repo.repo}`;
}

function pullPath(repo: Repo, pr: Pr): string {
    return `${repoPath(repo)}/pulls/${pr.number}`;
}

function resolveTools(mode: Mode, callerPath: string): Tools {
    const find = (name: string): string => {
        const found = resolveExecutable(name, callerPath);
        if (found === undefined) {
            throw new Error(`${name} was not found on PATH`);
        }
        return found;
    };
    if (mode === 'stub') {
        try {
            fs.accessSync(STUB_CLAUDE, fs.constants.X_OK);
        } catch {
            throw new Error('scripts/smoke/stubClaude.sh is not executable');
        }
    }
    return {
        gh: find('gh'),
        git: find('git'),
        tmux: find('tmux'),
        claude: mode === 'stub' ? STUB_CLAUDE : find('claude'),
    };
}

async function viewRepo(ctx: Ctx, tools: Tools): Promise<Repo> {
    const stdout = await runChecked(ctx, 'gh repo view', {
        file: tools.gh,
        args: ['repo', 'view', '--json', 'nameWithOwner,defaultBranchRef'],
        cwd: ROOT,
    });
    const value = parseJson(stdout);
    const [owner = '', repo = '', ...extra] = (getString(value, 'nameWithOwner') ?? '').split('/');
    const defaultBranch = getString(getPath(value, 'defaultBranchRef'), 'name') ?? '';
    if (extra.length > 0 || !isValidName(owner) || !isValidName(repo) || !isValidBranch(defaultBranch)) {
        throw new Error('gh repo view gave an unexpected repository or default branch');
    }
    return { owner, repo, defaultBranch };
}

function createWorkArea(runstamp: string): string {
    fs.mkdirSync(SMOKE_CACHE, { recursive: true, mode: 0o700 });
    const dir = path.join(SMOKE_CACHE, runstamp);
    fs.mkdirSync(dir, { mode: 0o700 });
    return fs.realpathSync.native(dir);
}

async function localConfig(runner: CommandRunner, tools: Tools, key: string): Promise<string | undefined> {
    const result = await runner.run({ file: tools.git, args: ['-C', ROOT, 'config', '--local', '--get', key] });
    const value = result.stdout.trim();
    return result.code === 0 && value.length > 0 ? value : undefined;
}

// Only the identity configured locally for this working copy is used: the global one may hold a personal address
// that must not reach the public remote.
async function readLocalIdentity(runner: CommandRunner, tools: Tools): Promise<Identity | undefined> {
    const name = await localConfig(runner, tools, 'user.name');
    const email = await localConfig(runner, tools, 'user.email');
    return name !== undefined && email !== undefined ? { name, email } : undefined;
}

async function setIdentity(ctx: Ctx, tools: Tools, clone: string, identity: Identity): Promise<void> {
    await git(ctx, tools, clone, ['config', '--local', 'user.name', identity.name]);
    await git(ctx, tools, clone, ['config', '--local', 'user.email', identity.email]);
}

async function pushScratchBranch(
    ctx: Ctx,
    tools: Tools,
    repo: Repo,
    workArea: string,
    branch: string,
    identity: Identity
): Promise<{ clone: string; headSha: string }> {
    // Claude Code asks for folder trust per repository root, so the clone keeps one path across runs: the owner
    // trusts it once and every later run reuses that decision. Two smokes at the same time would share it.
    const clone = path.join(SMOKE_CACHE, 'clone');
    fs.rmSync(clone, { recursive: true, force: true });
    const url = `https://github.com/${repo.owner}/${repo.repo}.git`;
    await git(ctx, tools, workArea, ['clone', '--quiet', '--no-tags', '--branch', repo.defaultBranch, url, clone]);
    await setIdentity(ctx, tools, clone, identity);
    await git(ctx, tools, clone, ['checkout', '--quiet', '-b', branch]);
    fs.mkdirSync(path.join(clone, path.dirname(SCRATCH_FILE)), { recursive: true });
    fs.writeFileSync(path.join(clone, SCRATCH_FILE), SCRATCH_TEXT);
    await git(ctx, tools, clone, ['add', '--', SCRATCH_FILE]);
    await git(ctx, tools, clone, ['commit', '--quiet', '-m', COMMIT_MESSAGE, '--', SCRATCH_FILE]);
    const head = await git(ctx, tools, clone, ['rev-parse', 'HEAD']);
    await git(ctx, tools, clone, ['push', '--quiet', 'origin', `${branch}:refs/heads/${branch}`]);
    return { clone, headSha: head.trim() };
}

async function openPr(ctx: Ctx, tools: Tools, repo: Repo, branch: string): Promise<Pr> {
    const fields = { title: PR_TITLE, head: branch, base: repo.defaultBranch, body: PR_BODY };
    const value = await ghApi(ctx, tools, `${repoPath(repo)}/pulls`, requestArgs('POST', fields, { draft: 'true' }));
    const number = getNumber(value, 'number');
    const url = getString(value, 'html_url');
    if (number === undefined || url === undefined) {
        throw new Error('the created PR has no number or URL');
    }
    return { number, url, key: `${repo.owner.toLowerCase()}+${repo.repo.toLowerCase()}+${number}` };
}

async function postComment(
    ctx: Ctx,
    tools: Tools,
    target: PrTarget,
    line: number,
    body: string
): Promise<ReviewComment> {
    const fields = { body, commit_id: target.headSha, path: SCRATCH_FILE, side: 'RIGHT' };
    const args = requestArgs('POST', fields, { line: String(line) });
    const value = await ghApi(ctx, tools, `${pullPath(target.repo, target.pr)}/comments`, args);
    const id = getNumber(value, 'id');
    const nodeId = getString(value, 'node_id');
    if (id === undefined || nodeId === undefined) {
        throw new Error('the created review comment has no id');
    }
    return { id, nodeId };
}

async function addRocket(ctx: Ctx, tools: Tools, repo: Repo, comment: ReviewComment): Promise<void> {
    const endpoint = `${repoPath(repo)}/pulls/comments/${comment.id}/reactions`;
    await ghApi(ctx, tools, endpoint, requestArgs('POST', { content: 'rocket' }));
}

// The viewer's reactions per comment database id, read through the same reviewThreads and reactionGroups shape the
// watcher's PrwcPoll query uses.
async function viewerReactions(ctx: Ctx, tools: Tools, repo: Repo, pr: Pr): Promise<Map<number, Set<string>>> {
    const variables = { owner: repo.owner, repo: repo.repo, number: pr.number };
    const result = await ghGraphql(
        { runner: ctx.runner },
        { path: tools.gh, host: GITHUB_HOST },
        THREADS_QUERY,
        variables
    );
    if (result.kind !== 'ok') {
        throw new Error(`the reactions query failed: ${safeText(result.message)}`);
    }
    const reactions = new Map<number, Set<string>>();
    const threads = getArray(getPath(result.data, 'repository', 'pullRequest', 'reviewThreads'), 'nodes') ?? [];
    for (const thread of threads) {
        for (const comment of getArray(getPath(thread, 'comments'), 'nodes') ?? []) {
            const id = getNumber(comment, 'databaseId');
            const groups = getArray(comment, 'reactionGroups') ?? [];
            const reacted = groups.filter((group) => getBoolean(group, 'viewerHasReacted') === true);
            if (id !== undefined) {
                reactions.set(id, new Set(reacted.map((group) => getString(group, 'content') ?? '')));
            }
        }
    }
    return reactions;
}

async function approveCommentA(ctx: Ctx, tools: Tools, target: PrTarget): Promise<ReviewComment> {
    const comment = await postComment(ctx, tools, target, LINE_A, BODY_A[ctx.options.mode]);
    await addRocket(ctx, tools, target.repo, comment);
    const reactions = await viewerReactions(ctx, tools, target.repo, target.pr);
    if (reactions.get(comment.id)?.has('ROCKET') !== true) {
        throw new Error('viewerHasReacted is not true for the rocket on comment A');
    }
    say('viewerHasReacted=true');
    return comment;
}

// Comment B gets its rocket first and is edited afterwards, so the watcher must refuse it as edited after approval.
async function prepareEditedComment(ctx: Ctx, tools: Tools, target: PrTarget): Promise<ReviewComment> {
    const comment = await postComment(ctx, tools, target, LINE_B, BODY_B);
    await addRocket(ctx, tools, target.repo, comment);
    await pause(ctx, EDIT_DELAY_MS);
    const endpoint = `${repoPath(target.repo)}/pulls/comments/${comment.id}`;
    await ghApi(ctx, tools, endpoint, requestArgs('PATCH', { body: BODY_B_EDITED }));
    return comment;
}

async function tmuxOn(
    runner: CommandRunner,
    tools: Tools,
    serverName: string,
    args: readonly string[],
    timeoutMs?: number
): Promise<CommandResult> {
    const env = serverEnv(process.env);
    return await runner.run({ file: tools.tmux, args: ['-L', serverName, ...args], env, timeoutMs });
}

function serverGone(result: CommandResult): boolean {
    return result.code === 1 && NO_SERVER.test(result.stderr);
}

// Every request gets the time left until the deadline as its timeout, so a hanging tmux cannot stretch the wait.
function boundedRunner(runner: CommandRunner, deadline: number): CommandRunner {
    return {
        run: async (request) => {
            const left = Math.ceil(deadline - performance.now());
            if (left <= 0) {
                return { code: DEADLINE_CODE, stdout: '', stderr: 'the wait deadline passed' };
            }
            return await runner.run({ ...request, timeoutMs: Math.min(request.timeoutMs ?? left, left) });
        },
    };
}

async function waitForCode(ctx: Ctx, file: string, timeoutMs: number): Promise<string> {
    const deadline = performance.now() + timeoutMs;
    for (;;) {
        const text = readText(file);
        if (text !== undefined) {
            return text.trim();
        }
        const left = deadline - performance.now();
        if (left <= 0) {
            throw new Error('the background start did not finish in time');
        }
        await pause(ctx, Math.min(FILE_POLL_MS, left));
    }
}

async function recordSocketPath(ctx: Ctx, tools: Tools, serverName: string): Promise<void> {
    const result = await tmuxOn(ctx.runner, tools, serverName, [
        'display-message',
        '-p',
        '-t',
        SESSION,
        '#{socket_path}',
    ]);
    const socket = result.stdout.trim();
    if (result.code === 0 && socket.startsWith('/')) {
        ctx.trace.socketPath = socket;
    }
}

// Step 4: the first pane of a fresh isolated server runs the background start with the caller's full PATH.
async function startWatcher(ctx: Ctx, target: Target): Promise<void> {
    const { tools, workArea } = target;
    const out = path.join(workArea, 'background.out');
    const codeFile = path.join(workArea, 'background.code');
    const env = ['/usr/bin/env', `PATH=${target.callerPath}`, `PRWC_STATE_DIR=${target.stateDir}`];
    const shell = ['/bin/sh', '-c', PANE_SCRIPT, 'sh', out, codeFile];
    const watch = [
        '--background',
        '--no-attach',
        '--dir',
        target.clone,
        '--interval',
        WATCHER_INTERVAL,
        '--claude',
        tools.claude,
    ];
    const command = [...env, ...shell, BIN, target.pr.url, ...watch];
    ctx.trace.serverStarted = true;
    const session = ['-f', '/dev/null', 'new-session', '-d', '-s', SESSION, '-x', '200', '-y', '50'];
    const started = await tmuxOn(ctx.runner, tools, target.serverName, [...session, ...command]);
    if (started.code !== 0) {
        throw new Error(`tmux new-session failed: ${describeFailure(started)}`);
    }
    await recordSocketPath(ctx, tools, target.serverName);
    const code = await waitForCode(ctx, codeFile, BACKGROUND_WAIT_MS);
    const output = readText(out) ?? '';
    const match = WATCHING.exec(output);
    if (code !== '0' || match === null) {
        throw new Error(`background start exited with ${safeText(code)}: ${safeText(output.trim())}`);
    }
    ctx.trace.watcherStarted = true;
    say(`watcher started in tmux session ${match[1] ?? ''}`);
}

// The watcher pane is the pane of the window tagged with this PR's @prwc_watcher that is not a worker pane. A
// failed listing (a timeout, say) is unknown, not absent: only a listing without it or a gone server proves absence.
async function watcherPane(ctx: Ctx, target: Target): Promise<PaneLookup> {
    const result = await tmuxOn(ctx.runner, target.tools, target.serverName, [
        'list-panes',
        '-a',
        '-F',
        '#{pane_id} #{pane_dead} #{@prwc_watcher} #{@prwc_run}',
    ]);
    if (serverGone(result)) {
        return { kind: 'absent' };
    }
    if (result.code !== 0) {
        return { kind: 'unknown' };
    }
    for (const line of result.stdout.split('\n')) {
        const [pane = '', dead = '', tag = '', run = ''] = line.split(' ');
        if (tag === target.pr.key && run.length === 0) {
            return { kind: 'found', pane, dead: dead === '1' };
        }
    }
    return { kind: 'absent' };
}

function recordStates(stateDir: string): RecordState[] {
    const runsDir = path.join(stateDir, 'runs');
    return listDir(runsDir).map((runId) => {
        const value = parseJson(readText(path.join(runsDir, runId, 'record.json')) ?? '');
        return {
            runId,
            state: getString(value, 'state') ?? 'unreadable',
            outcome: getString(value, 'outcome') ?? '',
            reason: getString(value, 'reason') ?? '',
        };
    });
}

function workerKitPresent(stateDir: string, runId: string): boolean {
    const dir = runDir(stateDir, runId);
    return ['hook.sh', 'launcher.sh', 'prompt.txt', 'settings.json'].every((file) => !pathAbsent(path.join(dir, file)));
}

// The worker panes are the panes tagged with a run id; a failed listing yields none, the next poll tries again.
async function workerPanes(ctx: Ctx, target: Target): Promise<WorkerPane[]> {
    const result = await tmuxOn(ctx.runner, target.tools, target.serverName, [
        'list-panes',
        '-a',
        '-F',
        '#{pane_id} #{pane_dead} #{@prwc_run}',
    ]);
    if (result.code !== 0) {
        return [];
    }
    const panes: WorkerPane[] = [];
    for (const line of result.stdout.split('\n')) {
        const [pane = '', dead = '', runId = ''] = line.split(' ');
        if (pane.length > 0 && runId.length > 0) {
            panes.push({ pane, runId, dead: dead === '1' });
        }
    }
    return panes;
}

// Read joined (-J), so a wrapped line still matches. Undefined when the capture failed.
async function captureLog(ctx: Ctx, target: Target, pane: string): Promise<string | undefined> {
    const args = ['capture-pane', '-p', '-J', '-S', '-', '-t', pane];
    const captured = await tmuxOn(ctx.runner, target.tools, target.serverName, args);
    return captured.code === 0 ? captured.stdout : undefined;
}

// The watcher log is also kept in the work area, where it survives the isolated server. A failed capture keeps the
// previous log, so a single slow tmux answer never hides what was already seen.
async function observe(ctx: Ctx, target: Target, previousLog: string): Promise<Observation> {
    const found = await watcherPane(ctx, target);
    const captured = found.kind === 'found' ? await captureLog(ctx, target, found.pane) : undefined;
    if (captured !== undefined && captured.length > 0) {
        fs.writeFileSync(path.join(target.workArea, 'watcher.log'), captured);
    }
    const lockDir = path.join(target.stateDir, 'worktrees', worktreeKey(target.clone), 'lock');
    const records = recordStates(target.stateDir);
    const panes = await workerPanes(ctx, target);
    return {
        log: captured ?? previousLog,
        watcherGone: found.kind === 'absent' || (found.kind === 'found' && found.dead),
        watcherState: readStatus(target.stateDir, target.pr.key)?.state ?? 'unreadable',
        records,
        lockGone: pathAbsent(lockDir),
        kitRunIds: records
            .filter((record) => workerKitPresent(target.stateDir, record.runId))
            .map((record) => record.runId),
        liveRunIds: records
            .filter((record) => workerAlive(target.stateDir, record.runId))
            .map((record) => record.runId),
        visibleRunIds: panes.filter((pane) => !pane.dead).map((pane) => pane.runId),
    };
}

// A real claude that waits at the folder trust dialog never submits its prompt, so the run would only surface as
// claude-did-not-start after the start timeout; the visible screen of each worker pane shows the dialog at once.
async function trustDialogWaiting(ctx: Ctx, target: Target): Promise<boolean> {
    for (const { pane } of await workerPanes(ctx, target)) {
        const captured = await tmuxOn(ctx.runner, target.tools, target.serverName, [
            'capture-pane',
            '-p',
            '-J',
            '-t',
            pane,
        ]);
        if (captured.code === 0 && trustDialogShown(captured.stdout)) {
            return true;
        }
    }
    return false;
}

function retainedSuccessRecord(obs: Observation): RecordState | undefined {
    const [record] = obs.records;
    const success = record?.state === 'retained' && record.outcome === 'completed' && record.reason === 'done';
    return obs.records.length === 1 && success ? record : undefined;
}

function settled(obs: Observation, mode: Mode): boolean {
    const record = retainedSuccessRecord(obs);
    const runDone =
        record !== undefined &&
        !obs.lockGone &&
        obs.watcherState === 'holding' &&
        obs.kitRunIds.includes(record.runId) &&
        obs.liveRunIds.includes(record.runId) &&
        obs.visibleRunIds.includes(record.runId) &&
        obs.log.includes('event stop');
    return runDone && (mode === 'real' || obs.log.includes('edited after approval'));
}

function failFast(obs: Observation): void {
    if (obs.log.includes('event permission')) {
        throw new Error('permission prompt');
    }
    const attention = obs.records.find((record) => record.state === 'needs_attention');
    if (attention !== undefined) {
        throw new Error(`needs_attention ${safeText(attention.reason)}`);
    }
    const failed = obs.records.find((record) => record.state === 'retained' && record.outcome === 'failed');
    if (failed !== undefined) {
        throw new Error(`failed ${safeText(failed.reason)}`);
    }
}

// Step 5 wait: returns once the run is over, or at the deadline with whatever was observed last.
async function awaitRun(ctx: Ctx, target: Target): Promise<{ obs: Observation; timedOut: boolean }> {
    const seconds = RUN_WAIT_SECONDS[target.mode];
    say(`waiting up to ${seconds} s for the run`);
    const deadline = performance.now() + seconds * 1000;
    const bounded: Ctx = { ...ctx, runner: boundedRunner(ctx.runner, deadline) };
    let log = '';
    for (;;) {
        const obs = await observe(bounded, target, log);
        log = obs.log;
        if (target.mode === 'real' && (await trustDialogWaiting(bounded, target))) {
            throw new Error(TRUST_FAILURE);
        }
        failFast(obs);
        if (settled(obs, target.mode)) {
            return { obs, timedOut: false };
        }
        if (obs.watcherGone) {
            throw new Error('the watcher exited');
        }
        const left = deadline - performance.now();
        if (left <= 0) {
            return { obs, timedOut: true };
        }
        await pause(ctx, Math.min(RUN_POLL_MS, left));
    }
}

function localChecks(obs: Observation, target: Target): Check[] {
    const record = retainedSuccessRecord(obs);
    const common: Check[] = [
        [obs.log.includes('event permission'), 'permission prompt'],
        [record === undefined, 'no successful retained run record remains'],
        [obs.lockGone, 'the worktree lock directory is gone'],
        [obs.watcherState !== 'holding', `the watcher state is ${safeText(obs.watcherState)}, not holding`],
        [record !== undefined && !obs.kitRunIds.includes(record.runId), 'the retained worker kit is incomplete'],
        [record !== undefined && !obs.liveRunIds.includes(record.runId), 'the retained Claude process is not live'],
        [record !== undefined && !obs.visibleRunIds.includes(record.runId), 'the retained Claude pane is not visible'],
        [!obs.log.includes('event prompt'), 'the watcher log has no event prompt'],
        [!obs.log.includes('event stop'), 'the watcher log has no event stop'],
        [obs.log.includes('launch cancelled'), 'the watcher log has launch cancelled'],
    ];
    if (target.mode === 'real') {
        return [...common, [!obs.log.includes('event tool'), 'the watcher log has no event tool']];
    }
    const stubPath = readText(CLAUDE_PATH_FILE)?.trim();
    return [
        ...common,
        [!obs.log.includes('edited after approval'), 'the watcher log has no edited after approval'],
        [stubPath !== target.callerPath, 'the stub claude PATH is not the caller PATH'],
    ];
}

// A comment missing from the query result is a failure: its reactions are unknown, not empty.
function reactionChecks(reactions: Map<number, Set<string>>, target: Target): Check[] {
    const onA = reactions.get(target.commentA.id);
    if (onA === undefined) {
        return [[true, 'comment A is missing from the reactions query']];
    }
    const checks: Check[] = [
        [!onA.has('THUMBS_UP'), 'comment A has no viewer +1'],
        [onA.has('EYES'), 'comment A still has the viewer eyes'],
        [onA.has('ROCKET'), 'comment A still has the viewer rocket'],
    ];
    if (target.commentB === undefined) {
        return checks;
    }
    const onB = reactions.get(target.commentB.id);
    if (onB === undefined) {
        return [...checks, [true, 'comment B is missing from the reactions query']];
    }
    return [
        ...checks,
        [onB.has('ROCKET'), 'comment B still has the viewer rocket'],
        [onB.has('EYES'), 'comment B has the viewer eyes'],
    ];
}

async function listed(ctx: Ctx, tools: Tools, endpoint: string): Promise<unknown[]> {
    const value = await ghApi(ctx, tools, `${endpoint}?per_page=100`);
    if (!isList(value)) {
        throw new Error(`gh api ${endpoint} did not return a list`);
    }
    return value;
}

async function branchFailure(ctx: Ctx, target: Target): Promise<string | undefined> {
    const { tools, repo, branch } = target;
    const info = await ghApi(ctx, tools, `${repoPath(repo)}/branches/${branch}`);
    const sha = getString(getPath(info, 'commit'), 'sha');
    if (sha === undefined || sha === target.headSha) {
        return 'the scratch branch has no new commit';
    }
    const file = await ghApi(ctx, tools, `${repoPath(repo)}/contents/${SCRATCH_FILE}?ref=${sha}`);
    const text = Buffer.from(getString(file, 'content') ?? '', 'base64').toString('utf8');
    return text.includes('beta') ? undefined : `${SCRATCH_FILE} on the scratch branch does not contain beta`;
}

// The tag must be the literal last line: only one final line break (LF or CRLF) may follow it.
function endsWithReplyTag(body: string): boolean {
    const text = body.replace(/\r?\n$/, '');
    return text === REPLY_TAG || text.endsWith(`\n${REPLY_TAG}`);
}

async function githubFailure(ctx: Ctx, target: Target): Promise<string | undefined> {
    const { tools, repo, pr } = target;
    const reactions = await viewerReactions(ctx, tools, repo, pr);
    const reaction = reactionChecks(reactions, target).find(([failed]) => failed);
    if (reaction !== undefined) {
        return reaction[1];
    }
    const comments = await listed(ctx, tools, `${pullPath(repo, pr)}/comments`);
    const replies = comments.filter((comment) => getNumber(comment, 'in_reply_to_id') === target.commentA.id);
    if (replies.length === 0) {
        return 'no reply in the thread of comment A';
    }
    if (!replies.some((reply) => endsWithReplyTag(getString(reply, 'body') ?? ''))) {
        return 'reply tag missing';
    }
    const issueComments = await listed(ctx, tools, `${repoPath(repo)}/issues/${pr.number}/comments`);
    if (issueComments.length > 0) {
        return 'the PR has issue comments';
    }
    return target.mode === 'real' ? await branchFailure(ctx, target) : undefined;
}

async function verifyRun(ctx: Ctx, target: Target): Promise<void> {
    const { obs, timedOut } = await awaitRun(ctx, target);
    const local = localChecks(obs, target).find(([failed]) => failed)?.[1];
    const failure = local ?? (await githubFailure(ctx, target));
    if (failure !== undefined) {
        const seconds = RUN_WAIT_SECONDS[target.mode];
        throw new Error(timedOut ? `timeout after ${seconds} s: ${failure}` : failure);
    }
}

async function runSmoke(ctx: Ctx, runstamp: string, tools: Tools, identity: Identity): Promise<void> {
    const { options, trace } = ctx;
    trace.tools = tools;
    const repo = await viewRepo(ctx, tools);
    trace.repo = repo;
    const workArea = createWorkArea(runstamp);
    trace.workArea = workArea;
    const { clone, headSha } = await pushScratchBranch(ctx, tools, repo, workArea, trace.branch, identity);
    const pr = await openPr(ctx, tools, repo, trace.branch);
    trace.pr = pr;
    say(`pr: ${pr.url}`);
    const commentA = await approveCommentA(ctx, tools, { repo, pr, headSha });
    const commentB =
        options.mode === 'stub' ? await prepareEditedComment(ctx, tools, { repo, pr, headSha }) : undefined;
    const callerPath = normalizeCallerPath(process.env.PATH ?? '', [clone]);
    const stateDir = path.join(workArea, 'state');
    trace.callerPath = callerPath;
    trace.stateDir = stateDir;
    fs.rmSync(CLAUDE_PATH_FILE, { force: true });
    const target: Target = {
        mode: options.mode,
        tools,
        repo,
        pr,
        branch: trace.branch,
        serverName: trace.serverName,
        headSha,
        clone,
        workArea,
        stateDir,
        callerPath,
        commentA,
        commentB,
    };
    await startWatcher(ctx, target);
    await verifyRun(ctx, target);
}

// One cleanup step: a throw or a reported problem is recorded and never skips the steps after it.
async function attempt(cleanup: Cleanup, label: string, step: () => Promise<string | undefined>): Promise<boolean> {
    try {
        const problem = await step();
        if (problem === undefined) {
            return true;
        }
        cleanup.problems.push(problem);
    } catch (error) {
        cleanup.problems.push(`${label} failed: ${errorMessage(error)}`);
    }
    return false;
}

// A step with an effect beyond killing the server is skipped once a signal arrived during cleanup.
async function outward(cleanup: Cleanup, label: string, step: () => Promise<string | undefined>): Promise<boolean> {
    return cleanup.stop.aborted ? false : await attempt(cleanup, label, step);
}

async function stopWatcher(cleanup: Cleanup): Promise<string | undefined> {
    const { trace } = cleanup;
    if (!trace.watcherStarted || trace.pr === undefined || trace.callerPath === undefined) {
        return;
    }
    const env: Env = { ...serverEnv(process.env), PATH: trace.callerPath, PRWC_STATE_DIR: trace.stateDir };
    const result = await cleanup.runner.run({ file: BIN, args: ['--stop', trace.pr.url], env, cwd: ROOT });
    return result.code === 0 ? undefined : `--stop failed: ${describeFailure(result)}`;
}

// Kept panes go to the work area as text, since the server and its scrollback are gone after cleanup.
async function savePanes(cleanup: Cleanup): Promise<string | undefined> {
    const { trace } = cleanup;
    if (trace.tools === undefined || trace.workArea === undefined || !trace.serverStarted) {
        return;
    }
    const { tools, workArea, serverName } = trace;
    const listArgs = ['list-panes', '-a', '-F', '#{pane_id}'];
    const listing = await tmuxOn(cleanup.runner, tools, serverName, listArgs, CLEANUP_TMUX_TIMEOUT_MS);
    const panes = listing.code === 0 ? listing.stdout.split('\n').filter((pane) => /^%\d+$/u.test(pane)) : [];
    for (const pane of panes) {
        if (cleanup.stop.aborted) {
            return;
        }
        const captureArgs = ['capture-pane', '-p', '-J', '-S', '-', '-t', pane];
        const captured = await tmuxOn(cleanup.runner, tools, serverName, captureArgs, CLEANUP_TMUX_TIMEOUT_MS);
        if (captured.code === 0) {
            fs.writeFileSync(path.join(workArea, `pane-${pane.slice(1)}.txt`), captured.stdout);
        }
    }
    return;
}

// tmux leaves its socket file behind; it is removed once the server is confirmed gone.
function removeSocket(trace: Trace): string | undefined {
    if (trace.socketPath === undefined || !isSocket(trace.socketPath)) {
        return;
    }
    try {
        fs.rmSync(trace.socketPath, { force: true });
    } catch (error) {
        return `removing the tmux socket failed: ${errorMessage(error)}`;
    }
    return;
}

// Only tmux's own no-server answer proves the server is gone; a timeout or a killed probe proves nothing, so the
// kill is retried a bounded number of times and then reported.
async function killServer(cleanup: Cleanup): Promise<string | undefined> {
    const { trace } = cleanup;
    if (trace.tools === undefined || !trace.serverStarted) {
        return;
    }
    const { tools, serverName } = trace;
    let last = '';
    for (let round = 1; round <= KILL_ATTEMPTS; round += 1) {
        const killed = await tmuxOn(cleanup.killRunner, tools, serverName, ['kill-server'], CLEANUP_TMUX_TIMEOUT_MS);
        const probe = await tmuxOn(cleanup.killRunner, tools, serverName, ['list-sessions'], CLEANUP_TMUX_TIMEOUT_MS);
        if (serverGone(probe)) {
            return removeSocket(trace);
        }
        const killNote = killed.code === 0 ? '' : `kill-server: ${describeFailure(killed)}; `;
        const probeNote = probe.code === 0 ? 'the server still answers' : `the probe failed: ${describeFailure(probe)}`;
        last = `${killNote}${probeNote}`;
        if (round < KILL_ATTEMPTS) {
            await delay(KILL_RETRY_MS);
        }
    }
    return `the isolated tmux server was not confirmed gone: ${last}`;
}

function createdPr(trace: Trace): { tools: Tools; repo: Repo; pr: Pr } | undefined {
    const { tools, repo, pr } = trace;
    return tools !== undefined && repo !== undefined && pr !== undefined ? { tools, repo, pr } : undefined;
}

async function closePr(cleanup: Cleanup): Promise<string | undefined> {
    const created = createdPr(cleanup.trace);
    if (created === undefined) {
        return;
    }
    const { tools, repo, pr } = created;
    const args = ghApiArgs(pullPath(repo, pr), requestArgs('PATCH', { state: 'closed' }));
    const closed = await cleanup.runner.run({ file: tools.gh, args });
    if (closed.code !== 0) {
        return `closing the PR failed: ${describeFailure(closed)}`;
    }
    cleanup.prClosed = true;
    return;
}

async function deleteBranch(cleanup: Cleanup): Promise<string | undefined> {
    const created = createdPr(cleanup.trace);
    if (created === undefined) {
        return;
    }
    const { tools, repo } = created;
    const args = ghApiArgs(`${repoPath(repo)}/git/refs/heads/${cleanup.trace.branch}`, requestArgs('DELETE', {}));
    const deleted = await cleanup.runner.run({ file: tools.gh, args });
    if (deleted.code !== 0) {
        return `deleting the branch failed: ${describeFailure(deleted)}`;
    }
    cleanup.branchDeleted = true;
    return;
}

function removeWorkArea(trace: Trace): string | undefined {
    if (trace.workArea !== undefined) {
        fs.rmSync(trace.workArea, { recursive: true, force: true });
    }
    return;
}

function sayKept(cleanup: Cleanup): void {
    const { trace } = cleanup;
    const pr = trace.pr === undefined ? 'none' : `${trace.pr.url}${cleanup.prClosed ? ' (closed)' : ''}`;
    const branch = `${trace.branch}${cleanup.branchDeleted ? ' (deleted)' : ''}`;
    say(`kept PR: ${pr} branch: ${branch} work area: ${trace.workArea ?? 'none'}`);
}

// --keep leaves the watcher, Claude, tmux server and worker kit usable. Otherwise the isolated server is always
// killed. On a pass, cleanup stops the watcher before killing its owned test server, then removes the remote and
// local artifacts. On a failure it saves pane output before killing the server and keeps the remaining artifacts.
async function cleanUp(trace: Trace, options: Options, passed: boolean, stop: AbortSignal): Promise<string[]> {
    const cleanup: Cleanup = {
        trace,
        runner: createProcessRunner(runnerEnv(process.env), { signal: stop }),
        killRunner: createProcessRunner(runnerEnv(process.env)),
        stop,
        problems: [],
        prClosed: false,
        branchDeleted: false,
    };
    if (options.keep) {
        sayKept(cleanup);
        return cleanup.problems;
    }
    const removeAll = passed;
    await (removeAll
        ? outward(cleanup, '--stop', () => stopWatcher(cleanup))
        : outward(cleanup, 'saving the panes', () => savePanes(cleanup)));
    await attempt(cleanup, 'killing the tmux server', () => killServer(cleanup));
    if (removeAll) {
        await outward(cleanup, 'closing the PR', () => closePr(cleanup));
        await outward(cleanup, 'deleting the branch', () => deleteBranch(cleanup));
        if (cleanup.problems.length === 0) {
            await outward(cleanup, 'removing the work area', () => Promise.resolve(removeWorkArea(trace)));
        }
    }
    if (!removeAll || cleanup.problems.length > 0 || stop.aborted) {
        sayKept(cleanup);
    }
    return cleanup.problems;
}

// SIGINT, SIGTERM and SIGHUP abort the run; one that arrives during cleanup also stops the cleanup steps that reach
// beyond the isolated server, which is killed in any case.
function watchSignals(): Signals {
    const runController = new AbortController();
    const cleanupController = new AbortController();
    const state = { name: '', cleaning: false };
    const handlers = HANDLED_SIGNALS.map((signalName) => {
        const handler = (): void => {
            if (state.name.length === 0) {
                state.name = signalName;
            }
            runController.abort();
            if (state.cleaning) {
                cleanupController.abort();
            }
        };
        process.on(signalName, handler);
        return { signalName, handler };
    });
    return {
        name: () => state.name,
        run: runController.signal,
        cleanup: cleanupController.signal,
        enterCleanup: () => {
            state.cleaning = true;
        },
        dispose: () => {
            for (const { signalName, handler } of handlers) {
                process.off(signalName, handler);
            }
        },
    };
}

function tryResolveTools(mode: Mode): Tools | string {
    try {
        return resolveTools(mode, normalizeCallerPath(process.env.PATH ?? ''));
    } catch (error) {
        return errorMessage(error);
    }
}

// Runs the smoke, then cleans up; the verdict line comes before cleanup on a failure (spec order) and after it on a
// pass, so SMOKE PASS is printed only once the cleanup succeeded.
async function runAndClean(options: Options, runstamp: string, tools: Tools, identity: Identity): Promise<number> {
    const signals = watchSignals();
    try {
        const smokeName = `prwc-smoke-${runstamp}`;
        const trace: Trace = { branch: smokeName, serverName: smokeName, serverStarted: false, watcherStarted: false };
        const runner = createProcessRunner(runnerEnv(process.env), { signal: signals.run });
        let failure: string | undefined;
        try {
            await runSmoke({ options, runner, signal: signals.run, trace }, runstamp, tools, identity);
        } catch (error) {
            failure = signals.run.aborted ? `interrupted by ${signals.name()}` : errorMessage(error);
        }
        signals.enterCleanup();
        if (failure === undefined && signals.name().length > 0) {
            failure = `interrupted by ${signals.name()}`;
        }
        if (failure !== undefined) {
            say(`SMOKE FAIL: ${failure}`);
        }
        const problems = await cleanUp(trace, options, failure === undefined, signals.cleanup);
        if (signals.cleanup.aborted) {
            problems.push(`interrupted by ${signals.name()}`);
        }
        if (failure !== undefined) {
            for (const problem of problems) {
                say(`cleanup: ${problem}`);
            }
            return 1;
        }
        if (problems.length > 0) {
            say(`SMOKE FAIL: cleanup: ${problems.join('; ')}`);
            return 1;
        }
        say(`SMOKE PASS (${options.mode})`);
        return 0;
    } finally {
        signals.dispose();
    }
}

async function main(): Promise<number> {
    const options = parseOptions(process.argv.slice(2));
    if (options === undefined) {
        say(USAGE);
        return 2;
    }
    const env: Env = process.env;
    if (env[CONFIRM_VAR] !== '1') {
        say(GATE_REFUSAL);
        return 2;
    }
    for (const tokenName of setTokenNames(env)) {
        say(`warning: ${tokenName} is set and ignored; this smoke uses the gh login stored for github.com`);
    }
    if (!hostAllowed(env)) {
        say(HOST_REFUSAL);
        return 2;
    }
    const runstamp = utcStamp(new Date());
    say(`runstamp: ${runstamp}`);
    const tools = tryResolveTools(options.mode);
    if (typeof tools === 'string') {
        say(`SMOKE FAIL: ${tools}`);
        return 1;
    }
    const identity = await readLocalIdentity(createProcessRunner(runnerEnv(env)), tools);
    if (identity === undefined) {
        say(IDENTITY_REFUSAL);
        return 2;
    }
    process.umask(0o077);
    return await runAndClean(options, runstamp, tools, identity);
}

process.exitCode = await main();
