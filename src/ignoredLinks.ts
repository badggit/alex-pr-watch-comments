import fs from 'node:fs';
import path from 'node:path';

import { gitIn } from './guards.ts';
import type { Deps } from './types.ts';
import { safeText } from './validate.ts';

export type LinkDeps = Pick<Deps, 'runner' | 'log'>;

// Build and cache outputs stay per working tree: a link would let a run on the PR branch overwrite the outputs of
// the branch the owner works on.
const EXCLUDED_NAMES: ReadonlySet<string> = new Set([
    '.cache',
    '.eslintcache',
    '.next',
    '.turbo',
    'build',
    'coverage',
    'dist',
    'out',
]);
const EXCLUDED_SUFFIX = '.tsbuildinfo';

export function isLinkExcluded(rel: string): boolean {
    const name = path.posix.basename(rel);
    return EXCLUDED_NAMES.has(name) || name.endsWith(EXCLUDED_SUFFIX);
}

// The topmost ignored paths of the working tree at source, relative and without a trailing slash, build and cache
// outputs left out; undefined when git fails.
export async function ignoredPaths(deps: LinkDeps, gitPath: string, source: string): Promise<string[] | undefined> {
    const args = ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'];
    const listed = await gitIn(deps, gitPath, source, args);
    if (listed.code !== 0) {
        return;
    }
    return listed.stdout
        .split('\0')
        .map((entry) => (entry.endsWith('/') ? entry.slice(0, -1) : entry))
        .filter((entry) => entry.length > 0 && !isLinkExcluded(entry));
}

function lstatOrUndefined(file: string): fs.Stats | undefined {
    try {
        return fs.lstatSync(file);
    } catch {
        return;
    }
}

function realOrUndefined(file: string): string | undefined {
    try {
        return fs.realpathSync.native(file);
    } catch {
        return;
    }
}

// The parent must be a real directory of the worktree itself: a parent reached through a link into the clone would
// put the new link into the clone.
function parentInside(target: string, rel: string): boolean {
    const parent = path.dirname(path.join(target, rel));
    const realTarget = realOrUndefined(target);
    return realTarget !== undefined && realOrUndefined(parent) === path.join(realTarget, path.dirname(rel));
}

// A link the watcher made: a symbolic link at TARGET/REL whose text is exactly SOURCE/REL.
export function isOwnLink(source: string, target: string, rel: string): boolean {
    const dest = path.join(target, rel);
    if (lstatOrUndefined(dest)?.isSymbolicLink() !== true) {
        return false;
    }
    try {
        return fs.readlinkSync(dest) === path.join(source, rel);
    } catch {
        return false;
    }
}

const EXCLUDE_HEADER = '# alex-pr-watch-comments: links in watch worktrees, ignored in the clone already';
const GLOB_CHARACTERS = /[*?[\\]/gu;

// An anchored gitignore pattern that matches exactly REL, a link included: a pattern with a trailing slash such as
// node_modules/ matches directories only, so it does not ignore a link of that name.
export function anchoredPattern(rel: string): string {
    const escaped = rel.replaceAll(GLOB_CHARACTERS, String.raw`\$&`);
    return `/${escaped.endsWith(' ') ? `${escaped.slice(0, -1)}${String.raw`\ `}` : escaped}`;
}

function readTextOrEmpty(file: string): string {
    try {
        return fs.readFileSync(file, 'utf8');
    } catch {
        return '';
    }
}

// Appends a pattern for every link to the repository's info/exclude, which all its working trees share, so git
// lists no link as untracked and no link can be committed by accident. For the clone this changes nothing: every
// linked path is one that is ignored there already.
async function excludeLinks(deps: LinkDeps, gitPath: string, target: string, rels: readonly string[]): Promise<void> {
    if (rels.length === 0) {
        return;
    }
    const resolved = await gitIn(deps, gitPath, target, ['rev-parse', '--git-path', 'info/exclude']);
    const [line = ''] = resolved.stdout.split('\n', 1);
    if (resolved.code !== 0 || line.length === 0) {
        deps.log.warn('cannot find the info/exclude file of the repository; the worktree links show as untracked');
        return;
    }
    const file = path.resolve(target, line);
    const text = readTextOrEmpty(file);
    const present = new Set(text.split('\n'));
    const missing = rels.map((rel) => anchoredPattern(rel)).filter((pattern) => !present.has(pattern));
    if (missing.length === 0) {
        return;
    }
    const header = present.has(EXCLUDE_HEADER) ? [] : [EXCLUDE_HEADER];
    const lead = text.length > 0 && !text.endsWith('\n') ? '\n' : '';
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, `${lead}${[...header, ...missing].join('\n')}\n`);
    } catch {
        deps.log.warn(`cannot update ${safeText(file)}; the worktree links show as untracked`);
    }
}

// Links every ignored path of SOURCE into TARGET where TARGET has nothing at that path yet; existing files, own
// links and paths whose parent directory is missing in TARGET are left alone. Returns the number of new links, or
// undefined when the ignored paths cannot be listed. Every own link is then excluded in info/exclude. Never fails
// the caller: a link that cannot be made is logged.
export async function syncIgnoredLinks(
    deps: LinkDeps,
    gitPath: string,
    source: string,
    target: string
): Promise<number | undefined> {
    if (source === target) {
        return 0;
    }
    const entries = await ignoredPaths(deps, gitPath, source);
    if (entries === undefined) {
        deps.log.warn(`cannot list the ignored files of ${safeText(source)}; nothing linked into the worktree`);
        return;
    }
    let created = 0;
    for (const rel of entries) {
        const dest = path.join(target, rel);
        if (lstatOrUndefined(dest) !== undefined || !parentInside(target, rel)) {
            continue;
        }
        try {
            fs.symlinkSync(path.join(source, rel), dest);
            created += 1;
        } catch (error) {
            const code = error instanceof Error && 'code' in error ? String(error.code) : 'unknown';
            if (code !== 'EEXIST') {
                deps.log.warn(`cannot link ${safeText(rel)} into the worktree: ${safeText(code)}`);
            }
        }
    }
    const own = entries.filter((rel) => isOwnLink(source, target, rel));
    await excludeLinks(deps, gitPath, target, own);
    return created;
}

// Removes the links syncIgnoredLinks made, found among the untracked and ignored entries of TARGET itself, so a
// link whose clone path no longer exists is found as well. False when TARGET cannot be listed or a link cannot be
// removed.
export async function removeIgnoredLinks(
    deps: LinkDeps,
    gitPath: string,
    source: string,
    target: string
): Promise<boolean> {
    if (source === target) {
        return true;
    }
    const listed = await gitIn(deps, gitPath, target, ['ls-files', '-z', '--others', '--directory']);
    if (listed.code !== 0) {
        return false;
    }
    const own = listed.stdout
        .split('\0')
        .filter((entry) => entry.length > 0 && !entry.endsWith('/') && isOwnLink(source, target, entry));
    let removed = true;
    for (const rel of own) {
        try {
            fs.unlinkSync(path.join(target, rel));
        } catch {
            removed = false;
        }
    }
    return removed;
}
