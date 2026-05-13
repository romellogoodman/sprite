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

// --- per-project notes ---
// Lives in the user config dir, not the repo, so a cloned repo can't pre-seed
// it and edit_file (which refuses the config dir) can't reach it. Writes go
// through the save_note tool, which prompts for approval.

/** Path to this project's notes file. Keyed by absolute cwd like the bash allowlist. */
export function notesPath(cwd: string = process.cwd()): string {
  return path.join(configDir(), "notes", `${cwdSlug(cwd)}.md`);
}

/** Read this project's notes, or "" if none. */
export function loadNotes(cwd: string = process.cwd()): string {
  try {
    return fs.readFileSync(notesPath(cwd), "utf8").trim();
  } catch {
    return "";
  }
}

// Hard cap so a note stays a one-liner and can't quietly eat the context budget.
const NOTE_MAX = 200;

/**
 * Collapse a model-proposed note to one line of printable text. Strips ANSI
 * escape sequences and all C0/C1 control chars so what NoteConfirm renders is
 * byte-for-byte what lands in the file — a `\r` or `ESC[K` can't hide part of
 * the note from the approval prompt. The same function runs on the way to the
 * display and the way to disk, so there's one definition of "clean."
 */
export function sanitizeNote(raw: string): string {
  return raw
    // CSI sequences ("\x1b[...m", "\x1b[2K", …) removed wholesale so the
    // payload doesn't leave stray "[2K" garbage behind.
    .replace(/\x1b\[[0-9;:?<=>]*[!-/]*[@-~]/g, "")
    // Any remaining C0/C1 control char (lone ESC, CR, BS, DEL, 0x80-0x9f).
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, NOTE_MAX)
    .trim();
}

/** Append a note as a bullet line. Creates the file and its directory lazily. */
export function appendNote(note: string, cwd: string = process.cwd()): string {
  const clean = sanitizeNote(note);
  if (!clean) throw new Error("appendNote: note is empty after sanitization.");
  const file = notesPath(cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, `- ${clean}\n`, { mode: 0o600 });
  return file;
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
