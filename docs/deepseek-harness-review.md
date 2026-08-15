# What sprite can take from DeepSeek Harness

*2026-08-15 · reviewing `~/code/deepseek-harness` at `47f943859b` (0.1.0-rc.5, MIT, "developer preview")*

DeepSeek Harness (`dsh`) is a plugin-based agent harness: ~198k lines of TypeScript across 1,185 source files, 219 packages in 49 groups, all on a vendored DI framework (Cordis) where "everything is a plugin." It ships a Web UI, a headless one-shot runner, an ACP server, a JSON-RPC SDK, and a Python SDK. It does **not** ship a TUI. Its default bundle mounts roughly 25 model-visible tools; sprite has 8.

So the answer to "what can we bring in" is not the architecture. It's a short list of mechanisms, prompt text, and two security fixes that dsh's patterns exposed in sprite. Almost everything below is under 150 lines. Every claim has a `file:line` pointer into the checkout so you can verify it.

## TL;DR

| | What | Cost | Why |
|---|---|---|---|
| **Fix** | `edit_file` follows in-repo symlinks out of the workspace — and into `~/.config/sprite/` (verified, §1.1) | ~15 lines | Real bypass of the config-dir hard refusal. Same fix belongs in lca. |
| **Fix** | Mode-dependent tool list busts the whole prompt cache on shift+tab (§1.2) | 1 line | You already refuse `exit_plan_mode` at execution; the filter is redundant and expensive. |
| **Adopt** | Seatbelt (`sandbox-exec`) confinement for bash on macOS (§3.1) | ~50 lines | Kernel-enforced write confinement; the highest-leverage security idea in the repo. |
| **Adopt** | `/compact` as a cache-prefix request + middle-prune old tool results first (§2.4, §2.5) | ~40 lines | Compaction currently re-bills the whole history at full price. |
| **Adopt** | dsh's plan-mode prose; bash `description`/`workdir` params; repeat-tool reminder (§2.1–2.3) | ~60 lines | Prompt text is the cheapest thing to steal and theirs is better on a few points. |
| **Consider** | Background bash jobs, skills, hooks, keyless replay tests (§3) | ~120–150 lines each | Real reasons exist for each; none is urgent. |
| **Skip** | Cordis, Web UI, subagents, workflows, ralph, goals, code mode, ACP, Landlock (§4) | — | Wrong scale for a 5.7k-line tool. |

## What dsh is, and where sprite is already ahead

dsh's design center is a **session log that is the source of truth**: every model-visible thing is a durable event, `deriveMessages()` projects the request from the log, and an invariant asserts the outgoing request equals the projection (`packages/core/agent-loop/src/invariant.ts:19-55`). Compaction, resume, fork, and tool-result pruning are all "replace a span of the log's surface." Its permission model is the other big idea: **no command allowlist, no prefix matching, no classifier** — commands run inside a kernel sandbox (Landlock / bwrap / Seatbelt), and when the kernel denies a write the model gets a marker and a one-shot escalation path that raises the human prompt (`packages/sandbox/sandbox/src/escalation.ts:72,85`).

Being honest about the comparison, sprite is ahead in several places:

