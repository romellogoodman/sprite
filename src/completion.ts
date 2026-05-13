import fs from "node:fs";
import path from "node:path";
import { BUILTIN_COMMANDS, listCommands } from "./commands.js";

export type Completion = {
  value: string;
  desc?: string;
};

const SKIP_DIRS = new Set(["node_modules", "dist", "build", "coverage"]);

let fileCache: string[] | null = null;

/**
 * Drop the memoized file list so the next @-completion re-walks the tree.
 * Called from edit_file when a new file lands; bash-created files are a
 * smaller gap and restarting sprite or /clear picks them up.
 */
export function invalidateFileCache(): void {
  fileCache = null;
}

/** Recursive relative-path listing of cwd, skipping common junk dirs. */
export function listProjectFiles(root: string = process.cwd()): string[] {
  if (fileCache) return fileCache;
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    if (out.length > 5000) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") && e.name !== ".env") continue;
      const r = rel ? path.posix.join(rel, e.name) : e.name;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        out.push(r + "/");
        walk(path.join(dir, e.name), r);
      } else {
        out.push(r);
      }
    }
  };
  walk(root, "");
  fileCache = out;
  return out;
}

/**
 * Cheap fuzzy match: characters of `query` must appear in order in the
 * candidate. Ranks by (contiguous prefix > contiguous substring > scattered)
 * and then by length. Good enough for a file picker.
 */
export function fuzzy(candidates: string[], query: string): string[] {
  if (!query) return candidates.slice(0, 50);
  const q = query.toLowerCase();
  const scored: Array<[number, string]> = [];
  for (const c of candidates) {
    const lc = c.toLowerCase();
    let s: number;
    if (lc.startsWith(q)) s = 0;
    else if (lc.includes(q)) s = 1;
    else if (subseq(lc, q)) s = 2;
    else continue;
    scored.push([s * 1000 + c.length, c]);
  }
  scored.sort((a, b) => a[0] - b[0]);
  return scored.slice(0, 50).map(([, c]) => c);
}

function subseq(s: string, q: string): boolean {
  let i = 0;
  for (const ch of s) {
    if (ch === q[i]) i++;
    if (i === q.length) return true;
  }
  return false;
}

export type Trigger =
  | { type: "slash"; query: string; start: number; end: number }
  | { type: "at"; query: string; start: number; end: number };

/** Find an active @/​slash trigger at the cursor, or null. */
export function findTrigger(value: string, cursor: number): Trigger | null {
  if (value.startsWith("/") && !value.slice(0, cursor).includes(" ")) {
    const end = value.indexOf(" ");
    return {
      type: "slash",
      query: value.slice(1, end === -1 ? undefined : end),
      start: 0,
      end: end === -1 ? value.length : end,
    };
  }
  let start = cursor;
  while (start > 0 && !/\s/.test(value[start - 1]!)) start--;
  let end = cursor;
  while (end < value.length && !/\s/.test(value[end]!)) end++;
  const token = value.slice(start, end);
  if (token.startsWith("@")) {
    return { type: "at", query: token.slice(1), start, end };
  }
  return null;
}

export function getCompletions(t: Trigger): Completion[] {
  if (t.type === "slash") {
    const q = t.query.toLowerCase();
    const all: Completion[] = [
      ...BUILTIN_COMMANDS.map((c) => ({ value: "/" + c.name, desc: c.desc })),
      ...listCommands().map((name) => ({ value: "/" + name, desc: "custom" })),
    ];
    return all.filter((c) => c.value.slice(1).startsWith(q));
  }
  return fuzzy(listProjectFiles(), t.query).map((f) => ({ value: "@" + f }));
}
