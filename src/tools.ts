import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type Anthropic from "@anthropic-ai/sdk";
import { configDir } from "./config.js";

/** The directory edits are confined to: the git root above cwd, or cwd itself. */
function workspaceRoot(): string {
  let dir = process.cwd();
  for (;;) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
}

const WORKSPACE = workspaceRoot();
const CONFIG_DIR = configDir();

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** Refuse writes outside the workspace or anywhere under sprite's own config. */
function assertWritable(relPath: string): string {
  const abs = path.resolve(relPath);
  if (isInside(abs, CONFIG_DIR) || abs === CONFIG_DIR) {
    throw new Error(`Refusing to edit sprite's own config: ${abs}`);
  }
  if (!isInside(abs, WORKSPACE) && abs !== WORKSPACE) {
    throw new Error(
      `Refusing to edit outside the workspace (${WORKSPACE}): ${abs}`,
    );
  }
  return abs;
}

export const tools: Anthropic.Tool[] = [
  {
    name: "read_file",
    description:
      "Read a file at the given relative path. Returns up to 2000 lines; for larger files pass offset/limit to page through it. Use this to inspect existing code or configuration before making changes.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative path to the file to read.",
        },
        offset: {
          type: "number",
          description:
            "1-based line number to start reading from. Defaults to 1.",
        },
        limit: {
          type: "number",
          description:
            "Maximum number of lines to return. Defaults to 2000.",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "list_files",
    description:
      "List files and directories at the given relative path (non-recursive). Directories are suffixed with '/'. Omit path to list the current working directory.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Relative directory path to list. Defaults to '.' if omitted.",
        },
      },
      required: [],
    },
  },
  {
    name: "edit_file",
    description:
      "Edit a file by replacing exact string matches. Pass old_str/new_str for a single edit, or an edits array for several non-overlapping edits in one call (e.g. renaming a symbol at every occurrence). Each old_str must match exactly once in the file as it is on disk. If the file does not exist, pass a single empty old_str and the file is created with new_str as its contents. Writes are confined to the current project (the git root); paths outside it are refused.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative path to the file to edit or create.",
        },
        old_str: {
          type: "string",
          description:
            "Exact text to replace. Must appear exactly once. Use an empty string to create a new file.",
        },
        new_str: {
          type: "string",
          description:
            "Text to replace old_str with, or the full contents when creating a new file.",
        },
        edits: {
          type: "array",
          description:
            "Multiple edits to apply atomically. Each old_str is matched against the file as it is before any edits are applied; edits must not overlap. Use this instead of old_str/new_str when changing several places at once.",
          items: {
            type: "object",
            properties: {
              old_str: { type: "string" },
              new_str: { type: "string" },
            },
            required: ["old_str", "new_str"],
          },
        },
      },
      required: ["path"],
    },
  },
  {
    name: "bash",
    description:
      "Run a shell command in the current working directory and return its combined stdout/stderr. Use this for anything the file tools can't do: grep, git, running tests, installing packages, etc. Commands time out after 120s.",
    input_schema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The shell command to execute.",
        },
      },
      required: ["command"],
    },
  },
];

type ToolInput = Record<string, unknown>;

const MAX_OUTPUT = 50_000;

function cap(s: string): string {
  if (s.length <= MAX_OUTPUT) return s;
  const half = Math.floor(MAX_OUTPUT / 2);
  const omitted = s.length - 2 * half;
  return `${s.slice(0, half)}\n\n[... ${omitted} bytes truncated by sprite ...]\n\n${s.slice(-half)}`;
}

/**
 * For bash output the end is what matters (errors, test summaries), so keep
 * the tail. The full output is spilled to a temp file so the model can grep
 * or `sed -n` it if the truncated part turns out to matter.
 */
function capTail(s: string): string {
  if (s.length <= MAX_OUTPUT) return s;
  const spill = path.join(
    os.tmpdir(),
    `sprite-bash-${randomUUID().slice(0, 8)}.log`,
  );
  fs.writeFileSync(spill, s, "utf8");
  // Start the tail at a line boundary so the first visible line isn't torn.
  let cut = s.length - MAX_OUTPUT;
  const nl = s.indexOf("\n", cut);
  if (nl !== -1 && nl < s.length - 1) cut = nl + 1;
  const omitted = cut;
  return (
    `[${omitted} bytes truncated; showing the tail. Full output: ${spill}]\n` +
    s.slice(cut)
  );
}