- **`fetch_url` ships with SSRF protection.** dsh ships `web_fetch` *disabled* — its own comment: "that provider defers SSRF protection and the model would choose the request target" (`packages/bundle/base/cordis.patch.yml:397-403`; `packages/web/web-fetch-http/src/provider.ts:6-7`). Sprite's DNS-pinned, per-hop check is strictly stronger.
- **Env allowlist beats their denylist.** dsh scrubs `/KEY|PASSWORD|SECRET|TOKEN/i` (`packages/subprocess/subprocess/src/index.ts:44`), which misses `DATABASE_URL`, `GH_PAT`, `NPM_AUTH`, `SSH_AUTH_SOCK`. Keep `SAFE_ENV_KEYS`.
- **Read confinement.** dsh reads anything in every sandbox mode; its own `~/.dsh/.credentials.yaml` is readable by any confined command (only a `chmod 600` startup check protects it, `packages/credentials/credentials-local/src/index.ts:103-122`). Sprite's git-root read confinement and config-dir refusal have no dsh equivalent.
- **Mode reminder in the user message.** dsh's plan-mode section is a system-prompt section at order 50, so entering/leaving plan mode invalidates the prefix from there on (`packages/plan/plan-mode/README.md`, "KV Cache effect"). Sprite's `modeReminder` in the user turn is the better design — with the one exception in §1.2.
- **Custom `/commands` from markdown.** dsh has none; every command is a plugin.
- **`npm run probe`** has no dsh analogue (they have regression replay, not exploratory probing — see §3.6).
- Process-tree kill, 0600 spill files, tail-keep truncation, the untrusted-content footer on fetched pages, `read_file` naming the next offset, dedup of identical `CLAUDE.md`/`AGENTS.md` — all already in sprite.

---

## 1. Fix now

*Status: both fixed on 2026-08-15 — `canonicalPath()` on the read/write checks in `src/tools.ts`, and a mode-independent `TOOLS` list. Regression tests in `src/tools.test.ts`.*

### 1.1 `edit_file` follows in-repo symlinks out of the workspace (verified)

`assertReadable` realpaths before checking (`src/tools.ts:82`), but `editFile` checks and writes the lexical `path.resolve(relPath)` (`src/tools.ts:670-679`). `assertNotConfigDir` and `isInWorkspace` both run on that lexical path. Git stores symlinks, so a cloned repo can ship one.

Repro (scratch config dir via `SPRITE_CONFIG_DIR`, `headlessContext()` with `trust: false`):

```
repo/cfg -> $SPRITE_CONFIG_DIR       # committed symlink
repo/out -> /somewhere/outside

edit_file cfg/projects.json  (old_str: "")  → "Created cfg/projects.json"   # written into the config dir, no prompt
edit_file out/pwned.txt      (old_str: "")  → "Created out/pwned.txt"       # written outside the workspace, no prompt
```

That's the same threat model the read confinement already defends against (prompt injection in a cloned README), and it defeats the one guarantee CLAUDE.md calls a "hard refusal" — a model could rewrite `projects.json` to allowlist itself.

The dsh pattern (`packages/fs/fs-sandbox/src/index.ts:122-148`, `packages/sandbox/sandbox/src/roots.ts:26-36`):

1. Canonicalize **immediately before the syscall** — realpath the deepest existing ancestor, re-append the missing tail, and if the final component exists and is a symlink, realpath it too.
2. Run both checks (`assertNotConfigDir`, `isInWorkspace` against `WORKSPACE_REAL`) on the canonical path.
3. **Write to the canonical path**, not the original string — "no check-here-write-there TOCTOU."
4. Use `fs.realpathSync.native`, not `fs.realpathSync`: the JS implementation collapses `..` lexically before resolving a preceding symlink; the native one walks component-by-component like the kernel does. (This one applies to `assertReadable` and `WORKSPACE_REAL` too.)

**Twin sync:** lca's write path needs the same check.

### 1.2 The mode-dependent tool list busts the prompt cache

`toolsForMode` drops `exit_plan_mode` outside plan mode (`src/tools.ts:117-120`), and `runTurn` sends `cachedTools(toolsForMode(ctx.getMode()))` (`src/agent.ts:600`). Tools are the first segment of Anthropic's cached prefix; changing them invalidates tools, system, *and* every message. So each shift+tab into or out of plan mode re-bills the entire history at uncached rates on the next request.

You already refuse the call at execution time — `src/tools.ts:516`: "exit_plan_mode can only be called while plan mode is active." dsh made the same call deliberately: "exit_plan_mode stays in the model-facing schema while planning is inactive so transitions add no tool-catalog churn" (`docs/tool-catalog.md`, `packages/plan/plan-mode/src/index.ts:16-19`), and it tells the model why in the plan prompt: "The tool catalog stays the same across modes for request-cache stability."

