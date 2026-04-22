# sprite

A CLI coding agent — an LLM in a loop with file tools.

## Architecture

Core loop:
1. Read user input
2. Send conversation history + tool definitions to Claude
3. If the response contains `tool_use` blocks, execute them locally and append `tool_result` blocks to the conversation
4. Repeat 2–3 until Claude responds without tool calls
5. Print the response; go to 1

The model never touches the filesystem directly — it requests, the loop executes.

## Tools

- `read_file(path)` — return file contents
- `list_files(path?)` — return directory listing
- `edit_file(path, old_str, new_str)` — string-replace edit; creates the file if it doesn't exist
- `bash(command)` — run a shell command (120s timeout)

Four tools, no more. Anything else sprite needs, it can do via `bash` or by writing a script into the project. All tool output is capped at 50 KB (head + tail) before it reaches the model.

## Stack

- TypeScript / Node (ESM)
- `@anthropic-ai/sdk` for the model
- `ink` + `react` for the terminal UI
- Run: `npm start` (via `tsx`)
- Typecheck: `npm run typecheck`

## Layout

- `bin/sprite.mjs` — global-link shim (spawns local `tsx` with project tsconfig)
- `src/cli.tsx` — entry point; routes to `<App />` or `runPrint()` based on flags
- `src/App.tsx` — Ink UI: login screen, conversation view, slash-command handling
- `src/PromptInput.tsx` — custom input: cursor, ↑/↓ history, bracketed paste
- `src/agent.ts` — `runTurn()` model↔tool loop; system prompt; `compactHistory()`; `@path` expansion
- `src/tools.ts` — tool schemas + `executeTool()` with output capping
- `src/print.ts` — headless one-shot runner for `-p`
- `src/session.ts` — JSONL save/load under `~/.config/sprite/sessions/`
- `src/config.ts` — API key + bash allowlist persistence

## CLI flags

- `-p "<prompt>"` / `--print` — run one turn non-interactively; assistant text → stdout, tool activity → stderr
- `-c` / `--continue` — resume the most recent session for this directory
- `--trust` — skip bash confirmations

## Slash commands

- `/clear` — drop history, start a fresh session file
- `/compact` — summarize the conversation into one message and continue from that
- `/logout` — clear the saved API key

## System prompt

`buildSystemPrompt()` assembles, in order:
1. The hard-coded base persona
2. An environment block (cwd + today's date)
3. Project instructions from `AGENTS.md` / `AGENT.md` / `CLAUDE.md`, gathered from `~/.config/sprite/` (global) then each directory from the git root down to cwd. Duplicate contents are de-duped; later sections are more specific and take precedence.

This is rebuilt per turn, so editing `CLAUDE.md` mid-session takes effect on the next message (at the cost of a prompt-cache miss when it changes).

## Input handling

`PromptInput` enables bracketed paste (`\x1b[?2004h`), buffers between `[200~ … [201~`, and collapses multi-line pastes to a `[Pasted #n N lines]` token that's expanded on submit. `@path` tokens in the submitted text are replaced with the referenced file's contents inside `runTurn()`.

## Sessions

Every interactive run writes `history` to `~/.config/sprite/sessions/<dirname-hash>/<timestamp>.jsonl` after each turn (full rewrite, not append — keeps the file a consistent snapshot). `-c` loads the newest file for the current directory; `/clear` starts a new one.

## Auth

Key resolution order: `ANTHROPIC_API_KEY` env → `~/.config/sprite/config.json`. If neither is set, sprite shows a login prompt on launch and saves the key (mode 0600). `/logout` clears it.

## Permissions

`bash` commands prompt for confirmation (`[y]` once / `[a]` always / `[n]` deny). "Always" saves a command prefix to `~/.config/sprite/projects.json`, keyed by the project's absolute path — the allowlist lives in the user's home, not the repo, so a cloned project can't pre-seed its own permissions. Commands containing shell operators (`;`, `&&`, `|`, `$(`, etc.) always prompt regardless of the allowlist. `sprite --trust` skips all confirmations.

## Principles

- Keep the loop small. Complexity belongs in tool implementations, not orchestration.
- Tool descriptions are load-bearing — the model reasons from them. Write them with care.
- The client owns conversation state; resend the full history every turn.
- No agent framework. If you reach for one, reread the references.

## References

- https://ampcode.com/notes/how-to-build-an-agent
- https://www.mihaileric.com/The-Emperor-Has-No-Clothes/
