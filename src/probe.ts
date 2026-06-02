/**
 * Model-behavior probe: `npm run probe` (optionally `-- --model <id>`).
 *
 * Ported from lca's probe harness. Runs a small battery of real requests
 * against the Anthropic API and records what actually happened — tool-call
 * fidelity, tool-result round trips, thinking behavior, prompt-cache hits,
 * stop_reason at the token cap — so assumptions baked into agent.ts and
 * models.ts can be re-checked whenever a new model or SDK version lands.
 * Reports go to docs/probes/.
 *
 * Costs a handful of small requests against the configured model.
 */

import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { loadApiKey } from "./config.js";
import { findModel } from "./models.js";

type ProbeResult = {
  name: string;
  outcome: string;
  detail: string;
  durationMs: number;
};

const results: ProbeResult[] = [];

function record(name: string, outcome: string, detail: string, durationMs: number): void {
  results.push({ name, outcome, detail, durationMs });
  const pad = name.padEnd(36);
  console.log(`  ${pad} ${outcome}${detail ? `  (${detail})` : ""}`);
}

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const WEATHER_TOOL: Anthropic.Tool = {
  name: "get_weather",
  description: "Get the current weather for a city.",
  input_schema: {
    type: "object",
    properties: { city: { type: "string", description: "City name" } },
    required: ["city"],
  },
};

