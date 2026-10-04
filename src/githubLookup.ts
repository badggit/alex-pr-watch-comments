import { GRAPHQL_OPS, PAGE_SIZE } from './constants.ts';
import { ghGraphql, type GhDeps } from './gh.ts';
import { getArray, getBoolean, getNumber, getPath, getRecord, getString, isoToEpoch, isRecord } from './json.ts';
import type { GhFailure, GhResult, LookupEntry, LookupResult, RateInfo } from './types.ts';
import { quoteUntrusted, visibleText } from './untrustedText.ts';
import { isValidNodeId } from './validate.ts';

export type PagedReaction = 'ROCKET' | 'THUMBS_UP';
export type ReactionContent = PagedReaction | 'EYES' | 'THUMBS_DOWN';
export type ReactionAction = 'add' | 'remove';

export type LookupOutcome = { kind: 'ok'; result: LookupResult } | GhFailure;
export type ReactionTimeOutcome = { kind: 'ok'; at: number | undefined; rate: RateInfo } | GhFailure;
export type ContextOutcome = { kind: 'ok'; text: string } | GhFailure;
export type ReactOutcome = GhResult | { kind: 'invalid' };

interface ReactionConnection {
    hasNextPage: boolean;
    endCursor: string | undefined;
    nodes: unknown[];
}

interface LookupPage {
    viewer: string;
    rate: RateInfo;
    nodes: unknown[];
}

type ChunkOutcome = { kind: 'ok'; data: unknown; gone: string[] } | GhFailure;
type TimeOutcome = { kind: 'ok'; at: number | undefined; rate: RateInfo | undefined } | GhFailure;
type EntryOutcome = { kind: 'ok'; entry: LookupEntry | undefined; rate: RateInfo | undefined } | GhFailure;

const RATE_FIELDS = 'rateLimit { remaining resetAt }';
const REACTION_PAGE = 'pageInfo { hasNextPage endCursor } nodes { createdAt user { login } }';
const LOOKUP_QUERY = [
    `query ${GRAPHQL_OPS.lookup}($ids: [ID!]!) {`,
    `viewer { login } ${RATE_FIELDS}`,
    'nodes(ids: $ids) { ... on PullRequestReviewComment {',
    'id databaseId url lastEditedAt body path line author { login }',
    `rocket: reactions(content: ROCKET, first: ${PAGE_SIZE}) { ${REACTION_PAGE} }`,
    `plus: reactions(content: THUMBS_UP, first: ${PAGE_SIZE}) { ${REACTION_PAGE} }`,
    'reactionGroups { content viewerHasReacted }',
    '} } }',
].join(' ');
const REACTIONS_QUERY = [
    `query ${GRAPHQL_OPS.reactions}($id: ID!, $content: ReactionContent!, $endCursor: String) {`,
    RATE_FIELDS,
    'node(id: $id) { ... on PullRequestReviewComment {',
    `reactions(content: $content, first: ${PAGE_SIZE}, after: $endCursor) { ${REACTION_PAGE} }`,
    '} } }',
].join(' ');
const CONTEXT_QUERY = [
    `query ${GRAPHQL_OPS.context}($ids: [ID!]!) {`,
    RATE_FIELDS,
    'nodes(ids: $ids) { ... on PullRequestReviewComment { id createdAt body author { login } } } }',
].join(' ');
const ADD_REACTION_MUTATION = [
    `mutation ${GRAPHQL_OPS.addReaction}($id: ID!, $content: ReactionContent!) {`,
    'addReaction(input: { subjectId: $id, content: $content }) { reaction { content } } }',
].join(' ');
const REMOVE_REACTION_MUTATION = [
    `mutation ${GRAPHQL_OPS.removeReaction}($id: ID!, $content: ReactionContent!) {`,
    'removeReaction(input: { subjectId: $id, content: $content }) { reaction { content } } }',
].join(' ');
const GHOST_AUTHOR = 'ghost';

function emptyRate(): RateInfo {
    return { remaining: undefined, resetAt: undefined };
}

