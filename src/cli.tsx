#!/usr/bin/env node
import { render } from "ink";
import { App } from "./App.js";
import { runPrint } from "./print.js";

const argv = process.argv.slice(2);
const trust = argv.includes("--trust");
const cont = argv.includes("-c") || argv.includes("--continue");

const modelIdx = argv.indexOf("--model");
if (modelIdx !== -1 && argv[modelIdx + 1]) {
  process.env.SPRITE_MODEL = argv[modelIdx + 1];
}

const pIdx = argv.findIndex((a) => a === "-p" || a === "--print");
if (pIdx !== -1) {
  const prompt = argv.slice(pIdx + 1).filter((a) => !a.startsWith("-")).join(" ");
  if (!prompt) {
    process.stderr.write("Usage: sprite -p <prompt>\n");
    process.exit(1);
  }
  await runPrint(prompt, trust);
} else {
  render(<App trust={trust} resume={cont} />);
}
