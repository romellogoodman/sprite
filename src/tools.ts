import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
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
      "Read the contents of a file at the given relative path. Use this to inspect existing code or configuration before making changes.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative path to the file to read.",
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
      "Edit a file by replacing an exact string match. If the file does not exist and old_str is empty, the file is created with new_str as its contents. old_str must match exactly once in the file. Writes are confined to the current project (the git root); paths outside it are refused.",
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
          description: "Text to replace old_str with, or the full contents when creating a new file.",
        },
      },
      required: ["path", "old_str", "new_str"],
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
      return cap(readFile(String(input.path)));
    case "list_files":
      return cap(listFiles(input.path ? String(input.path) : "."));
    case "edit_file":
      return editFile(
        String(input.path),
        String(input.old_str),
        String(input.new_str),
      );
    case "bash":
      return cap(await runBash(String(input.command), ctx));
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
  return bash(command);
}

function readFile(relPath: string): string {
  return fs.readFileSync(relPath, "utf8");
}

function listFiles(relPath: string): string {
  const entries = fs.readdirSync(relPath, { withFileTypes: true });
  const names = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
  return JSON.stringify(names, null, 2);
}

function editFile(relPath: string, oldStr: string, newStr: string): string {
  assertWritable(relPath);
  const exists = fs.existsSync(relPath);

  if (!exists) {
    if (oldStr !== "") {
      throw new Error(`File not found: ${relPath}`);
    }
    fs.mkdirSync(path.dirname(relPath), { recursive: true });
    fs.writeFileSync(relPath, newStr, "utf8");
    return `Created ${relPath}`;
  }

  const content = fs.readFileSync(relPath, "utf8");

  if (oldStr === "") {
    throw new Error(
      `File ${relPath} already exists; provide a non-empty old_str to edit it.`,
    );
  }

  const occurrences = content.split(oldStr).length - 1;
  if (occurrences === 0) {
    throw new Error(`old_str not found in ${relPath}`);
  }
  if (occurrences > 1) {
    throw new Error(
      `old_str matched ${occurrences} times in ${relPath}; provide a more specific string.`,
    );
  }

  fs.writeFileSync(relPath, content.replace(oldStr, () => newStr), "utf8");
  return `Edited ${relPath}\n${renderDiff(content, oldStr, newStr)}`;
}

function renderDiff(content: string, oldStr: string, newStr: string): string {
  const idx = content.indexOf(oldStr);
  const startLine = content.slice(0, idx).split("\n").length;
  const minus = oldStr.split("\n").map((l) => `- ${l}`);
  const plus = newStr.split("\n").map((l) => `+ ${l}`);
  return [`@@ line ${startLine} @@`, ...minus, ...plus].join("\n");
}

export function bash(command: string): string {
  const result = spawnSync(command, {
    shell: true,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 10 * 1024 * 1024,
  });

  if (result.error) {
    throw result.error;
  }

  const out = [result.stdout, result.stderr].filter(Boolean).join("");
  if (result.signal) {
    throw new Error(`killed by ${result.signal}\n${out || "(no output)"}`);
  }
  if (result.status !== 0) {
    return `[exit ${result.status}]\n${out || "(no output)"}`;
  }
  return out || "(no output)";
}
