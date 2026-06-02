import { readFileSync, existsSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import {
  toolsForMode,
  executeTool,
  type PermissionMode,
  type ToolContext,
} from "./tools.js";
import { configDir } from "./config.js";
import { loadNotes, notesPath } from "./session.js";
import { findModel } from "./models.js";

const DEFAULT_MODEL = "claude-haiku-4-5";

// Read lazily so --model (which sets the env var after module import) is seen.
export function model(): string {
  return process.env.SPRITE_MODEL || DEFAULT_MODEL;
}

// effort/adaptive-thinking aren't supported on every model; only send them
// where they won't 400.
function modelParams(): Partial<Anthropic.MessageCreateParams> {
  const m = model();
  if (m.includes("opus-4-7")) {
    return {
      thinking: { type: "adaptive" },
      output_config: { effort: "xhigh" },
    };
  }
  if (m.includes("opus") || m.includes("sonnet-4-6")) {
    return {
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
    };
  }
  return {};
}

// Approximate context windows for the % indicator, pulled from the shared
// catalog. Unknown models fall back to 200K so auto-compact errs toward
// triggering early rather than late.
export function contextWindow(): number {
  return findModel(model())?.contextWindow ?? 200_000;
}

const BASE_SYSTEM_PROMPT = `You are sprite, a coding assistant working in the user's current directory.

Tools: read_file, list_files, edit_file, bash, fetch_url, ask_user_question. Read before you edit. Reach for bash when the file tools can't do it — tests, grep, git, installs. Use fetch_url when the user pastes a link, asks about external docs, or when you need to verify something against a real source instead of guessing from training data. When you change something, say what changed and why in one line.

Be practical. Short answers — this is a terminal. Prefer showing the work to explaining it. Don't narrate the mode you're in or the step you're about to take; just take it.

Finish the task before yielding back. Don't stop at analysis when you should be executing, and don't trail off with "want me to also…?" or "should I continue?" — just do the work. The only time to ask is when a real decision blocks you and the wrong guess would waste the turn: use ask_user_question with batched multi-choice options, never a prose question. If the ambiguity is minor, pick the smallest reasonable interpretation and say what you assumed.

Verify before you claim done. When you've changed code, run the project's own check — typecheck, lint, build, the nearest test — whatever package.json, Makefile, or the project docs expose. If it fails, fix it; if there's genuinely no check to run, say so in one line. "It should work" is not done.

Ground every claim in what you actually saw. A ranged read ("Lines 1-80 of 316") is a partial view — page the rest or say you only saw part, don't describe the whole file from it. An empty result is data: no search hits, a git log that printed nothing, a command with no output — report it as empty, don't smooth it over with a plausible guess. Never state a count, a filename, or a commit hash you didn't read from a tool result. When you're inferring rather than quoting, say so. A confident summary that outruns the evidence is worse than "I only checked X".

When a lookup fails — a repo 404s, a package isn't found, a search returns nothing — try one obvious alternative before giving up. Repo renames, alias names, a parent path, the dash/underscore swap. Don't pivot to "did you mean something else?" on the first miss.

Project context (CLAUDE.md, AGENTS.md) is guidance for you, not script to quote back at the user. They wrote it; they know what it says. Use it to decide, don't parrot it.

save_note is your scratchpad across sessions. When you learn something about this project that future you would need and that isn't already in the code or the instruction files — the exact test command, a quirk of the build, a decision the user made and why — call save_note with a one-line summary. The user sees and approves every note, so keep them short and factual. Don't log every session; save only what would spare a future rediscovery.

Pay attention to what the code is trying to do, not just what it says. Small, careful edits over large rewrites.`;

/**
 * Mode-specific reminder injected as a tag inside the user's message at the
 * top of each turn. Kept out of the static system prompt so shift+tab flips
 * don't bust the prompt cache.
 */
function modeReminder(mode: PermissionMode): string | null {
  if (mode !== "plan") return null;
  return `Plan mode is active. The user does NOT want you to execute yet. You MUST NOT call edit_file, and you MUST NOT run bash commands that change the system (no writes, installs, commits, or network changes — read-only commands like grep, git log, ls are fine if needed).

Explore the codebase with read_file, list_files, fetch_url, and read-only bash. Don't narrate the mode to the user — skip "I'll explore first" or "I'm in plan mode"; the UI shows it. Just do the work.

Use ask_user_question when you hit a decision only the user can make (requirements, tradeoffs, preferences). Never ask what you could find by reading the code; batch related questions together.

End your turn either by calling ask_user_question (to clarify) or exit_plan_mode (to request approval). Pass the full plan as markdown to exit_plan_mode; do not ask "is the plan ready?" via ask_user_question or prose — that's what exit_plan_mode is for. The plan should cover: what will change, which files, existing code to reuse (with paths), and how to verify.`;
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Load project instructions from AGENTS.md / AGENT.md / CLAUDE.md.
 *
 * Searches ~/.config/sprite/ (global), then walks from the git root down to
 * cwd so inner files come last. Stops the upward walk at the first directory
 * containing `.git`, or at the filesystem root. Duplicate contents (e.g. via
 * symlinks) are included once. Missing files are skipped silently.
 *
 * Files found inside the repo are symlink-aware: realpath them and skip if
 * they resolve outside the git root, so a cloned repo with
 * `AGENTS.md -> /etc/passwd` can't pull arbitrary files into the system
 * prompt. Files in ~/.config/sprite/ or above the git root are left alone —
 * those are the user's own, and dotfile managers legitimately symlink them.
 */
function loadProjectContext(cwd: string = process.cwd()): string {
  const names = ["AGENTS.md", "AGENT.md", "CLAUDE.md"];
  const seen = new Set<string>();
  const sections: string[] = [];

  const home = os.homedir();
  const ancestors: string[] = [];
  let dir = path.resolve(cwd);
  let gitRoot: string | null = null;
  for (;;) {
    ancestors.push(dir);
    if (existsSync(path.join(dir, ".git"))) {
      gitRoot = dir;
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir || dir === home) break;
    dir = parent;
  }
  const repoReal = gitRoot
    ? (() => {
        try {
          return realpathSync(gitRoot);
        } catch {
          return gitRoot;
        }
      })()
    : null;

  const MAX = 32 * 1024;
  const tryLoad = (dir: string, inRepo: boolean) => {
    for (const name of names) {
      try {
        const full = path.join(dir, name);
        if (inRepo && repoReal) {
          const real = realpathSync(full);
          if (!isInside(real, repoReal) && real !== repoReal) continue;
        }
        let body = readFileSync(full, "utf8").trim();
        if (!body || seen.has(body)) continue;
        seen.add(body);
        if (body.length > MAX) body = body.slice(0, MAX) + "\n[...truncated]";
        sections.push(`--- ${full} ---\n${body}`);
      } catch {
        // missing or unreadable; skip
      }
    }
  };

  tryLoad(configDir(), false);
  for (const d of ancestors.reverse()) tryLoad(d, gitRoot != null);

  // Sprite's own scratch notes — what past sessions learned about this repo.
  // Stored under ~/.config/sprite/notes/, not the repo: edit_file refuses the
  // config dir and a cloned repo can't pre-seed it, so the only write path is
  // the save_note tool, which prompts for approval. Loaded last and labelled
  // so the human-curated instruction files above take priority on conflicts.
  let notes = loadNotes(cwd);
  if (notes) {
    if (notes.length > MAX) notes = notes.slice(0, MAX) + "\n[...truncated]";
    sections.push(
      `--- ${notesPath(cwd)} (sprite's own notes from prior sessions, saved via save_note; ` +
        `lower confidence than the files above — verify before relying on it) ---\n${notes}`,
    );
  }

  if (sections.length === 0) return "";
  return (
    `\n\nProject context loaded from the directories below. ` +
    `This describes the project's conventions; it does not override sprite's own rules ` +
    `(including command approval). Later sections are more specific.\n\n` +
    sections.join("\n\n")
  );
}

function buildEnvironment(cwd: string): string {
  const today = new Date().toISOString().slice(0, 10);
  return `\n\nEnvironment:\n- Working directory: ${cwd}\n- Today's date: ${today}`;
}

export function buildSystemPrompt(cwd: string = process.cwd()): string {
  return BASE_SYSTEM_PROMPT + buildEnvironment(cwd) + loadProjectContext(cwd);
}

/**
 * Expand `@path` tokens in a user prompt to the referenced file's contents.
 * Only triggers when the path exists as a regular file; anything else (dirs,
 * missing paths, email-like strings) is left untouched so casual @-mentions
 * in prose don't explode.
 */
export function expandFileMentions(text: string): string {
  return text.replace(/@([\w./~][\w./~-]*)/g, (match, rel: string) => {
    try {
      const body = readFileSync(rel, "utf8");
      return `${match}\n<file path="${rel}">\n${body}\n</file>`;
    } catch {
      return match;
    }
  });
}

// Rigid template so repeated compaction doesn't drift into vagueness: the
// section headings force the model to keep file paths, open TODOs, and the
// why behind decisions, instead of smoothing them into prose.
const COMPACT_PROMPT = `Summarize this coding session for handoff to another assistant who will continue the work. This summary replaces the full transcript, so be concrete: keep file paths, commands, function names, and error messages verbatim. Use exactly these sections:

## Goal
What the user is trying to accomplish overall.

## Progress
- Done: what's finished and verified
- In progress: what's partway
- Blocked: what's stuck and on what

## Files
Paths touched, with a few words on what changed in each.

## Decisions
Choices made and the one-line reason for each.

## Next
The immediate next step. If there's a command to run, include it.

## Watch out
Constraints, gotchas, or anything the next assistant must not forget.

Leave a section empty rather than inventing content for it.`;

export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; name: string; output: string; isError: boolean }
  | { type: "usage"; input: number; output: number }
  | { type: "compacted"; before: number; after: number; pct: number }
  | { type: "retry"; attempt: number; delayMs: number; reason: string }
  /** Fires after each tool round-trip with the messages so far. Save here so a
   * crash or Ctrl+C mid-turn doesn't lose the tool work already done. */
  | { type: "checkpoint"; messages: Anthropic.MessageParam[] }
  | { type: "done"; durationMs: number; input: number; output: number };

/**
 * Transient API failures — rate limits, overload, 5xx, dropped sockets — are
 * worth one or two retries before throwing the whole turn away. Anything else
 * (400 bad request, 401 auth) fails fast.
 */
function isTransient(err: unknown): boolean {
  if (err instanceof Anthropic.APIConnectionError) return true;
  if (err instanceof Anthropic.APIError) {
    const s = err.status;
    return s === 429 || s === 529 || (typeof s === "number" && s >= 500);
  }
  return false;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(signal.reason ?? new Error("aborted"));
      },
      { once: true },
    );
  });
}