Fix: always send `ALL_TOOLS`; keep the description's "Only available in plan mode." Add a line to CLAUDE.md's prompt-caching section so it doesn't come back.

---

## 2. Quick wins (an hour or less each, no new tools)

### 2.1 Plan-mode prose

dsh's plan section (`packages/bundle/base/cordis.patch.yml:264-280`; also `apps/cli/config/agent-presets/standard/agent.cordis.yml:113-128`) is the best-written prompt text in the repo. Sprite's `modeReminder` (`src/agent.ts:74-83`) covers most of it; four sentences are worth lifting:

> A user's conversational agreement — including an answer confirming something you asked — approves nothing and does not end plan mode; fold the confirmed decision into the plan and submit it through exit_plan_mode.

> Imperative language to implement changes means plan the implementation, not execute it.

> Resolve discoverable facts by inspection. Use ask_user_question only for user-owned choices or material ambiguity that inspection cannot answer. Do not ask the user where code lives or how current behavior works when you can find out.

> Make exit_plan_mode the only and final tool call in that assistant response … If review rejects it, incorporate the feedback and present again. If the review channel is unavailable or aborted, stay in plan mode and ask the user to switch modes manually; do not proceed with implementation.

The first closes the most common plan-mode leak (model asks "shall I?", user says "yes", model starts editing). Two small mechanics from `packages/plan/plan-mode/src/index.ts`: require the plan to start with a `# heading` (`:328`, `/^#\s+\S/`), and treat "Approve + free-text feedback" as *not* approval (`:370`). Also worth adding: when the user flips modes, inject one line — "The user switched this session to plan mode." / "…back to the default mode." (`:462-473`) — so the model isn't confused by a silent mid-conversation change.

### 2.2 `bash`: `description` and `workdir` params, and the exit-code line

`packages/shell/tool-bash/src/index.ts:245-272`:

- `description` (required): "Clear, concise description of what this command does in active voice, 5-10 words (shown in the UI). Examples: `ls` → `List files in current directory`; `git status` → `Show working tree status`." — costs a few tokens; buys a readable transcript and a confirmation prompt that says what the command is *for*. `BashConfirm` could show it above the command.
- `workdir`: "Working directory for this command. Defaults to the session workspace; a relative path is resolved against it." — plus the description sentence "Each call runs in a fresh shell: no state (cwd, variables, functions) persists between calls — pass `workdir` instead of using `cd`."
- Prompt-section line (`:235-240`): "Check the [exit code: N] marker on every bash result; investigate failures before moving on."

Also from the bash description: "Only what you print or return comes back — curate it" (their `run_code` framing, `packages/core/tools/src/code-mode.ts:47-53`) is a good line to borrow for `bash` — it nudges the model to filter in the pipeline rather than dump full output.

### 2.3 Repeat-tool reminder

`packages/guard/repeat-tool-reminder/` — advisory only, never blocks. Key = `(tool name, deep-key-sorted JSON of args)`; consecutive-run thresholds `[3, 5, 8]`; first threshold gets a short nudge, later ones name the tool, run length, and args (head-truncated at 500 chars) and say:

> The repeated calls are not making progress. Do not call this tool with these exact arguments again. Inspect the latest result and choose a different action, different arguments, or finish the task if enough evidence has been gathered.

Three non-obvious rules that make it work (`README.md`): **denied/errored calls count** (a model hammering a denied command is exactly the loop to break); a **new user message resets** the chain; the args in the reminder are **capped, but the key uses the full string**. In sprite this is a `Map` in `runTurn` and a string appended to the tool result — ~40 lines.

### 2.4 `/compact` as a cache-prefix request

