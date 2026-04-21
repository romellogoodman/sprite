import Anthropic from "@anthropic-ai/sdk";
import { tools, executeTool } from "./tools.js";

const MODEL = "claude-opus-4-7";

const SYSTEM_PROMPT = `You are sprite, a coding assistant working in the user's current directory.

You have four tools: read_file, list_files, edit_file, bash. Read before you edit. Reach for bash when the file tools can't do it — running tests, grep, git, installs. When you change something, say what changed and why in one line.

Be practical. Short answers — this is a terminal. Prefer showing the work to explaining it. If a request is ambiguous and the choice matters, ask one short question and wait. If it's minor, pick the smallest reasonable interpretation and say what you assumed.

Pay attention to what the code is trying to do, not just what it says. Small, careful edits over large rewrites.`;

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
  onEvent: (e: AgentEvent) => void,
): Promise<Anthropic.MessageParam[]> {
  const client = new Anthropic({ apiKey });
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
      system: SYSTEM_PROMPT,
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

    const toolResults: Anthropic.ToolResultBlockParam[] = toolUses.map((tu) => {
      try {
        const output = executeTool(tu.name, tu.input as Record<string, unknown>);
        onEvent({
          type: "tool_result",
          id: tu.id,
          name: tu.name,
          output,
          isError: false,
        });
        return { type: "tool_result", tool_use_id: tu.id, content: output };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        onEvent({
          type: "tool_result",
          id: tu.id,
          name: tu.name,
          output: msg,
          isError: true,
        });
        return {
          type: "tool_result",
          tool_use_id: tu.id,
          content: msg,
          is_error: true,
        };
      }
    });

    messages.push({ role: "user", content: toolResults });
  }
}