const RETRY_DELAYS_MS = [1_000, 3_000, 8_000];

/**
 * Run `fn`, retrying on transient API errors with short backoff. `canRetry`
 * gates it — the caller flips it false once content has streamed to the UI, so
 * a mid-stream failure surfaces as an error instead of a duplicated response.
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  canRetry: () => boolean,
  onRetry: (attempt: number, delayMs: number, reason: string) => void,
  signal?: AbortSignal,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (signal?.aborted) throw err;
      if (attempt >= RETRY_DELAYS_MS.length || !canRetry() || !isTransient(err)) {
        throw err;
      }
      const delay = RETRY_DELAYS_MS[attempt];
      const reason = err instanceof Error ? err.message : String(err);
      onRetry(attempt + 1, delay, reason);
      await sleep(delay, signal);
    }
  }
}

/**
 * Prompt caching: the API caches the request prefix (tools → system →
 * messages) up to each `cache_control` breakpoint. We set three:
 * the last tool def and the system block cover the static prefix, and the
 * final content block of the last message moves forward each request so the
 * whole growing history is re-read from cache instead of re-billed.
 */
function cachedSystem(system: string): Anthropic.TextBlockParam[] {
  return [{ type: "text", text: system, cache_control: { type: "ephemeral" } }];
}

function cachedTools(tools: Anthropic.ToolUnion[]): Anthropic.ToolUnion[] {
  if (tools.length === 0) return tools;
  return tools.map((t, i) =>
    i === tools.length - 1 ? { ...t, cache_control: { type: "ephemeral" } } : t,
  );
}