`compactHistory` (`src/agent.ts:452-490`) sends `system: COMPACT_PROMPT`, no tools, and the head — a fresh request, so the entire summarized span is billed uncached. dsh's summarizer replays *the conversation's own* system prompt and tool schemas, then the messages, then the compaction instruction **as the final user message** (`packages/compaction/compaction-basic/src/summarizer.ts:24-30, 145-163`), so the request is a byte-for-byte prefix of the last routed request and reuses whatever the provider still has cached. On Anthropic that means: same `cachedTools`, same `cachedSystem`, `head` verbatim, then `{role:"user", content: COMPACT_INSTRUCTION}` with the cache marker on it. This is a reorder, not a rewrite.

Three prompt details from their instruction (`summarizer.ts:31-66`) worth adding to `COMPACT_PROMPT`:

- "If the conversation already contains a `<compacted-summary>` block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary" — stops summaries accreting like sediment on the second and third `/compact`.
- "Do NOT mention this summarization request or that the context was compacted."
- A singular `## Next Step` section, forced to `(none)` if absent, so the resumed model doesn't re-plan.

And a guard: reject the compaction if the framed summary isn't strictly smaller than what it replaces (`region.ts:373-378`).

### 2.5 Middle-prune old tool results before calling the summarizer

`packages/compaction/compaction-tool-result-pruner/` runs *before* the LLM summarizer: any tool result in history over 8,192 chars becomes `head(4,096) + "\n\n[... tool result middle pruned ...]\n\n" + tail(1,024)`, sliced by code point (no split surrogates), then the context is re-measured — if that alone gets under threshold, no model call happens. Sprite's 50 KB cap is applied at capture; this is applied retroactively to results already in context, which is where the tokens actually pile up. It's cache-destructive from the first pruned message, so do it only inside the compaction path (which is already destructive). ~30 lines.

While in there: dsh's cut rule is "anywhere the count of open tool calls is 0" (`packages/compaction/compaction/src/tool-pairing.ts:29-38`) rather than "a real user turn." Sprite's `isUserTurnStart` cut is safe but coarse; the tool-pairing rule is finer-grained and equally safe.

### 2.6 Keep volatile facts out of the system prompt

`buildEnvironment` puts today's date in the system prompt (`src/agent.ts:205-208`) — the one per-day-variable thing in the cached system block. dsh emits volatile context (time, policy state, tmux pane) as a self-superseding **user-role snapshot, only when the rendered text changes**, prefixed "Current runtime context. This snapshot supersedes earlier runtime-context snapshots." (`packages/core/agent-loop/src/runtime-context.ts:13, 62-76`). Sprite already has the slot for this — the `modeReminder` tag in the user message. Move the date there. Their `time-context` also adds one line worth stealing: "Elapsed since the preceding model-visible message: 2m 14s" (`packages/context/time-context/src/index.ts:110-125`) — tells the model how long the user was away.

### 2.7 `fetch_url` transport hygiene

Sprite wins on the SSRF core; dsh's `validateFetchUrl` (`packages/web/web-fetch-http/src/policy.ts:24-41`) and provider (`provider.ts:56-207`) have a few checks a naive fetcher misses:

- Reject URLs with embedded credentials (`url.username || url.password`) — closes `https://evil.com@internal.host/`.
- Refuse **cross-origin** redirects instead of following them ("retry against that URL directly"), so each new origin is a fresh tool call and a fresh policy decision. Composes with the per-hop IP pin.
- Content-type allowlist (`text/*`, `application/json|xml`, `*+json`, `*+xml`) and charset-aware decoding; unknown charset is a hard error, not mojibake.
- Enforce the size cap on the stream, not just `Content-Length` (the header is attacker-controlled).

### 2.8 Distinct denial strings

dsh maps each non-grant outcome to different model-facing text — user rejected vs. cancelled vs. no approval channel available (`packages/core/tools/src/index.ts:1712-1726`). Sprite's `"Command denied by user."` covers the first; `headlessContext` denials read the same. Models react differently and correctly to "the human said no" vs. "there is no one to ask" — cheap to distinguish.

---

## 3. Worth a day each

### 3.1 Seatbelt confinement for bash (macOS)