function readRate(data: unknown): RateInfo {
    const rateLimit = getRecord(data, 'rateLimit');
    return { remaining: getNumber(rateLimit, 'remaining'), resetAt: isoToEpoch(getPath(rateLimit, 'resetAt')) };
}

// The fresh rate of a response whose structure is otherwise unusable, so a malformed answer still updates pacing.
function freshRate(data: unknown, previous: RateInfo | undefined): RateInfo | undefined {
    return getRecord(data, 'rateLimit') === undefined ? previous : readRate(data);
}

function withRate(failure: GhFailure, rate: RateInfo | undefined): GhFailure {
    return rate === undefined ? failure : { ...failure, rate };
}

function transient(message: string, rate?: RateInfo): GhFailure {
    return withRate({ kind: 'transient', message }, rate);
}

function chunked(ids: readonly string[]): string[][] {
    const chunks: string[][] = [];
    for (let start = 0; start < ids.length; start += PAGE_SIZE) {
        chunks.push(ids.slice(start, start + PAGE_SIZE));
    }
    return chunks;
}

function readConnection(value: unknown): ReactionConnection | undefined {
    const nodes = getArray(value, 'nodes');
    const hasNextPage = getBoolean(getRecord(value, 'pageInfo'), 'hasNextPage');
    if (nodes === undefined || hasNextPage === undefined) {
        return;
    }
    return { hasNextPage, endCursor: getString(getRecord(value, 'pageInfo'), 'endCursor'), nodes };
}

function viewerNode(nodes: readonly unknown[], viewer: string): unknown {
    return nodes.find((node) => getPath(node, 'user', 'login') === viewer);
}

function viewerHasReacted(node: unknown, content: ReactionContent): boolean {
    const groups = getArray(node, 'reactionGroups') ?? [];
    const group = groups.find((item) => getString(item, 'content') === content);
    return getBoolean(group, 'viewerHasReacted') === true;
}

// Retries a chunk once without the ids a gone failure named; a second gone failure is transient.
async function queryChunk(deps: GhDeps, ghPath: string, ids: readonly string[]): Promise<ChunkOutcome> {
    const first = await ghGraphql(deps, ghPath, LOOKUP_QUERY, { ids });
    if (first.kind === 'ok') {
        return { kind: 'ok', data: first.data, gone: [] };
    }
    if (first.kind !== 'gone') {
        return first;
    }
    const goneIds = new Set(first.ids);
    const gone = ids.filter((id) => goneIds.has(id));
    if (gone.length === 0) {
        return transient(first.message);
    }
    const rest = ids.filter((id) => !goneIds.has(id));
    if (rest.length === 0) {
        return { kind: 'ok', data: undefined, gone };
    }
    const retry = await ghGraphql(deps, ghPath, LOOKUP_QUERY, { ids: rest });
    if (retry.kind === 'ok') {
        return { kind: 'ok', data: retry.data, gone };
    }
    return retry.kind === 'gone' ? transient(retry.message) : retry;
}

function decodeLookupPage(data: unknown): LookupPage | undefined {
    const viewer = getPath(data, 'viewer', 'login');
    const nodes = getArray(data, 'nodes');
    if (typeof viewer !== 'string' || viewer.length === 0 || nodes === undefined) {
        return;
    }
    return { viewer, rate: readRate(data), nodes };
}

// The own key lastEditedAt is required: null means never edited; a missing key or an unparsable time gives undefined,
// so the node is dropped and an edit after approval can never pass as "not edited".
function readEditedAt(node: unknown): { editedAt: number | undefined } | undefined {
    if (!isRecord(node) || !Object.hasOwn(node, 'lastEditedAt')) {
        return;
    }
    const value = node.lastEditedAt;
    if (value === null) {
        return { editedAt: undefined };
    }
    const editedAt = isoToEpoch(value);
    return editedAt === undefined ? undefined : { editedAt };
}

