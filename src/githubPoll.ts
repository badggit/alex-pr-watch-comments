import { GRAPHQL_OPS, PAGE_SIZE } from './constants.ts';
import { ghGraphql, type GhDeps } from './gh.ts';
import { getArray, getBoolean, getNumber, getPath, getRecord, getString, isoToEpoch } from './json.ts';
import type { GhFailure, PollComment, PollResult, PrInfo, PrRef, PrState, RateInfo } from './types.ts';
import { isValidNodeId } from './validate.ts';

interface PageInfo {
    hasNextPage: boolean;
    endCursor: string | undefined;
}

interface CommentNode {
    nodeId: string;
    dbId: number;
    rocket: boolean;
}

interface CommentPage {
    pageInfo: PageInfo;
    comments: CommentNode[];
}

interface ThreadNode {
    id: string;
    firstPage: CommentPage;
}

interface PollPage {
    viewer: string;
    prState: PrState;
    headRef: string;
    pageInfo: PageInfo;
    threads: ThreadNode[];
}

interface HeadRepository {
    owner: string;
    repo: string;
    permission: string;
}

type Fetched<T> = { kind: 'ok'; value: T; rate: RateInfo } | GhFailure;

type CursorStep = { kind: 'done' } | { kind: 'next'; cursor: string } | { kind: 'stuck' };

const PUSH_PERMISSIONS: ReadonlySet<string> = new Set(['ADMIN', 'MAINTAIN', 'WRITE']);

const PR_STATES: readonly PrState[] = ['OPEN', 'CLOSED', 'MERGED'];

const RATE_FIELDS = 'rateLimit { remaining resetAt }';

const COMMENT_FIELDS =
    'pageInfo { hasNextPage endCursor } nodes { id databaseId reactionGroups { content viewerHasReacted } }';

const PR_INFO_QUERY = `query ${GRAPHQL_OPS.prInfo}($owner: String!, $repo: String!, $number: Int!) {
    viewer { login }
    ${RATE_FIELDS}
    repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
            state
            headRefName
            isCrossRepository
            maintainerCanModify
            headRepository { owner { login } name viewerPermission }
            baseRepository { viewerPermission }
        }
    }
}`;

const POLL_QUERY = `query ${GRAPHQL_OPS.poll}($owner: String!, $repo: String!, $number: Int!, $endCursor: String) {
    viewer { login }
    ${RATE_FIELDS}
    repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
            state
            headRefName
            reviewThreads(first: ${PAGE_SIZE}, after: $endCursor) {
                pageInfo { hasNextPage endCursor }
                nodes { id comments(first: ${PAGE_SIZE}) { ${COMMENT_FIELDS} } }
            }
        }
    }
}`;

const THREAD_COMMENTS_QUERY = `query ${GRAPHQL_OPS.threadComments}($id: ID!, $endCursor: String) {
    ${RATE_FIELDS}
    node(id: $id) {
        ... on PullRequestReviewThread {
            comments(first: ${PAGE_SIZE}, after: $endCursor) { ${COMMENT_FIELDS} }
        }
    }
}`;

function toPrState(value: string | undefined): PrState | undefined {
    return PR_STATES.find((state) => state === value);
}

function decodeRate(data: unknown): RateInfo {
    return {
        remaining: getNumber(getRecord(data, 'rateLimit'), 'remaining'),
        resetAt: isoToEpoch(getPath(data, 'rateLimit', 'resetAt')),
    };
}

// A response without any rate reading must not replace an older, usable one.
function freshRate(data: unknown): RateInfo | undefined {
    const rate = decodeRate(data);
    return rate.remaining === undefined && rate.resetAt === undefined ? undefined : rate;
}

// Any undecodable item makes the whole list undecodable.
function decodeEach<T>(items: unknown[] | undefined, decode: (_item: unknown) => T | undefined): T[] | undefined {
    if (items === undefined) {
        return;
    }
    const decoded: T[] = [];
    for (const item of items) {
        const value = decode(item);
        if (value === undefined) {
            return;
        }
        decoded.push(value);
    }
    return decoded;
}

// endCursor is null on an empty connection.
function decodePageInfo(value: unknown): PageInfo | undefined {
    const hasNextPage = getBoolean(value, 'hasNextPage');
    const endCursor = getPath(value, 'endCursor');
    if (hasNextPage === undefined) {
        return;
    }
    if (typeof endCursor === 'string') {
        return { hasNextPage, endCursor };
    }
    if (endCursor === null) {
        return { hasNextPage, endCursor: undefined };
    }
    return;
}

