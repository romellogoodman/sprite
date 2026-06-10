import { runTurn } from "./agent.js";
import { summarizeInput, headlessContext } from "./tools.js";
import { loadApiKey } from "./config.js";

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

  const ctx = headlessContext({
    trust,
    onBash: async (command) => {
      process.stderr.write(
        `✗ bash denied (non-interactive): ${command}\n  Re-run with --trust or allowlist the command interactively.\n`,
      );
      return "no";
    },
    onWrite: async (absPath) => {
      process.stderr.write(
        `✗ write denied (non-interactive): ${absPath}\n  Writes outside the project need confirmation; re-run with --trust or allowlist the directory interactively.\n`,
      );
      return "no";
    },
  });

  const controller = new AbortController();
  process.once("SIGINT", () => {
    controller.abort();
    process.stderr.write("\n(cancelled)\n");
  });

  try {
    await runTurn(apiKey, [], prompt, ctx, (e) => {
      if (e.type === "text") {
        // Deltas are partial chunks, not whole lines — write them verbatim and
        // emit a single trailing newline on `done`, or the output is shredded
        // into one line per streamed token.
        process.stdout.write(e.text);
      } else if (e.type === "tool_use") {
        process.stderr.write(`⚙ ${e.name} ${summarizeInput(e.name, e.input)}\n`);
      } else if (e.type === "tool_result") {
        const mark = e.isError ? "✗" : "✓";
        process.stderr.write(`${mark} ${e.name}\n`);
      } else if (e.type === "retry") {
        process.stderr.write(
          `⟳ retrying (${e.attempt}) in ${Math.round(e.delayMs / 1000)}s — ${e.reason}\n`,
        );
      } else if (e.type === "done") {
        process.stdout.write("\n");
        const s = (e.durationMs / 1000).toFixed(1);
        process.stderr.write(`✓ done ${s}s · ${e.input} in / ${e.output} out\n`);
      }
    }, controller.signal);
  } catch (err) {
    if (controller.signal.aborted) process.exit(130);
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`✗ ${msg}\n`);
    process.exit(1);
  }
}
