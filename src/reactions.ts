import { sessionGh } from './gh.ts';
import { react, type ReactOutcome } from './githubLookup.ts';
import type { Deps, Session } from './types.ts';
import { safeText } from './validate.ts';

export interface ReactTarget {
    nodeId: string;
    dbId: number;
}

// eyesOn: the viewer's EYES may still be on the comment, so a removal is tried first.
export interface FailTarget extends ReactTarget {
    eyesOn: boolean;
}

// A call, so TypeScript does not narrow the flag across the awaits between two checks.
function stopped(stop: AbortSignal | undefined): boolean {
    return stop?.aborted === true;
}

function failureText(outcome: ReactOutcome): string {
    return outcome.kind === 'invalid' ? 'invalid comment id' : outcome.kind === 'ok' ? '' : safeText(outcome.message);
}

export async function removeEyes(deps: Deps, session: Session, target: ReactTarget): Promise<void> {
    const result = await react(deps, sessionGh(session), 'remove', target.nodeId, 'EYES');
    if (result.kind !== 'ok') {
        deps.log.warn(`could not remove EYES from comment ${target.dbId}: ${failureText(result)}`);
    }
}

// Marks comments whose run ended without a fresh +1: EYES go, a THUMBS_DOWN comes. Adding a reaction the viewer
// already has changes nothing on GitHub, so marking again after an interrupted end is harmless. Failures are only
// logged; an observed stop ends the marking before the next request.
export async function markFailed(
    deps: Deps,
    session: Session,
    targets: readonly FailTarget[],
    stop?: AbortSignal
): Promise<void> {
    for (const target of targets) {
        if (stopped(stop)) {
            return;
        }
        if (target.eyesOn) {
            await removeEyes(deps, session, target);
            if (stopped(stop)) {
                return;
            }
        }
        const added = await react(deps, sessionGh(session), 'add', target.nodeId, 'THUMBS_DOWN');
        if (added.kind === 'ok') {
            deps.log.info(`comment ${target.dbId} marked as failed`);
        } else {
            deps.log.warn(`could not add THUMBS_DOWN to comment ${target.dbId}: ${failureText(added)}`);
        }
    }
}
