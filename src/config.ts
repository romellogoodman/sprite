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

// --- project-local settings (.sprite/settings.json in cwd) ---

const PROJECT_DIR = path.join(process.cwd(), ".sprite");
const PROJECT_SETTINGS = path.join(PROJECT_DIR, "settings.json");

type ProjectSettings = {
  allowBash?: string[];
};

function readProjectSettings(): ProjectSettings {
  try {
    return JSON.parse(fs.readFileSync(PROJECT_SETTINGS, "utf8")) as ProjectSettings;
  } catch {
    return {};
  }
}

function writeProjectSettings(s: ProjectSettings): void {
  fs.mkdirSync(PROJECT_DIR, { recursive: true });
  fs.writeFileSync(PROJECT_SETTINGS, JSON.stringify(s, null, 2) + "\n");
}

export function isBashAllowed(command: string): boolean {
  const allow = readProjectSettings().allowBash ?? [];
  return allow.some((prefix) => command.startsWith(prefix));
}

export function allowBashPrefix(prefix: string): void {
  const s = readProjectSettings();
  const allow = s.allowBash ?? [];
  if (!allow.includes(prefix)) allow.push(prefix);
  writeProjectSettings({ ...s, allowBash: allow });
}

/** Suggest a reasonable prefix to save for "always allow": first two words. */
export function suggestBashPrefix(command: string): string {
  const parts = command.trim().split(/\s+/);
  return parts.slice(0, 2).join(" ");
}
