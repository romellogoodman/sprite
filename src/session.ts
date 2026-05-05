import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { configDir } from "./config.js";

function cwdSlug(cwd: string): string {
  const real = fs.realpathSync(cwd);
  const hash = crypto.createHash("sha256").update(real).digest("hex").slice(0, 12);
  return `${path.basename(real)}-${hash}`;
}

function sessionDir(cwd: string): string {
  return path.join(configDir(), "sessions", cwdSlug(cwd));
}

export type Session = {
  file: string;
  save: (history: Anthropic.MessageParam[]) => void;
};

/**
 * Start a new session file for this cwd. Returns a save() that rewrites the
 * file with the full history as JSONL. Rewriting is fine at sprite's scale
 * and means the file is always a consistent snapshot.
 */
export function startSession(cwd: string = process.cwd()): Session {
  const dir = sessionDir(cwd);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
  return {
    file,
    save(history) {
      const body = history.map((m) => JSON.stringify(m)).join("\n") + "\n";
      fs.writeFileSync(file, body, { mode: 0o600 });
    },
  };
}

/** Load the most recent session's history for this cwd, or [] if none. */
export function loadLastSession(cwd: string = process.cwd()): Anthropic.MessageParam[] {
  const dir = sessionDir(cwd);
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort();
  } catch {
    return [];
  }
  const last = files[files.length - 1];
  if (!last) return [];
  try {
    return fs
      .readFileSync(path.join(dir, last), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Anthropic.MessageParam);
  } catch {
    return [];
  }
}