function textOf(resp: Anthropic.Message): string {
  return resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

function toolUsesOf(resp: Anthropic.Message): Anthropic.ToolUseBlock[] {
  return resp.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
}

async function main(): Promise<void> {
  const apiKey = loadApiKey();
  if (!apiKey) {
    console.error("No API key. Set ANTHROPIC_API_KEY or log in via sprite first.");
    process.exit(1);
  }
  const model = argValue("--model") || process.env.SPRITE_MODEL || "claude-haiku-4-5";
  const client = new Anthropic({ apiKey });

  console.log(`sprite probe — model ${model}\n`);

  // 1. Plain generation.
  try {
    const start = Date.now();
    const r = await client.messages.create({
      model,
      max_tokens: 50,
      messages: [{ role: "user", content: "Reply with exactly: ok" }],
    });
    record(
      "plain generation",
      textOf(r).toLowerCase().includes("ok") ? "ok" : "unexpected",
      `stop_reason=${r.stop_reason}, out=${r.usage.output_tokens} tok`,
      Date.now() - start,
    );
  } catch (err) {
    console.error(`\nFirst request failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  // 2. Tool call fidelity.
  try {
    const start = Date.now();
    const r = await client.messages.create({
      model,
      max_tokens: 300,
      tools: [WEATHER_TOOL],
      messages: [{ role: "user", content: "Use the get_weather tool to check the weather in Tokyo." }],
    });
    const uses = toolUsesOf(r);
    record(
      "tool call (simple)",
      uses.length > 0 ? "tool_use emitted" : "NO tool call",
      uses.length > 0
        ? `${uses[0].name}(${JSON.stringify(uses[0].input)})`
        : textOf(r).slice(0, 60).replace(/\n/g, " "),
      Date.now() - start,
    );

    // 3. Tool-result round trip (reuses the call above when present).
    if (uses.length > 0) {
      const start2 = Date.now();
      const r2 = await client.messages.create({
        model,
        max_tokens: 200,
        tools: [WEATHER_TOOL],
        messages: [
          { role: "user", content: "Use the get_weather tool to check the weather in Tokyo, then tell me in one short sentence." },
          { role: "assistant", content: r.content },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: uses[0].id, content: "Tokyo: 18C, light rain" },
            ],
          },
        ],
      });
      const used = /18|rain/i.test(textOf(r2));
      record(
        "tool result round trip",
        used ? "result used in answer" : "result IGNORED",
        textOf(r2).slice(0, 60).replace(/\n/g, " "),
        Date.now() - start2,
      );
    }
  } catch (err) {
    record("tool call (simple)", "error", String(err instanceof Error ? err.message : err), 0);
  }

  // 4. Adaptive thinking accepted? (agent.ts sends this for opus/sonnet-4-6+)
  try {
    const start = Date.now();
    const r = await client.messages.create({
      model,
      max_tokens: 2000,
      thinking: { type: "adaptive" } as Anthropic.MessageCreateParams["thinking"],
      messages: [{ role: "user", content: "What is 17 * 23? Reply with just the number." }],
    });
    const thought = r.content.some((b) => b.type === "thinking");
    record(
      "adaptive thinking",
      thought ? "thinking block produced" : "accepted, no thinking block",
      `out=${r.usage.output_tokens} tok`,
      Date.now() - start,
    );
  } catch (err) {
    record(
      "adaptive thinking",
      "REJECTED",
      String(err instanceof Error ? err.message : err).slice(0, 80),
      0,
    );
  }

  // 5. Prompt caching: same big system prefix twice; second call should
  // report cache_read_input_tokens > 0. Mirrors how agent.ts marks the
  // system block. Cache minimum is ~1-4K tokens depending on model.
  try {
    const bigSystem = "You are a test assistant. " + "Background context. ".repeat(400);
    const params: Anthropic.MessageCreateParams = {
      model,
      max_tokens: 20,
      system: [{ type: "text", text: bigSystem, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: "Reply with exactly: ok" }],
    };
    const start = Date.now();
    const r1 = await client.messages.create(params);
    const r2 = await client.messages.create(params);
    const wrote = r1.usage.cache_creation_input_tokens ?? 0;
    const read = r2.usage.cache_read_input_tokens ?? 0;
    record(
      "prompt caching",
      read > 0 ? "cache HIT on 2nd call" : wrote > 0 ? "wrote but no hit" : "NOT CACHED",
      `created=${wrote}, read=${read}`,
      Date.now() - start,
    );
  } catch (err) {
    record("prompt caching", "error", String(err instanceof Error ? err.message : err), 0);
  }

  // 6. stop_reason at the cap.
  try {
    const start = Date.now();
    const r = await client.messages.create({
      model,
      max_tokens: 30,
      messages: [{ role: "user", content: "Count from 1 to 200, one number per line." }],
    });
    record(
      "stop_reason at max_tokens cap",
      r.stop_reason === "max_tokens" ? "reports 'max_tokens'" : `reports '${r.stop_reason}'`,
      `out=${r.usage.output_tokens} tok`,
      Date.now() - start,
    );
  } catch (err) {
    record("stop_reason at max_tokens cap", "error", String(err instanceof Error ? err.message : err), 0);
  }

  // Write the report.
  const date = new Date().toISOString().slice(0, 10);
  const slug = model.replace(/[^a-z0-9.]+/gi, "-");
  const dir = path.join(process.cwd(), "docs", "probes");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${date}-${slug}.md`);
  const known = findModel(model);
  const lines = [
    `# Probe: ${model} via Anthropic API`,
    "",
    `- Date: ${date}`,
    `- In catalog: ${known ? `yes (${known.label}, ${known.contextWindow.toLocaleString()} ctx)` : "no (falls back to 200K ctx)"}`,
    "",
    "| Probe | Outcome | Detail | ms |",
    "|---|---|---|---|",
    ...results.map((r) => `| ${r.name} | ${r.outcome} | ${r.detail.replace(/\|/g, "\\|")} | ${r.durationMs || ""} |`),
    "",
    "## Implications for sprite",
    "",
    "- If `adaptive thinking` is REJECTED, fix the model match in `modelParams()` (agent.ts).",
    "- If `prompt caching` shows NOT CACHED, check `cachedSystem`/`cachedTools`/`withCacheMarker` in agent.ts and the model's cache minimum.",
    "- If `tool result round trip` shows IGNORED, the model/tool-description combination needs work in tools.ts.",
    "",
  ];
  fs.writeFileSync(file, lines.join("\n"));
  console.log(`\nReport written to ${path.relative(process.cwd(), file)}`);
}

main().catch((err) => {
  console.error(`probe failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
