/**
 * sprite as a library. The agent loop is runTurn(); everything else here is
 * what you need to feed it and read its events. There's no build step —
 * consume with a TS-aware runtime (tsx, bun, ts-node).
 *
 *   import { runTurn, headlessContext, loadApiKey } from "sprite";
 *
 *   await runTurn(loadApiKey()!, [], "explain this repo",
 *     headlessContext({ trust: true }),
 *     (e) => { if (e.type === "text") process.stdout.write(e.text); },
 *   );
 */

export {
  runTurn,
  compactHistory,
  buildSystemPrompt,
  model,
  contextWindow,
  type AgentEvent,
} from "./agent.js";

export {
  headlessContext,
  executeTool,
  summarizeInput,
  type ToolContext,
  type PermissionMode,
  type BashApproval,
} from "./tools.js";

export { loadApiKey } from "./config.js";
