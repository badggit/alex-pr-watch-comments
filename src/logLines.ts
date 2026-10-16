import { toned } from './logParts.ts';
import type { LogMessage, LogPart, LookupEntry, RunComment } from './types.ts';
import { visibleText } from './untrustedText.ts';

// What a console line needs to name a comment; author and url come from GitHub and are escaped before printing.
export interface CommentLabel {
    dbId: number;
    url?: string;
    author?: string;
}

// The login whose rocket approved the comment: the viewer when the viewer's rocket is the counting one, else the
// other user whose rocket time is the approval time (see resolveEntry in approval.ts).
export function approverOf(entry: LookupEntry, viewer: string): string | undefined {
    if (entry.rocketAt === undefined) {
        return;
    }
    if (entry.viewerRocketAt === entry.rocketAt) {
        return viewer;
    }
    return entry.rockets.find((rocket) => rocket.at === entry.othersRocketAt)?.login;
}

export function runPart(runId: string): LogPart {
    return toned('run', `run ${runId}`);
}

function authorPart(login: string): LogPart {
    return toned('author', `@${visibleText(login)}`);
}

function linkPart(url: string): LogPart {
    return toned('link', visibleText(url));
}

function placeParts(comment: RunComment): LogPart[] {
    if (comment.path === undefined) {
        return [];
    }
    const line = comment.line === undefined ? '' : `:${comment.line}`;
    return [' on ', toned('path', `${visibleText(comment.path)}${line}`)];
}

export function batchLine(runId: string, count: number): LogPart[] {
    const noun = count === 1 ? 'comment' : 'comments';
    return [runPart(runId), ': Claude is fixing ', toned('strong', `${count} ${noun}`)];
}

// An indented line per comment: who wrote it, where, who approved it and its link. A record written before author
// and path were stored names the comment by its id.
export function commentLine(comment: RunComment, approver?: string): LogPart[] {
    const who = comment.author === undefined ? [`comment ${comment.dbId}`] : [authorPart(comment.author)];
    const approved = approver === undefined ? [] : [', approved by ', authorPart(approver)];
    return ['  ', ...who, ...placeParts(comment), ...approved, ': ', linkPart(comment.url)];
}

export function linkLine(url: string): LogPart[] {
    return ['  ', linkPart(url)];
}

export function markedFailedLine(label: CommentLabel): LogMessage {
    if (label.url === undefined || label.author === undefined) {
        return `comment ${label.dbId} marked as failed`;
    }
    return [
        'comment by ',
        authorPart(label.author),
        ' ',
        toned('bad', 'marked -1'),
        ' (not resolved): ',
        linkPart(label.url),
    ];
}
