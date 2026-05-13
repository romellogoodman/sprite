# sprite

A CLI coding agent — an LLM in a loop with a handful of tools. It works in whatever directory you run it from.

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

- `src/cli.tsx` — entry; routes to `<App />`, stdin pipe, or headless `runPrint()`
- `src/index.ts` — library entry for `import { runTurn } from "sprite"`
- `src/agent.ts` — `runTurn()` loop, system prompt, `/compact`, `@path` expansion, `AgentEvent`
- `src/tools.ts` — tool defs + execution, `ToolContext`, `headlessContext()`, 50 KB output cap
- `src/commands.ts` — custom `/command` loader (`.sprite/commands/*.md`)
- `src/models.ts` — model catalog for the picker and context-window lookup
- `src/print.ts` — `-p` one-shot mode
- `src/session.ts` — JSONL persistence under `~/.config/sprite/sessions/`
- `src/config.ts` — API key + per-project bash allowlist
- `src/completion.ts`, `src/poem.ts` — typeahead matches, spinner phrases
- `src/ui/` — Ink/React components
  - `App.tsx` — top-level state, slash commands, event loop wiring
  - `Line.tsx` — renders one transcript row; owns `DisplayLine`
  - `Markdown.tsx` — marked→Ink renderer for assistant text
  - `PromptInput.tsx` — input: cursor, history, bracketed paste
  - `Header.tsx`, `BashConfirm.tsx`, `Login.tsx`, `ModelPicker.tsx`, `QuestionPrompt.tsx`, `PlanApproval.tsx`

See README.md for user-facing flags and commands.

## Tools

Capability tools: `read_file`, `list_files`, `edit_file`, `bash`, `fetch_url`. Control-flow tools: `ask_user_question` (multi-choice, always available), `exit_plan_mode` (plan mode only). Keep the capability set small — additions need a real reason, not just convenience. Most new capabilities should go through `bash` or a script the model writes. Evaluate proposals on their merits; don't refuse reflexively.

## Permissions

Two modes, cycled with shift+tab: `default` and `plan`. Plan mode refuses `edit_file` and non-read-only `bash`; the turn ends with `exit_plan_mode(plan)` which prompts for approval and drops back to `default`. The mode is read live via `ctx.getMode()` so mid-turn flips apply to the next tool call.

`bash` prompts for confirmation; "always" saves a prefix to `~/.config/sprite/projects.json` keyed by absolute cwd (so a cloned repo can't pre-seed its own allowlist). Commands with shell operators always prompt. `--trust` skips it all. When touching this path, err toward more confirmation, not less.

Bash is spawned with a narrow env whitelist by default (`SAFE_ENV_KEYS` in `tools.ts`) — PATH/HOME/locale/etc., no secrets. `--trust` or `SPRITE_FULL_ENV=1` forwards `process.env`; `SPRITE_EXPOSE_ENV=VAR1,VAR2` widens just those vars. Closes the "model runs `env | grep KEY`" and "approved-prefix with `$VAR` expansion" exfil paths.

`read_file`/`list_files` are confined to the workspace like `edit_file`, symlink-aware (`assertReadable`). `fetch_url` refuses private/loopback/link-local addresses via a DNS-pinned lookup so the checked address is the connected address, re-applied on every redirect hop (`ssrfLookup`). Both escape hatches are `bash` — it has the confirmation gate. These close the "prompt injection in a cloned README reads `~/.ssh/` or hits the cloud metadata endpoint" exfil paths.

## Principles

- Keep the loop small. Complexity belongs in tool implementations, not orchestration.
- Tool descriptions are load-bearing — the model reasons from them. Write them with care.
- The client owns conversation state; resend the full history every turn.
- No agent framework. If you reach for one, reread the references.

## References

- https://ampcode.com/notes/how-to-build-an-agent
- https://www.mihaileric.com/The-Emperor-Has-No-Clothes/
