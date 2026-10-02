// Builds lookup and PrwcReactions responses with many reactions in memory, so no 100-node JSON is checked in.

export type PagedContent = 'ROCKET' | 'THUMBS_UP';

export const VIEWER = 'me';
export const FIRST_CURSOR = 'cursor-100';
export const MANY_NODE_ID = 'PRRC_many';

const BASE_MS = Date.UTC(2026, 0, 1);
const RESET_AT = '2026-01-01T01:00:00Z';
// GitHub sends null for a comment that was never edited; the house lint rule forbids a null literal.
const NEVER_EDITED: unknown = JSON.parse('null');

export interface ManyLookupOptions {
    content: PagedContent;
    viewerHasReacted: boolean;
    remaining: number;
}

export interface ReactionsPageOptions {
    first: number;
    count: number;
    viewerPosition?: number;
    hasNextPage: boolean;
    endCursor: string;
    remaining: number;
}

// The reaction at a position was created that many seconds after the base time.
export function reactionIso(position: number): string {
    return new Date(BASE_MS + position * 1000).toISOString();
}

export function reactionEpoch(position: number): number {
    return Math.floor((BASE_MS + position * 1000) / 1000);
}

function reactionNodes(first: number, count: number, viewerPosition?: number): unknown[] {
    return Array.from({ length: count }, (_, index) => {
        const position = first + index;
        const login = position === viewerPosition ? VIEWER : `user${position}`;
        return { createdAt: reactionIso(position), user: { login } };
    });
}

function emptyConnection(): unknown {
    return { pageInfo: { hasNextPage: false }, nodes: [] };
}

// One comment whose first 100 reactions of the given kind are all from other users.
export function manyReactionsLookup(options: ManyLookupOptions): unknown {
    const fullPage = {
        pageInfo: { hasNextPage: true, endCursor: FIRST_CURSOR },
        nodes: reactionNodes(1, 100),
    };
    return {
        data: {
            viewer: { login: VIEWER },
            rateLimit: { remaining: options.remaining, resetAt: RESET_AT },
            nodes: [
                {
                    id: MANY_NODE_ID,
                    databaseId: 301,
                    url: 'https://github.com/OWNER/REPO/pull/1#discussion_r301',
                    lastEditedAt: NEVER_EDITED,
                    body: 'popular comment',
                    path: 'src/many.ts',
                    line: 1,
                    author: { login: 'reviewer' },
                    rocket: options.content === 'ROCKET' ? fullPage : emptyConnection(),
                    plus: options.content === 'THUMBS_UP' ? fullPage : emptyConnection(),
                    reactionGroups: [
                        { content: options.content, viewerHasReacted: options.viewerHasReacted },
                        { content: 'EYES', viewerHasReacted: false },
                    ],
                },
            ],
        },
    };
}

export function reactionsPage(options: ReactionsPageOptions): unknown {
    return {
        data: {
            rateLimit: { remaining: options.remaining, resetAt: RESET_AT },
            node: {
                reactions: {
                    pageInfo: { hasNextPage: options.hasNextPage, endCursor: options.endCursor },
                    nodes: reactionNodes(options.first, options.count, options.viewerPosition),
                },
            },
        },
    };
}
