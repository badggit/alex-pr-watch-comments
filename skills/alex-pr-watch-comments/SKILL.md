---
name: alex-pr-watch-comments
description: Starts, lists or stops the alex-pr-watch-comments watcher, which turns rocket-approved inline review comments on a GitHub pull request into commits made by Claude Code in tmux panes. Use only when the user runs this skill with a PR URL, optionally followed by --worktree, list, or stop and a PR URL.
argument-hint: PR_URL [--worktree] | list | stop PR_URL
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/bin/alex-pr-watch-comments *)
disable-model-invocation: true
---

# alex-pr-watch-comments

This skill is a thin wrapper around the standalone `alex-pr-watch-comments` command. It runs exactly one command and relays its output. The command does every check itself.

Arguments: `$ARGUMENTS`

## Map the arguments to one command

Run the command from the current project directory, as a single Bash call, with no other options, pipes, redirections or chaining:

- A pull request URL (`https://HOST/OWNER/REPO/pull/NUMBER`, where HOST is github.com or a GitHub Enterprise Server host):
  `"${CLAUDE_PLUGIN_ROOT}/bin/alex-pr-watch-comments" PR_URL --background`
- A pull request URL followed by `--worktree`:
  `"${CLAUDE_PLUGIN_ROOT}/bin/alex-pr-watch-comments" PR_URL --background --worktree`
- `list`:
  `"${CLAUDE_PLUGIN_ROOT}/bin/alex-pr-watch-comments" --list`
- `stop` followed by a pull request URL:
  `"${CLAUDE_PLUGIN_ROOT}/bin/alex-pr-watch-comments" --stop PR_URL`

Put the URL from the arguments in place of `PR_URL`, as one argument, exactly as given.

If the arguments match none of these forms (empty, several URLs, an unknown word or any other option), do not run anything. Reply with the usage line `/alex-pr-watch-comments:alex-pr-watch-comments PR_URL [--worktree] | list | stop PR_URL` and stop.

## Rules

- Relay the command's output to the user verbatim: your reply starts with the output exactly as printed, byte for byte. Keep its lowercase first letter (`no watchers` stays `no watchers`, never `No watchers`), its words and its punctuation; never capitalize, summarize, reword or translate it, even when the output is a single short line. Then stop. After the output, add at most one short sentence when the command failed, naming the exit code.
- Do no checks of your own before or after the command: no git, gh, tmux or file inspection.
- Never retry with other flags or other arguments, and never run any other command.
