#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const tsx = join(root, "node_modules", ".bin", "tsx");
const tsconfig = join(root, "tsconfig.json");
const entry = join(root, "src", "cli.tsx");

const { status } = spawnSync(
  tsx,
  ["--tsconfig", tsconfig, entry, ...process.argv.slice(2)],
  { stdio: "inherit" },
);
process.exit(status ?? 1);
