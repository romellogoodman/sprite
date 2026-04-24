import { readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { tools, executeTool, type ToolContext } from "./tools.js";
import { configDir } from "./config.js";

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

// Approximate context windows for the % indicator. Unknown models fall back
// to 200K so auto-compact errs toward triggering early rather than late.
const CONTEXT_WINDOWS: Record<string, number> = {
  "claude-opus-4-7": 1_000_000,
  "claude-opus-4-6": 1_000_000,
  "claude-sonnet-4-6": 1_000_000,
  "claude-haiku-4-5": 200_000,
};
export function contextWindow(): number {
  return CONTEXT_WINDOWS[model()] ?? 200_000;
}

const BASE_SYSTEM_PROMPT = `You are sprite, a coding assistant working in the user's current directory.

You have four tools: read_file, list_files, edit_file, bash. Read before you edit. Reach for bash when the file tools can't do it — running tests, grep, git, installs. When you change something, say what changed and why in one line.

Be practical. Short answers — this is a terminal. Prefer showing the work to explaining it. If a request is ambiguous and the choice matters, ask one short question and wait. If it's minor, pick the smallest reasonable interpretation and say what you assumed.

Pay attention to what the code is trying to do, not just what it says. Small, careful edits over large rewrites.`;

/**
 * Load project instructions from AGENTS.md / AGENT.md / CLAUDE.md.
 *
 * Searches ~/.config/sprite/ (global), then walks from the git root down to
 * cwd so inner files come last. Stops the upward walk at the first directory
 * containing `.git`, or at the filesystem root. Duplicate contents (e.g. via
 * symlinks) are included once. Missing files are skipped silently.
 */
function loadProjectContext(cwd: string = process.cwd()): string {
  const names = ["AGENTS.md", "AGENT.md", "CLAUDE.md"];
  const seen = new Set<string>();
  const sections: string[] = [];

  const MAX = 32 * 1024;
  const tryLoad = (dir: string) => {
    for (const name of names) {
      try {
        const full = path.join(dir, name);
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

  tryLoad(configDir());

  const home = os.homedir();
  const ancestors: string[] = [];
  let dir = path.resolve(cwd);
  for (;;) {
    ancestors.push(dir);
    if (existsSync(path.join(dir, ".git"))) break;
    const parent = path.dirname(dir);
    if (parent === dir || dir === home) break;
    dir = parent;
  }
  for (const d of ancestors.reverse()) tryLoad(d);

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
  | { type: "compacted"; before: number; pct: number };

/**
 * Summarize the conversation so far and return a fresh history containing
 * just that summary as a single user message. Used by /compact to keep long
 * sessions under the context limit without losing the thread.
 */
export async function compactHistory(
  apiKey: string,
  history: Anthropic.MessageParam[],
): Promise<Anthropic.MessageParam[]> {
  if (history.length === 0) return history;
  const client = new Anthropic({ apiKey });
  const resp = await client.messages.create({
    model: model(),
    max_tokens: 4000,
    system: COMPACT_PROMPT,
    messages: [
      ...history,
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
      content: `[Context from an earlier session, summarized by /compact:]\n\n${summary}`,
    },
  ];
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
  let messages: Anthropic.MessageParam[] = [
    ...history,
    { role: "user", content: userMessage },
  ];

  while (true) {
    signal?.throwIfAborted();
    const stream = client.messages.stream(
      {
        model: model(),
        max_tokens: 16000,
        ...modelParams(),
        cache_control: { type: "ephemeral" },
        system,
        tools,
        messages,
      },
      { signal },
    );

    stream.on("text", (delta) => onEvent({ type: "text", text: delta }));

    const response = await stream.finalMessage();

    const inputTokens =
      (response.usage.input_tokens ?? 0) +
      (response.usage.cache_read_input_tokens ?? 0) +
      (response.usage.cache_creation_input_tokens ?? 0);
    onEvent({
      type: "usage",
      input: inputTokens,
      output: response.usage.output_tokens ?? 0,
    });

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

    // Safety net: if the conversation is nearing the context limit, compact
    // before the next model call. /compact is still the preferred path so
    // the user can pick the moment; this just stops us hitting the wall.
    if (inputTokens > window * 0.85) {
      const before = messages.length;
      const pct = Math.round((100 * inputTokens) / window);
      messages = await compactHistory(apiKey, messages);
      onEvent({ type: "compacted", before, pct });
    }
  }
}
