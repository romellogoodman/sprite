import { readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { tools, executeTool, type ToolContext } from "./tools.js";
import { configDir } from "./config.js";

const MODEL = "claude-opus-4-7";

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

export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; name: string; output: string; isError: boolean }
  | { type: "usage"; input: number; output: number };

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
    model: MODEL,
    max_tokens: 4000,
    system:
      "Summarize the conversation so far for handoff to another assistant. " +
      "Capture: what the user is trying to do, key decisions and their rationale, " +
      "files touched, commands run, current state, and anything still open. " +
      "Be concrete and concise; this replaces the full transcript.",
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
): Promise<Anthropic.MessageParam[]> {
  const client = new Anthropic({ apiKey });
  const system = buildSystemPrompt();
  userMessage = expandFileMentions(userMessage);
  const messages: Anthropic.MessageParam[] = [
    ...history,
    { role: "user", content: userMessage },
  ];

  while (true) {
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      output_config: { effort: "xhigh" },
      cache_control: { type: "ephemeral" },
      system,
      tools,
      messages,
    });

    const response = await stream.finalMessage();

    onEvent({
      type: "usage",
      input:
        (response.usage.input_tokens ?? 0) +
        (response.usage.cache_read_input_tokens ?? 0) +
        (response.usage.cache_creation_input_tokens ?? 0),
      output: response.usage.output_tokens ?? 0,
    });

    const toolUses: Anthropic.ToolUseBlock[] = [];
    for (const block of response.content) {
      if (block.type === "text") {
        onEvent({ type: "text", text: block.text });
      } else if (block.type === "tool_use") {
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
      try {
        const output = await executeTool(
          tu.name,
          tu.input as Record<string, unknown>,
          ctx,
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
  }
}
