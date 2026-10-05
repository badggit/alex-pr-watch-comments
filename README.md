# alex-pr-watch-comments

Turn inline review comments on a GitHub pull request into commits, hands-free.

Leave comments on lines of the PR diff, approve them with a `rocket` reaction, and a watcher picks them up. It opens a new tmux pane, starts [Claude Code](https://docs.claude.com/en/docs/claude-code/overview) in your project and gives it every approved comment to resolve, one after another. For each comment Claude fixes the code if needed, commits and pushes to the PR branch, replies in the comment thread and marks the comment as done.

## How it works

1. You start the watcher for one PR from a tmux session, for a local clone of the PR's repository with the PR branch checked out.
2. Every 2 minutes (`--interval`, default 120 seconds) the watcher reads the PR's inline review threads with `gh`.
3. A comment is picked up when it carries a `rocket` reaction added by you, the account `gh` is logged in as. Only inline review comments (comments on the diff) count; general PR comments (the "Conversation" tab) are ignored. All comments approved at that moment go into one run as a batch, oldest rocket first, at most `--batch-max` (default 5) of them; the rest wait for the next batch. One run at a time.
4. The watcher checks the clone, saves the text of every approved comment, replaces each of your `rocket` reactions with `eyes`, opens a new pane in the watcher's window and starts `claude` there. The task is passed as claude's initial prompt on the command line; nothing is typed into the pane. Claude first checks that the clone is still on the PR head branch and reads the project instructions (`CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md` and `AGENTS.local.md` in the project directory, where they exist; the run's own rules win over them). Then it works through the comments in order, one at a time:
    - reads the comment and decides whether the code needs a change;
    - if it does, fixes the code, commits only that change and pushes to the PR branch, so every comment gets its own commit;
    - replies to the comment inline, in the same thread, ending the reply with the tag `#alex-pr-watch-comments` on its own last line;
    - removes `eyes` and adds a fresh `+1`.

    After the last comment it checks whether the PR description is still accurate and updates it if needed, then makes sure every commit of the run is pushed.
5. While the run is in flight the watcher checks it every 15 seconds (`PRWC_RUN_CHECK`). Once claude has stopped and stayed idle for a short quiet period, and every comment of the batch has its fresh `+1` or a failure reply, the watcher ends that claude session and marks its pane as finished. Every comment without a fresh `+1` gets a `-1`. Then it reads the PR again right away, and the comments approved in the meantime become the next batch.

### Pane layout

The panes of the watcher's window are laid out as a grid in launch order, columns first: 2 panes sit side by side, 3 are two on top and one full-width below, 4 make a 2x2 grid, 5 are three on top and two below, and so on. The grid covers every pane of the window, so when the watcher runs in a window you also use, your own panes are rearranged too. When a window is too small for one more pane, the worker opens in a new window. When the finished panes beyond `--keep-panes` are closed, the grid is laid out again.

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
- A run completes only after claude has stayed idle for a short quiet period and every comment of the batch has a fresh `+1` (a `+1` newer than your `rocket`). The quiet period is `PRWC_STOP_QUIET`, default 10 seconds: one of your own Stop hooks may make claude continue after it stopped once, and that work shows up as new activity before the period ends.
- If claude cannot resolve a comment, it posts a reply that explains the blocker (also ending with the `#alex-pr-watch-comments` tag), removes `eyes`, adds no `+1` and goes on with the next comment. When claude has stopped, the watcher adds a `-1` to every such comment, and the run ends as failed.
- If claude exits before the run is done (for example you quit it, or it crashed), or the run could not be started or was interrupted, the run ends as exited: the watcher removes `eyes` and adds a `-1` to every comment of the batch that has no fresh `+1`. Add the `rocket` again to retry a comment.
- A comment whose `rocket` you added again during the run gets no `-1`: it goes into the next batch.
- A deleted comment simply drops out of its batch. Anything else (claude idle while a comment has neither `+1` nor a failure reply, a permission prompt, every comment of the batch deleted) leaves the run in needs attention; that is not a failure yet, so no `-1` is added. See [State and logs](#state-and-logs).

### Stop hooks

If your Claude Code settings define their own Stop hooks, a hook that runs longer than the quiet period can be cut short when the run completes. The work is already pushed and replied at that point, so only the extra work your hook asked for is lost. At start-up the watcher warns when your user, project or local settings declare Stop hooks. If yours are slow, set a larger `PRWC_STOP_QUIET`.

## Requirements

- Node.js 22.18 or newer. On the 23 line, 23.6 or newer is needed. The plugin runs its TypeScript directly with Node's built-in type stripping: there is no build step and no `npm install`. The launcher accepts only release versions (`MAJOR.MINOR.PATCH`, no pre-release strings).
- [tmux](https://github.com/tmux/tmux) 3.0 or newer. The watcher runs inside a tmux session, because it opens new panes there.
- `git`, and a local clone of the repository with the PR branch checked out.
- [GitHub CLI](https://cli.github.com/) (`gh`), logged in to the PR's host with `gh auth login` (for GitHub Enterprise Server: `gh auth login --hostname HOST`) and with push access to the PR branch.
- [Claude Code](https://docs.claude.com/en/docs/claude-code/overview) (`claude`) on your `PATH`, or given with `--claude`.
- The project directory trusted in Claude Code, see [Trust and permissions](#trust-and-permissions).
- macOS is the main target. Linux works too.

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
/alex-pr-watch-comments:alex-pr-watch-comments list
/alex-pr-watch-comments:alex-pr-watch-comments stop https://github.com/OWNER/REPO/pull/123
```

The skill is a thin wrapper. It runs exactly one command and shows its output:

- a PR URL runs `alex-pr-watch-comments PR_URL --background` from the current project directory;
- `list` runs `alex-pr-watch-comments --list`;
- `stop PR_URL` runs `alex-pr-watch-comments --stop PR_URL`.

The skill has no `--dir`: the watcher uses the directory Claude Code runs in, so for a [dedicated clone](#shared-clone) start Claude Code there.

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

# Show every watcher and run.
alex-pr-watch-comments --list

# Stop the watcher of one PR.
alex-pr-watch-comments --stop https://github.com/OWNER/REPO/pull/123
```

## Options

```text
alex-pr-watch-comments <PR URL> [options]               watch in the foreground of the current tmux pane
alex-pr-watch-comments <PR URL> --background [options]  watch in a detached tmux window
alex-pr-watch-comments --list                           list watchers and runs
alex-pr-watch-comments --stop <PR URL>                  stop the watcher for a PR (a running worker is kept)
alex-pr-watch-comments --help                           show this help
```

| Option               | Meaning                                                                                                                                                                                       |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--background`       | Start the watcher in a detached window of the current tmux session and return once its first poll succeeded. Cannot be combined with `--list`, `--stop` or `--once`.                          |
| `--list`             | List watchers and runs. Takes no PR URL. Needs no tmux.                                                                                                                                       |
| `--stop PR_URL`      | Stop the watcher of a PR. Needs no tmux session of its own.                                                                                                                                   |
| `--dir PATH`         | Project directory, default: the current directory.                                                                                                                                            |
| `--interval SECONDS` | How often the PR is read for new rockets, a whole number from 1 to 86400, default 120.                                                                                                        |
| `--claude PATH`      | The claude executable, default: `claude` found on `PATH` at start.                                                                                                                            |
| `--claude-arg ARG`   | One extra argument for claude, repeatable, passed literally as its own argument (never through a shell). A value cannot contain a newline. An argument ending in `;` is passed literally too. |
| `--keep-panes N`     | Finished worker panes to keep for the PR, 0 or more, default 5. Older finished panes are closed.                                                                                              |
| `--batch-max N`      | Approved comments one run takes at most, 1 to 50, default 5. The oldest rockets go first; the rest wait for the next batch.                                                                    |
| `--once`             | One polling pass, then exit. Not with `--background`.                                                                                                                                         |
| `--help`             | Show the usage text.                                                                                                                                                                          |

The PR URL has the form `https://HOST/OWNER/REPO/pull/NUMBER`, where `HOST` is `github.com` or the host of a GitHub Enterprise Server. Host, owner and repository names are case-insensitive, so two spellings of one URL name the same PR. A host with a port is not supported.

Example with claude arguments:

```sh
alex-pr-watch-comments https://github.com/OWNER/REPO/pull/123 --claude-arg --model --claude-arg sonnet
```

### Environment variables

All values are whole seconds unless noted. A value that is not a positive whole number, or that is above 2147483, falls back to the default.

| Variable             | Default                            | Meaning                                                                                                                 |
| -------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `PRWC_STATE_DIR`     | `~/.local/state/alex-pr-watch-comments` | State directory, see [State and logs](#state-and-logs).                                                                 |
| `PRWC_STOP_QUIET`    | 10                                 | Quiet period after claude stopped before a run counts as done.                                                          |
| `PRWC_RUN_CHECK`     | 15                                 | How often a run in flight is checked (or `--interval`, when that is shorter).                                           |
| `PRWC_START_TIMEOUT` | 120                                | Time from the pane start until claude's first prompt must be recorded; after that the run shows `claude-did-not-start`. |
| `PRWC_TERM_WAIT`     | 10                                 | Time the watcher waits for claude to exit after it ended a finished run.                                                |
| `PRWC_LAUNCH_WAIT`   | 60                                 | Time a new worker pane waits for the watcher's go before it gives up.                                                   |
| `PRWC_RATE_RESERVE`  | 500                                | GitHub GraphQL budget (requests, not seconds) below which polling slows down until the budget resets.                   |
| `PRWC_BG_TIMEOUT`    | 60                                 | Time `--background` waits for the watcher's first poll.                                                                 |
| `PRWC_READY_WAIT`    | 15                                 | Time a background watcher waits for its window to be ready.                                                             |
| `PRWC_STOP_WAIT`     | 10                                 | Time `--stop` waits for the watcher to exit.                                                                            |
| `PRWC_NODE`          | `node` on `PATH`                   | Node.js executable used by the launcher (a path, not seconds).                                                          |

`--background` passes the effective value of every variable above except `PRWC_STOP_WAIT` and `PRWC_NODE` to the watcher window, defaults included, so a stale value in the tmux server environment never wins.

### Output and exit codes

| Command            | Output                                                                                                                                                                                                                                                                                                                                 | Exit code                                                                                                                                               |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--background`     | `watching URL in window @N`                                                                                                                                                                                                                                                                                                            | 0                                                                                                                                                       |
| `--background`     | `already watched by pid PID (window @N)`                                                                                                                                                                                                                                                                                               | 0                                                                                                                                                       |
| `--background`     | a start-up refusal, a state directory refusal, `could not create the watcher window`, `watcher failed: MESSAGE`, `watcher did not report its first poll; check window @N` or `watcher exited before its first poll; check window @N`                                                                                                   | 1                                                                                                                                                       |
| `--list`           | one line per watcher and per run, `unreadable record PATH (format N)` for a run record it cannot read, or `no watchers`; `unsupported state format N` for a state directory of another format                                                                                                                                          | 0 (1 only for an unsafe state directory)                                                                                                                |
| `--stop`           | `watcher pid PID was not running` if the watcher was already gone, `left in place: run RUN_ID state=STATE` for each run of the PR and `unreadable record PATH (format N)` for each unreadable run record, then `stopped watcher for URL`                                                                                               | 0                                                                                                                                                       |
| `--stop`           | `unsafe state directory: ...`, `unsupported state format N`, `not watched: URL`, `invalid lock socket`, `watcher pid PID belongs to another process; not signalled`, `could not verify watcher pid PID; not signalled`, `watcher pid PID did not exit within N seconds` or `the PR lock of URL has an unreadable owner; not signalled` | 1                                                                                                                                                       |
| foreground watcher | `already watched by pid PID (window @N)`                                                                                                                                                                                                                                                                                               | 0                                                                                                                                                       |
| foreground watcher | a start-up refusal or a state directory refusal                                                                                                                                                                                                                                                                                        | 1                                                                                                                                                       |
| foreground watcher | log lines in the pane                                                                                                                                                                                                                                                                                                                  | 0 when the PR is closed or merged or the watcher is stopped, 1 on a fatal error; with `--once`, 0 after a good pass and 1 after a failed GitHub request |
| any                | `alex-pr-watch-comments: MESSAGE` plus the usage text for a wrong option or argument                                                                                                                                                                                                                                                        | 2                                                                                                                                                       |
| any                | `alex-pr-watch-comments: MESSAGE` for an unexpected error                                                                                                                                                                                                                                                                                   | 1                                                                                                                                                       |

When a `--background` start fails after the window was created, the window stays open so you can read why.

`--stop` sends the watcher a TERM signal only after it checked that the recorded process is still the same one (its start time matches). It never signals a process it could not verify, never kills a running worker or its pane, and never touches the clone or a run record. If the stopped watcher ran in a background window, that window is closed once its pane has exited.

## Shared clone

The watcher and its runs work in your clone, the one given by `--dir`:

- The clone must have the PR head branch checked out (`gh pr checkout NUMBER`), and it needs a remote for the PR head repository. The fetch and push destinations of that remote, after any `insteadOf` or `pushInsteadOf` rewrite, must all name that same repository on the PR's host (`https://HOST/OWNER/REPO.git`, `ssh://git@HOST/OWNER/REPO.git` or `git@HOST:OWNER/REPO.git`). Anything else is refused.
- Before each run the watcher checks the remote and the branch, that tracked files have no uncommitted changes, fetches the branch and checks that the local branch is not ahead of the remote. If a check fails, the watcher is holding: it shows the reason and a hint in `--list` and tries again on the next poll. Nothing on GitHub changes while it is holding.
- One clone runs one batch at a time. Watchers for other PRs on the same clone wait (`holding` with `clone busy`).
- While a run is in flight, do not change tracked files, the index or the checked-out branch in that clone. The run commits and pushes from there.

The easiest way to keep this contract is a dedicated clone for the watcher, given with `--dir`, while you keep working in your usual one.

## Trust and permissions

The worker runs your normal `claude`, with your settings and your permission rules.

- Trust the project directory in Claude Code once before the first run: run `claude` in it and accept the folder trust dialog. Subdirectories inherit that decision. Otherwise claude waits at the trust dialog, and the run ends in needs attention with `claude-did-not-start` and the hint `see the worker pane: claude may wait at a dialog like folder trust - trust the dir`.
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

- `PATH` entries inside the working tree are ignored when the watcher resolves `git`, `gh`, `tmux` and `claude`, and a tool that would resolve inside the working tree refuses the start. Before claude starts, the worker checks that `git` and `gh` still resolve to the same executables the watcher checked at start.
- Accepted risk: the worker runs with your Claude Code permissions and your stored gh login. The comment text is still untrusted input, and the `rocket` is your approval to act on it, so read the comment before you add one.

## State and logs

The watcher keeps locks, run records and the per-run files in the state directory: `~/.local/state/alex-pr-watch-comments`, or `PRWC_STATE_DIR` when set (made absolute against the current directory). The path may contain only letters, digits and `_ . / + -`.

The state directory must be owned by you with mode 700, with no group- or world-writable parent (the sticky `/tmp` is fine); otherwise every command refuses with `unsafe state directory` and a fix hint. On Linux systems with user-private groups, `~/.local` is often mode 775; fix it with `chmod go-w ~/.local`, or set `PRWC_STATE_DIR` to a directory elsewhere.

The watcher logs to its own pane (the foreground pane or the background window), one line per event with a UTC time. Run notices, such as a run that needs attention, also appear in the tmux status line.

### Watcher and run states

`--list` prints one line per watcher and one per run:

```text
OWNER/REPO pull 123 state=running age=40s reason=working hint= comments=COMMENT_ID,COMMENT_ID last_error=
run 20261003120000-COMMENT_ID state=running comments=COMMENT_ID,COMMENT_ID age=38s
```

A watcher line ends with ` dead` when its process is gone. Watcher states:

| State             | Meaning                                                                                                                                                                                                                                                                                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `starting`        | Start-up checks.                                                                                                                                                                                                                                                                                                                                                   |
| `polling`         | Waiting for an approved comment. After a run ended, `reason` says how: `done`, `claude-took-failure-path`, `claude-exited`, `abandoned` or `record-unreadable`.                                                                                                                                                                                                    |
| `holding`         | An approved comment waits because a check of the clone failed. `reason` and `hint` say why and what to do, for example `uncommitted changes to tracked files` with `commit or stash them`, `wrong branch: ...` with `git checkout BRANCH`, `local branch is ahead of the remote` with `push or reset the branch manually`, `clone busy` or `context fetch failed`. |
| `running`         | A run is in flight. `reason` is `working`, `settling` (claude stopped, quiet period running), `preparing`, or a reason why the watcher put off a decision until the next poll, such as `claude-pid-unverifiable`.                                                                                                                                                  |
| `needs_attention` | The run needs you, see below.                                                                                                                                                                                                                                                                                                                                      |
| `backing_off`     | A GitHub request failed; polling slows down, up to 300 seconds between polls, or the `--interval` if that is longer. `last_error` shows the error.                                                                                                                                                                                                                 |
| `throttled`       | The GitHub GraphQL budget is below `PRWC_RATE_RESERVE`; polling waits for the reset, at most one hour, or the `--interval` if that is longer.                                                                                                                                                                                                                      |
| `exited`          | The PR was closed or merged.                                                                                                                                                                                                                                                                                                                                       |
| `fatal`           | The watcher stopped on an error, for example a failed GitHub authentication.                                                                                                                                                                                                                                                                                       |

The delay between two reads of the PR never drops below the configured `--interval`. While a run is in flight, the watcher checks it every `PRWC_RUN_CHECK` seconds (only the comments of the run are read then), and right after the run ends it reads the PR at once for the next batch.

A gap in which the wall clock advanced more than 30 seconds beyond the monotonic clock (the host was asleep) is not counted as a polling failure.

Needs-attention reasons:

| Reason                                       | What to do                                                                                                                                                                                                                    |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `waiting-for-permission`                     | Answer the permission prompt in the worker pane.                                                                                                                                                                              |
| `idle-without-done-marker`                   | Claude stopped while a comment has neither `+1` nor a failure reply. Look at the worker pane; finish the task there or quit claude.                                                                                          |
| `claude-did-not-start`                       | See the worker pane: claude may wait at a dialog like folder trust. Answer it there, or quit claude, trust the project directory and add the `rocket` again.                                                                  |
| `comment-deleted`                            | Every comment of the batch is gone. Quit claude in the worker pane.                                                                                                                                                           |
| `claude-did-not-exit`                        | Claude did not exit after the run ended. Quit it in the worker pane.                                                                                                                                                          |
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

Warning: the smoke pushes a scratch branch to this repository's GitHub remote and opens and closes a scratch PR there, so set `PRWC_SMOKE_CONFIRMED=1` only when that is intended. `--mode stub` uses a stand-in claude; `--mode real` runs the real claude unattended with your settings and gh login. `--keep` keeps the PR and the work area. The smoke clones into `.cache/smoke/clone`, so trust that directory in Claude Code once before a real run.
