import fs from 'node:fs';
import path from 'node:path';

import { normalizeCallerPath, projectRoots, resolveExecutable } from './preflight.ts';
import { hasControlCharacter, isSafeAbsPath, safeText } from './validate.ts';
import { canonical, entryExists } from './watchWorktree.ts';

export interface FsTrees {
    current: string | undefined;
    main: string | undefined;
    commonDir: string | undefined;
}

export type ToolCheck = { ok: true; pathValue: string; git: string } | { ok: false; reason: string };

type ToolLookup = { ok: true; file: string } | { ok: false; reason: string };

const GIT_ENTRY = '.git';
const GITDIR_PREFIX = 'gitdir: ';

// Undefined when the file is absent; FAILED when it exists but cannot be read, so callers can tell the two apart.
const FAILED = Symbol('failed');

function readTextFile(file: string): string | undefined | typeof FAILED {
    try {
        return fs.readFileSync(file, 'utf8');
    } catch (error) {
        return error instanceof Error && 'code' in error && error.code === 'ENOENT' ? undefined : FAILED;
    }
}

function statOrUndefined(file: string): fs.Stats | undefined {
    try {
        return fs.statSync(file);
    } catch {
        return;
    }
}

function nearestGitHolder(start: string): string | undefined {
    let current = start;
    while (!entryExists(path.join(current, GIT_ENTRY))) {
        const parent = path.dirname(current);
        if (parent === current) {
            return;
        }
        current = parent;
    }
    return current;
}

// Git reads these files as one record: only the final line terminator is stripped, and any other control character
// (an extra line included) makes the file malformed.
function singleRecord(text: string): string | undefined {
    let record = text;
    if (record.endsWith('\r\n')) {
        record = record.slice(0, -2);
    } else if (record.endsWith('\n')) {
        record = record.slice(0, -1);
    }
    return record.length === 0 || hasControlCharacter(record) ? undefined : record;
}

// A .git file holds `gitdir: X`; a linked worktree's X has a commondir file naming the shared git dir relative to X.
function commonDirFromGitFile(gitFile: string, holder: string): string | undefined {
    const text = readTextFile(gitFile);
    if (typeof text !== 'string') {
        return;
    }
    const line = singleRecord(text);
    if (line === undefined || !line.startsWith(GITDIR_PREFIX) || line.length === GITDIR_PREFIX.length) {
        return;
    }
    const gitDir = canonical(path.resolve(holder, line.slice(GITDIR_PREFIX.length)));
    const commonText = readTextFile(path.join(gitDir, 'commondir'));
    if (commonText === undefined) {
        return gitDir;
    }
    if (commonText === FAILED) {
        return;
    }
    const common = singleRecord(commonText);
    return common === undefined ? undefined : canonical(path.resolve(gitDir, common));
}

// Finds the working tree, the shared git dir and the main working tree without running any process, so that no
// git from an untrusted PATH runs before the PATH is cleaned.
export function discoverTreesByFs(cwd: string): FsTrees {
    const current = nearestGitHolder(canonical(path.resolve(cwd)));
    if (current === undefined) {
        return { current: undefined, main: undefined, commonDir: undefined };
    }
    const gitEntry = path.join(current, GIT_ENTRY);
    // The entry is found with lstat but classified with stat, so a .git symlink to a directory works as it does in git.
    const stats = statOrUndefined(gitEntry);
    let commonDir: string | undefined;
    if (stats?.isDirectory() === true) {
        commonDir = gitEntry;
    } else if (stats?.isFile() === true) {
        commonDir = commonDirFromGitFile(gitEntry, current);
    }
    const main =
        commonDir !== undefined && path.basename(commonDir) === GIT_ENTRY ? path.dirname(commonDir) : undefined;
    return { current, main, commonDir };
}

function isWithin(file: string, root: string): boolean {
    const relative = path.relative(root, file);
    return relative === '' || (relative !== '..' && !relative.startsWith('../') && !path.isAbsolute(relative));
}

// The canonical form of the longest existing prefix plus the rest as given, so a root that does not exist yet (the
// target) still compares against canonical tool paths.
function canonicalPrefix(file: string): string {
    const resolved = path.resolve(file);
    const parent = path.dirname(resolved);
    if (entryExists(resolved) || parent === resolved) {
        return canonical(resolved);
    }
    return path.join(canonicalPrefix(parent), path.basename(resolved));
}

// The PATH entry may be clean while the executable in it is a symlink into the project, so the real file is checked
// against the excluded roots too.
function lookupTool(name: string, pathValue: string, excluded: readonly string[]): ToolLookup {
    const file = resolveExecutable(name, pathValue);
    if (file === undefined) {
        return { ok: false, reason: `missing required tool: ${name}` };
    }
    if (!isSafeAbsPath(file)) {
        return {
            ok: false,
            reason: `unusable tool path for ${name}: ${safeText(file)} must be absolute with no control characters`,
        };
    }
    let real: string;
    try {
        real = fs.realpathSync.native(file);
    } catch {
        return { ok: false, reason: `cannot resolve ${name}: ${safeText(file)}` };
    }
    if (excluded.some((root) => isWithin(real, root))) {
        return { ok: false, reason: `${name} resolves into the project: ${safeText(real)}` };
    }
    return { ok: true, file };
}

// ROOTS (main, current, the common dir's parent, the target) are excluded as given: the target may not exist yet,
// so no enclosing worktree is looked up for them.
export function checkTools(pathValue: string, cwd: string, roots: readonly string[]): ToolCheck {
    const all = [...projectRoots(cwd), ...roots];
    const cleaned = normalizeCallerPath(pathValue, all);
    const excluded = all.flatMap((root) => [path.resolve(root), canonicalPrefix(root)]);
    const git = lookupTool('git', cleaned, excluded);
    if (!git.ok) {
        return git;
    }
    const cp = lookupTool('cp', cleaned, excluded);
    if (!cp.ok) {
        return cp;
    }
    return { ok: true, pathValue: cleaned, git: git.file };
}