// The comment fields without the reaction times; undefined for a node that is not a usable review comment.
function decodeComment(node: unknown): Omit<LookupEntry, 'rocketAt' | 'plus1At'> | undefined {
    const nodeId = getString(node, 'id');
    const edited = readEditedAt(node);
    const dbId = getNumber(node, 'databaseId');
    const url = getString(node, 'url');
    const body = getString(node, 'body');
    const filePath = getString(node, 'path');
    if (
        nodeId === undefined ||
        !isValidNodeId(nodeId) ||
        dbId === undefined ||
        !Number.isSafeInteger(dbId) ||
        dbId <= 0 ||
        url === undefined ||
        body === undefined ||
        filePath === undefined ||
        edited === undefined
    ) {
        return;
    }
    const line = getNumber(node, 'line');
    return {
        nodeId,
        dbId,
        eyes: viewerHasReacted(node, 'EYES'),
        minus1: viewerHasReacted(node, 'THUMBS_DOWN'),
        editedAt: edited.editedAt,
        url,
        author: getString(getRecord(node, 'author'), 'login') ?? GHOST_AUTHOR,
        path: filePath,
        line: line !== undefined && Number.isSafeInteger(line) ? line : undefined,
        body,
    };
}

export async function fetchReactionTime(
    deps: GhDeps,
    ghPath: string,
    nodeId: string,
    content: PagedReaction,
    startCursor: string,
    viewer: string
): Promise<ReactionTimeOutcome> {
    let cursor = startCursor;
    const seenCursors = new Set([startCursor]);
    let rate: RateInfo | undefined;
    for (;;) {
        const result = await ghGraphql(deps, ghPath, REACTIONS_QUERY, { id: nodeId, content, endCursor: cursor });
        if (result.kind !== 'ok') {
            return withRate(result, rate);
        }
        const connection = readConnection(getPath(result.data, 'node', 'reactions'));
        if (connection === undefined) {
            return transient(`unexpected ${GRAPHQL_OPS.reactions} response`, freshRate(result.data, rate));
        }
        rate = readRate(result.data);
        const found = viewerNode(connection.nodes, viewer);
        if (found !== undefined) {
            return { kind: 'ok', at: isoToEpoch(getPath(found, 'createdAt')), rate };
        }
        if (!connection.hasNextPage) {
            return { kind: 'ok', at: undefined, rate };
        }
        if (connection.endCursor === undefined || seenCursors.has(connection.endCursor)) {
            return transient(`${GRAPHQL_OPS.reactions} returned a repeated cursor`, rate);
        }
        cursor = connection.endCursor;
        seenCursors.add(cursor);
    }
}

// The viewer's reaction time from the first page, or through the follow-up only when the viewer reacted but is
// not among the first page's reactions and more pages exist.
async function viewerReactionTime(
    deps: GhDeps,
    ghPath: string,
    node: unknown,
    nodeId: string,
    content: PagedReaction,
    viewer: string
): Promise<TimeOutcome> {
    const connection = readConnection(getPath(node, content === 'ROCKET' ? 'rocket' : 'plus'));
    if (connection === undefined) {
        return { kind: 'ok', at: undefined, rate: undefined };
    }
    const found = viewerNode(connection.nodes, viewer);
    if (found !== undefined) {
        return { kind: 'ok', at: isoToEpoch(getPath(found, 'createdAt')), rate: undefined };
    }
    if (!connection.hasNextPage || !viewerHasReacted(node, content)) {
        return { kind: 'ok', at: undefined, rate: undefined };
    }
    if (connection.endCursor === undefined) {
        return transient(`${GRAPHQL_OPS.lookup} returned no reaction cursor`);
    }
    const followUp = await fetchReactionTime(deps, ghPath, nodeId, content, connection.endCursor, viewer);
    return followUp;
}

async function decodeEntry(
    deps: GhDeps,
    ghPath: string,
    node: unknown,
    viewer: string,
    lastRate: RateInfo
): Promise<EntryOutcome> {
    const comment = decodeComment(node);
    if (comment === undefined) {
        return { kind: 'ok', entry: undefined, rate: undefined };
    }
    const rocket = await viewerReactionTime(deps, ghPath, node, comment.nodeId, 'ROCKET', viewer);
    if (rocket.kind !== 'ok') {
        return withRate(rocket, rocket.rate ?? lastRate);
    }
    const rateAfterRocket = rocket.rate ?? lastRate;
    const plus = await viewerReactionTime(deps, ghPath, node, comment.nodeId, 'THUMBS_UP', viewer);
    if (plus.kind !== 'ok') {
        return withRate(plus, plus.rate ?? rateAfterRocket);
    }
    return {
        kind: 'ok',
        entry: { ...comment, rocketAt: rocket.at, plus1At: plus.at },
        rate: plus.rate ?? rocket.rate,
    };
}