/**
 * Return a copy of `messages` with an ephemeral cache breakpoint on the final
 * content block of the last message. Stored history is never mutated — the
 * marker is added per-request so it always sits at the live end of the
 * conversation. String content is wrapped into a text block to carry it.
 */
export function withCacheMarker(
  messages: Anthropic.MessageParam[],
): Anthropic.MessageParam[] {
  if (messages.length === 0) return messages;
  const last = messages[messages.length - 1];
  let content: Anthropic.MessageParam["content"];
  if (typeof last.content === "string") {
    content = [
      {
        type: "text",
        text: last.content,
        cache_control: { type: "ephemeral" },
      },
    ];
  } else {
    const blocks = [...last.content];
    const tail = blocks[blocks.length - 1];
    // thinking/redacted_thinking blocks can't carry cache_control; skip the
    // marker rather than 400 the request.
    if (
      tail &&
      tail.type !== "thinking" &&
      tail.type !== "redacted_thinking"
    ) {
      blocks[blocks.length - 1] = {
        ...tail,
        cache_control: { type: "ephemeral" },
      } as (typeof blocks)[number];
    }
    content = blocks;
  }
  return [...messages.slice(0, -1), { ...last, content }];
}

/** Rough token count. Good enough to decide where to cut; not for billing. */
function estimateTokens(m: Anthropic.MessageParam): number {
  const s =
    typeof m.content === "string" ? m.content : JSON.stringify(m.content);
  return Math.ceil(s.length / 4);
}

