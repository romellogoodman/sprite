# sprite

A small helping hand inside your computer.

A CLI coding agent: an LLM in a loop with five tools — `read_file`, `list_files`, `edit_file`, `bash`, `fetch_url`. It works in whatever directory you run it from.

## Setup

Clone the repository, install dependencies, and link it globally:

```sh
git clone https://github.com/romellogoodman/sprite.git
cd sprite
npm install
npm link
```

This package is not deployed to npm — link it locally to make the `sprite` command available globally on your system.

## Run

From any directory:

```sh
sprite                            # interactive
sprite -c                         # continue the last session in this directory
sprite -p "run the tests"         # one-shot: print to stdout, tool activity to stderr
git diff | sprite -p "review"     # pipe stdin; combines with -p if both are given
sprite --trust                    # skip bash confirmations
sprite --model <id>               # pick the model (default: claude-haiku-4-5)
```

`--model` only takes Claude models — see the [model overview](https://platform.claude.com/docs/en/about-claude/models/overview) for valid API strings. You can also set `SPRITE_MODEL` in your environment.

First launch will ask for an Anthropic API key. It's saved to `~/.config/sprite/config.json` (or set `ANTHROPIC_API_KEY` to skip the prompt).

## In the prompt

- `↑ / ↓` — recall previous prompts
- `Shift+Tab` — toggle plan mode (read-only; propose a plan for approval before editing)
- `Esc` — clear the input; if a turn is running, cancel it
- `Ctrl+O` — expand/collapse tool output in the transcript
- `Ctrl+A / E / U` — start of line, end of line, clear line
- `! <command>` — run a shell command yourself; output shows inline, no tokens spent
- `@path/to/file` — the file's contents are inlined when you submit
- Multi-line pastes collapse to `[Pasted #1 N lines]` and expand on submit
- Typing while a turn runs is fine — `Enter` queues one follow-up for when it finishes
- `/clear` — reset the conversation
- `/compact` — summarize the conversation so far and keep going with just the summary in context
- `/model` — pick a model for the rest of the session (or `/model <id>` to switch directly)
- `/logout` — forget the saved API key
- `exit` — quit

## Custom commands

Drop a markdown file in `./.sprite/commands/` (project) or `~/.config/sprite/commands/` (global) and it becomes a `/command`. The file's body is sent as the prompt; `$ARGS` is replaced with whatever you type after the command name. Project commands shadow global ones of the same name.

```
./.sprite/commands/review.md   →   /review [args]
```

## Project context

sprite reads `AGENTS.md`, `AGENT.md`, and `CLAUDE.md` from the current directory, every parent up to the git root, and `~/.config/sprite/` (global). Whatever it finds is appended to the system prompt, so you can tell it how your project works once and it'll remember.

## Permissions

Shell commands prompt for confirmation before running. Choosing "always" remembers the command prefix for this project (stored in `~/.config/sprite/projects.json`, keyed by directory so a cloned repo can't pre-seed its own allowlist). Commands containing shell operators (`;`, `|`, `$(` …) always prompt. `--trust` skips all of it.

Edits are confined to the git root (or cwd if there isn't one); paths outside it are refused.

Bash runs with a narrowed environment by default — `PATH`, `HOME`, `USER`, `SHELL`, locale, `TZ`, `TERM`, temp-dir vars. Project secrets in your shell (`ANTHROPIC_API_KEY`, `*_TOKEN`, `DATABASE_URL`, etc.) aren't forwarded, so the model can't exfiltrate them by running `env` or expanding `$VAR` inside an approved command. Widen as needed:

- `--trust` — full env (paired with skipping confirmations; use when you already trust the agent).
- `SPRITE_EXPOSE_ENV=NODE_ENV,DATABASE_URL sprite` — forward just the listed vars, keep the rest hidden.
- `SPRITE_FULL_ENV=1 sprite` — forward everything without `--trust`'s other effects.

## As a library

sprite exports its loop. There's no build step — consume it with a TS-aware runtime (`tsx`, `bun`, `ts-node`):

```ts
import { runTurn, headlessContext, loadApiKey } from "sprite";

await runTurn(loadApiKey()!, [], "explain this repo",
  headlessContext({ trust: true }),
  (e) => { if (e.type === "text") process.stdout.write(e.text); },
);
```

`runTurn` emits `text`, `tool_use`, `tool_result`, `usage`, and `done` events; it returns the updated message history so you can pass it back in for the next turn. `headlessContext()` denies unapproved bash by default — pass `trust: true` or your own `onBash` to change that.

## Storage

```
~/.config/sprite/
  config.json        API key
  projects.json      per-directory bash allowlists
  AGENTS.md          global instructions (optional)
  commands/*.md      global custom /commands (optional)
  sessions/<dir>/    conversation history, one JSONL per session
```

## Dev

```sh
npm start        # run from source
npm run typecheck
```

## References

- [How to Build an Agent](https://ampcode.com/notes/how-to-build-an-agent)
- [The Emperor Has No Clothes](https://www.mihaileric.com/The-Emperor-Has-No-Clothes/)
