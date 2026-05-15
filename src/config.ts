import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CONFIG_DIR = path.join(os.homedir(), ".config", "sprite");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

type Config = {
  apiKey?: string;
};

function readConfig(): Config {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) as Config;
  } catch {
    return {};
  }
}

function writeConfig(config: Config): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", {
    mode: 0o600,
  });
}

/** Resolve the API key: env var takes precedence, then the config file. */
export function loadApiKey(): string | undefined {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  return readConfig().apiKey;
}

export function saveApiKey(apiKey: string): void {
  writeConfig({ ...readConfig(), apiKey });
}

export function clearApiKey(): void {
  const { apiKey: _discard, ...rest } = readConfig();
  void _discard;
  writeConfig(rest);
}

export function configPath(): string {
  return CONFIG_PATH;
}

export function configDir(): string {
  return CONFIG_DIR;
}

// --- per-project bash allowlist, stored in the USER config dir ---
// Keyed by absolute cwd so a cloned repo can't pre-seed its own allowances.

const PROJECTS_PATH = path.join(CONFIG_DIR, "projects.json");

type ProjectSettings = {
  allowBash?: string[];
};

type ProjectsFile = Record<string, ProjectSettings>;

function projectKey(): string {
  return fs.realpathSync(process.cwd());
}

function readProjects(): ProjectsFile {
  try {
    return JSON.parse(fs.readFileSync(PROJECTS_PATH, "utf8")) as ProjectsFile;
  } catch {
    return {};
  }
}

function writeProjects(p: ProjectsFile): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(PROJECTS_PATH, JSON.stringify(p, null, 2) + "\n", {
    mode: 0o600,
  });
}

// Shell control operators — commands containing these always require
// confirmation so an allowed prefix can't be chained into something else.
const SHELL_META = /[;&|`<>\n]|\$\(/;

/**
 * `allow` is injectable for tests. In the real call path it's read from the
 * per-project entry in projects.json; tests pass their own list to avoid
 * touching ~/.config.
 */
export function isBashAllowed(
  command: string,
  allow?: readonly string[],
): boolean {
  if (SHELL_META.test(command)) return false;
  const cmd = command.trim();
  const prefixes =
    allow ?? readProjects()[projectKey()]?.allowBash ?? [];
  return prefixes.some((p) => {
    const prefix = p.trim();
    if (!prefix) return false;
    return cmd === prefix || cmd.startsWith(prefix + " ");
  });
}

export function allowBashPrefix(prefix: string): void {
  const clean = prefix.trim();
  if (!clean) return;
  const all = readProjects();
  const key = projectKey();
  const entry = all[key] ?? {};
  const allow = entry.allowBash ?? [];
  if (!allow.includes(clean)) allow.push(clean);
  all[key] = { ...entry, allowBash: allow };
  writeProjects(all);
}

// Commands that execute whatever follows them. Allowlisting any of these as
// a prefix is equivalent to allowlisting everything, so we only ever suggest
// the full exact command instead.
const BARE_WRAPPERS = new Set([
  "bash", "sh", "zsh", "fish",
  "sudo", "doas",
  "env", "nice", "nohup", "time", "timeout",
  "xargs", "exec", "eval",
  "python", "python3", "node", "perl", "ruby", "awk", "find",
]);

/**
 * Suggest a prefix to save for "always allow". Uses the second token only
 * when it looks like a subcommand (git log, npm run, cargo build) — not a
 * flag, path, or argument — so `rm -rf foo` suggests `rm`, not `rm -rf`.
 */
export function suggestBashPrefix(command: string): string {
  const parts = command.trim().split(/\s+/);
  const [cmd, arg] = parts;
  if (!cmd) return "";
  if (BARE_WRAPPERS.has(cmd)) return command.trim();
  if (arg && /^[a-z][\w-]*$/.test(arg)) return `${cmd} ${arg}`;
  return cmd;
}
