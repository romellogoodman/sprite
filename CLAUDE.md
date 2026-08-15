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
- Test: `npm test` (tools, config, session, agent helpers, completion)
- Probe: `npm run probe` — real-API behavior battery (tool calls, caching, thinking); reports to `docs/probes/`

## Layout

- `src/cli.tsx` — entry; routes to `<App />`, stdin pipe, or headless `runPrint()`
- `src/index.ts` — library entry for `import { runTurn } from "sprite"`
- `src/agent.ts` — `runTurn()` loop, system prompt, `/compact`, `@path` expansion, `AgentEvent`
- `src/tools.ts` — tool defs + execution, `ToolContext`, `headlessContext()`, 50 KB output cap
- `src/commands.ts` — custom `/command` loader (`.sprite/commands/*.md`)
- `src/models.ts` — model catalog for the picker and context-window lookup
- `src/print.ts` — `-p` one-shot mode
- `src/session.ts` — JSONL persistence under `~/.config/sprite/sessions/`, cross-session notes under `~/.config/sprite/notes/`
- `src/config.ts` — API key + per-project bash allowlist
- `src/completion.ts`, `src/poem.ts` — typeahead matches, spinner phrases
- `src/probe.ts` — `npm run probe`; model-behavior reports to `docs/probes/` (ported from lca)
- `src/ui/theme.ts` — all TUI colors (brand/mode accents/warn) in one place
- `src/ui/` — Ink/React components
  - `App.tsx` — top-level state, slash commands, event loop wiring; owns the single `accent` color shared by the prompt caret and the status line below the input (renders "plan mode" and, only at 60%+, context %; always one row so it can't jump the layout)
  - `Line.tsx` — renders one transcript row; owns `DisplayLine`
  - `Markdown.tsx` — marked→Ink renderer for assistant text
  - `PromptInput.tsx` — input: cursor, history, bracketed paste
  - `Header.tsx` — frozen masthead, no live props. Rendered once as item 0 of the transcript `<Static>` so it prints at the top and scrolls away. Do NOT add live state here (context %, mode) — Ink would repaint it every turn and it'd walk down the page; live status belongs in `App.tsx` below the input
  - `BashConfirm.tsx`, `NoteConfirm.tsx`, `Login.tsx`, `ModelPicker.tsx`, `QuestionPrompt.tsx`, `PlanApproval.tsx`

See README.md for user-facing flags and commands.

## Tools

Capability tools: `read_file`, `list_files`, `edit_file`, `bash`, `fetch_url`. Control-flow tools: `ask_user_question` (multi-choice, always available), `exit_plan_mode` (plan mode only), `save_note` (confirmation-gated; writes to `~/.config/sprite/notes/` so `edit_file` can't reach it and a cloned repo can't pre-seed it). Keep the capability set small — additions need a real reason, not just convenience. Most new capabilities should go through `bash` or a script the model writes. Evaluate proposals on their merits; don't refuse reflexively.

## Permissions

Three modes, cycled with shift+tab (`default → plan → auto`): the caret stays `❯`; the mode reads from the accent color (cyan/magenta/green) and the status line. Plan mode refuses `edit_file` and non-read-only `bash`; the turn ends with `exit_plan_mode(plan)` which prompts for approval and drops back to `default`. The mode is read live via `ctx.getMode()` so mid-turn flips apply to the next tool call. `modeReminder` injects a plan-mode notice for the model; `auto` injects nothing — the model never learns it's in auto mode, because auto only changes execution gating, not what the model should do.

`bash` prompts for confirmation; "always" saves a prefix to `~/.config/sprite/projects.json` keyed by absolute cwd (so a cloned repo can't pre-seed its own allowlist). Commands with shell operators always prompt. `--trust` skips it all. When touching this path, err toward more confirmation, not less.

`edit_file` writes inside the workspace (the git root) run silently. Writes outside prompt with the same `y/a/n` shape — "always" saves the suggested directory to `allowWrite` in the same `projects.json`. The suggested dir is the shallowest non-existing ancestor of the target (the root of a project being scaffolded), falling back to the immediate parent. Sprite's own config dir is a hard refusal that `--trust`, the allowlist, and "always" can't override — the allowlist writer itself refuses to persist a prefix that would cover CONFIG_DIR, and the write path refuses it again even if somehow stored. Headless refuses out-of-tree writes (no confirmation channel); pass `onWrite` to `headlessContext` to handle it yourself.

Auto mode (`classifyCommand` in `agent.ts`, wired as `ctx.classifyBash`) trades the bash prompt for a classifier: for a command that isn't `--trust`'d or already allowlisted, one pinned-haiku call judges it irreversible/destructive/exfiltrating. Safe → runs silently; flagged → falls back to the normal confirmation prompt carrying the reason (never a silent run, never a hard refusal). Missing/failed/unparseable classifier ⇒ flagged, so it degrades toward the human. The classifier reads the same project context (`loadProjectContext`) the main loop does, so a "never force-push" line in CLAUDE.md steers it too. Headless (`headlessContext`) pins mode to `default`, so auto is a TUI-only path today.

Bash is spawned with a narrow env whitelist by default (`SAFE_ENV_KEYS` in `tools.ts`) — PATH/HOME/locale/etc., no secrets. `--trust` or `SPRITE_FULL_ENV=1` forwards `process.env`; `SPRITE_EXPOSE_ENV=VAR1,VAR2` widens just those vars. Closes the "model runs `env | grep KEY`" and "approved-prefix with `$VAR` expansion" exfil paths.

`read_file`/`list_files` are confined to the workspace, symlink-aware (`assertReadable`) — reads stay strictly in-tree because an exfil read into the transcript is silent damage, whereas an out-of-tree write at least passes through a visible confirmation. `fetch_url` refuses private/loopback/link-local addresses via a DNS-pinned lookup so the checked address is the connected address, re-applied on every redirect hop (`ssrfLookup`). The escape hatch for reads is `bash` — it has the confirmation gate. These close the "prompt injection in a cloned README reads `~/.ssh/` or hits the cloud metadata endpoint" exfil paths.

## Prompt caching

`runTurn` sets three cache breakpoints per request (see `cachedSystem`/`cachedTools`/`withCacheMarker` in agent.ts): the last tool def, the system block, and the final content block of the last message — the moving marker means the whole growing history re-reads from cache each round-trip. The mode reminder is injected into the user message, not the system prompt, so shift+tab flips don't bust the cache. The tool list (`TOOLS`) is the same in every mode for the same reason — tools are the *first* segment of the prefix, so a mode-dependent list would invalidate tools, system, and every message on the flip; `exit_plan_mode` stays listed and is refused at execution outside plan mode. Don't add anything per-turn-variable to the system prompt or tool defs.

## Principles

- Keep the loop small. Complexity belongs in tool implementations, not orchestration.
- Tool descriptions are load-bearing — the model reasons from them. Write them with care.
- The client owns conversation state; resend the full history every turn.
- No agent framework. If you reach for one, reread the references.
- **Twin sync**: local-coding-agent (`../local-coding-agent`) is sprite's Ollama twin. The
  security-critical code is duplicated, not shared — the SSRF guard + private-address
  ranges, the bash env whitelist (`SAFE_ENV_KEYS`), the config-dir hard refusal, and the
  untrusted fetch-content footer in `tools.ts`. When touching any of these, check whether
  the same change belongs in lca, and vice versa. A drift here is a real security risk.

## References

- https://ampcode.com/notes/how-to-build-an-agent
- https://www.mihaileric.com/The-Emperor-Has-No-Clothes/
