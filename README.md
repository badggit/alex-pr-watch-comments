# pr-watch-comments

Turn inline review comments on a GitHub pull request into commits, hands-free.

Leave a comment on a line of the PR diff, approve it with a 🚀 reaction, and a background watcher picks it up. It opens a new tmux pane, starts [Claude Code](https://docs.claude.com/en/docs/claude-code/overview) in your project and asks it to resolve the comment. Claude fixes the code if needed, commits and pushes to the PR branch, replies in the comment thread and marks the comment as done.

> **Status: early development.** This README describes the target behavior. Commands and options will be finalized as the implementation lands.

## How it works

1. You start the watcher for one PR, from a tmux session, inside a local clone of the PR's repository.
2. Every 15 seconds the watcher fetches the PR's inline review comments with `gh`.
3. A comment is picked up when it carries a 🚀 `rocket` reaction. General PR comments (the "Conversation" tab) are ignored.
4. The watcher replaces 🚀 with 👀 `eyes` to mark the comment as taken, opens a new pane in the current tmux session, changes to the project directory and runs `claude`.
5. After a short delay it types a prompt with a link to the comment. Claude then:
   - reads the comment and decides whether the code needs a change;
   - if it does, fixes the code, commits and pushes to the PR branch;
   - replies to the comment inline, in the same thread;
   - checks whether the PR description is still accurate and updates it if needed;
   - replaces 👀 with 👍 `+1`.

### Reactions

| Reaction | Meaning |
| --- | --- |
| 🚀 `rocket` | You approve the comment for automatic processing. |
| 👀 `eyes` | The watcher took the comment, a Claude session is working on it. |
| 👍 `+1` | Done: the reply is posted and any fix is pushed. |

## Requirements

- macOS (the primary target). Development also happens on Linux.
- [tmux](https://github.com/tmux/tmux). The watcher must run inside a tmux session, because it opens new panes there.
- [GitHub CLI](https://cli.github.com/) (`gh`), logged in with access to the repository.
- `git`, and a local clone of the repository with the PR branch available.
- [Claude Code](https://docs.claude.com/en/docs/claude-code/overview) (`claude`) on your `PATH`.

## Installation

The repository is a Claude Code plugin marketplace with a single plugin. In Claude Code:

```text
/plugin marketplace add badggit/pr-watch-comments
/plugin install pr-watch-comments@pr-watch-comments
```

## Usage

From Claude Code, running inside tmux:

```text
/pr-watch-comments:pr-watch-comments https://github.com/OWNER/REPO/pull/123
```

The same watcher can be started directly from a shell, without the skill. The exact command will be documented here once it lands.

## Safety

Every triggered run starts an agent that edits code and pushes it to your branch, so the trigger has to be trusted:

- Only a 🚀 reaction added by you, the account `gh` is logged in as, starts a run. On a public repository anyone can react to a comment, and those reactions are ignored.
- The comment text is still untrusted input. The 🚀 reaction is your approval to act on it, so read the comment before you add one.
- The Claude session runs with your normal Claude Code permission settings in your local clone.
