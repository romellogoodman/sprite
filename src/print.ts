import { runTurn } from "./agent.js";
import type { ToolContext } from "./tools.js";
import {
  loadApiKey,
  isBashAllowed,
  allowBashPrefix,
  suggestBashPrefix,
} from "./config.js";

/**
 * Headless one-shot: run a single turn, write assistant text to stdout and
 * tool activity to stderr, then exit. No TTY, so bash commands that aren't
 * already allowlisted are denied unless --trust is set.
 */
export async function runPrint(prompt: string, trust: boolean): Promise<void> {
  const apiKey = loadApiKey();
  if (!apiKey) {
    process.stderr.write(
      "No API key. Set ANTHROPIC_API_KEY or run `sprite` interactively to log in.\n",
    );
    process.exit(1);
  }

  const ctx: ToolContext = {
    trust,
    isAllowed: isBashAllowed,
    allowPrefix: allowBashPrefix,
    suggestPrefix: suggestBashPrefix,
    confirmBash: async (command) => {
      process.stderr.write(
        `✗ bash denied (non-interactive): ${command}\n  Re-run with --trust or allowlist the command interactively.\n`,
      );
      return "no";
    },
  };

  try {
    await runTurn(apiKey, [], prompt, ctx, (e) => {
      if (e.type === "text") {
        process.stdout.write(e.text + "\n");
      } else if (e.type === "tool_use") {
        process.stderr.write(`⚙ ${e.name} ${JSON.stringify(e.input)}\n`);
      } else if (e.type === "tool_result") {
        const mark = e.isError ? "✗" : "✓";
        process.stderr.write(`${mark} ${e.name}\n`);
      }
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`✗ ${msg}\n`);
    process.exit(1);
  }
}
