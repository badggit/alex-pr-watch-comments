---
name: alex-worktree-new
description: Creates a sibling git worktree of the current project, with copy-on-write clones of dependency folders and links to other ignored paths, and switches the session into it. Use only when the user runs this skill, optionally with a worktree name, a ticket key, a pull request, task words, --branch or --base.
argument-hint: [NAME | TICKET | PR | task words] [--branch BRANCH] [--base REF]
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/bin/alex-pr-watch-comments new-worktree *)
disable-model-invocation: true
---

# alex-worktree-new

This skill is a thin wrapper around the `new-worktree` subcommand of the standalone `alex-pr-watch-comments` command. It runs exactly one command, relays its output and then switches the session into the new worktree. The command does every check itself and prints the absolute worktree path on success.

Arguments: `$ARGUMENTS`

## Read the arguments

Take `--branch BRANCH` and `--base REF` out of the arguments first; they are passed through unchanged in every form below. Call the rest ARG and read it as follows. The first match wins:

1. A ticket key: uppercase letters and digits, a dash, then digits, for example `ABC-123`. It becomes `--task abc-123` (the key in lowercase). Only a strictly uppercase key counts: lowercase `app-2` is not a ticket key.
2. A pull request reference: `#42` or a pull request URL ending in `/pull/42`. It becomes `--task pr-42`. Pass `--branch HEAD_BRANCH` only when the conversation already names the head branch of that pull request and the arguments have no `--branch`. Otherwise the branch is new from HEAD, not the pull request head branch, and the reply says so (see step 2).
3. Several words, for example `fix login form`. They become `--task SLUG`, where SLUG is a 1-2 word kebab-case summary of the task in lowercase letters, digits and dashes (`fix login form` gives `login-form`).
4. One word. It is the literal worktree name: pass it as NAME, without `--task`. This holds even when the word is not a safe folder name (for example `foo/bar`, `.hidden` or `-x`): still pass it as NAME, single-quoted, and let the command refuse it. Do not rewrite or reject it yourself.
5. Nothing, or only options: derive the SLUG from the conversation, in the same order: a ticket key mentioned in the conversation, then a pull request, then a 1-2 word summary of the current task. Pass it as `--task SLUG`. If the conversation has no task to name the worktree after, ask the owner one short question for the task or the name as plain reply text, with no tool, and end the turn. When the owner answers, read the answer as ARG with the rules above and continue.

## Quote every value

Every value placed in the command (NAME, SLUG, BRANCH, REF) is POSIX single-quoted: wrap it in `'...'` and write each apostrophe inside it as `'\''`. Never put a value in double quotes and never leave it unquoted, even when it looks harmless. Examples:

```
$(id)       ->  '$(id)'
a`b         ->  'a`b'
a;rm x      ->  'a;rm x'
it's        ->  'it'\''s'
login-form  ->  'login-form'
```

## Steps

1. Run the command from the current project directory once, as a single Bash call, with no pipes, redirections or chaining. The call starts exactly with `"${CLAUDE_PLUGIN_ROOT}/bin/alex-pr-watch-comments" new-worktree`:
   `"${CLAUDE_PLUGIN_ROOT}/bin/alex-pr-watch-comments" new-worktree 'NAME' [--branch 'BRANCH'] [--base 'REF']`
   or
   `"${CLAUDE_PLUGIN_ROOT}/bin/alex-pr-watch-comments" new-worktree --task 'SLUG' [--branch 'BRANCH'] [--base 'REF']`
   Put each value in as one single-quoted argument. Include `--branch` and `--base` only when you have them.
2. Relay the command's output to the user verbatim: your reply starts with the output exactly as printed. Never capitalize, summarize, reword or translate it. After the output you may add at most one short sentence, and only in these cases:
   - the command failed: name the exit code, then stop;
   - the command created or reused a worktree for a pull request without a known head branch: say that the branch is new from HEAD, not the pull request head branch;
   - the output has an `info already in the worktree ...` log line: say that the session is already in a worktree and no new one was created.
3. On success (exit code 0), first look for a log line whose text right after the timestamp starts with `info already in the worktree `. If there is one, the session already works in a linked worktree and nothing was created: do not switch and stop here. Otherwise find PATH. The Bash output mixes stdout and stderr in no guaranteed order; log lines on stderr start with an ISO timestamp, for example `2026-10-08T10:00:00Z info ...`. PATH is the one output line that starts with `/`. If there is not exactly one such line, do not switch: give the two lines from step 4 with the literal placeholder `PATH`, and say that the worktree path is in the output above. Otherwise switch the session into PATH with the `EnterWorktree` tool, setting its `path` parameter to PATH. When `EnterWorktree` is deferred, load it first through tool search (`select:EnterWorktree`). Claude Code normally shows the owner one approval prompt for this switch, because the path is outside the project.
4. If `EnterWorktree` is unavailable, refused (for example because the session is already in a worktree session) or declined by the owner, do not try anything else. Reply with:
   - `/cd PATH` to move this session into the worktree;
   - `cd 'PATH' && claude` to start a new session from a new terminal.
   Write PATH shell-quoted in single quotes in the second line; a single quote inside PATH is written as `'\''`.

## Rules

- Do no checks of your own before or after the command: no git, file or directory inspection. The command checks everything itself.
- Never retry with other arguments or flags, and never run any other command. Use no tools other than the one Bash call, tool search for `EnterWorktree`, and `EnterWorktree` itself.
- After a switch, the main clone is off-limits for the rest of the session. Leaving the worktree with "exit the worktree" keeps it on disk; remove it by hand with `git worktree remove` when the work is done.
