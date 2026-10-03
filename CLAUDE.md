## Session Initialization

At the start of each session, you MUST:
1. **Read `CLAUDE.local.md` in the repository root if it exists** and follow it for the rest of the session. It holds machine-specific instructions that are gitignored and therefore absent from a fresh clone; treat them as an extension of this file.
2. If you need to save a private data (URLs, paths, logins, usernames, password, keys, etc.) use ONLY `CLAUDE.local.md`. NEVER save this data to git-based files.

## Project

`pr-watch-comments` is a Claude Code plugin that turns inline review comments on a GitHub pull request into commits. A background watcher polls the PR, and for every inline comment approved with a `rocket` reaction it opens a new tmux pane, starts `claude` in the project directory and hands it the comment to resolve. See `README.md` for the user-facing behavior.

- The repository is also a single-plugin marketplace. Marketplace, plugin and skill are all named `pr-watch-comments`, so the skill is invoked as `/pr-watch-comments:pr-watch-comments <PR URL>`.
- The watcher must work in two ways: launched by the skill, and launched directly from a shell. Keep the skill a thin wrapper around the standalone command so both paths share one implementation.
- Only inline review comments (comments on the diff) are in scope. General PR conversation comments are ignored, both when reading and when replying.

## Rules

### Public repository

- This repository is public. Never commit private data: personal names, emails, local paths, tokens, hostnames, machine details.
- Private notes, the project wiki, alex-loop artifacts (designs, plans, challenges) and reports live under the gitignored `docs.local/` tree or in `CLAUDE.local.md`, never under `docs/`.

### Target platform

- The watcher is written in TypeScript and runs directly on Node.js 22.18 or newer (built-in type stripping): no build step, no compiled output in the repo. Use only erasable TypeScript syntax (no `enum`, `namespace` or parameter properties).
- No runtime npm dependencies: Claude Code installs the plugin as a plain checkout without a package install step, so runtime code may import only Node built-ins (`node:*`). Development tools (TypeScript, ESLint, Prettier) are dev dependencies.
- The runtime target is macOS; development may happen on Linux, so shipped code must run on both. Prefer Node APIs over shelling out to platform tools. Any remaining shell code (the entry launcher, generated worker scripts) must be POSIX `sh` that runs under macOS `/bin/sh`.
- Runtime dependencies are `node` (>= 22.18), `tmux`, `git`, an authenticated `gh` and the `claude` CLI. Any other dependency must be justified and documented in `README.md`.

### Code and docs

- Follow `eslint.config.mjs` for all TypeScript and JavaScript (typed linting uses the `tsconfig.json` at the repo root). Never use `any` and never add lint-suppression comments.
- Write code comments in English and use plain ASCII punctuation in all text.
- Keep `README.md` in sync with behavior, install steps and command-line options.
