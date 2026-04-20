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
