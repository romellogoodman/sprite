import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_CONFIG_DIR = path.join(os.homedir(), ".config", "sprite");

// SPRITE_CONFIG_DIR overrides the location (read lazily so tests can stub it
// per-run); primarily a test isolation hook.
export function configDir(): string {
  return process.env.SPRITE_CONFIG_DIR || DEFAULT_CONFIG_DIR;
}

export function configPath(): string {
  return path.join(configDir(), "config.json");
}

type Config = {
  apiKey?: string;
};

function readConfig(): Config {
  try {
    return JSON.parse(fs.readFileSync(configPath(), "utf8")) as Config;
  } catch {
    return {};
  }
}

function writeConfig(config: Config): void {
  fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2) + "\n", {
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

// --- per-project bash allowlist, stored in the USER config dir ---
// Keyed by absolute cwd so a cloned repo can't pre-seed its own allowances.

const projectsPath = () => path.join(configDir(), "projects.json");

type ProjectSettings = {
  allowBash?: string[];
  /**
   * Absolute directories in which `edit_file` may write without prompting.
   * Populated by user-approved "always" choices on the write-confirmation
   * prompt. Only consulted for paths outside the workspace; in-workspace
   * writes never touch this list.
   */
  allowWrite?: string[];
};

type ProjectsFile = Record<string, ProjectSettings>;

function projectKey(): string {
  return fs.realpathSync(process.cwd());
}

function readProjects(): ProjectsFile {
  try {
    return JSON.parse(fs.readFileSync(projectsPath(), "utf8")) as ProjectsFile;
  } catch {
    return {};
  }
}

function writeProjects(p: ProjectsFile): void {
  fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(projectsPath(), JSON.stringify(p, null, 2) + "\n", {
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

// --- per-project write allowlist, parallel to the bash one above ---
// Used only for edit_file writes *outside* the workspace. In-workspace writes
// go through without consulting this list. No shell-meta short-circuit —
// filesystem paths don't have shell semantics; a directory-prefix match is
// safe on its own.

/** Does `parent` contain `child` (strictly below it, no equality)? */
function isInsideDir(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Is this absolute path covered by any entry in the write allowlist? The
 * match is by directory-prefix: allow `/a/b` permits writes to `/a/b/c.txt`,
 * `/a/b/sub/d.txt`, etc., but not `/a/sibling` or `/a/bc`.
 *
 * `allow` is injectable for tests (skips the projects.json read).
 */
export function isWriteAllowed(
  absPath: string,
  allow?: readonly string[],
): boolean {
  const dirs =
    allow ?? readProjects()[projectKey()]?.allowWrite ?? [];
  return dirs.some((d) => {
    const dir = d.trim();
    if (!dir) return false;
    return absPath === dir || isInsideDir(dir, absPath);
  });
}

/**
 * Persist a directory as user-approved for out-of-workspace writes.
 *
 * Defense-in-depth: we refuse to store any prefix that would cover the
 * sprite config dir. The edit_file hard-refusal on CONFIG_DIR catches the
 * actual write regardless, but this keeps the allowlist from looking
 * dangerous in `projects.json`, and stops `isWriteAllowed` returning `true`
 * for a path whose write would then throw.
 */
export function allowWriteDir(absDir: string): void {
  const clean = absDir.trim();
  if (!clean || !path.isAbsolute(clean)) return;
  // Refuse any prefix that would allow silent writes to sprite's own
  // config dir (either equal to or an ancestor of CONFIG_DIR). The hard
  // refusal in edit_file catches the write itself, but suppressing the
  // allowlist write too keeps projects.json from encoding a prefix whose
  // implied allowance is a lie.
  const cfg = configDir();
  if (clean === cfg || isInsideDir(clean, cfg)) {
    return;
  }
  const all = readProjects();
  const key = projectKey();
  const entry = all[key] ?? {};
  const allow = entry.allowWrite ?? [];
  if (!allow.includes(clean)) allow.push(clean);
  all[key] = { ...entry, allowWrite: allow };
  writeProjects(all);
}

/**
 * Suggest the directory to save for "always allow writes under …".
 *
 * When the target file's parent chain includes ancestors that don't yet
 * exist, return the shallowest such ancestor — i.e. the directory the write
 * is about to create. This makes scaffolding a new project approvable in
 * one click: the first write under `~/Desktop/new-proj/` (which doesn't
 * exist yet) suggests `~/Desktop/new-proj`, covering every subsequent
 * write into its subtree.
 *
 * When every ancestor already exists, return the immediate parent — the
 * narrowest sensible scope.
 */
export function suggestWriteDir(absFilePath: string): string {
  const immediate = path.dirname(absFilePath);
  let dir = immediate;
  while (true) {
    const parent = path.dirname(dir);
    if (parent === dir) return immediate; // hit filesystem root
    if (fs.existsSync(parent)) return dir;
    dir = parent;
  }
}