function followUpFailure(failure: GhFailure): GhFailure {
    return failure.kind === 'gone' ? withRate({ kind: 'transient', message: failure.message }, failure.rate) : failure;
}

export async function lookupComments(deps: GhDeps, ghPath: string, ids: readonly string[]): Promise<LookupOutcome> {
    const unique = [...new Set(ids.filter((id) => isValidNodeId(id)))];
    const entries: LookupEntry[] = [];
    const gone: string[] = [];
    let rate: RateInfo | undefined;
    for (const chunk of chunked(unique)) {
        const result = await queryChunk(deps, ghPath, chunk);
        if (result.kind !== 'ok') {
            return withRate(result, rate);
        }
        gone.push(...result.gone);
        if (result.data !== undefined) {
            const page = decodeLookupPage(result.data);
            if (page === undefined) {
                return transient(`unexpected ${GRAPHQL_OPS.lookup} response`, freshRate(result.data, rate));
            }
            rate = page.rate;
            for (const node of page.nodes) {
                const decoded = await decodeEntry(deps, ghPath, node, page.viewer, rate);
                if (decoded.kind !== 'ok') {
                    return followUpFailure(decoded);
                }
                rate = decoded.rate ?? rate;
                if (decoded.entry !== undefined) {
                    entries.push(decoded.entry);
                }
            }
        }
    }
    return { kind: 'ok', result: { rate: rate ?? emptyRate(), entries, gone } };
}

function contextSection(node: unknown): string {
    const author = getString(getRecord(node, 'author'), 'login') ?? GHOST_AUTHOR;
    const createdAt = getString(node, 'createdAt');
    const timestamp = createdAt !== undefined && isoToEpoch(createdAt) !== undefined ? createdAt : 'unknown time';
    const body = getString(node, 'body') ?? '';
    const header = `--- UNTRUSTED CONTEXT: earlier comment by ${visibleText(author)} at ${timestamp} ---`;
    return `${header}\n${quoteUntrusted(body).join('\n')}\n`;
}

// Earlier thread comments in the given order, each under an UNTRUSTED CONTEXT header with its body quoted; one call
// per chunk of 100 ids, and a failure carries the rate of the last call that succeeded.
export async function fetchContext(deps: GhDeps, ghPath: string, nodeIds: readonly string[]): Promise<ContextOutcome> {
    const ids = nodeIds.filter((id) => isValidNodeId(id));
    const byId = new Map<string, unknown>();
    let rate: RateInfo | undefined;
    for (const chunk of chunked(ids)) {
        const result = await ghGraphql(deps, ghPath, CONTEXT_QUERY, { ids: chunk });
        if (result.kind !== 'ok') {
            return withRate(result, rate);
        }
        const nodes = getArray(result.data, 'nodes');
        if (nodes === undefined) {
            return transient(`unexpected ${GRAPHQL_OPS.context} response`, freshRate(result.data, rate));
        }
        rate = readRate(result.data);
        for (const node of nodes) {
            const id = getString(node, 'id');
            if (id !== undefined) {
                byId.set(id, node);
            }
        }
    }
    const sections = ids.map((id) => byId.get(id)).filter((node) => node !== undefined);
    return { kind: 'ok', text: sections.map((node) => contextSection(node)).join('\n') };
}

export async function react(
    deps: GhDeps,
    ghPath: string,
    action: ReactionAction,
    nodeId: string,
    content: ReactionContent
): Promise<ReactOutcome> {
    if (!isValidNodeId(nodeId)) {
        return { kind: 'invalid' };
    }
    const mutation = action === 'add' ? ADD_REACTION_MUTATION : REMOVE_REACTION_MUTATION;
    const result = await ghGraphql(deps, ghPath, mutation, { id: nodeId, content });
    return result;
}
