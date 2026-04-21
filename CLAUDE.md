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

Four tools, no more. Anything else sprite needs, it can do via `bash` or by writing a script into the project.

## Stack

- TypeScript / Node (ESM)
- `@anthropic-ai/sdk` for the model
- `ink` + `react` for the terminal UI
- Run: `npm start` (via `tsx`)
- Typecheck: `npm run typecheck`

## Layout

- `bin/sprite.mjs` — global-link shim (spawns local `tsx` with project tsconfig)
- `src/cli.tsx` — entry point, renders `<App />`
- `src/App.tsx` — Ink UI: login screen, conversation view, input prompt
- `src/agent.ts` — `runTurn()`: the model ↔ tool loop
- `src/tools.ts` — tool schemas + `executeTool()`
- `src/config.ts` — API key persistence at `~/.config/sprite/config.json`

## Auth

Key resolution order: `ANTHROPIC_API_KEY` env → `~/.config/sprite/config.json`. If neither is set, sprite shows a login prompt on launch and saves the key (mode 0600). `/logout` clears it.

## Principles

- Keep the loop small. Complexity belongs in tool implementations, not orchestration.
- Tool descriptions are load-bearing — the model reasons from them. Write them with care.
- The client owns conversation state; resend the full history every turn.
- No agent framework. If you reach for one, reread the references.

## References

- https://ampcode.com/notes/how-to-build-an-agent
- https://www.mihaileric.com/The-Emperor-Has-No-Clothes/
