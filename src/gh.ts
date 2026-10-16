import { isRecord, parseJson } from './json.ts';
import type { CommandResult, Deps, GhFailure, GhResult, Session } from './types.ts';
import { isValidNodeId } from './validate.ts';

export type GhDeps = Pick<Deps, 'runner'>;

// The gh executable plus the host every call goes to: github.com or the GitHub Enterprise Server host of the PR.
export interface GhCli {
    path: string;
    host: string;
}

const MESSAGE_LIMIT = 500;
const AUTH_MARKERS: readonly string[] = ['HTTP 401', 'Bad credentials', 'gh auth login'];
// Lower case; matched against the lower-cased stderr. The first two are gh's own offline text, the rest are Go
// network errors gh passes through.
const NETWORK_MARKERS: readonly string[] = [
    'error connecting to',
    'check your internet connection',
    'dial tcp',
    'no such host',
    'i/o timeout',
    'network is unreachable',
    'connection refused',
    'connection reset',
    'tls handshake timeout',
    'client.timeout exceeded',
    'server misbehaving',
    'temporary failure in name resolution',
];
const GONE_MARKER = 'Could not resolve to a node with the global id of';
const GONE_ID = /global id of '([^']*)'/gu;

function isNetworkError(stderr: string): boolean {
    const lower = stderr.toLowerCase();
    return NETWORK_MARKERS.some((marker) => lower.includes(marker));
}

// The message is the trimmed, truncated stderr and is not sanitized: callers that display it use safeText. Network
// markers are checked before the auth markers, so a lost connection is never taken for a fatal auth failure.
export function classifyGhFailure(stderr: string): GhFailure {
    const message = stderr.trim().slice(0, MESSAGE_LIMIT);
    if (isNetworkError(stderr)) {
        return { kind: 'transient', offline: true, message };
    }
    if (AUTH_MARKERS.some((marker) => stderr.includes(marker))) {
        return { kind: 'auth', message };
    }
    if (stderr.includes(GONE_MARKER)) {
        const quoted = [...stderr.matchAll(GONE_ID)].map((match) => match[1] ?? '');
        const ids = [...new Set(quoted.filter((id) => isValidNodeId(id)))];
        return { kind: 'gone', ids, message };
    }
    return { kind: 'transient', message };
}

// stdout of a failed call is never parsed: gh prints raw error bodies or partial data there. A call the runner cut
// off at its timeout counts as a lost connection.
export function commandFailure(result: CommandResult): GhFailure {
    if (result.timedOut === true) {
        const stderr = result.stderr.trim().slice(0, MESSAGE_LIMIT);
        return { kind: 'transient', offline: true, message: stderr.length > 0 ? stderr : 'gh timed out' };
    }
    const failure = classifyGhFailure(result.stderr);
    if (failure.message.length > 0) {
        return failure;
    }
    const message =
        result.spawnError === undefined
            ? `gh exited with code ${result.code}`
            : `gh could not be started: ${result.spawnError}`;
    return { ...failure, message };
}

export function sessionGh(session: Session): GhCli {
    return { path: session.tools.gh, host: session.pr.host };
}

export async function ghGraphql(
    deps: GhDeps,
    gh: GhCli,
    query: string,
    variables: Readonly<Record<string, unknown>>
): Promise<GhResult> {
    const input = JSON.stringify({ query, variables });
    const args = ['api', 'graphql', '--hostname', gh.host, '--input', '-'];
    const result = await deps.runner.run({ file: gh.path, args, input });
    if (result.code !== 0) {
        return commandFailure(result);
    }
    const parsed = parseJson(result.stdout);
    if (!isRecord(parsed)) {
        return { kind: 'transient', message: 'gh api graphql printed output that is not a JSON object' };
    }
    return { kind: 'ok', data: parsed.data };
}

// For non-graphql calls; the caller passes the full argument list, including --hostname with gh.host.
export async function ghCommand(deps: GhDeps, gh: GhCli, args: readonly string[]): Promise<GhResult> {
    const result = await deps.runner.run({ file: gh.path, args });
    if (result.code !== 0) {
        return commandFailure(result);
    }
    return { kind: 'ok', data: undefined };
}

// For REST reads that print a JSON body; the caller passes the full argument list, including --hostname with gh.host.
export async function ghJson(deps: GhDeps, gh: GhCli, args: readonly string[]): Promise<GhResult> {
    const result = await deps.runner.run({ file: gh.path, args });
    if (result.code !== 0) {
        return commandFailure(result);
    }
    const parsed = parseJson(result.stdout);
    if (!isRecord(parsed)) {
        return { kind: 'transient', message: 'gh api printed output that is not a JSON object' };
    }
    return { kind: 'ok', data: parsed };
}
