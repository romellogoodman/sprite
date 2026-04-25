import fs from "node:fs";
import path from "node:path";
import { configDir } from "./config.js";

/**
 * Custom slash commands are plain markdown files whose body is a prompt
 * template. `$ARGS` is replaced with whatever the user typed after the
 * command name; if the body never mentions `$ARGS`, the args are appended
 * on a new line so nothing is lost.
 *
 * Search order: project-local `./.sprite/commands/` first so a repo can
 * override a user's global commands in `~/.config/sprite/commands/`.
 */

const BUILTINS = new Set(["clear", "compact", "logout", "model"]);

function commandDirs(): string[] {
  return [
    path.join(process.cwd(), ".sprite", "commands"),
    path.join(configDir(), "commands"),
  ];
}

export function listCommands(): string[] {
  const names = new Set<string>();
  for (const dir of commandDirs()) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith(".md")) continue;
      const name = e.name.slice(0, -3);
      if (BUILTINS.has(name)) continue;
      names.add(name);
    }
  }
  return [...names].sort();
}

export function resolveCommand(name: string, args: string): string | undefined {
  if (BUILTINS.has(name)) return undefined;
  for (const dir of commandDirs()) {
    try {
      const body = fs.readFileSync(path.join(dir, `${name}.md`), "utf8");
      return body.includes("$ARGS")
        ? body.replaceAll("$ARGS", args)
        : args
          ? `${body.trimEnd()}\n\n${args}`
          : body;
    } catch {
      continue;
    }
  }
  return undefined;
}