The single most portable thing in the repo for sprite. dsh probes `bwrap → landlock` on Linux and uses `sandbox-exec` on macOS (`packages/sandbox/sandbox-local/src/index.ts:159-166`); the whole macOS profile is (`profiles.ts:51-58`):

```
(version 1)
(allow default)
(deny file-write*)
(allow file-write* (literal "/dev/null"))
(allow file-write* (subpath "<realpath cwd>") (subpath "/private/tmp") (subpath "<realpath os.tmpdir()>"))
```

with roots canonicalized via `realpathSync.native` because `/tmp` *is* `/private/tmp` on darwin and an as-spelled grant matches nothing (`packages/sandbox/sandbox/src/roots.ts:26-55`). A one-time functional probe runs the real profile around `true` and caches the verdict; if `sandbox-exec` is unusable it **fails closed** rather than running unconfined (`sandbox-local/src/index.ts:85-91`; Apple marks the CLI deprecated but ships it on every macOS). Denial shows up as `operation not permitted` on stderr; dsh appends `[sandbox: file access denied under <mode> mode]` so the model reads it as policy, not a bug (`sandbox/src/escalation.ts:72`).

For sprite this doesn't reduce confirmation — it adds enforcement under it. Two ways to use it, in order of ambition:

1. **Defense in depth.** Run every bash command (approved, allowlisted, `--trust`, auto-mode-cleared) under the workspace-write profile. An approved `npm test` still can't write to `~/.ssh`. ~50 lines, no UX change, consistent with "err toward more confirmation, not less."
2. **The escalation model.** dsh has *zero* command parsing because the kernel is the classifier: run unrecognized commands under the read-only profile silently; when a write is denied, the model retries once with a `justification` and *that* raises the human prompt (`escalation.ts:157`, `tool-bash/src/index.ts:82-92`). This would replace, not add to, sprite's prefix allowlist and haiku classifier. It's the deepest architectural idea in the repo and worth a probe before deciding — it's a different trust model (network and process visibility are explicitly *not* confined; only file writes are), and it needs the read-only path to be genuinely silent to be worth it.

Skip Landlock, bwrap, and Windows ACL entirely.

### 3.2 Background bash jobs

Postmortem 0003 (`docs/postmortem/0003-web-agent-gui-feedback-loop.md`) is the motivation: the agent started a dev server with shell `&`, so "job identity, completion notices, collection, and cleanup did not apply," then validated the wrong server. Sprite's 120s timeout means the model can't run a dev server at all today; `&` is the workaround it will find.

dsh's minimal shape: `run_in_background: true` on `bash` returns a job id; `job_output(job_id)` returns the **delta since the last read** (single consuming cursor, so seen output is never re-sent) ending in `[status: …]`; `job_kill`. Completion pushes one line — "background job bash-1 (…) finished [status: …]. Read its output with job_output." — into the next user turn (`packages/jobs/tool-jobs/src/index.ts:278-300`). Prompt section: "do not busy-poll or sleep on one; keep working on independent steps … Before giving a final answer, collect every still-relevant job with job_output" (`:262-266`). ~120 lines and two tools. This is a real reason under CLAUDE.md's "additions need a real reason" bar.

### 3.3 `grep` / `glob` tools — a genuine trade-off

dsh's `glob`/`grep` spawn a packaged ripgrep directly through the subprocess seam — no shell, unconditionally allowed, `--no-config` to block `RIPGREP_CONFIG_PATH` hijack (`packages/fs/tool-fs-search/src/search-core.ts:228`). Sprite's principle is "most new capabilities should go through bash," and bash grep works. The honest cost of the current design: in default mode every `grep -rn` prompts until the user says "always" for that prefix, and in auto mode every one costs a classifier round-trip. Read-only search is the most common tool call in a coding session. If you add them, take dsh's cap behavior: over 100 glob results, **sample across top-level entries** rather than returning the first 100 of one subtree, and say so in the footer (`glob.ts:150-203`). If you don't, §3.1's read-only sandbox path is the other way to make searches free.