function decodeComment(value: unknown): CommentNode | undefined {
    const nodeId = getString(value, 'id');
    const dbId = getNumber(value, 'databaseId');
    const groups = getArray(value, 'reactionGroups');
    if (nodeId === undefined || !isValidNodeId(nodeId) || dbId === undefined || groups === undefined) {
        return;
    }
    if (!Number.isSafeInteger(dbId) || dbId <= 0) {
        return;
    }
    const rocket = groups.some(
        (group) => getString(group, 'content') === 'ROCKET' && getBoolean(group, 'viewerHasReacted') === true
    );
    return { nodeId, dbId, rocket };
}

function decodeCommentPage(value: unknown): CommentPage | undefined {
    const pageInfo = decodePageInfo(getPath(value, 'pageInfo'));
    const comments = decodeEach(getArray(value, 'nodes'), (item) => decodeComment(item));
    if (pageInfo === undefined || comments === undefined) {
        return;
    }
    return { pageInfo, comments };
}

function decodeThread(value: unknown): ThreadNode | undefined {
    const id = getString(value, 'id');
    const firstPage = decodeCommentPage(getPath(value, 'comments'));
    if (id === undefined || !isValidNodeId(id) || firstPage === undefined) {
        return;
    }
    return { id, firstPage };
}

function decodePollPage(data: unknown): PollPage | undefined {
    const pull = getPath(data, 'repository', 'pullRequest');
    const viewer = getString(getPath(data, 'viewer'), 'login');
    const prState = toPrState(getString(pull, 'state'));
    const headRef = getString(pull, 'headRefName');
    const pageInfo = decodePageInfo(getPath(pull, 'reviewThreads', 'pageInfo'));
    const threads = decodeEach(getArray(getPath(pull, 'reviewThreads'), 'nodes'), (item) => decodeThread(item));
    if (
        viewer !== undefined &&
        prState !== undefined &&
        headRef !== undefined &&
        pageInfo !== undefined &&
        threads !== undefined
    ) {
        return { viewer, prState, headRef, pageInfo, threads };
    }
    return;
}

function decodeHeadRepository(value: unknown): HeadRepository | undefined {
    const owner = getString(getPath(value, 'owner'), 'login');
    const repo = getString(value, 'name');
    const permission = getString(value, 'viewerPermission');
    if (owner !== undefined && repo !== undefined && permission !== undefined) {
        return { owner, repo, permission };
    }
    return;
}

// GitHub returns the canonical mixed-case head names; they are lowercased like PrRef so comparisons ignore case.
function decodePrInfo(data: unknown): PrInfo | undefined {
    const pull = getPath(data, 'repository', 'pullRequest');
    const viewer = getString(getPath(data, 'viewer'), 'login');
    const state = toPrState(getString(pull, 'state'));
    const headRef = getString(pull, 'headRefName');
    const isCross = getBoolean(pull, 'isCrossRepository');
    const maintainerCanModify = getBoolean(pull, 'maintainerCanModify');
    const head = decodeHeadRepository(getPath(pull, 'headRepository'));
    const basePermission = getString(getPath(pull, 'baseRepository'), 'viewerPermission');
    if (
        viewer !== undefined &&
        state !== undefined &&
        headRef !== undefined &&
        isCross !== undefined &&
        maintainerCanModify !== undefined &&
        head !== undefined &&
        basePermission !== undefined
    ) {
        const canPush =
            PUSH_PERMISSIONS.has(head.permission) ||
            (isCross && maintainerCanModify && PUSH_PERMISSIONS.has(basePermission));
        return {
            viewer,
            state,
            headRef,
            headOwner: head.owner.toLowerCase(),
            headRepo: head.repo.toLowerCase(),
            isCross,
            canPush,
        };
    }
    return;
}

async function fetchDecoded<T>(
    deps: GhDeps,
    ghPath: string,
    operation: string,
    query: string,
    variables: Readonly<Record<string, unknown>>,
    decode: (_data: unknown) => T | undefined
): Promise<Fetched<T>> {
    const response = await ghGraphql(deps, ghPath, query, variables);
    if (response.kind !== 'ok') {
        return response;
    }
    const value = decode(response.data);
    if (value === undefined) {
        const message = `unexpected ${operation} response`;
        const rate = freshRate(response.data);
        return rate === undefined ? { kind: 'transient', message } : { kind: 'transient', message, rate };
    }
    return { kind: 'ok', value, rate: decodeRate(response.data) };
}

// A node vanishing mid-poll is transient for the poll. The failure keeps the rate of its own malformed response
// when it had one, else the rate of the last successful call.
function pollFailure(failure: GhFailure, previousRate: RateInfo | undefined): GhFailure {
    const kind = failure.kind === 'auth' ? 'auth' : 'transient';
    const { message } = failure;
    const rate = failure.rate ?? previousRate;
    return rate === undefined ? { kind, message } : { kind, message, rate };
}

