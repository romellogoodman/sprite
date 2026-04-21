import { readFileSync } from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { tools, executeTool, type ToolContext } from "./tools.js";

const MODEL = "claude-opus-4-7";

const BASE_SYSTEM_PROMPT = `You are sprite, a coding assistant working in the user's current directory.

You have four tools: read_file, list_files, edit_file, bash. Read before you edit. Reach for bash when the file tools can't do it — running tests, grep, git, installs. When you change something, say what changed and why in one line.

Be practical. Short answers — this is a terminal. Prefer showing the work to explaining it. If a request is ambiguous and the choice matters, ask one short question and wait. If it's minor, pick the smallest reasonable interpretation and say what you assumed.

Pay attention to what the code is trying to do, not just what it says. Small, careful edits over large rewrites.`;

/**
 * Load project-level instructions from AGENTS.md / AGENT.md / CLAUDE.md in cwd.
 * All three names are checked; duplicate contents (e.g. symlinks) are included
 * once. Missing or unreadable files are skipped silently.
 */
function loadProjectContext(cwd: string = process.cwd()): string {
  const files = ["AGENTS.md", "AGENT.md", "CLAUDE.md"];
  const seen = new Set<string>();
  const sections: string[] = [];

  for (const name of files) {
    try {
      const body = readFileSync(path.join(cwd, name), "utf8").trim();
      if (!body || seen.has(body)) continue;
      seen.add(body);
      sections.push(`--- ${name} ---\n${body}`);
    } catch {
      // file missing or unreadable; skip
    }
  }

  if (sections.length === 0) return "";
  return (
    `\n\nThe following project instructions were loaded from the working directory. ` +
    `Treat them as authoritative guidance for this project.\n\n` +
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

export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; name: string; output: string; isError: boolean };

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