### 3.4 Skills

Sprite's `/commands` are "run this now." dsh's skills are "here's how to do X; the model decides when" — the delta is small. Format: `<name>/SKILL.md` or `<name>.md` with frontmatter `name`, `description`, optional `disable-model-invocation` (`packages/skill/skill-filesystem/README.md`). Discovery roots include `.agents/skills` (project) and `~/.agents/skills` (home) alongside their own — sprite could read `.sprite/skills` plus `.agents/skills` for free compatibility. Disclosure is two-stage: a `<system-reminder>` catalog of `name: description` lines, content-addressed by digest and re-sent only when it changes (`packages/skill/tool-skill/src/index.ts:213-310`), then a `skill(name)` tool that returns the body wrapped with "Base directory for this skill: … Resolve relative paths against it." Ordering rule worth keeping: background (workspace rules, catalog) first, the material to act on last. ~150 lines. The same trust caveat README already documents for project commands applies to project skills.

### 3.5 Hooks (Claude Code–compatible subset)

`packages/hooks/hooks-claude-code/` reads `.claude/settings.json`'s `hooks` key directly (`src/config.ts:80-90`), runs `type: "command"` hooks with JSON on stdin, and honors the exit-code contract: **0** → stdout as JSON (or plain `additionalContext`), **2** → block with stderr as the model-facing reason, anything else → logged (`hook-protocol/src/codec.ts:59-70`). It supports 7 of Claude Code's ~30 events; `PreToolUse` / `PostToolUse` / `UserPromptSubmit` are the ones that matter. Their own README is candid that a native plugin does this better and the bridge exists for compatibility. For sprite: ~150 lines buys the only feature on this list that lets users extend sprite *without editing sprite* (format-on-write, block-secrets, inject-git-branch), and reads existing `.claude/settings.json` files for free.

### 3.6 Keyless replay tests from sprite's own JSONL

dsh's regression fixtures *are* persisted session logs (`packages/test-support/llm-replay/`): record once with a real key, then replay by grouping recorded assistant chunks per step and yielding them back in place of the API call; normalize cwd/session-id/UUIDs/timestamps but keep sequence numbers; fail the test if fewer model calls were made than recorded (`assertConsumed`). Two cases need a sidecar (a pre-chunk throw like a 401; a cancel/hang) — worth designing for on day one. Sprite's `probe` is exploratory (what does the model do?); this is the regression half (did *my* change alter behavior?). Sprite already writes the JSONL, so `SPRITE_REPLAY=<session.jsonl>` swapping the client for a scripted stream is ~50 lines, and every probe run becomes a permanent keyless fixture. Their postmortem 0002 lesson applies: a snapshot refresh is fixture production, not correctness review — add semantic guards (no `unknown tool` results in a golden).

### 3.7 Smaller loop refinements

