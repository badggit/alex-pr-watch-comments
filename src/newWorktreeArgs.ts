import path from 'node:path';

import { hasControlCharacter, safeText } from './validate.ts';
import { WORKTREE_PREFIX } from './watchWorktree.ts';

export interface NewWorktreeArgs {
    name: string | undefined;
    task: string | undefined;
    branch: string | undefined;
    base: string | undefined;
}

export interface WorktreeTarget {
    name: string;
    path: string;
    branch: string;
}

export type NewWorktreeParse =
    { kind: 'ok'; args: NewWorktreeArgs } | { kind: 'help' } | { kind: 'error'; message: string };

export type TargetResult = { ok: true; target: WorktreeTarget } | { ok: false; message: string };

export const MAX_SEGMENT = 100;

type ValueOption = '--task' | '--branch' | '--base';

const VALUE_OPTIONS: ReadonlySet<string> = new Set(['--task', '--branch', '--base']);
const OPTION_FIELDS: Readonly<Record<ValueOption, 'task' | 'branch' | 'base'>> = {
    '--task': 'task',
    '--branch': 'branch',
    '--base': 'base',
};

const SEGMENT = /^\w[\w.-]*$/u;
const BRANCH_FORBIDDEN_CHARS: ReadonlySet<string> = new Set([' ', '~', '^', ':', '?', '*', '[', '\\']);
const BRANCH_FORBIDDEN_PARTS: readonly string[] = ['..', '@{', '//'];

export function isSafeSegment(value: string): boolean {
    return value.length > 0 && value.length <= MAX_SEGMENT && SEGMENT.test(value);
}

// A lexical port of git check-ref-format for refs/heads/VALUE, plus the refusals of git branch (HEAD) and of
// values starting with "-" or "refs/" so the name can never be read as an option or as a fully qualified ref.
export function isBranchName(value: string): boolean {
    if (value.length === 0 || value === '@' || value === 'HEAD' || hasControlCharacter(value)) {
        return false;
    }
    if ([...value].some((char) => BRANCH_FORBIDDEN_CHARS.has(char))) {
        return false;
    }
    if (BRANCH_FORBIDDEN_PARTS.some((part) => value.includes(part))) {
        return false;
    }
    if (value.startsWith('/') || value.endsWith('/') || value.endsWith('.')) {
        return false;
    }
    if (value.startsWith('-') || value.startsWith('refs/')) {
        return false;
    }
    return value.split('/').every((component) => !component.startsWith('.') && !component.endsWith('.lock'));
}

function segmentProblem(label: string, value: string): string | undefined {
    if (!isSafeSegment(value)) {
        return (
            `${label} must be 1 to ${MAX_SEGMENT} letters, digits, ".", "_" or "-" ` +
            `and must not start with "." or "-": ${safeText(value)}`
        );
    }
    return;
}

function nameProblem(name: string): string | undefined {
    const problem = segmentProblem('name', name);
    if (problem !== undefined) {
        return problem;
    }
    if (name.startsWith(WORKTREE_PREFIX)) {
        return `name must not start with the reserved prefix ${WORKTREE_PREFIX}: ${safeText(name)}`;
    }
    return;
}

function baseProblem(base: string): string | undefined {
    if (base.length === 0) {
        return 'missing value for --base';
    }
    if (base.startsWith('-')) {
        return `--base must not start with "-": ${safeText(base)}`;
    }
    if (hasControlCharacter(base)) {
        return '--base must not contain control characters';
    }
    return;
}

function valueProblem(option: ValueOption, value: string): string | undefined {
    switch (option) {
        case '--task': {
            return segmentProblem('--task', value);
        }
        case '--branch': {
            return isBranchName(value) ? undefined : `not a valid branch name: ${safeText(value)}`;
        }
        case '--base': {
            return baseProblem(value);
        }
    }
}

function isValueOption(arg: string): arg is ValueOption {
    return VALUE_OPTIONS.has(arg);
}

function argsProblem(args: NewWorktreeArgs): string | undefined {
    if (args.name === undefined && args.task === undefined) {
        return 'give a NAME or --task SLUG';
    }
    if (args.name !== undefined && args.task !== undefined) {
        return 'give either a NAME or --task SLUG, not both';
    }
    return args.name === undefined ? undefined : nameProblem(args.name);
}

// argv is everything after the word new-worktree.
export function parseNewWorktreeArgs(argv: readonly string[]): NewWorktreeParse {
    if (argv.includes('--help')) {
        return { kind: 'help' };
    }
    const args: NewWorktreeArgs = { name: undefined, task: undefined, branch: undefined, base: undefined };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index] ?? '';
        if (isValueOption(arg)) {
            const field = OPTION_FIELDS[arg];
            if (args[field] !== undefined) {
                return { kind: 'error', message: `${arg} can be given only once` };
            }
            const value = argv[index + 1];
            if (value === undefined) {
                return { kind: 'error', message: `missing value for ${arg}` };
            }
            const problem = valueProblem(arg, value);
            if (problem !== undefined) {
                return { kind: 'error', message: problem };
            }
            args[field] = value;
            index += 1;
        } else if (arg.startsWith('-')) {
            return { kind: 'error', message: `unknown option: ${safeText(arg)}` };
        } else if (args.name === undefined) {
            args.name = arg;
        } else {
            return { kind: 'error', message: `only one NAME is allowed, got another: ${safeText(arg)}` };
        }
    }
    const problem = argsProblem(args);
    return problem === undefined ? { kind: 'ok', args } : { kind: 'error', message: problem };
}

// The target is a sibling of the main worktree; the caller maps a failure to exit code 2.
export function deriveTarget(args: NewWorktreeArgs, mainTree: string): TargetResult {
    let name: string;
    if (args.name !== undefined) {
        name = args.name;
    } else if (args.task === undefined) {
        return { ok: false, message: 'give a NAME or --task SLUG' };
    } else {
        name = `${path.basename(mainTree)}-${args.task}`;
    }
    const problem = nameProblem(name);
    if (problem !== undefined) {
        return { ok: false, message: problem };
    }
    const branch = args.branch ?? args.task ?? name;
    if (!isBranchName(branch)) {
        return { ok: false, message: `not a valid branch name: ${safeText(branch)}` };
    }
    return { ok: true, target: { name, path: path.join(path.dirname(mainTree), name), branch } };
}
