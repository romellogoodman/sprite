#!/usr/bin/env node
import { render } from "ink";
import { App } from "./ui/App.js";
import { runPrint } from "./print.js";

const argv = process.argv.slice(2);
const trust = argv.includes("--trust");
const cont = argv.includes("-c") || argv.includes("--continue");

const modelIdx = argv.indexOf("--model");
if (modelIdx !== -1 && argv[modelIdx + 1]) {
  process.env.SPRITE_MODEL = argv[modelIdx + 1];
}

const pIdx = argv.findIndex((a) => a === "-p" || a === "--print");
const pArg =
  pIdx === -1 ? "" : argv.slice(pIdx + 1).filter((a) => !a.startsWith("-")).join(" ");

async function readStdin(): Promise<string> {
  let s = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) s += chunk;
  return s.trim();
}

if (!process.stdin.isTTY) {
  // Piped input: `git diff | sprite -p "review"` or bare `echo "hi" | sprite`.
  const piped = await readStdin();
  const prompt = [pArg, piped].filter(Boolean).join("\n\n");
  if (!prompt) {
    process.stderr.write("Usage: sprite -p <prompt>  (or pipe to stdin)\n");
    process.exit(1);
  }
  await runPrint(prompt, trust);
} else if (pIdx !== -1) {
  if (!pArg) {
    process.stderr.write("Usage: sprite -p <prompt>\n");
    process.exit(1);
  }
  await runPrint(pArg, trust);
} else {
  render(<App trust={trust} resume={cont} />);
}
