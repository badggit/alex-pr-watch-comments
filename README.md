# alex-pr-watch-comments

Turn inline review comments on a GitHub pull request into commits, hands-free.

Leave comments on lines of the PR diff, approve them with a `rocket` reaction, and a watcher picks them up. It opens a new tmux pane, starts [Claude Code](https://docs.claude.com/en/docs/claude-code/overview) in your project and gives it every approved comment to resolve, one after another. For each comment Claude fixes the code if needed, commits and pushes to the PR branch, replies in the comment thread and marks the comment as done.

The plugin also has a small helper for parallel work: `new-worktree` creates a git worktree next to your clone, with copy-on-write clones of the dependency folders and links to your other ignored files, and switches the Claude Code session into it. See [New worktree](#new-worktree).

## How it works

1. You start the watcher for one PR from a tmux session, for a local clone of the PR's repository with the PR branch checked out. By default it works in that clone. Pass `--worktree` to use a separate git worktree next to the clone and keep your clone available for other work. See [Watch worktree](#watch-worktree).
2. Every 2 minutes (`--interval`, default 120 seconds) the watcher reads the PR's inline review threads with `gh`.
3. A comment is picked up when it carries a `rocket` reaction added by you, the account `gh` is logged in as. Only inline review comments (comments on the diff) count; general PR comments (the "Conversation" tab) are ignored. All comments approved at that moment go into one run as a batch, oldest rocket first, at most `--batch-max` (default 5) of them; the rest wait for the next batch. One run at a time.
4. The watcher checks its worktree, saves the text of every approved comment, replaces each of your `rocket` reactions with `eyes`, opens a new pane in the watcher's window and starts `claude` there. The task is passed as claude's initial prompt on the command line; nothing is typed into the pane. Claude first checks that the worktree is still on the PR head branch and reads the project instructions (`CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md` and `AGENTS.local.md` in the worktree, where they exist; the run's own rules win over them). Then it works through the comments in order, one at a time:
    - reads the comment and decides whether the code needs a change;
    - if it does, fixes the code, commits only that change and pushes to the PR branch, so every comment gets its own commit;
    - replies to the comment inline, in the same thread, ending the reply with the tag `#alex-pr-watch-comments` on its own last line;
    - removes `eyes` and adds a fresh `+1`.

    After the last comment it checks whether the PR description is still accurate and updates it if needed, then makes sure every commit of the run is pushed.

5. While the run is in flight the watcher checks it every 15 seconds (`PRWC_RUN_CHECK`). Once claude has stopped and stayed idle for a short quiet period, and every comment of the batch has its fresh `+1` or a failure reply, the watcher records the batch result. Every unresolved comment gets a `-1`, unless it was deleted or approved again. Claude stays open so you can inspect the conversation or continue it. The watcher keeps the working tree locked and continues polling the PR; new batches wait until you exit Claude. Then the watcher marks the pane as finished, frees the working tree and reads the PR again for the next batch.

### Pane layout

The panes of the watcher's window are laid out as a grid in launch order, columns first: 2 panes sit side by side, 3 are two on top and one full-width below, 4 make a 2x2 grid, 5 are three on top and two below, and so on. The grid covers every pane of the window, so when the watcher runs in a window you also use, your own panes are rearranged too. When a window is too small for one more pane, the worker opens in a new window. When the finished panes beyond `--keep-panes` are closed, the grid is laid out again. A worker pane counts as finished only after Claude has exited; the limit never closes a retained Claude session, including with `--keep-panes 0`.

### Reactions

| Reaction | Meaning                                                          |
| -------- | ---------------------------------------------------------------- |
| `rocket` | You approve the comment for automatic processing.                |
| `eyes`   | The watcher took the comment, a Claude session is working on it. |
| `+1`     | Done: the reply is posted and any fix is pushed.                 |
| `-1`     | Failed: the comment was not resolved; see the reply or the log.  |

### Reaction lifecycle

- Only your own `rocket` counts. It is removed when the run starts, so the same comment never runs twice by accident. To run a comment again, add the `rocket` again; the watcher removes your old `+1` or `-1` when the new run starts.
- If the comment was edited at or after the time of your `rocket`, it is not run: the watcher removes the `rocket` and logs that the comment was edited after approval. Read the new text and add the `rocket` again to approve it.
- A batch completes only after claude has stayed idle for a short quiet period and every comment of the batch has a fresh `+1` (a `+1` newer than your `rocket`). The quiet period is `PRWC_STOP_QUIET`, default 10 seconds: one of your own Stop hooks may make claude continue after it stopped once, and that work shows up as new activity before the period ends. The run is then `retained` with outcome `completed`: the session and its working-tree lock remain until you exit Claude. Restarting the watcher preserves this result and waiting state.
- If claude cannot resolve a comment, it posts a reply that explains the blocker (also ending with the `#alex-pr-watch-comments` tag), removes `eyes`, adds no `+1` and goes on with the next comment. When claude has stopped, the watcher adds a `-1` to every such comment and records the run as `retained` with outcome `failed`. Claude stays open for inspection; new batches wait for you to exit it, see [Watcher and run states](#watcher-and-run-states).
- If claude exits before the run is done (for example you quit it, or it crashed), or the run could not be started or was interrupted, the run ends as exited: the watcher removes `eyes` and adds a `-1` to every comment of the batch that has no fresh `+1`. Add the `rocket` again to retry a comment.
- A comment whose `rocket` you added again during the run gets no `-1`: it goes into the next batch.
- A deleted comment simply drops out of its batch. Anything else (claude idle while a comment has neither `+1` nor a failure reply, a permission prompt, every comment of the batch deleted) leaves the run in needs attention; that is not a failure yet, so no `-1` is added. See [State and logs](#state-and-logs).

### Stop hooks

If your Claude Code settings define their own Stop hooks, they may make Claude continue after a Stop event. At start-up the watcher warns when your user, project or local settings declare Stop hooks. Set a larger `PRWC_STOP_QUIET` if yours are slow so the batch result is recorded after their activity settles. The watcher keeps Claude open and the working tree locked after recording that result.

## Requirements

- Node.js 22.18 or newer. On the 23 line, 23.6 or newer is needed. The plugin runs its TypeScript directly with Node's built-in type stripping: there is no build step and no `npm install`. The launcher accepts only release versions (`MAJOR.MINOR.PATCH`, no pre-release strings).
- [tmux](https://github.com/tmux/tmux) 3.0 or newer. The watcher runs inside a tmux session, because it opens new panes there.
- `git` 2.29 or newer, and a local clone of the repository with the PR branch checked out. With `--worktree`, the PR branch must not be checked out in that clone, see [Watch worktree](#watch-worktree).
- [GitHub CLI](https://cli.github.com/) (`gh`), logged in to the PR's host with `gh auth login` (for GitHub Enterprise Server: `gh auth login --hostname HOST`) and with push access to the PR branch.
- [Claude Code](https://docs.claude.com/en/docs/claude-code/overview) (`claude`) on your `PATH`, or given with `--claude`.
- The working tree trusted in Claude Code once, including the separate watch worktree when using `--worktree`, see [Trust and permissions](#trust-and-permissions).
- macOS is the main target. Linux works too.

`new-worktree` needs only Node.js, `git` and `cp`. It does not need `gh`, `tmux` or `claude`, and it works outside tmux.

## Installation

The repository is a Claude Code plugin marketplace with a single plugin. In Claude Code:

```text
/plugin marketplace add badggit/alex-pr-watch-comments
/plugin install alex-pr-watch-comments@alex-pr-watch-comments
```

For console use, clone this repository anywhere:

```sh
git clone https://github.com/badggit/alex-pr-watch-comments.git /path/to/alex-pr-watch-comments
```

## Usage

### From Claude Code

Run Claude Code inside tmux, in the project directory, and use the skill:

```text
/alex-pr-watch-comments:alex-pr-watch-comments https://github.com/OWNER/REPO/pull/123
/alex-pr-watch-comments:alex-pr-watch-comments https://github.com/OWNER/REPO/pull/123 --worktree
/alex-pr-watch-comments:alex-pr-watch-comments list
/alex-pr-watch-comments:alex-pr-watch-comments stop https://github.com/OWNER/REPO/pull/123
```

The skill is a thin wrapper. It runs exactly one command and shows its output:

- a PR URL runs `alex-pr-watch-comments PR_URL --background` from the current project directory;
- a PR URL followed by `--worktree` runs `alex-pr-watch-comments PR_URL --background --worktree`;
- `list` runs `alex-pr-watch-comments --list`;
- `stop PR_URL` runs `alex-pr-watch-comments --stop PR_URL`.

The skill uses the directory Claude Code runs in as the clone and works there by default. It accepts `--worktree` after the PR URL to use a [watch worktree](#watch-worktree); it has no `--dir` or other watcher options.

The second skill creates a worktree for parallel work and moves the session into it. It runs only when you call it; Claude never picks it on its own. It does not need tmux:

```text
/alex-pr-watch-comments:new-worktree ABC-123
/alex-pr-watch-comments:new-worktree #42 --branch feature/login
/alex-pr-watch-comments:new-worktree fix login form --base origin/main
/alex-pr-watch-comments:new-worktree app-hotfix
/alex-pr-watch-comments:new-worktree
```

The argument is read in this order, the first match wins:

- a ticket key in uppercase letters and digits, a dash and digits (`ABC-123`) becomes `--task abc-123`; lowercase `app-2` is not a ticket key;
- a pull request (`#42` or a URL ending in `/pull/42`) becomes `--task pr-42`. The skill passes the PR head branch as `--branch` only when the conversation already names it; otherwise the branch is `pr-42`, which the command checks out when it already exists locally or as a remote-tracking branch, or else creates from HEAD (or `--base`). The skill never asks GitHub;
- several words (`fix login form`) become `--task` with a 1-2 word kebab-case summary (`login-form`);
- one word is the literal worktree name (`app-hotfix`). The skill passes it as is and lets the command refuse a name that is not a safe folder name;
- nothing: the skill takes a ticket key, a PR or a short summary of the task from the conversation. When the conversation has no task, it asks you one short question for the task or the name.

`--branch BRANCH` and `--base REF` are passed through unchanged in every form. The skill runs exactly one command, `alex-pr-watch-comments new-worktree ...` from the current project directory, shows its output as printed and does no git checks of its own.

On success the skill takes the path from the one output line that starts with `/` and switches the session into the new worktree with Claude Code's `EnterWorktree` tool. When the output has no such line or more than one, it does not switch and gives the two lines below with the placeholder `PATH`. Claude Code normally asks you once to approve this switch, because the path is outside the project. When the switch is not available, is refused (for example because the session is already in a worktree session) or you decline it, the skill gives two lines instead:

- `/cd PATH` to move this session into the worktree;
- `cd 'PATH' && claude` to start a new session from a new terminal.

After the switch:

- the main clone is off-limits for the rest of that session; Claude works only in the worktree;
- Claude Code works from the worktree folder, so the instruction files it loads (`CLAUDE.md`, `CLAUDE.local.md` and the like, as linked or checked out there) are the worktree's; this is Claude Code's behavior, not something the skill controls;
- leaving with "exit the worktree" only moves the session back. The worktree stays on disk until you remove it, see [New worktree](#new-worktree).

A new worktree is a new folder for Claude Code, so it may show the folder trust dialog once, as for the watch worktree. The command never trusts a folder for you.

### Console use

The same command works directly from a shell, without the skill. Use the launcher from a clone of this repository:

```sh
/path/to/alex-pr-watch-comments/bin/alex-pr-watch-comments https://github.com/OWNER/REPO/pull/123 --dir /path/to/project
```

Do not call the copy in the Claude Code plugin cache: its path contains the plugin version and changes with every plugin update. A symlink to `bin/alex-pr-watch-comments` from a directory on your `PATH` works; the launcher follows it.

Common forms, with the symlink from above:

```sh
# Watch in the foreground of the current tmux pane; Ctrl-C stops the watcher.
alex-pr-watch-comments https://github.com/OWNER/REPO/pull/123

# Watch in a detached window of the current tmux session.
alex-pr-watch-comments https://github.com/OWNER/REPO/pull/123 --background --dir /path/to/project

# Watch in a separate git worktree.
alex-pr-watch-comments https://github.com/OWNER/REPO/pull/123 --worktree

# Show every watcher and run.
alex-pr-watch-comments --list

# Stop the watcher of one PR.
alex-pr-watch-comments --stop https://github.com/OWNER/REPO/pull/123

# Create a worktree next to the main clone and change into it.
cd "$(alex-pr-watch-comments new-worktree --task abc-123)"

# The same with a literal name, a branch and a start point.
alex-pr-watch-comments new-worktree app-hotfix --branch hotfix/login --base origin/main
```

`new-worktree` prints only the absolute worktree path on stdout, so `cd "$(alex-pr-watch-comments new-worktree NAME)"` works. Progress and warnings go to stderr as log lines; on failure stdout is empty. For example:

```text
$ cd /path/to/app && alex-pr-watch-comments new-worktree --task abc-123
2026-10-08T10:00:00Z info name based on main working tree folder app
2026-10-08T10:00:00Z info created worktree /path/to/app-abc-123 on new branch abc-123 from 1a2b3c4
2026-10-08T10:00:01Z info cloning node_modules into the worktree with copy-on-write
/path/to/app-abc-123
```

## Options

```text
alex-pr-watch-comments <PR URL> [options]               watch in the foreground of the current tmux pane
alex-pr-watch-comments <PR URL> --background [options]  watch in a detached tmux window
alex-pr-watch-comments --list                           list watchers and runs
alex-pr-watch-comments --stop <PR URL>                  stop the watcher for a PR (a running worker is kept)
alex-pr-watch-comments new-worktree NAME [--branch BRANCH] [--base REF]
alex-pr-watch-comments new-worktree --task SLUG [--branch BRANCH] [--base REF]
    create or reuse a worktree next to the main clone and print its path
alex-pr-watch-comments --help                           show this help
```

The options in the table below are for the watcher. `new-worktree` takes only its own:

| Option            | Meaning                                                                                                                                                                                                                                                                                                                                                     |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NAME`            | The worktree folder name. 1 to 100 letters, digits, `.`, `_` or `-`, not starting with `.` or `-`, and not starting with `alex-pr-watch-comments-pr-`.                                                                                                                                                                                                      |
| `--task SLUG`     | Name the worktree `MAIN-SLUG`, where `MAIN` is the folder name of the main clone. `SLUG` takes 1 to 100 letters, digits, `.`, `_` or `-`, not starting with `.` or `-`; the combined `MAIN-SLUG` must then pass every `NAME` rule, so a long slug or main folder name can still end in a usage error (exit 2). Exactly one of `NAME` or `--task` is needed. |
| `--branch BRANCH` | The branch of the worktree, default: `SLUG` with `--task`, else `NAME`. Must be a valid branch name; values starting with `-` or `refs/` are refused.                                                                                                                                                                                                       |
| `--base REF`      | The start commit of a new branch, default: `HEAD` of the working tree the command runs in. Refused when the branch already exists or the worktree is reused.                                                                                                                                                                                                |
| `--help`          | Show the usage text.                                                                                                                                                                                                                                                                                                                                        |

`--task`, `--branch` and `--base` can each be given once. `--help` anywhere prints the usage text and exits 0.

| Option               | Meaning                                                                                                                                                                                       |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--background`       | Start the watcher in a detached window of the current tmux session and return once its first poll succeeded. Cannot be combined with `--list`, `--stop` or `--once`.                          |
| `--list`             | List watchers and runs. Takes no PR URL. Needs no tmux.                                                                                                                                       |
| `--stop PR_URL`      | Stop the watcher of a PR. Needs no tmux session of its own.                                                                                                                                   |
| `--dir PATH`         | Your clone of the repository, default: the current directory.                                                                                                                                 |
| `--worktree`         | Use a separate watch worktree on the PR branch. Cannot be combined with `--in-place`. See [Watch worktree](#watch-worktree).                                                                  |
| `--in-place`         | Explicitly select the default: work in the clone itself, on its checked-out PR branch. Kept for compatibility.                                                                                |
| `--interval SECONDS` | How often the PR is read for new rockets, a whole number from 1 to 86400, default 120.                                                                                                        |
| `--claude PATH`      | The claude executable, default: `claude` found on `PATH` at start.                                                                                                                            |
| `--claude-arg ARG`   | One extra argument for claude, repeatable, passed literally as its own argument (never through a shell). A value cannot contain a newline. An argument ending in `;` is passed literally too. |
| `--keep-panes N`     | Worker panes to keep after Claude exits, 0 or more, default 5. Older finished panes are closed; live retained sessions are kept.                                                              |
| `--batch-max N`      | Approved comments one run takes at most, 1 to 50, default 5. The oldest rockets go first; the rest wait for the next batch.                                                                   |
| `--once`             | One polling pass, then exit. Not with `--background`.                                                                                                                                         |
| `--help`             | Show the usage text.                                                                                                                                                                          |

The PR URL has the form `https://HOST/OWNER/REPO/pull/NUMBER`, where `HOST` is `github.com` or the host of a GitHub Enterprise Server. Host, owner and repository names are case-insensitive, so two spellings of one URL name the same PR. A host with a port is not supported.

Example with claude arguments:

```sh
alex-pr-watch-comments https://github.com/OWNER/REPO/pull/123 --claude-arg --model --claude-arg sonnet
```

### Environment variables

All values are whole seconds unless noted. A value that is not a positive whole number, or that is above 2147483, falls back to the default.

| Variable             | Default                                 | Meaning                                                                                                                 |
| -------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `PRWC_STATE_DIR`     | `~/.local/state/alex-pr-watch-comments` | State directory, see [State and logs](#state-and-logs).                                                                 |
| `PRWC_STOP_QUIET`    | 10                                      | Quiet period after claude stopped before a run counts as done.                                                          |
| `PRWC_RUN_CHECK`     | 15                                      | How often a run in flight is checked (or `--interval`, when that is shorter).                                           |
| `PRWC_START_TIMEOUT` | 120                                     | Time from the pane start until claude's first prompt must be recorded; after that the run shows `claude-did-not-start`. |
| `PRWC_LAUNCH_WAIT`   | 60                                      | Time a new worker pane waits for the watcher's go before it gives up.                                                   |
| `PRWC_RATE_RESERVE`  | 500                                     | GitHub GraphQL budget (requests, not seconds) below which polling slows down until the budget resets.                   |
| `PRWC_BG_TIMEOUT`    | 60                                      | Time `--background` waits for the watcher's first poll.                                                                 |
| `PRWC_READY_WAIT`    | 15                                      | Time a background watcher waits for its window to be ready.                                                             |
| `PRWC_STOP_WAIT`     | 10                                      | Time `--stop` waits for the watcher to exit.                                                                            |
| `PRWC_NODE`          | `node` on `PATH`                        | Node.js executable used by the launcher (a path, not seconds).                                                          |

`--background` passes the effective value of every variable above except `PRWC_STOP_WAIT` and `PRWC_NODE` to the watcher window, defaults included, so a stale value in the tmux server environment never wins.

### Output and exit codes

| Command            | Output                                                                                                                                                                                                                                                                                                                                 | Exit code                                                                                                                                               |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--background`     | `watching URL in window @N`                                                                                                                                                                                                                                                                                                            | 0                                                                                                                                                       |
| `--background`     | `already watched by pid PID (window @N)`                                                                                                                                                                                                                                                                                               | 0                                                                                                                                                       |
| `--background`     | a start-up refusal, a state directory refusal, `could not create the watcher window`, `watcher failed: MESSAGE`, `watcher did not report its first poll; check window @N` or `watcher exited before its first poll; check window @N`                                                                                                   | 1                                                                                                                                                       |
| `--list`           | one line per watcher and per run (a run removed while listing is skipped), `unreadable record PATH (format N)` for a run record it cannot read, or `no watchers`; `unsupported state format N` for a state directory of another format                                                                                                 | 0 (1 only for an unsafe state directory)                                                                                                                |
| `--stop`           | `watcher pid PID was not running` if the watcher was already gone, `left in place: run RUN_ID state=STATE` for each run of the PR and `unreadable record PATH (format N)` for each unreadable run record, then `stopped watcher for URL`                                                                                               | 0                                                                                                                                                       |
| `--stop`           | `unsafe state directory: ...`, `unsupported state format N`, `not watched: URL`, `invalid lock socket`, `watcher pid PID belongs to another process; not signalled`, `could not verify watcher pid PID; not signalled`, `watcher pid PID did not exit within N seconds` or `the PR lock of URL has an unreadable owner; not signalled` | 1                                                                                                                                                       |
| foreground watcher | `already watched by pid PID (window @N)`                                                                                                                                                                                                                                                                                               | 0                                                                                                                                                       |
| foreground watcher | a start-up refusal or a state directory refusal                                                                                                                                                                                                                                                                                        | 1                                                                                                                                                       |
| foreground watcher | log lines in the pane                                                                                                                                                                                                                                                                                                                  | 0 when the PR is closed or merged or the watcher is stopped, 1 on a fatal error; with `--once`, 0 after a good pass and 1 after a failed GitHub request |
| `new-worktree`     | the absolute worktree path on stdout (created or reused), log lines on stderr                                                                                                                                                                                                                                                          | 0                                                                                                                                                       |
| `new-worktree`     | `alex-pr-watch-comments: REASON` on stderr for a refusal (see [New worktree](#new-worktree)) or a git error, with nothing on stdout                                                                                                                                                                                                    | 1                                                                                                                                                       |
| `new-worktree`     | `alex-pr-watch-comments: MESSAGE` plus the usage text for a wrong option, a bad name or an invalid branch name                                                                                                                                                                                                                         | 2                                                                                                                                                       |
| any                | `alex-pr-watch-comments: MESSAGE` plus the usage text for a wrong option or argument                                                                                                                                                                                                                                                   | 2                                                                                                                                                       |
| any                | `alex-pr-watch-comments: MESSAGE` for an unexpected error                                                                                                                                                                                                                                                                              | 1                                                                                                                                                       |

When a `--background` start fails after the window was created, the window stays open so you can read why.

`--stop` sends the watcher a TERM signal only after it checked that the recorded process is still the same one (its start time matches). It never signals a process it could not verify, never kills a running worker or its pane, and never touches the clone or a run record. If the stopped watcher ran in a background window, that window is closed once its pane has exited.

## Watch worktree

By default the watcher works in your clone on its checked-out PR branch. With `--worktree`, it works in its own git worktree next to the clone:

- The worktree is `alex-pr-watch-comments-pr-NUMBER` in the directory that holds your clone (`--dir`, default: the current directory), on the PR head branch. The watcher creates it at start with `git worktree add`, or reuses it when it is already there. When your clone has no local branch for the PR yet, it is created from the remote branch, with tracking.
- Your clone can be on any other branch, with any changes: the watcher never touches its working tree, its index or its `FETCH_HEAD`. Git allows a branch in one working tree only, so the start refuses while the PR branch is checked out in your clone or in another worktree. Switch that one to another branch first.
- The start also refuses when something else already exists at the worktree path (for example the watch worktree of another clone in the same directory for a PR with the same number), or when the worktree there was switched to another branch. A worktree whose folder you deleted is registered again.
- Ignored `node_modules` folders, including nested ones, are cloned into the worktree with copy-on-write where the filesystem supports it: APFS on macOS when the clone and worktree are on the same volume, or btrfs, XFS and bcachefs on Linux. Reinstalling dependencies in the worktree does not change your clone's folder. On unsupported filesystems such as ext4, or across volumes, they remain symbolic links and the log says copy-on-write is unavailable; the watcher never falls back to a full copy. A `node_modules` link made by an earlier watcher version is replaced with a clone at the next start or before a run when possible. If cloning fails, the folder stays linked until the watcher restarts. Existing cloned folders are never refreshed, so later dependency installs in your clone do not reach them. Cloning many files can take several seconds; the watcher logs the start and duration.
- Other ignored paths stay symbolic links, including `.env`, `CLAUDE.local.md`, `docs.local` and Python `.venv` or `venv` folders. A file the run changes through a link changes in your clone. Build and cache outputs are not linked, so the two branches never overwrite each other's outputs: `dist`, `build`, `out`, `.next`, `coverage`, `.turbo`, `.cache`, `.eslintcache` and `*.tsbuildinfo`. Links and copy-on-write dependency clones are added at start and before every run; existing paths not created as links by the watcher are left untouched. Each linked path and cloned dependency folder is also added as an anchored pattern (for example `/node_modules`) to the repository's `.git/info/exclude`, which all its working trees share, so git never lists them as untracked and a run cannot commit them by accident. In your clone these paths are ignored already, so nothing changes there.
- When the PR is closed or merged, the watcher waits for any retained Claude session to exit before removing the worktree. It removes the worktree only when no run holds it, its tracked files have no changes, every commit is pushed, and it holds no untracked files and no ignored files besides the links, `node_modules` folders and the build and cache outputs listed above. Cloned or reinstalled `node_modules` folders do not keep the worktree, just like build and cache outputs; any manual edits inside them are removed with it. Otherwise it keeps the worktree and logs why. The local branch is always kept. `--stop` keeps the worktree, and the next start reuses it.
- A new worktree is a new folder for Claude Code, so trust it once, see [Trust and permissions](#trust-and-permissions).

Time Machine backs up each cloned dependency folder as full data. Exclude watch worktrees from Time Machine if your backups grow too large.

## New worktree

`alex-pr-watch-comments new-worktree` (and the `new-worktree` skill, which runs it) creates a git worktree for your own parallel work, or reuses one that is already there, and prints its path. It never fetches and never talks to GitHub.

Placement and names:

- The worktree goes into the directory that holds the main clone (the original clone, not a linked worktree), at `<that directory>/NAME`. With `--task SLUG` the name is `MAIN-SLUG`, where `MAIN` is the folder name of the main clone, so running it inside a linked worktree still gives `app-abc-123`, not `app-foo-abc-123`. The log says which folder the name is based on.
- When the main clone cannot be determined (for example a bare clone with worktrees, or a linked worktree of a repository with a separate git dir), the working tree the command runs in is used as the name base and as the source of the sync, and the log says so. A bare repository with no working tree and a repository inside a superproject (a submodule) are refused.
- The branch is `--branch BRANCH`, else the `--task` slug, else the name.

What it does, the first matching rule wins:

1. Refusals: the target is the working tree the command runs in or the main clone (so the command cannot refresh the worktree it runs in; run it from the main clone for that), the target is a symbolic link, or its state cannot be read.
2. A worktree is already registered at the target: it is reused when it is on the branch. It is refused when it is a watch worktree (folder name starting with `alex-pr-watch-comments-pr-`), when its folder is missing (run `git worktree prune` first), when it is locked, detached or on another branch, and when `--base` is given.
3. Anything else at the target, an empty folder included, is refused. So is a branch checked out in another working tree; the reason names it.
4. A local branch with that name is checked out in the new worktree. `--base` is refused.
5. A remote-tracking branch `REMOTE/BRANCH` that is already fetched (no fetch is done) gives a new local branch tracking it. Matches on several remotes are refused with the candidates; create the branch locally first. `--base` is refused.
6. Otherwise a new branch is created from the `HEAD` of the working tree the command runs in, or from `--base REF`, resolved to a commit first. The new branch has no upstream.

The branch is created explicitly before `git worktree add`, never with `git worktree add -b`. If `git worktree add` fails, the command deletes the branch it has just created, only while it still points where it was created and is not checked out anywhere; a branch that existed before is never touched. If git registered the worktree but reported an error (for example a failing `post-checkout` hook of your repository), nothing is removed: the command exits 1 and names the worktree path and its branch so you can inspect it.

After creating or reusing the worktree, the command syncs ignored paths from the main clone into it, the same way as for the [watch worktree](#watch-worktree):

- Ignored `node_modules` folders are cloned with copy-on-write where the filesystem supports it, else linked; there is never a full copy.
- Other ignored paths (`.env`, `CLAUDE.local.md`, `docs.local` and the like) are linked. Build and cache outputs (`dist`, `build`, `.next` and the rest of the list there) are not linked.
- Each linked path and cloned dependency folder is added as an anchored pattern to the shared `.git/info/exclude`.
- Only missing paths are added; existing paths, earlier clones included, are left as they are. The one exception is a `node_modules` link that points exactly at the main clone's folder (made by an earlier run where copy-on-write was unavailable): it is replaced with a copy-on-write clone when that works now. A nested ignored path is skipped unless its parent already exists as a real folder in the worktree. Ignored paths whose names contain line breaks or other control characters are skipped with a warning, because they cannot be written as one exclude line; this applies to the watch worktree too.
- Sync problems are only warnings: the worktree exists and its path is printed, and you can install dependencies by hand.

Things to know:

- Dependency folders are cloned from the main clone as they are. Nothing checks that they match the new branch's lockfile; reinstall when the branch changes dependencies.
- An ignored parent folder that contains `node_modules` (for example a fully ignored `vendor/`) is listed by git as one path and linked as a whole, so its dependencies are shared with the main clone, not cloned.
- Do not run two invocations for the same name at once. Git refuses a second creator at the same path, but the second one may reuse the worktree while the first one's hook or sync is still running and report success too early.
- Before any `git` runs, the command drops every `PATH` entry inside the project folders it can find from the file system alone (the current tree, the main clone, the shared git dir and the expected target) and checks that `git` and `cp` do not resolve into them, so a `git` or `cp` planted in the project cannot run. After git has located the repository, it repeats the check against the actual main tree and target; in unusual layouts (a bare clone with worktrees, a separate git dir) that second check is the first one to know those folders. The copy runs with the same cleaned `PATH`.

Removal is manual. When you are done with the work:

```sh
git worktree remove /path/to/app-abc-123
git branch -d abc-123
```

A fresh worktree with links and cloned dependency folders is removed by a plain `git worktree remove`, because the exclude patterns hide them. If the command warned that it could not update the exclude file, the links show as untracked: remove them first, then run `git worktree remove`. The exclude patterns stay in `.git/info/exclude` after the worktree is gone, as for the watch worktree.

## Working tree checks

The watcher's working tree is your clone by default, or the separate watch worktree with `--worktree`:

- The clone needs a remote for the PR head repository. The fetch and push destinations of that remote, after any `insteadOf` or `pushInsteadOf` rewrite, must all name that same repository on the PR's host (`https://HOST/OWNER/REPO.git`, `ssh://git@HOST/OWNER/REPO.git` or `git@HOST:OWNER/REPO.git`). Anything else is refused.
- By default the clone must have the PR head branch checked out (`gh pr checkout NUMBER`), and the runs work in it. `--in-place` explicitly selects this same behavior.
- Before each run the watcher checks the remote and the branch, that tracked files have no uncommitted changes, fetches the branch and checks that the local branch is not ahead of the remote. If a check fails, the watcher is holding: it shows the reason and a hint in `--list` and tries again on the next poll. Nothing on GitHub changes while it is holding.
- One working tree runs one batch at a time. A retained run keeps that working tree locked until its Claude session exits. Watchers for other PRs on the same clone wait (`holding` with `clone busy`); when a retained run holds the clone, the hint is `run RUN_ID of PR NUMBER holds the clone until its Claude session exits`.
- While a run is in flight, do not change tracked files, the index or the checked-out branch in that working tree. The run commits and pushes from there.

## Trust and permissions

The worker runs your normal `claude`, with your settings and your permission rules.

- Trust the watcher's working tree in Claude Code once before its first run: run `claude` in it and accept the folder trust dialog. Claude Code asks for trust per git working tree, so the watch worktree needs it once even when your clone is already trusted; when the watcher creates a worktree, it prints a warning with the path. The watcher never trusts a folder for you. Otherwise claude waits at the trust dialog, and the run ends in needs attention with `claude-did-not-start` and the hint `see the worker pane: claude may wait at a dialog like folder trust - trust the dir`.
- Every run adds one settings layer (`--settings` with a per-run file). It adds hooks that report claude's activity to the watcher, and allow rules for the conveyor's own commands: the exact git and gh commands listed under [Safety](#safety), `Read` of the run directory, and `Edit(path)` rules for the files claude writes there (one reply body per comment, the commit message and the PR body). It never removes your rules and never bypasses permissions.
- Your own ask and deny rules still apply to the conveyor's commands. For example, a rule `Bash(git push *)` that asks makes the run stop at that prompt, and the run shows as needs attention. Any other prompt, for example for editing project files when your settings ask for that, shows as needs attention too. Answer it in the worker pane and the run goes on.
- The allow rules do not cover editing the project's own files: your permission mode and rules decide that. To let runs edit without asking, allow it in your settings or pass a mode, for example `--claude-arg --permission-mode --claude-arg acceptEdits`.

## GitHub host and authentication

- alex-pr-watch-comments works with github.com and with GitHub Enterprise Server. The host comes from the PR URL: every GitHub call of the watcher and of the worker passes `--hostname HOST`, and a `GH_HOST` set to any other host is refused at start.
- alex-pr-watch-comments never uses `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN` or `GITHUB_ENTERPRISE_TOKEN`. They are removed from every process the watcher starts and from the worker's environment, including any that a tmux server still holds from earlier; a `--background` window gets them as empty values, and the watcher drops those at start. So the watcher and the worker panes always use the gh login stored for the PR's host (`gh auth login`, or `gh auth login --hostname HOST` for GitHub Enterprise Server). `GH_REPO` is removed the same way.
- When one of these variables is set, a foreground or a background start only warns, naming the variable, that it is ignored. A token variable never blocks a start. When gh is not logged in, the start-up refusal names the ignored variable too, so the fix is `gh auth login` for that host.
- Your effective gh config directory (`GH_CONFIG_DIR`, else `XDG_CONFIG_HOME/gh`, else `~/.config/gh`) is passed to the watcher window and to every worker pane, together with `GH_HOST=HOST` of the PR.

## Safety

Every run starts an agent that edits code and pushes it to your branch, so the trigger has to be trusted:

- Only a `rocket` reaction added by you, the account `gh` is logged in as, starts a run. On a public repository anyone can react to a comment, and those reactions are ignored.
- An edit of the comment after your `rocket` needs a fresh `rocket`: the watcher never runs text you did not approve.
- The text saved when the run starts (one snapshot per comment) is the only approved text. Earlier comments of the same thread are included as untrusted context only. The worker never fetches other comments or replies.
- Scope: claude changes only what the comment asks for, never runs commands quoted in comments, and does not touch dependencies, lockfiles, CI or workflow files or package scripts unless the approved comment asks for that file. It replies only inline in the same thread, never as a general PR comment or a review.
- The worker can use git and gh only through these exact commands (`RUN_DIR` is the run's directory in the state directory; `ID` is the database id of a comment of the batch and `REPLY_TO_ID` the first comment of its thread, and the four lines with them repeat for every comment; `*` stands for explicit file paths):

    ```text
    git status
    git status --porcelain --untracked-files=no
    git branch --show-current
    git rev-parse HEAD
    git rev-parse FETCH_HEAD
    git log --oneline -n 20
    git diff
    git diff --cached
    git diff --cached --name-only
    git fetch REMOTE refs/heads/BRANCH
    git merge --ff-only HEAD_SHA
    git add -- *
    git commit -F RUN_DIR/commit-msg.txt -- *
    git push REMOTE HEAD:refs/heads/BRANCH
    gh api repos/OWNER/REPO/pulls/NUMBER/comments/REPLY_TO_ID/replies --hostname HOST -F body=@RUN_DIR/reply-ID.md
    gh api graphql --hostname HOST -F query=@RUN_DIR/gql/removeEyes-ID.graphql
    gh api graphql --hostname HOST -F query=@RUN_DIR/gql/removePlus1-ID.graphql
    gh api graphql --hostname HOST -F query=@RUN_DIR/gql/addPlus1-ID.graphql
    gh api repos/OWNER/REPO/pulls/NUMBER --hostname HOST --jq .body
    gh api -X PATCH repos/OWNER/REPO/pulls/NUMBER --hostname HOST -F body=@RUN_DIR/pr-body.md
    ```

    There is no wildcard `git diff`: with a path wildcard, `git diff` could read any file outside the repository. The reaction files are written per comment and name only that approved comment. The worker never adds a `-1`: only the watcher does. The push goes only to the PR branch: no force push, no amend, no rebase.

- `PATH` entries inside your clone or the watch worktree are ignored when the watcher resolves `git`, `gh`, `tmux` and `claude`, and a tool that would resolve inside the working tree refuses the start. Before claude starts, the worker checks that `git` and `gh` still resolve to the same executables the watcher checked at start.
- Accepted risk: the worker runs with your Claude Code permissions and your stored gh login. The comment text is still untrusted input, and the `rocket` is your approval to act on it, so read the comment before you add one.

## State and logs

The watcher keeps locks, run records and the per-run files in the state directory: `~/.local/state/alex-pr-watch-comments`, or `PRWC_STATE_DIR` when set (made absolute against the current directory). A removed run is first moved into its `trash` child and then deleted there; anything left in `trash` is deleted at every watcher start. The path may contain only letters, digits and `_ . / + -`.

The state directory must be owned by you with mode 700, with no group- or world-writable parent (the sticky `/tmp` is fine); otherwise every command refuses with `unsafe state directory` and a fix hint. On Linux systems with user-private groups, `~/.local` is often mode 775; fix it with `chmod go-w ~/.local`, or set `PRWC_STATE_DIR` to a directory elsewhere.

The watcher logs to its own pane (the foreground pane or the background window), one line per event with a UTC time. Run notices, such as a run that needs attention, also appear in the tmux status line.

### Watcher and run states

`--list` prints one line per watcher and one per run:

```text
OWNER/REPO pull 123 state=running age=40s reason=working hint= comments=COMMENT_ID,COMMENT_ID last_error= dir=/path/to/alex-pr-watch-comments-pr-123
run 20261003120000-COMMENT_ID state=running comments=COMMENT_ID,COMMENT_ID age=38s
run 20261003110000-COMMENT_ID state=retained outcome=failed comments=COMMENT_ID age=2520s
```

`dir` is the working tree the watcher works in. A watcher line ends with ` dead` when its process is gone. A run line shows `age` in seconds and its state: `preparing`, `running`, `needs_attention`, `retained` (with `outcome=completed` or `outcome=failed`), `exited` or `abandoned`. Watcher states:

| State             | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `starting`        | Start-up checks.                                                                                                                                                                                                                                                                                                                                                                                                             |
| `polling`         | Waiting for an approved comment. After a run ended, `reason` says how: `done`, `claude-took-failure-path`, `claude-exited`, `abandoned` or `record-unreadable`.                                                                                                                                                                                                                                                              |
| `holding`         | An approved comment waits because a check of the clone failed. `reason` and `hint` say why and what to do, for example `uncommitted changes to tracked files` with `commit or stash them`, `wrong branch: ...` with `git checkout BRANCH`, `local branch is ahead of the remote` with `push or reset the branch manually`, `clone busy` or `context fetch failed`. Also shown while a retained run waits for you, see below. |
| `running`         | A run is in flight. `reason` is `working`, `settling` (claude stopped, quiet period running), `preparing`, or a reason why the watcher put off a decision until the next poll, such as `claude-pid-unverifiable`.                                                                                                                                                                                                            |
| `needs_attention` | The run needs you, see below.                                                                                                                                                                                                                                                                                                                                                                                                |
| `backing_off`     | A GitHub request failed; polling slows down, up to 300 seconds between polls, or the `--interval` if that is longer. `last_error` shows the error.                                                                                                                                                                                                                                                                           |
| `throttled`       | The GitHub GraphQL budget is below `PRWC_RATE_RESERVE`; polling waits for the reset, at most one hour, or the `--interval` if that is longer.                                                                                                                                                                                                                                                                                |
| `exited`          | The PR was closed or merged.                                                                                                                                                                                                                                                                                                                                                                                                 |
| `fatal`           | The watcher stopped on an error, for example a failed GitHub authentication.                                                                                                                                                                                                                                                                                                                                                 |

A `retained` run has finished its batch, but its Claude session is still open. Inspect or continue that session, then exit Claude to release the working tree and start the next batch. Its hooks and settings remain available while it is open, and restarting the watcher preserves the batch result. Run records with the state `completed` or `failed` from development builds are read as `retained`.

While a run is retained, the watcher shows `holding` with reason `OUTCOME-waiting-for-owner`, where `OUTCOME` is `completed` or `failed`. When approved comments wait behind it, the reason gets a count, for example `failed-waiting-for-owner, 2 approved comments waiting`, and the hint is `exit Claude in pane N to start the next batch`. After the PR is closed or merged, the reason ends with `, PR merged` (or `, PR closed`) and the hint is `exit Claude in pane N to finish`. If the worker pane was not found at watcher start, the state is `needs_attention` with reason `worker-pane-not-found` and the same suffix.

- When the set of waiting comments changes (but not when it empties), the watcher posts a tmux notice such as `alex-pr-watch-comments: run RUN_ID: 2 approved comments waiting, exit Claude in pane N to start the next batch`. After the PR is closed or merged, the notice is `PR merged, exit Claude to finish` (or `PR closed, ...`).
- A notice is repeated as a reminder at most every 30 minutes. Every change also goes to the watcher log.
- A comment edited after its `rocket` is not counted; add the `rocket` again to approve the new text.
- A tmux notice is short and needs an attached client, so `--list` is the authoritative view.

When the PR is closed or merged, the watcher keeps waiting while the in-flight run has, or may have, a worker. A run that has not started its worker yet (`preparing`) ends the watcher.

The delay between two reads of the PR never drops below the configured `--interval`. While a run is in flight, the watcher checks it every `PRWC_RUN_CHECK` seconds (only the comments of the run are read then), and right after the run ends it reads the PR at once for the next batch.

A gap in which the wall clock advanced more than 30 seconds beyond the monotonic clock (the host was asleep) is not counted as a polling failure.

Needs-attention reasons:

| Reason                                       | What to do                                                                                                                                                                                                                    |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `waiting-for-permission`                     | Answer the permission prompt in the worker pane.                                                                                                                                                                              |
| `idle-without-done-marker`                   | Claude stopped while a comment has neither `+1` nor a failure reply. Look at the worker pane; finish the task there or quit claude.                                                                                           |
| `claude-did-not-start`                       | See the worker pane: claude may wait at a dialog like folder trust. Answer it there, or quit claude, trust the working tree and add the `rocket` again.                                                                       |
| `comment-deleted`                            | Every comment of the batch is gone. Quit claude in the worker pane.                                                                                                                                                           |
| `claude-pid-reused`, `claude-pid-unreadable` | The recorded claude process could not be verified, so nothing was signalled. Quit claude in the worker pane.                                                                                                                  |
| `worker-pane-not-found`                      | After a watcher restart, the run's claude still runs but the watcher could not find a tmux pane for the run. Find that claude and quit it.                                                                                    |
| `run-missing`                                | The run's directory was removed while the watcher ran. Make sure no claude still runs in the clone (`--stop` never stops a worker), then stop and start the watcher, which frees the clone; remove a leftover `eyes` by hand. |
| `record-unreadable`, `claude-pid-mismatch`   | The run's record cannot be read, or its claude process cannot be matched. See manual recovery below.                                                                                                                          |

For the reasons above `run-missing`, once claude in the worker pane has exited, the watcher clears the run as `claude-exited`, removes `eyes`, adds a `-1` to every comment without a fresh `+1` and frees the clone. A `record-unreadable` run whose claude is gone and whose pane is closed is cleared too, as `record-unreadable`, but its `eyes` reactions may remain: remove them by hand. Add the `rocket` again to retry a comment.

### Manual recovery

Manual recovery is needed only when the watcher cannot clear the run itself, for example when it cannot prove the worker has exited: a `record-unreadable` run whose pane or claude is still there or whose claude pid cannot be read, or a `claude-pid-mismatch` run. Such a run keeps the clone until you clear it:

1. Stop the watcher: `alex-pr-watch-comments --stop PR_URL`.
2. Make sure no claude is running in the clone (quit it in the worker pane).
3. Delete `runs/RUN_ID` under the state directory (`RUN_ID` is shown by `--list` and in the notice).
4. Start the watcher again, and remove leftover `eyes` reactions from its comments by hand.

## Development

```sh
npm ci                  # development tools only; the plugin itself has no runtime dependencies
npm run check           # ESLint, tsc, the repository rules and the full test suite
npm run test:min-node   # the suite again on Node 22.18.0, downloaded and checksum-verified
```

Tests never touch the network, the real claude, real GitHub or your default tmux server.

For a release, bump `version` in `.claude-plugin/plugin.json`: installed copies update only when the version changes.

The live smoke is a maintainer tool. It needs an authenticated `gh`, tmux and a local git identity in this clone:

```sh
PRWC_SMOKE_CONFIRMED=1 node scripts/smoke/liveSmoke.ts --mode stub
```

Warning: the smoke pushes a scratch branch to this repository's GitHub remote and opens and closes a scratch PR there, so set `PRWC_SMOKE_CONFIRMED=1` only when that is intended. `--mode stub` uses a stand-in claude; `--mode real` runs the real claude unattended with your settings and gh login. `--keep` keeps the PR and the work area. The smoke clones into `.cache/smoke/clone` and runs the watcher there in the default in-place mode, so trust that directory in Claude Code once before a real run. It verifies that the retained Claude session of a completed batch remains open with its kit and working-tree lock. With `--keep`, inspect the session there and exit Claude when ready; without `--keep`, smoke cleanup stops the watcher and closes its own test tmux server before deleting the work area.