/**
 * A "real" user turn (something the human typed, or a prior compaction
 * summary) as opposed to a tool_result batch. In sprite those are always
 * string-content; tool results are always arrays. Cutting here keeps the
 * tool_use/tool_result pairing intact on both sides of the cut.
 */
function isUserTurnStart(m: Anthropic.MessageParam): boolean {
  return m.role === "user" && typeof m.content === "string";
}

const KEEP_TOKENS = 20_000;

/**
 * Walk backward accumulating tokens until we've covered KEEP_TOKENS and are
 * sitting on a user-turn boundary. Returns the index to cut at — everything
 * before it gets summarized, everything from it onward is kept verbatim.
 * Returns 0 if the whole history fits (nothing to summarize).
 */
function findCutPoint(history: Anthropic.MessageParam[]): number {
  let acc = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    acc += estimateTokens(history[i]);
    if (acc >= KEEP_TOKENS && isUserTurnStart(history[i])) return i;
  }
  return 0;
}

/**
 * Compact the conversation: summarize the older part, keep the recent tail
 * verbatim so file paths, exact error messages, and in-progress tool state
 * survive. If no sensible cut point exists, fall back to summarizing
 * everything (the old behavior).
 */
export async function compactHistory(
  apiKey: string,
  history: Anthropic.MessageParam[],
): Promise<Anthropic.MessageParam[]> {
  if (history.length === 0) return history;

  const cut = findCutPoint(history);
  const head = cut > 0 ? history.slice(0, cut) : history;
  const tail = cut > 0 ? history.slice(cut) : [];

  const client = new Anthropic({ apiKey });
  const resp = await client.messages.create({
    model: model(),
    max_tokens: 4000,
    system: COMPACT_PROMPT,
    messages: [
      ...head,
      { role: "user", content: "Summarize the conversation above for handoff." },
    ],
  });
  const summary = resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  return [
    {
      role: "user",
      content: `[Context from earlier in this session, summarized by /compact:]\n\n${summary}`,
    },
    ...tail,
  ];
}