function stuckFailure(operation: string, rate: RateInfo): GhFailure {
    return { kind: 'transient', message: `${operation} pagination cursor did not advance`, rate };
}

// A next page whose cursor is missing or was already seen on this connection would loop forever (A -> B -> A
// as well as A -> A), so it is stuck. Records the new cursor in seen.
function advance(pageInfo: PageInfo, seen: Set<string>): CursorStep {
    if (!pageInfo.hasNextPage) {
        return { kind: 'done' };
    }
    if (pageInfo.endCursor === undefined || seen.has(pageInfo.endCursor)) {
        return { kind: 'stuck' };
    }
    seen.add(pageInfo.endCursor);
    return { kind: 'next', cursor: pageInfo.endCursor };
}

function positioned(threadId: string, nodes: readonly CommentNode[]): PollComment[] {
    const topDbId = nodes[0]?.dbId;
    if (topDbId === undefined) {
        return [];
    }
    return nodes.map((node, position) => ({
        threadId,
        position,
        nodeId: node.nodeId,
        dbId: node.dbId,
        topDbId,
        rocket: node.rocket,
    }));
}

// Continues a thread whose first comment page is not its last, starting after that page's endCursor.
async function collectThread(
    deps: GhDeps,
    ghPath: string,
    thread: ThreadNode,
    rate: RateInfo
): Promise<{ kind: 'ok'; comments: PollComment[]; rate: RateInfo } | GhFailure> {
    const nodes = [...thread.firstPage.comments];
    let latestRate = rate;
    const seen = new Set<string>();
    let step = advance(thread.firstPage.pageInfo, seen);
    while (step.kind === 'next') {
        const { cursor } = step;
        const page = await fetchDecoded(
            deps,
            ghPath,
            GRAPHQL_OPS.threadComments,
            THREAD_COMMENTS_QUERY,
            { id: thread.id, endCursor: cursor },
            (data) => decodeCommentPage(getPath(data, 'node', 'comments'))
        );
        if (page.kind !== 'ok') {
            return pollFailure(page, latestRate);
        }
        latestRate = page.rate;
        nodes.push(...page.value.comments);
        step = advance(page.value.pageInfo, seen);
    }
    if (step.kind === 'stuck') {
        return stuckFailure(GRAPHQL_OPS.threadComments, latestRate);
    }
    return { kind: 'ok', comments: positioned(thread.id, nodes), rate: latestRate };
}

export async function fetchPrInfo(
    deps: GhDeps,
    ghPath: string,
    pr: PrRef
): Promise<{ kind: 'ok'; info: PrInfo } | GhFailure> {
    const variables = { owner: pr.owner, repo: pr.repo, number: pr.number };
    const response = await ghGraphql(deps, ghPath, PR_INFO_QUERY, variables);
    if (response.kind !== 'ok') {
        return response;
    }
    if (getPath(response.data, 'repository', 'pullRequest', 'headRepository') === null) {
        return { kind: 'transient', message: 'head repository deleted' };
    }
    const info = decodePrInfo(response.data);
    return info === undefined
        ? { kind: 'transient', message: `unexpected ${GRAPHQL_OPS.prInfo} response` }
        : { kind: 'ok', info };
}

// One call per review-thread page plus one per extra comment page of a long thread; the rate is the last
// successful call's, whichever query it was.
export async function pollPr(
    deps: GhDeps,
    ghPath: string,
    pr: PrRef
): Promise<{ kind: 'ok'; result: PollResult } | GhFailure> {
    const baseVariables = { owner: pr.owner, repo: pr.repo, number: pr.number };
    const comments: PollComment[] = [];
    let rate: RateInfo | undefined;
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (;;) {
        const variables = cursor === undefined ? baseVariables : { ...baseVariables, endCursor: cursor };
        const page = await fetchDecoded(deps, ghPath, GRAPHQL_OPS.poll, POLL_QUERY, variables, (data) =>
            decodePollPage(data)
        );
        if (page.kind !== 'ok') {
            return pollFailure(page, rate);
        }
        let latestRate = page.rate;
        for (const thread of page.value.threads) {
            const collected = await collectThread(deps, ghPath, thread, latestRate);
            if (collected.kind !== 'ok') {
                return collected;
            }
            latestRate = collected.rate;
            comments.push(...collected.comments);
        }
        rate = latestRate;
        const step = advance(page.value.pageInfo, seen);
        if (step.kind === 'stuck') {
            return stuckFailure(GRAPHQL_OPS.poll, latestRate);
        }
        if (step.kind === 'done') {
            const { prState, viewer, headRef } = page.value;
            return { kind: 'ok', result: { prState, viewer, headRef, rate: latestRate, comments } };
        }
        cursor = step.cursor;
    }
}
