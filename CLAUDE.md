# sprite

A CLI coding agent — an LLM in a loop with four file tools. It works in whatever directory you run it from.

## Architecture

1. Read user input
2. Send history + tool definitions to Claude
3. If the response has `tool_use` blocks, execute them locally, append `tool_result`s
4. Repeat 2–3 until Claude stops calling tools
5. Print the response; go to 1

The model never touches the filesystem — it requests, the loop executes.

## Stack

TypeScript/Node (ESM), `@anthropic-ai/sdk`, `ink`+React for the TUI.

- Run: `npm start`
- Typecheck: `npm run typecheck`

## Layout

- `src/cli.tsx` — entry; routes to `<App />` or headless `runPrint()`
- `src/ui/` — Ink/React components
  - `App.tsx` — top-level state, slash commands, event loop wiring
  - `Line.tsx` — renders one transcript row; owns `DisplayLine`
  - `Markdown.tsx` — marked→Ink renderer for assistant text
  - `PromptInput.tsx` — input: cursor, history, bracketed paste
  - `Header.tsx`, `BashConfirm.tsx`, `Login.tsx`
- `src/agent.ts` — `runTurn()` loop, system prompt, `/compact`, `@path` expansion
- `src/tools.ts` — the four tools + 50 KB output cap
- `src/print.ts` — `-p` one-shot mode
- `src/session.ts` — JSONL persistence under `~/.config/sprite/sessions/`
- `src/config.ts` — API key + per-project bash allowlist

See README.md for user-facing flags and commands.

## Tools

`read_file`, `list_files`, `edit_file`, `bash`. Four, no more — anything else goes through `bash` or a script the model writes.

## Permissions

`bash` prompts for confirmation; "always" saves a prefix to `~/.config/sprite/projects.json` keyed by absolute cwd (so a cloned repo can't pre-seed its own allowlist). Commands with shell operators always prompt. `--trust` skips it all. When touching this path, err toward more confirmation, not less.

## Principles

- Keep the loop small. Complexity belongs in tool implementations, not orchestration.
- Tool descriptions are load-bearing — the model reasons from them. Write them with care.
- The client owns conversation state; resend the full history every turn.
- No agent framework. If you reach for one, reread the references.

## References

- https://ampcode.com/notes/how-to-build-an-agent
- https://www.mihaileric.com/The-Emperor-Has-No-Clothes/
