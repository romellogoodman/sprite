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

// Each /clear and each launch writes a new JSONL; without a cap the per-project
// directory grows forever. Keep a generous tail and drop the rest.
const KEEP_SESSIONS = 20;

function pruneSessions(dir: string): void {
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort();
  } catch {
    return;
  }
  for (const old of files.slice(0, Math.max(0, files.length - KEEP_SESSIONS))) {
    try {
      fs.unlinkSync(path.join(dir, old));
    } catch {
      // best effort
    }
  }
}

/**
 * Start a new session file for this cwd. Returns a save() that rewrites the
 * file with the full history as JSONL. Rewriting is fine at sprite's scale
 * and means the file is always a consistent snapshot.
 */
export function startSession(cwd: string = process.cwd()): Session {
  const dir = sessionDir(cwd);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  pruneSessions(dir);
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
  let messages: Anthropic.MessageParam[];
  try {
    messages = fs
      .readFileSync(path.join(dir, last), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Anthropic.MessageParam);
  } catch {
    return [];
  }
  // A mid-turn checkpoint can leave the file ending on a tool_result batch
  // (role: user, array content). The API requires roles to alternate, so
  // close the interrupted turn rather than dropping the tool work.
  const tail = messages[messages.length - 1];
  if (tail?.role === "user" && Array.isArray(tail.content)) {
    messages.push({
      role: "assistant",
      content: "(session was interrupted mid-turn and resumed)",
    });
  }
  return messages;
}
