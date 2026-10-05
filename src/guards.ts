import type { CommandResult, Deps, GuardResult, Session } from './types.ts';
import { HOST_PATTERN, isValidName, isValidSha, safeText } from './validate.ts';

export type GitDeps = Pick<Deps, 'runner'>;

// The host is lowercase; owner and repo are compared case-insensitively.
export interface RepoRef {
    host: string;
    owner: string;
    repo: string;
}

export type RemoteCheck = { ok: true } | { ok: false; reason: string };

export type RemoteFound = { ok: true; remote: string } | { ok: false; reason: string };

// Exactly one of the three host groups matches, one per URL form.
const GITHUB_REMOTE_URL = new RegExp(
    String.raw`^(?:https://(${HOST_PATTERN})/|ssh://git@(${HOST_PATTERN})/|git@(${HOST_PATTERN}):)([\w.-]+)/([\w.-]+?)(?:\.git)?/?$`,
    'iu'
);
const COUNTS = /^(\d+)\t(\d+)$/u;
const REMOTE_HINT = "fix the remote's URLs";
const DIVERGE_HINT = 'push or reset the branch manually';
const BRANCH_REF_PREFIX = 'refs/heads/';
// A clone-local fetch.writeFetchHEAD=false would otherwise leave a stale FETCH_HEAD behind a successful fetch.
const FETCH_ARGS: readonly string[] = ['-c', 'fetch.writeFetchHEAD=true', 'fetch', '--quiet'];

export function gitIn(deps: GitDeps, gitPath: string, dir: string, args: readonly string[]): Promise<CommandResult> {
    return deps.runner.run({ file: gitPath, args: ['-C', dir, ...args] });
}

// One item per output line with only the final line terminator removed, so an empty value stays an empty item.
function outputLines(text: string): string[] {
    if (text.length === 0) {
        return [];
    }
    return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
}

// Strict syntax check of a GitHub remote URL; whether it names the right host and repository is up to the caller.
export function parseGithubRemoteUrl(url: string): RepoRef | undefined {
    const match = GITHUB_REMOTE_URL.exec(url);
    if (match === null) {
        return;
    }
    const [, httpsHost, sshHost, scpHost, owner = '', repo = ''] = match;
    const host = httpsHost ?? sshHost ?? scpHost ?? '';
    if (!isValidName(owner) || !isValidName(repo)) {
        return;
    }
    return { host: host.toLowerCase(), owner: owner.toLowerCase(), repo: repo.toLowerCase() };
}

function pointsTo(url: string, target: RepoRef): boolean {
    const parsed = parseGithubRemoteUrl(url);
    return (
        parsed?.host === target.host.toLowerCase() &&
        parsed.owner === target.owner.toLowerCase() &&
        parsed.repo === target.repo.toLowerCase()
    );
}

// The values of a multi-valued git config key, empty values included: no items only when git reports the key as
// unset (exit 1), undefined when git failed otherwise or claimed success without printing a value.
async function configValues(deps: GitDeps, gitPath: string, dir: string, key: string): Promise<string[] | undefined> {
    const result = await gitIn(deps, gitPath, dir, ['config', '--get-all', key]);
    if (result.code === 1) {
        return [];
    }
    const values = outputLines(result.stdout);
    return result.code === 0 && values.length > 0 ? values : undefined;
}

async function effectiveUrls(
    deps: GitDeps,
    gitPath: string,
    dir: string,
    args: readonly string[]
): Promise<string[] | undefined> {
    const result = await gitIn(deps, gitPath, dir, ['remote', 'get-url', ...args]);
    return result.code === 0 ? outputLines(result.stdout) : undefined;
}

// Every destination of the remote (raw url, every pushurl, effective fetch and push URL after insteadOf and
// pushInsteadOf rewrites) must be HOST/OWNER/REPO, so neither a fetch nor a push can reach another repository.
export async function verifyRemote(
    deps: GitDeps,
    gitPath: string,
    dir: string,
    remote: string,
    repoRef: RepoRef
): Promise<RemoteCheck> {
    const shown = safeText(remote);
    const target = safeText(`${repoRef.owner}/${repoRef.repo}`);
    const urls = isValidName(remote) ? await configValues(deps, gitPath, dir, `remote.${remote}.url`) : [];
    if (urls === undefined) {
        return { ok: false, reason: `cannot read the URLs of remote ${shown}` };
    }
    const [url] = urls;
    if (url === undefined) {
        return { ok: false, reason: `remote ${shown} not found` };
    }
    if (urls.length !== 1 || !pointsTo(url, repoRef)) {
        return { ok: false, reason: `remote ${shown} does not point to ${target}` };
    }
    const pushUrls = await configValues(deps, gitPath, dir, `remote.${remote}.pushurl`);
    const fetchTargets = await effectiveUrls(deps, gitPath, dir, ['--all', remote]);
    const pushTargets = await effectiveUrls(deps, gitPath, dir, ['--push', '--all', remote]);
    const verified =
        pushUrls !== undefined &&
        fetchTargets?.length === 1 &&
        pushTargets?.length === 1 &&
        [...pushUrls, ...fetchTargets, ...pushTargets].every((item) => pointsTo(item, repoRef));
    return verified ? { ok: true } : { ok: false, reason: `push target of remote ${shown} is not ${target}` };
}

