import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type Anthropic from "@anthropic-ai/sdk";

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
      "Edit a file by replacing an exact string match. If the file does not exist and old_str is empty, the file is created with new_str as its contents. old_str must match exactly once in the file.",
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

export function executeTool(name: string, input: ToolInput): string {
  switch (name) {
    case "read_file":
      return readFile(String(input.path));
    case "list_files":
      return listFiles(input.path ? String(input.path) : ".");
    case "edit_file":
      return editFile(
        String(input.path),
        String(input.old_str),
        String(input.new_str),
      );
    case "bash":
      return bash(String(input.command));
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
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

  fs.writeFileSync(relPath, content.replace(oldStr, newStr), "utf8");
  return `Edited ${relPath}`;
}

function bash(command: string): string {
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
  const exit = result.status ?? (result.signal ? `signal ${result.signal}` : 0);

  if (result.status !== 0) {
    throw new Error(`exit ${exit}\n${out || "(no output)"}`);
  }

  return out || "(no output)";
}
