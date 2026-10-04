import type { Candidate, Logger, LookupEntry, LookupResult, PollResult, QueueResult } from './types.ts';

interface Approved {
    candidate: Candidate;
    rocketAt: number;
}

export function lookupIds(poll: PollResult, inflightNodeIds: readonly string[] = []): string[] {
    const rocketed = poll.comments.filter((comment) => comment.rocket).map((comment) => comment.nodeId);
    return [...new Set([...rocketed, ...inflightNodeIds])];
}

// The in-flight nodes are left out entirely: their approved text is already pinned in their snapshots. A comment
// edited at or after its rocket is refused, never queued, because the approved text is no longer the current text.
export function buildQueue(
    poll: PollResult,
    lookup: LookupResult,
    inflightNodeIds: readonly string[],
    log: Logger
): QueueResult {
    const inflight = new Set(inflightNodeIds);
    const entries = new Map(lookup.entries.map((entry) => [entry.nodeId, entry]));
    const seen = new Set<string>();
    const approved: Approved[] = [];
    const edited: LookupEntry[] = [];
    const skippedDbIds: number[] = [];
    for (const comment of poll.comments) {
        const entry = entries.get(comment.nodeId);
        if (!comment.rocket || inflight.has(comment.nodeId) || seen.has(comment.nodeId) || entry === undefined) {
            continue;
        }
        seen.add(comment.nodeId);
        const { rocketAt, editedAt } = entry;
        if (rocketAt === undefined) {
            log.info(`comment ${comment.dbId}: viewer rocket time not found, skipped`);
            skippedDbIds.push(comment.dbId);
        } else if (editedAt !== undefined && editedAt >= rocketAt) {
            edited.push(entry);
        } else {
            approved.push({ candidate: { poll: comment, entry }, rocketAt });
        }
    }
    const candidates = approved
        .toSorted((a, b) => a.rocketAt - b.rocketAt || a.candidate.poll.dbId - b.candidate.poll.dbId)
        .map((item) => item.candidate);
    return { candidates, edited, skippedDbIds };
}