export type BashApproval = "yes" | "always" | "no";

export type ToolContext = {
  /** Skip all confirmations (--trust). */
  trust: boolean;
  /** Ask the user to approve a bash command. Returns their choice. */
  confirmBash: (command: string) => Promise<BashApproval>;
  /** Persist a prefix to the project allowlist. */
  allowPrefix: (prefix: string) => void;
  /** Check the project allowlist. */
  isAllowed: (command: string) => boolean;
  /** Derive a prefix to save for "always". */
  suggestPrefix: (command: string) => string;
};

export async function executeTool(
  name: string,
  input: ToolInput,
  ctx: ToolContext,
): Promise<string> {
  switch (name) {
    case "read_file":
      return cap(
        readFile(
          String(input.path),
          input.offset == null ? undefined : Number(input.offset),
          input.limit == null ? undefined : Number(input.limit),
        ),
      );
    case "list_files":
      return cap(listFiles(input.path ? String(input.path) : "."));
    case "edit_file": {
      const edits = Array.isArray(input.edits)
        ? (input.edits as Array<{ old_str: unknown; new_str: unknown }>).map(
            (e) => ({ old_str: String(e.old_str), new_str: String(e.new_str) }),
          )
        : [{ old_str: String(input.old_str), new_str: String(input.new_str) }];
      return editFile(String(input.path), edits);
    }
    case "bash":
      return capTail(await runBash(String(input.command), ctx));
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function runBash(command: string, ctx: ToolContext): Promise<string> {
  if (!ctx.trust && !ctx.isAllowed(command)) {
    const choice = await ctx.confirmBash(command);
    if (choice === "no") {
      throw new Error("Command denied by user.");
    }
    if (choice === "always") {
      ctx.allowPrefix(ctx.suggestPrefix(command));
    }
  }
  return await bash(command);
}

function readFile(relPath: string, offset = 1, limit = 2000): string {
  const content = fs.readFileSync(relPath, "utf8");
  const lines = content.split("\n");
  const total = lines.length;
  const start = Math.max(1, offset);
  const end = Math.min(total, start + limit - 1);
  if (start === 1 && end >= total) return content;
  if (start > total) {
    return `[File has ${total} lines; offset ${offset} is past the end.]`;
  }
  const slice = lines.slice(start - 1, end).join("\n");
  const more =
    end < total ? ` Use offset=${end + 1} to continue.` : "";
  return `[Lines ${start}-${end} of ${total}.${more}]\n${slice}`;
}

function listFiles(relPath: string): string {
  const entries = fs.readdirSync(relPath, { withFileTypes: true });
  const names = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
  return JSON.stringify(names, null, 2);
}

const toLF = (s: string) => s.replace(/\r\n/g, "\n");

type EditPair = { old_str: string; new_str: string };

function editFile(relPath: string, edits: EditPair[]): string {
  assertWritable(relPath);
  if (edits.length === 0) throw new Error("No edits provided.");
  const exists = fs.existsSync(relPath);

  if (!exists) {
    if (edits.length > 1 || edits[0].old_str !== "") {
      throw new Error(`File not found: ${relPath}`);
    }
    fs.mkdirSync(path.dirname(relPath), { recursive: true });
    fs.writeFileSync(relPath, edits[0].new_str, "utf8");
    return `Created ${relPath}`;
  }

  // Match and edit on LF-normalized text so CRLF files still match old_str
  // coming from the model (which is always LF). Remember the original EOL
  // and BOM so we can round-trip them on write.
  const raw = fs.readFileSync(relPath, "utf8");
  const hasBOM = raw.charCodeAt(0) === 0xfeff;
  const body = hasBOM ? raw.slice(1) : raw;
  const eol = body.includes("\r\n") ? "\r\n" : "\n";
  const content = toLF(body);

  // Locate every edit against the *original* content so later edits can't
  // accidentally match text an earlier edit inserted. Validate up front; if
  // any edit fails, nothing is written.
  const located = edits.map((e, i) => {
    const oldStr = toLF(e.old_str);
    const newStr = toLF(e.new_str);
    const n = i + 1;
    if (oldStr === "") {
      throw new Error(
        `edit ${n}: file ${relPath} already exists; provide a non-empty old_str to edit it.`,
      );
    }
    const occurrences = content.split(oldStr).length - 1;
    if (occurrences === 0) {
      throw new Error(`edit ${n}: old_str not found in ${relPath}`);
    }
    if (occurrences > 1) {
      throw new Error(
        `edit ${n}: old_str matched ${occurrences} times in ${relPath}; provide a more specific string.`,
      );
    }
    const start = content.indexOf(oldStr);
    return { start, end: start + oldStr.length, oldStr, newStr, n };
  });

  located.sort((a, b) => a.start - b.start);
  for (let i = 1; i < located.length; i++) {
    if (located[i].start < located[i - 1].end) {
      throw new Error(
        `edits ${located[i - 1].n} and ${located[i].n} overlap in ${relPath}; split them or widen the old_str of one.`,
      );
    }
  }

  let edited = content;
  for (let i = located.length - 1; i >= 0; i--) {
    const { start, end, newStr } = located[i];
    edited = edited.slice(0, start) + newStr + edited.slice(end);
  }

  const out =
    (hasBOM ? "\ufeff" : "") +
    (eol === "\r\n" ? edited.replace(/\n/g, "\r\n") : edited);
  fs.writeFileSync(relPath, out, "utf8");

  const diffs = located
    .map((l) => renderDiff(content, l.oldStr, l.newStr))
    .join("\n  \u22ee\n");
  const header =
    edits.length === 1 ? `Edited ${relPath}` : `Edited ${relPath} (${edits.length} edits)`;
  return `${header}\n${diffs}`;
}

function renderDiff(content: string, oldStr: string, newStr: string): string {
  const CTX = 2;
  const fileLines = content.split("\n");
  const idx = content.indexOf(oldStr);
  const start = content.slice(0, idx).split("\n").length; // 1-based
  const oldLines = oldStr.split("\n");
  const newLines = newStr.split("\n");

  const ctxLo = Math.max(1, start - CTX);
  const ctxBefore = fileLines.slice(ctxLo - 1, start - 1);
  const afterIdx = start - 1 + oldLines.length;
  const ctxAfter = fileLines.slice(afterIdx, afterIdx + CTX);

  const maxLn = start + Math.max(oldLines.length, newLines.length) + CTX;
  const w = String(maxLn).length;
  const num = (n: number | "") => String(n).padStart(w);

  const out: string[] = [];
  let ln = ctxLo;
  for (const l of ctxBefore) out.push(`  ${num(ln++)} │ ${l}`);
  for (const l of oldLines) out.push(`- ${num(ln++)} │ ${l}`);
  let nln = start;
  for (const l of newLines) out.push(`+ ${num(nln++)} │ ${l}`);
  for (const l of ctxAfter) out.push(`  ${num(nln++)} │ ${l}`);
  return out.join("\n");
}

/**
 * Kill a process and everything it spawned. `detached: true` below puts the
 * child in its own process group (pgid = pid), so on POSIX a negative pid
 * signals the whole group — otherwise `npm run dev` dies but its node child
 * lives on. Windows has no process groups in the same sense; taskkill /T
 * walks the tree.
 */
function killTree(pid: number): void {
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"]);
    } else {
      process.kill(-pid, "SIGTERM");
      setTimeout(() => {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {}
      }, 2000).unref();
    }
  } catch {}
}

export function bash(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    let out = "";
    let killedBy: string | null = null;
    child.stdout.setEncoding("utf8").on("data", (d) => (out += d));
    child.stderr.setEncoding("utf8").on("data", (d) => (out += d));

    const timer = setTimeout(() => {
      killedBy = "timeout after 120s";
      if (child.pid) killTree(child.pid);
    }, 120_000);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    // 'close' (not 'exit') so stdio is fully drained before we read `out` —
    // otherwise a detached grandchild holding the pipe can truncate output.
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (killedBy) {
        reject(new Error(`killed (${killedBy})\n${out || "(no output)"}`));
      } else if (signal) {
        reject(new Error(`killed by ${signal}\n${out || "(no output)"}`));
      } else if (code !== 0) {
        resolve(`[exit ${code}]\n${out || "(no output)"}`);
      } else {
        resolve(out || "(no output)");
      }
    });
  });
}