// The first remote, in git's order, whose raw URL names HOST/OWNER/REPO, verified with verifyRemote.
export async function findRemote(deps: GitDeps, gitPath: string, dir: string, repoRef: RepoRef): Promise<RemoteFound> {
    const listed = await gitIn(deps, gitPath, dir, ['remote']);
    if (listed.code !== 0) {
        return { ok: false, reason: 'cannot list the git remotes' };
    }
    for (const name of outputLines(listed.stdout)) {
        const urls = isValidName(name) ? await configValues(deps, gitPath, dir, `remote.${name}.url`) : undefined;
        if (urls?.some((url) => pointsTo(url, repoRef))) {
            const verified = await verifyRemote(deps, gitPath, dir, name, repoRef);
            return verified.ok ? { ok: true, remote: name } : verified;
        }
    }
    const target = safeText(`${repoRef.owner}/${repoRef.repo}`);
    const host = safeText(repoRef.host);
    return {
        ok: false,
        reason: `no git remote points to ${target} (add one: git remote add NAME https://${host}/${target}.git)`,
    };
}

// The checked-out local branch; undefined for a detached HEAD or a HEAD that points outside refs/heads/. The full
// ref is read instead of the short form, which git abbreviates to heads/NAME when a tag of the same name exists.
export async function currentBranch(deps: GitDeps, gitPath: string, dir: string): Promise<string | undefined> {
    const result = await gitIn(deps, gitPath, dir, ['symbolic-ref', '--quiet', 'HEAD']);
    const lines = outputLines(result.stdout);
    const [ref = ''] = lines;
    if (result.code !== 0 || lines.length !== 1 || !ref.startsWith(BRANCH_REF_PREFIX)) {
        return;
    }
    const branch = ref.slice(BRANCH_REF_PREFIX.length);
    return branch.length > 0 ? branch : undefined;
}

function hold(reason: string, hint: string): GuardResult {
    return { ok: false, reason, hint };
}

// Ahead and behind commit counts of HEAD against FETCH_HEAD.
async function divergence(
    deps: GitDeps,
    gitPath: string,
    dir: string
): Promise<{ ahead: number; behind: number } | undefined> {
    const result = await gitIn(deps, gitPath, dir, ['rev-list', '--left-right', '--count', 'HEAD...FETCH_HEAD']);
    if (result.code !== 0) {
        return;
    }
    const match = COUNTS.exec(result.stdout.trim());
    if (match === null) {
        return;
    }
    const [, ahead = '', behind = ''] = match;
    return { ahead: Number.parseInt(ahead, 10), behind: Number.parseInt(behind, 10) };
}

// Runs only while the caller holds the worktree lock: the fetch rewrites the clone-wide FETCH_HEAD. Never calls
// GitHub and never changes anything but FETCH_HEAD and the remote-tracking ref.
export async function runGuards(deps: GitDeps, session: Session): Promise<GuardResult> {
    const { dirCanon: dir, remote, headRef: branch } = session;
    const gitPath = session.tools.git;
    const remoteCheck = await verifyRemote(deps, gitPath, dir, remote, {
        host: session.pr.host,
        owner: session.headOwner,
        repo: session.headRepo,
    });
    if (!remoteCheck.ok) {
        return hold(remoteCheck.reason, REMOTE_HINT);
    }
    const current = await currentBranch(deps, gitPath, dir);
    if (current !== branch) {
        const shown = current === undefined ? 'a detached HEAD' : safeText(current);
        return hold(`wrong branch: ${shown} is checked out, not ${branch}`, `git checkout ${branch}`);
    }
    const status = await gitIn(deps, gitPath, dir, ['status', '--porcelain', '--untracked-files=no']);
    if (status.code !== 0) {
        return hold('git status failed', '');
    }
    if (status.stdout.trim().length > 0) {
        return hold('uncommitted changes to tracked files', 'commit or stash them');
    }
    const fetched = await gitIn(deps, gitPath, dir, [...FETCH_ARGS, remote, `${BRANCH_REF_PREFIX}${branch}`]);
    if (fetched.code !== 0) {
        return hold('fetch failed', '');
    }
    const head = await gitIn(deps, gitPath, dir, ['rev-parse', 'FETCH_HEAD']);
    const headSha = head.stdout.trim();
    if (head.code !== 0 || !isValidSha(headSha)) {
        return hold('cannot read the fetched remote head', '');
    }
    const counts = await divergence(deps, gitPath, dir);
    if (counts === undefined) {
        return hold('cannot compare the branch with the remote', '');
    }
    if (counts.ahead > 0) {
        const reason =
            counts.behind > 0 ? 'local branch has diverged from the remote' : 'local branch is ahead of the remote';
        return hold(reason, DIVERGE_HINT);
    }
    return { ok: true, headSha };
}