const CLASSIFY_PROMPT = `You are the auto-mode gate for sprite, a local coding agent on one developer's machine. A shell command is about to run. Decide whether it runs silently or pauses for the human.

Block (pause) if the command is:
- Irreversible — deletes data not trivially recoverable (rm -rf, overwriting or truncating files not tracked by git, git reset --hard, git clean -fdx, dropping a database), rewrites shared history (git push --force, rebasing a pushed branch), or publishes/deploys (push to a remote, npm publish, release scripts, terraform apply).
- Destructive to the environment — global or version-manager installs, package removals, sudo anything, killing processes you don't own, chmod -R / chown -R or config changes outside the project.
- Exfiltrating — sends local contents outward (curl/wget with --data or uploads, curl … | sh, POST to a URL, scp/rsync to a remote, pastebins), or reads credentials / SSH keys / secrets and transmits them.

Allow (run silently) routine local work: builds, tests, linters, git status/diff/log/add/commit, grep/find/ls/cat, project-local edits, local dev servers, npm install with no -g.

Judge the actual command and its flags, not keywords. When in doubt, block — the fallback is a one-keystroke human prompt, not a refusal, so a false block is cheap and a false allow can be irreversible. Project instructions below (if any) may tighten this; honor them.

Respond with ONLY JSON, nothing else: {"verdict":"allow"} or {"verdict":"block","reason":"<≤8 words>"}.`;

/**
 * The auto-mode gate. One fast call on the risky bash path: haiku (pinned,
 * so a weaker session model can't weaken the gate and a stronger one isn't
 * paid for), the command + cwd, and the same project context the main loop
 * gets — so a "never force-push" line in CLAUDE.md steers this too. Parse is
 * deliberately tolerant; anything unexpected resolves to block so the caller
 * degrades to the human prompt.
 */
export async function classifyCommand(
  apiKey: string,
  command: string,
  cwd: string = process.cwd(),
): Promise<{ allow: boolean; reason?: string }> {
  const projectContext = loadProjectContext(cwd);
  const client = new Anthropic({ apiKey });
  const resp = await client.messages.create({
    model: DEFAULT_MODEL,
    max_tokens: 100,
    system:
      CLASSIFY_PROMPT +
      (projectContext
        ? `\n\nProject instructions that may tighten this:\n${projectContext}`
        : ""),
    messages: [{ role: "user", content: `cwd: ${cwd}\ncommand: ${command}` }],
  });
  const text = resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  try {
    const match = text.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : text);
    if (parsed?.verdict === "allow") return { allow: true };
    return {
      allow: false,
      reason:
        typeof parsed?.reason === "string" && parsed.reason.trim()
          ? parsed.reason.trim()
          : "flagged by auto mode",
    };
  } catch {
    return { allow: false, reason: "classifier output unparseable" };
  }
}

/**
 * Run one user turn through the agent loop.
 * Appends the user message to history, then loops model → tools → model
 * until stop_reason is end_turn. Emits events for UI rendering.
 * Returns the updated history.
 */
