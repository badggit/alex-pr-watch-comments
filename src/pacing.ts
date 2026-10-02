import { BACKOFF_CAP, THROTTLE_CAP } from './constants.ts';
import type { PaceMode, RateInfo } from './types.ts';

export interface PaceStep {
    delaySeconds: number;
    mode: PaceMode;
}

// Beyond this many failures the doubled delay exceeds BACKOFF_CAP for any base of at least one second, so the
// power is not computed for large counters.
const MAX_DOUBLINGS = 8;

// Never shorter than the base interval, which may itself exceed THROTTLE_CAP.
function throttleDelay(baseSeconds: number, resetAt: number | undefined, nowSeconds: number): number {
    if (resetAt === undefined) {
        return baseSeconds;
    }
    return Math.max(baseSeconds, Math.min(resetAt - nowSeconds, THROTTLE_CAP));
}

// Never shorter than the base interval, which may itself exceed BACKOFF_CAP.
function backoffDelay(baseSeconds: number, failures: number): number {
    if (failures > MAX_DOUBLINGS) {
        return Math.max(baseSeconds, BACKOFF_CAP);
    }
    return Math.max(baseSeconds, Math.min(baseSeconds * 2 ** failures, BACKOFF_CAP));
}

// An unknown remaining budget never throttles; throttling wins over backoff.
export function nextDelay(
    baseSeconds: number,
    failures: number,
    rate: RateInfo,
    nowSeconds: number,
    reserve: number
): PaceStep {
    if (rate.remaining !== undefined && rate.remaining < reserve) {
        return { delaySeconds: throttleDelay(baseSeconds, rate.resetAt, nowSeconds), mode: 'throttled' };
    }
    if (failures > 0) {
        return { delaySeconds: backoffDelay(baseSeconds, failures), mode: 'backoff' };
    }
    return { delaySeconds: baseSeconds, mode: 'normal' };
}

// True when far more time passed since the last tick than was planned (sleep, suspend or a wall-clock change).
export function clockJumped(lastTickSeconds: number, nowSeconds: number, plannedDelaySeconds: number): boolean {
    return nowSeconds - lastTickSeconds > 3 * plannedDelaySeconds + 30;
}
