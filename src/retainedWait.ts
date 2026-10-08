// Pure helpers that make approved comments visible while a retained run holds the slot: the waiting set, the status
// texts, the notice schedule and the hint for a launch blocked by a retained clone.
import { RETAINED_REMINDER_SECONDS } from './constants.ts';
import { worktreeLockHolder } from './locks.ts';
import { readRecord } from './runStore.ts';
import type { Candidate, RunOutcome } from './types.ts';

export interface WaitingSet {
    keys: readonly string[];
    count: number;
}

export interface RetainedStatusInput {
    outcome: RunOutcome;
    paneId: string;
    waiting: WaitingSet | undefined;
    closed: 'CLOSED' | 'MERGED' | undefined;
}

export interface NoticeState {
    waitingKey: string | undefined;
    closedSeen: boolean;
    remindAt: number | undefined;
}

export interface NoticePlan {
    notice: string | undefined;
    log: string | undefined;
    next: NoticeState;
}

const PANE_ID = /^%(?<number>\d+)$/u;

export function waitingSetOf(candidates: readonly Candidate[]): WaitingSet {
    const keys = candidates.map(({ entry }) => `${entry.nodeId}:${entry.rocketAt ?? 0}`).toSorted();
    return { keys, count: keys.length };
}

function waitingKeyOf(waiting: WaitingSet): string {
    return waiting.keys.join(' ');
}

export function sameWaitingSet(a: WaitingSet | undefined, b: WaitingSet | undefined): boolean {
    if (a === undefined || b === undefined) {
        return a === b;
    }
    return waitingKeyOf(a) === waitingKeyOf(b);
}

function paneText(paneId: string): string {
    const number = PANE_ID.exec(paneId)?.groups?.number;
    return number === undefined ? 'its worker pane' : `pane ${number}`;
}

function closedWord(closed: 'CLOSED' | 'MERGED'): string {
    return closed === 'MERGED' ? 'merged' : 'closed';
}

function countText(count: number): string {
    return count === 1 ? '1 approved comment waiting' : `${count} approved comments waiting`;
}

export function waitingSuffix(waiting: WaitingSet | undefined, closed: 'CLOSED' | 'MERGED' | undefined): string {
    if (closed !== undefined) {
        return `, PR ${closedWord(closed)}`;
    }
    if (waiting === undefined || waiting.count === 0) {
        return '';
    }
    return `, ${countText(waiting.count)}`;
}

function nextBatchHint(paneId: string): string {
    return `exit Claude in ${paneText(paneId)} to start the next batch`;
}

export function retainedStatus(input: RetainedStatusInput): { reason: string; hint: string } {
    const { outcome, paneId, waiting, closed } = input;
    const reason = `${outcome}-waiting-for-owner${waitingSuffix(waiting, closed)}`;
    if (closed !== undefined) {
        return { reason, hint: `exit Claude in ${paneText(paneId)} to finish` };
    }
    if (waiting === undefined || waiting.count === 0) {
        return { reason, hint: '' };
    }
    return { reason, hint: nextBatchHint(paneId) };
}

export function initialNoticeState(): NoticeState {
    return { waitingKey: undefined, closedSeen: false, remindAt: undefined };
}

function reminderDue(state: NoticeState, now: number): boolean {
    return state.remindAt !== undefined && now >= state.remindAt;
}

function planClosed(previous: NoticeState, now: number, runId: string, closed: 'CLOSED' | 'MERGED'): NoticePlan {
    const notice = `PR ${closedWord(closed)}, exit Claude to finish`;
    const next: NoticeState = { ...previous, closedSeen: true, remindAt: now + RETAINED_REMINDER_SECONDS };
    if (!previous.closedSeen) {
        return { notice, log: `run ${runId}: PR ${closedWord(closed)}, waiting for the owner to exit Claude`, next };
    }
    if (reminderDue(previous, now)) {
        return { notice, log: undefined, next };
    }
    return { notice: undefined, log: undefined, next: previous };
}

// One reminder deadline per watcher: every notice moves it, and a set that empties clears it.
export function planNotice(
    previous: NoticeState,
    input: { now: number; runId: string; status: RetainedStatusInput }
): NoticePlan {
    const { now, runId, status } = input;
    if (status.closed !== undefined) {
        return planClosed(previous, now, runId, status.closed);
    }
    const open: NoticeState = { ...previous, closedSeen: false };
    const { waiting } = status;
    if (waiting === undefined) {
        return { notice: undefined, log: undefined, next: open };
    }
    const waitingKey = waitingKeyOf(waiting);
    const notice = `run ${runId}: ${countText(waiting.count)}, ${nextBatchHint(status.paneId)}`;
    if (waitingKey !== previous.waitingKey) {
        if (waiting.count > 0) {
            const next = { ...open, waitingKey, remindAt: now + RETAINED_REMINDER_SECONDS };
            return { notice, log: `run ${runId}: ${countText(waiting.count)}`, next };
        }
        const next = { ...open, waitingKey, remindAt: undefined };
        const log = previous.waitingKey === undefined ? undefined : `run ${runId}: no approved comments waiting`;
        return { notice: undefined, log, next };
    }
    if (waiting.count > 0 && reminderDue(previous, now)) {
        return { notice, log: undefined, next: { ...open, remindAt: now + RETAINED_REMINDER_SECONDS } };
    }
    return { notice: undefined, log: undefined, next: open };
}

export function busyHint(stateDir: string, wtKey: string): string {
    const runId = worktreeLockHolder(stateDir, wtKey);
    if (runId === undefined) {
        return '';
    }
    const read = readRecord(stateDir, runId);
    if (read.kind !== 'ok' || read.record.state !== 'retained') {
        return '';
    }
    return `run ${runId} of PR ${read.record.number} holds the clone until its Claude session exits`;
}
