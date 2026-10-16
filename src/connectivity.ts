// Lost-connection handling of the watcher: one line when GitHub cannot be reached, quiet checks while it stays
// unreachable, one line when it is back.
import { DEFAULT_OFFLINE_CHECK, ENV_NAMES, PROBE_TIMEOUT_MS } from './constants.ts';
import { commandFailure, type GhCli, type GhDeps } from './gh.ts';
import { toned } from './logParts.ts';
import type { Env, Logger, WatcherStatus } from './types.ts';
import { readEnvSeconds, safeText } from './validate.ts';

export type Connectivity = 'online' | 'offline';

// The part of the watcher runtime this module owns: offlineSince is the wall time (epoch seconds) of the first
// offline failure, undefined while GitHub is reachable.
export interface OfflineRuntime {
    offlineSince: number | undefined;
    failures: number;
}

export interface ConnectivityContext {
    log: Logger;
    env: Env;
    nowSeconds: number;
    setStatus: (_patch: Partial<WatcherStatus>) => void;
}

export function offlineCheckSeconds(env: Env): number {
    return readEnvSeconds(env, ENV_NAMES.offlineCheck, DEFAULT_OFFLINE_CHECK);
}

// Any answer from GitHub, an HTTP error such as a 404 of a server without rate limiting included, proves the network
// works; only an offline-classified failure or a timeout keeps the watcher offline.
export async function probeGitHub(deps: GhDeps, gh: GhCli): Promise<Connectivity> {
    const args = ['api', 'rate_limit', '--hostname', gh.host];
    const result = await deps.runner.run({ file: gh.path, args, timeoutMs: PROBE_TIMEOUT_MS });
    if (result.code === 0) {
        return 'online';
    }
    const failure = commandFailure(result);
    return failure.kind === 'transient' && failure.offline === true ? 'offline' : 'online';
}

export function formatDuration(totalSeconds: number): string {
    const seconds = Math.max(0, Math.floor(totalSeconds));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const rest = seconds % 60;
    if (hours > 0) {
        return `${hours}h ${minutes}m`;
    }
    if (minutes > 0) {
        return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`;
    }
    return `${rest}s`;
}

// Only the first offline failure is logged and shown; later ones change nothing, and none counts as a backoff
// failure, because the offline checks keep their own fixed pace.
export function noteOffline(ctx: ConnectivityContext, rt: OfflineRuntime, message: string): void {
    if (rt.offlineSince !== undefined) {
        return;
    }
    rt.offlineSince = ctx.nowSeconds;
    const text = safeText(message);
    const every = offlineCheckSeconds(ctx.env);
    ctx.log.warn(
        `lost the connection to GitHub (${text}); checking every ${every} s and staying quiet until it is back`
    );
    ctx.setStatus({ state: 'offline', lastError: text });
}

export function noteOnline(ctx: ConnectivityContext, rt: OfflineRuntime): void {
    if (rt.offlineSince === undefined) {
        return;
    }
    const duration = formatDuration(ctx.nowSeconds - rt.offlineSince);
    ctx.log.info([toned('ok', 'connection to GitHub is back'), ` after ${duration}; watching resumed`]);
    rt.offlineSince = undefined;
    rt.failures = 0;
    ctx.setStatus({ lastError: '' });
}