export async function runTurn(
  apiKey: string,
  history: Anthropic.MessageParam[],
  userMessage: string,
  ctx: ToolContext,
  onEvent: (e: AgentEvent) => void,
  signal?: AbortSignal,
): Promise<Anthropic.MessageParam[]> {
  const client = new Anthropic({ apiKey });
  const system = buildSystemPrompt();
  const window = contextWindow();
  userMessage = expandFileMentions(userMessage);
  const reminder = modeReminder(ctx.getMode());
  const firstMessage = reminder
    ? `${userMessage}\n\n<system-reminder>\n${reminder}\n</system-reminder>`
    : userMessage;
  let messages: Anthropic.MessageParam[] = [
    ...history,
    { role: "user", content: firstMessage },
  ];

  const started = Date.now();
  let totalIn = 0;
  let totalOut = 0;
  let autoCompacted = false;

  while (true) {
    signal?.throwIfAborted();

    // Don't retry once content has streamed to the UI — a second stream would
    // append on top of the partial text. Connect-time failures (429/529/5xx)
    // land here before any delta, which is the common case worth saving.
    let streamedAny = false;
    const response = await withRetry(
      async () => {
        const stream = client.messages.stream(
          {
            model: model(),
            max_tokens: 16000,
            ...modelParams(),
            system: cachedSystem(system),
            tools: cachedTools(toolsForMode(ctx.getMode())),
            messages: withCacheMarker(messages),
          },
          { signal },
        );
        stream.on("text", (delta) => {
          streamedAny = true;
          onEvent({ type: "text", text: delta });
        });
        return await stream.finalMessage();
      },
      () => !streamedAny,
      (attempt, delayMs, reason) =>
        onEvent({ type: "retry", attempt, delayMs, reason }),
      signal,
    );

    const inputTokens =
      (response.usage.input_tokens ?? 0) +
      (response.usage.cache_read_input_tokens ?? 0) +
      (response.usage.cache_creation_input_tokens ?? 0);
    const outputTokens = response.usage.output_tokens ?? 0;
    totalIn += inputTokens;
    totalOut += outputTokens;
    onEvent({ type: "usage", input: inputTokens, output: outputTokens });

    const toolUses: Anthropic.ToolUseBlock[] = [];
    for (const block of response.content) {
      if (block.type === "tool_use") {
        toolUses.push(block);
        onEvent({
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: block.input,
        });
      }
    }

    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "end_turn" || toolUses.length === 0) {
      onEvent({
        type: "done",
        durationMs: Date.now() - started,
        input: totalIn,
        output: totalOut,
      });
      return messages;
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      signal?.throwIfAborted();
      try {
        const output = await executeTool(
          tu.name,
          tu.input as Record<string, unknown>,
          ctx,
          signal,
        );
        onEvent({
          type: "tool_result",
          id: tu.id,
          name: tu.name,
          output,
          isError: false,
        });
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: output,
        });
      } catch (err) {
        // Don't turn an abort into a tool error that gets fed back to the
        // model; just let it propagate so the whole turn unwinds.
        if (signal?.aborted) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        onEvent({
          type: "tool_result",
          id: tu.id,
          name: tu.name,
          output: msg,
          isError: true,
        });
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: msg,
          is_error: true,
        });
      }
    }

    messages.push({ role: "user", content: toolResults });
    onEvent({ type: "checkpoint", messages });

    // Safety net: if the conversation is nearing the context limit, compact
    // before the next model call. /compact is still the preferred path so
    // the user can pick the moment; this just stops us hitting the wall.
    //
    // At most once per turn. If a single turn's tool results exceed the
    // budget on their own, compaction keeps the tail verbatim and re-fires
    // on the very next call — burning a summarization request each loop for
    // nothing. Better to compact once and let the API surface the limit; the
    // user can /compact or /clear from there. A compaction failure also
    // shouldn't throw away the tool work already done — surface the API
    // error on the real call instead.
    if (!autoCompacted && inputTokens > window * 0.85) {
      autoCompacted = true;
      const before = messages.length;
      const pct = Math.round((100 * inputTokens) / window);
      try {
        messages = await compactHistory(apiKey, messages);
        onEvent({ type: "compacted", before, after: messages.length, pct });
      } catch {
        // best effort; keep going with the uncompacted history
      }
    }
  }
}