- **Keep partial work on Ctrl+C.** Sprite drops the whole cancelled turn from in-memory history (`App.tsx:531-534` doesn't `setHistory` on abort), so the model forgets any tool work done before the cancel. dsh commits already-started results and writes synthetic `tool/result` pairs for undispatched calls — "Error: tool call aborted before dispatch" (`packages/core/agent-loop/src/tool-calls.ts:218-259`) — so the turn closes valid and the work survives. A design choice, but the current one throws away context.
- **Parallel read-only tools.** `runTurn` executes tool_use blocks sequentially (`src/agent.ts:650`). dsh runs concurrency-safe tools in a rolling pool and commits results in model order (`tool-calls.ts:146-160`). `read_file`/`list_files`/`fetch_url` in `Promise.all`, results appended in original order, `bash`/`edit_file` serialized: ~20 lines.
- **Retry.** Fixed `[1s, 3s, 8s]` on top of the SDK's own 2 retries. dsh: `min(500·2^n, 10s)` × 10% jitter, `Retry-After` honored only when ≤ max delay (otherwise give up rather than sleep for minutes), and *empty response* counted as retryable (`packages/llm/llm/src/retry-policy.ts:14-24`, `llm-retry/src/index.ts:194-205`). Low priority; the SDK covers most of it.
- **Cooperative tool timeout.** `packages/guard/timeout-policy/src/index.ts` (81 lines): derive a deadline signal, hand it to the tool, *await the tool*, and substitute the timeout result only if your own deadline fired. Never `Promise.race` a subprocess.
- **Torn-tail JSONL repair.** On load, keep events up to the last newline-terminated line that parses; truncate to that offset before appending (`packages/session/session-persistence-jsonl/src/format.ts:272-378`). Sprite's resume already closes a dangling tool batch; this handles a SIGKILL mid-write.
- **`todo_write`.** ~60 lines: whole-list replace, three statuses, "do not batch completions," "skip the list for trivial single-step tasks" (`packages/todo/tool-todo/src/index.ts:45-64`). Nice pattern in there: the "one in-progress" rule drives both the description clause and the validator from one flag, so prompt and enforcement can't drift. Needs a TUI render to be worth it.
- **Notes lifecycle.** dsh's Agent Notes are per-decision files with a `Status:` line and a supersede-don't-delete rule ("never edited into a different decision"). Sprite's single `notes/<dir>.md` will accumulate contradictions with no way to notice. Cheap upgrade: give `save_note` a `## title / Status: active / Date:` header and let it mark an older note `superseded by …` instead of appending a contradiction. Description tweak: notes should state the *why*, written to stand without the answer.

---

## 4. Skip

- **The plugin architecture** (Cordis, profiles, bundles, patch layers, seams). Sprite's whole point is one loop; CLAUDE.md already says "no agent framework."
- **Subagents** (8.4k lines, six transports), **workflows** (model-written orchestration scripts in a worker), **ralph** (fresh child per round), **goals** (idle-time self-prompting), **code mode** (`run_code` — model writes TS calling tools; the codegen is ~150 lines but the sandbox/proxy substrate is 300–400 and it's as powerful as every tool combined), **self-modification** (`cordis_*` tools), **ACP** (only if Zed or sprite-driving-sprite becomes a real consumer; ~250 lines then).
- **Landlock / bwrap / Windows ACL.** Seatbelt is the whole macOS win.
- **`str_replace_editor`** — an Anthropic-compatible clone kept for benchmark parity, not a design.
- **The env denylist**, **unrestricted reads**, **fetch without SSRF checks** — sprite's versions are better.
- **Web UI** — everything under `packages/client/` and `apps/web/`.

One pointer for later: for non-DeepSeek providers dsh doesn't hand-roll adapters — it wraps `@earendil-works/pi-ai` (`packages/llm/llm-pi-ai/`), and stores provider-specific replay state (Anthropic thinking signatures) as an opaque per-message blob that downgrades to "foreign" on a model switch (`replay.ts:20-31, 124-157`). Relevant if the local-models branch ever grows into multi-provider.

---

## 5. Process and docs

- **"KV Cache effect" per feature.** 215 package READMEs carry a mandatory `#### KV Cache effect` paragraph classifying the feature as append-only / prefix-stable / replacing / independent, and naming what invalidates reuse (`docs/cookbook/adding-a-package.md:96-107`; enforced by `scripts/verify-package-readme-model-experience.ts`). Sprite's CLAUDE.md prompt-caching section is the right home for a one-line version: each thing that touches the request says what it does to the three breakpoints. §1.2 is exactly the bug that discipline catches. Also: show `cache_read_input_tokens` separately in the usage line so you can *see* caching working.
- **Postmortem admission test.** `docs/postmortem/README.md`: write one only when a bug is subtle + systemic + costly to rediscover; open with a 30-second executive summary; link the concrete guardrail it motivated. Pairs well with `docs/probes/`. §1.1 would qualify.
- **Defensive patterns worth adopting as CLAUDE.md lines** (`docs/defensive-patterns.md`): report orthogonal outcomes independently (a process can time out *and* exit 0 because it trapped the signal — surface `timedOut`, `signal`, `exitCode` separately; sprite's `close` handler already lets `killedBy` win over `code`, which is the right call); dispose must reach quiescence (kill → *await* exit; close listeners before killing); unlink link-shaped paths with `lstat` + `unlink`, never recursive `rm` through a possible symlink.
- **Model-visible ⟺ logged.** dsh's one-line invariant — before every request, `JSON.stringify(requestMessages) === JSON.stringify(deriveFromLog())` — is what makes the log the truth rather than a debug artifact. Sprite's `checkpoint` events are close; the discipline is worth stating even if the assertion stays behind a flag.

---

## Appendix: pointers

All paths relative to `~/code/deepseek-harness`.

| Topic | Where |
|---|---|
| Architecture, turn flow, extension points | `docs/architecture.md`, `docs/tool-execution-pipeline.md`, `docs/agent-lifecycle.md` |
| Default composition (what ships, config values) | `packages/bundle/base/cordis.patch.yml` |
| Plan-mode prose | `packages/bundle/base/cordis.patch.yml:264-280`; mechanics `packages/plan/plan-mode/src/index.ts` |
| bash tool schema + result rendering | `packages/shell/tool-bash/src/index.ts:70-93, 244-272`, `src/render.ts:11-63` |
| Repeat-tool reminder | `packages/guard/repeat-tool-reminder/README.md`, `src/index.ts:89-232` |
| Cooperative tool timeout | `packages/guard/timeout-policy/src/index.ts` |
| Compaction prompt + prefix replay | `packages/compaction/compaction-basic/src/summarizer.ts:24-70, 145-163`, `README.md:156` |
| Tool-result pruner | `packages/compaction/compaction-tool-result-pruner/src/{index,config}.ts` |
| Tool-pairing cut | `packages/compaction/compaction/src/tool-pairing.ts` |
| Runtime-context snapshots | `packages/core/agent-loop/src/runtime-context.ts` |
| Cancel → synthetic results | `packages/core/agent-loop/src/tool-calls.ts:218-259` |
| Retry policy | `packages/llm/llm/src/retry-policy.ts`, `packages/llm/llm-retry/src/index.ts` |
| Seatbelt profile + roots + probe | `packages/sandbox/sandbox-local/src/profiles.ts:51-58`, `packages/sandbox/sandbox/src/roots.ts`, `sandbox-local/src/index.ts:85-91,159-166` |
| Escalation marker/flow | `packages/sandbox/sandbox/src/escalation.ts` |
| fs write canonicalization | `packages/fs/fs-sandbox/src/index.ts:122-148`, `src/containment.ts` |
| Read-before-edit version CAS | `packages/fs/fs-observation-policy/src/index.ts`, `packages/fs/fs-local/src/fsio.ts:73` |
| Web fetch URL policy | `packages/web/web-fetch-http/src/policy.ts`, `src/provider.ts` |
| Background jobs | `packages/jobs/tool-jobs/src/index.ts`, `packages/shell/tool-bash/src/background.ts` |
| Skills | `packages/skill/skill-filesystem/README.md`, `packages/skill/tool-skill/src/index.ts` |
| Hooks | `packages/hooks/hooks-claude-code/src/{config,index}.ts`, `packages/hooks/hook-protocol/src/codec.ts` |
| Keyless replay | `packages/test-support/llm-replay/`, `packages/test-support/acp-snapshot/src/normalize.ts`, `docs/testing.md` |
| JSONL torn-tail repair | `packages/session/session-persistence-jsonl/src/format.ts:272-378` |
| Postmortems, defensive patterns | `docs/postmortem/`, `docs/defensive-patterns.md` |
| Agent Notes process | `.agents/notes/README.md`, `.agents/skills/dsh-archive-agent-notes/SKILL.md` |
