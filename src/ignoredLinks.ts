import fs from 'node:fs';
import path from 'node:path';

import { defaultCloner, type Cloner } from './cowClone.ts';
import { gitIn } from './guards.ts';
import type { Deps } from './types.ts';
import { hasControlCharacter, safeText } from './validate.ts';

export { hasControlCharacter } from './validate.ts';

export type LinkDeps = Pick<Deps, 'runner' | 'log'>;

export interface SyncCounts {
    linked: number;
    cloned: number;
}

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

// Cloned per worktree where copy-on-write works and disposable on cleanup; Python venvs are not, because a byte copy
// of a venv still runs the clone's interpreter.
export function isDependencyDir(rel: string): boolean {
    return path.posix.basename(rel) === 'node_modules';
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

export const EXCLUDE_HEADER =
    '# alex-pr-watch-comments: links and dependency clones in worktrees, ignored in the main clone already';
// Written by earlier versions; a file that carries it needs no second header.
export const LEGACY_EXCLUDE_HEADER = '# alex-pr-watch-comments: links in watch worktrees, ignored in the clone already';
const EXCLUDE_FAILURE_TAIL = '; the worktree links show as untracked and must be removed before git worktree remove';
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

// Links and cloned node_modules get patterns in the shared info/exclude so git never lists or commits them.
async function excludeLinks(deps: LinkDeps, gitPath: string, target: string, rels: readonly string[]): Promise<void> {
    if (rels.length === 0) {
        return;
    }
    const resolved = await gitIn(deps, gitPath, target, ['rev-parse', '--git-path', 'info/exclude']);
    const [line = ''] = resolved.stdout.split('\n', 1);
    if (resolved.code !== 0 || line.length === 0) {
        deps.log.warn(`cannot find the info/exclude file of the repository${EXCLUDE_FAILURE_TAIL}`);
        return;
    }
    const file = path.resolve(target, line);
    const text = readTextOrEmpty(file);
    const present = new Set(text.split('\n'));
    const missing = rels.map((rel) => anchoredPattern(rel)).filter((pattern) => !present.has(pattern));
    if (missing.length === 0) {
        return;
    }
    const header = present.has(EXCLUDE_HEADER) || present.has(LEGACY_EXCLUDE_HEADER) ? [] : [EXCLUDE_HEADER];
    const lead = text.length > 0 && !text.endsWith('\n') ? '\n' : '';
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, `${lead}${[...header, ...missing].join('\n')}\n`);
    } catch {
        deps.log.warn(`cannot update ${safeText(file)}${EXCLUDE_FAILURE_TAIL}`);
    }
}

// Drops the paths with control characters in their names, each logged once.
function withoutControlCharacters(deps: LinkDeps, rels: readonly string[]): string[] {
    const kept: string[] = [];
    for (const rel of rels) {
        if (hasControlCharacter(rel)) {
            deps.log.warn(`skipped an ignored path with a control character in its name: ${safeText(rel)}`);
        } else {
            kept.push(rel);
        }
    }
    return kept;
}

function linkMissing(deps: LinkDeps, source: string, target: string, rel: string): boolean {
    const dest = path.join(target, rel);
    if (lstatOrUndefined(dest) !== undefined) {
        return false;
    }
    try {
        fs.symlinkSync(path.join(source, rel), dest);
        return true;
    } catch (error) {
        const code = error instanceof Error && 'code' in error ? String(error.code) : 'unknown';
        if (code !== 'EEXIST') {
            deps.log.warn(`cannot link ${safeText(rel)} into the worktree: ${safeText(code)}`);
        }
        return false;
    }
}

// Clones ignored node_modules with copy-on-write, converts own links and falls back to links; other paths stay shared. Returns new link/clone counts, or undefined on listing failure; excludes own links and dependency directories from git.
export async function syncIgnoredLinks(
    deps: LinkDeps,
    gitPath: string,
    source: string,
    target: string,
    cloner: Cloner = defaultCloner
): Promise<SyncCounts | undefined> {
    if (source === target) {
        return { linked: 0, cloned: 0 };
    }
    const listed = await ignoredPaths(deps, gitPath, source);
    if (listed === undefined) {
        deps.log.warn(`cannot list the ignored files of ${safeText(source)}; nothing linked into the worktree`);
        return;
    }
    const entries = withoutControlCharacters(deps, listed);
    const counts: SyncCounts = { linked: 0, cloned: 0 };
    const unavailable: string[] = [];
    for (const rel of entries) {
        const dest = path.join(target, rel);
        const dependency = isDependencyDir(rel);
        if (
            !parentInside(target, rel) ||
            (lstatOrUndefined(dest) !== undefined && !(dependency && isOwnLink(source, target, rel)))
        ) {
            continue;
        }
        if (dependency) {
            const outcome = await cloner.cloneDependency(deps, gitPath, source, target, rel);
            if (outcome.kind === 'cloned') {
                counts.cloned += 1;
                continue;
            }
            const linked = linkMissing(deps, source, target, rel);
            counts.linked += Number(linked);
            if (outcome.kind === 'unavailable' && linked) {
                unavailable.push(rel);
            }
            if (outcome.kind === 'failed') {
                const fallback = isOwnLink(source, target, rel) ? '; linked it instead' : '';
                deps.log.warn(
                    `cannot clone ${safeText(rel)} into the worktree (${safeText(outcome.reason)})${fallback}`
                );
            }
        } else {
            counts.linked += Number(linkMissing(deps, source, target, rel));
        }
    }
    if (unavailable.length > 0) {
        deps.log.info(
            `linked ${unavailable.map((rel) => safeText(rel)).join(', ')}: no copy-on-write between the clone and the worktree`
        );
    }
    const excluded = entries.filter(
        (rel) =>
            isOwnLink(source, target, rel) ||
            (isDependencyDir(rel) && lstatOrUndefined(path.join(target, rel))?.isDirectory() === true)
    );
    await excludeLinks(deps, gitPath, target, excluded);
    return counts;
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
