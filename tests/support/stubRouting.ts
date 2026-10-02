import path from 'node:path';

export type ToolName = 'gh' | 'tmux' | 'git' | 'claude' | 'ps' | 'other';

const KNOWN_TOOLS: readonly ToolName[] = ['gh', 'tmux', 'git', 'claude', 'ps'];
const OPERATION_NAME = /\b(?:query|mutation)\s+(\w+)/u;
const TMUX_VALUE_OPTIONS: readonly string[] = ['-S', '-L', '-f'];
const GIT_VALUE_OPTIONS: readonly string[] = ['-C', '-c'];

export function toolName(file: string): ToolName {
    const base = path.basename(file);
    return KNOWN_TOOLS.find((tool) => tool === base) ?? 'other';
}

function graphqlOperation(input: string | undefined): string | undefined {
    if (input === undefined) {
        return;
    }
    let body: unknown;
    try {
        body = JSON.parse(input);
    } catch {
        return;
    }
    if (typeof body !== 'object' || body === null || !('query' in body) || typeof body.query !== 'string') {
        return;
    }
    return OPERATION_NAME.exec(body.query)?.[1];
}

function firstCommand(args: readonly string[], valueOptions: readonly string[]): string {
    let skipNext = false;
    for (const arg of args) {
        if (skipNext) {
            skipNext = false;
        } else if (valueOptions.includes(arg)) {
            skipNext = true;
        } else if (!arg.startsWith('-')) {
            return arg;
        }
    }
    return '';
}

// gh graphql calls route on the operation name of the stdin body, other gh calls on their first two arguments,
// tmux and git on their subcommand; ps, claude and every other tool have one fixed key each.
export function routingKey(tool: ToolName, args: readonly string[], input?: string): string {
    switch (tool) {
        case 'gh': {
            if (args[0] === 'api' && args[1] === 'graphql') {
                return graphqlOperation(input) ?? 'api_graphql';
            }
            return args.slice(0, 2).join('_');
        }
        case 'tmux': {
            return firstCommand(args, TMUX_VALUE_OPTIONS);
        }
        case 'git': {
            return firstCommand(args, GIT_VALUE_OPTIONS);
        }
        case 'claude':
        case 'ps':
        case 'other': {
            return tool;
        }
    }
}
