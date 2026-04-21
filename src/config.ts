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
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
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
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(PROJECTS_PATH, JSON.stringify(p, null, 2) + "\n", {
    mode: 0o600,
  });
}

// Shell control operators — commands containing these always require
// confirmation so an allowed prefix can't be chained into something else.
const SHELL_META = /[;&|`<>\n]|\$\(/;

export function isBashAllowed(command: string): boolean {
  if (SHELL_META.test(command)) return false;
  const allow = readProjects()[projectKey()]?.allowBash ?? [];
  return allow.some((p) => p.trim().length > 0 && command.startsWith(p));
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

/** Suggest a reasonable prefix to save for "always allow": first two words. */
export function suggestBashPrefix(command: string): string {
  const parts = command.trim().split(/\s+/);
  return parts.slice(0, 2).join(" ");
}
