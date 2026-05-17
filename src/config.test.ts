/**
 * Bash sandboxing surface: the shell-meta short-circuit, the
 * prefix-matching rules, and the env narrowing. These are the layers that
 * sit between "the model suggests a command" and "arbitrary code runs with
 * the user's environment," so changes here warrant explicit coverage.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  isBashAllowed,
  suggestBashPrefix,
  isWriteAllowed,
  allowWriteDir,
  suggestWriteDir,
  configDir,
} from "./config.js";
import { resolveBashEnv } from "./tools.js";

describe("isBashAllowed — shell meta always denies", () => {
  // Even if the leading prefix is allowlisted, any of these characters means
  // the command can be chained into something arbitrary.
  const metas = [";", "&", "|", "`", "<", ">", "\n", "$("];
  for (const m of metas) {
    test(`"${JSON.stringify(m)}" in command → denied`, () => {
      assert.equal(isBashAllowed(`git log ${m} rm -rf /`, ["git log"]), false);
    });
  }
  test("plain $VAR (no $( ) is still allowed if prefix matches — meta check is narrow", () => {
    // $VAR expansion is closed by the env whitelist, not by the meta check.
    assert.equal(isBashAllowed("echo $HOME", ["echo"]), true);
  });
});

describe("isBashAllowed — prefix matching", () => {
  test("exact match allowed", () => {
    assert.equal(isBashAllowed("git status", ["git status"]), true);
  });

  test("prefix followed by space allowed", () => {
    assert.equal(isBashAllowed("git log --oneline", ["git log"]), true);
  });

  test("prefix without trailing space is NOT a substring match", () => {
    // "gitx clone" must not be considered allowed just because "git" is.
    assert.equal(isBashAllowed("gitx clone", ["git"]), false);
  });

  test("empty prefix entries ignored", () => {
    assert.equal(isBashAllowed("anything", ["  ", ""]), false);
  });

  test("empty allowlist denies all", () => {
    assert.equal(isBashAllowed("git status", []), false);
  });

  test("multiple prefixes — any match wins", () => {
    assert.equal(
      isBashAllowed("npm run test", ["git log", "npm run"]),
      true,
    );
  });
});

describe("suggestBashPrefix — safe-default heuristics", () => {
  test("subcommand pattern: git log --oneline → git log", () => {
    assert.equal(suggestBashPrefix("git log --oneline"), "git log");
  });

  test("flag after command: rm -rf foo → rm", () => {
    // -rf fails the /^[a-z][\w-]*$/ check; would-be prefix is just "rm".
    assert.equal(suggestBashPrefix("rm -rf foo"), "rm");
  });

  test("path with dot after command: cat foo.txt → cat", () => {
    assert.equal(suggestBashPrefix("cat foo.txt"), "cat");
  });

  test("bare wrapper bash → full command (never a prefix)", () => {
    assert.equal(suggestBashPrefix("bash -c 'evil'"), "bash -c 'evil'");
  });

  test("bare wrapper sudo → full command", () => {
    assert.equal(
      suggestBashPrefix("sudo apt install curl"),
      "sudo apt install curl",
    );
  });

  test("bare wrapper python → full command", () => {
    assert.equal(suggestBashPrefix("python script.py"), "python script.py");
  });

  test("bare wrapper env → full command", () => {
    assert.equal(suggestBashPrefix("env FOO=bar cmd"), "env FOO=bar cmd");
  });

  test("bare wrapper xargs → full command", () => {
    assert.equal(suggestBashPrefix("xargs rm"), "xargs rm");
  });

  test("single-token command → itself", () => {
    assert.equal(suggestBashPrefix("ls"), "ls");
  });

  test("empty input → empty string (not a throw)", () => {
    assert.equal(suggestBashPrefix(""), "");
  });
});

/**
 * resolveBashEnv mutates nothing but reads process.env. Each test snapshots
 * the relevant keys and restores them in a `finally` so tests don't
 * interfere with each other or with the surrounding runner.
 */
function withEnv<T>(
  overrides: Record<string, string | undefined>,
  fn: () => T,
): T {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(overrides)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe("isWriteAllowed — directory-prefix matching", () => {
  test("file directly inside an allowed dir → true", () => {
    assert.equal(isWriteAllowed("/a/b/file.txt", ["/a/b"]), true);
  });

  test("file in a nested subdir of an allowed dir → true", () => {
    assert.equal(isWriteAllowed("/a/b/c/d/file.txt", ["/a/b"]), true);
  });

  test("exact equality with an allowed dir → true (covers dir-as-target case)", () => {
    assert.equal(isWriteAllowed("/a/b", ["/a/b"]), true);
  });

  test("sibling of an allowed dir → false", () => {
    assert.equal(isWriteAllowed("/a/sibling/file.txt", ["/a/b"]), false);
  });

  test("shared-prefix-but-not-ancestor → false (no string-startsWith traps)", () => {
    // "/a/b" must NOT allow "/a/bc/*" — that would be a string-prefix bug.
    assert.equal(isWriteAllowed("/a/bc/file.txt", ["/a/b"]), false);
  });

  test("empty allowlist → false", () => {
    assert.equal(isWriteAllowed("/a/b/file.txt", []), false);
  });

  test("whitespace-only / empty entries ignored", () => {
    assert.equal(isWriteAllowed("/a/b/file.txt", ["", "  "]), false);
  });

  test("multiple prefixes — any match wins", () => {
    assert.equal(
      isWriteAllowed("/tmp/proj/src/file.ts", ["/etc/nope", "/tmp/proj"]),
      true,
    );
  });
});

describe("suggestWriteDir — scope of 'always'", () => {
  // Uses real filesystem under a fresh tempdir so we can exercise the
  // "shallowest non-existing ancestor" logic deterministically.
  let tmp: string;
  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sprite-suggest-"));
  });
  after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("all ancestors exist → immediate parent", () => {
    // tmp exists; a file written directly into tmp gets tmp as the suggestion.
    const target = path.join(tmp, "file.txt");
    assert.equal(suggestWriteDir(target), tmp);
  });

  test("one missing level deep → that missing dir is suggested", () => {
    // tmp/new-proj/ doesn't exist; writing tmp/new-proj/pkg.json suggests
    // tmp/new-proj (the scaffolded root).
    const target = path.join(tmp, "new-proj", "pkg.json");
    assert.equal(suggestWriteDir(target), path.join(tmp, "new-proj"));
  });

  test("two missing levels deep → shallowest new ancestor", () => {
    // Writing tmp/new-proj/src/App.jsx when neither new-proj/ nor src/
    // exists should suggest tmp/new-proj — covers every subsequent write.
    const target = path.join(tmp, "new-proj-2", "src", "App.jsx");
    assert.equal(suggestWriteDir(target), path.join(tmp, "new-proj-2"));
  });
});

/**
 * allowWriteDir writes to the shared projects.json. Each test in this suite
 * snapshots the file, runs, and restores — so running the suite is a no-op
 * on the user's real config (aside from the projects.json mtime).
 */
describe("allowWriteDir — persistence and hard-refusal", () => {
  const projectsPath = path.join(configDir(), "projects.json");
  let snapshot: string | null = null;
  let existed = false;

  before(() => {
    existed = fs.existsSync(projectsPath);
    snapshot = existed ? fs.readFileSync(projectsPath, "utf8") : null;
  });
  after(() => {
    if (existed && snapshot !== null) {
      fs.writeFileSync(projectsPath, snapshot);
    } else if (!existed && fs.existsSync(projectsPath)) {
      fs.unlinkSync(projectsPath);
    }
  });

  test("allowlist equal to CONFIG_DIR is refused (no-op, nothing persisted)", () => {
    // Read state before; call; read after; expect no change.
    const before = fs.existsSync(projectsPath)
      ? fs.readFileSync(projectsPath, "utf8")
      : "";
    allowWriteDir(configDir());
    const after = fs.existsSync(projectsPath)
      ? fs.readFileSync(projectsPath, "utf8")
      : "";
    assert.equal(after, before);
  });

  test("allowlist that is an ancestor of CONFIG_DIR is refused", () => {
    // ~/.config covers ~/.config/sprite, so it must not be persistable.
    const ancestor = path.dirname(configDir());
    const before = fs.existsSync(projectsPath)
      ? fs.readFileSync(projectsPath, "utf8")
      : "";
    allowWriteDir(ancestor);
    const after = fs.existsSync(projectsPath)
      ? fs.readFileSync(projectsPath, "utf8")
      : "";
    assert.equal(after, before);
  });

  test("non-absolute path refused (defensive)", () => {
    const before = fs.existsSync(projectsPath)
      ? fs.readFileSync(projectsPath, "utf8")
      : "";
    allowWriteDir("relative/path");
    const after = fs.existsSync(projectsPath)
      ? fs.readFileSync(projectsPath, "utf8")
      : "";
    assert.equal(after, before);
  });

  test("ordinary dir is persisted under the cwd key, retrievable via isWriteAllowed", () => {
    // Use a synthetic path that's safe to leave in the file — the after()
    // hook restores the snapshot anyway.
    const dir = path.join(os.tmpdir(), `sprite-test-allow-${Date.now()}`);
    assert.equal(isWriteAllowed(path.join(dir, "file.txt")), false);
    allowWriteDir(dir);
    assert.equal(isWriteAllowed(path.join(dir, "file.txt")), true);
    // And sanity: a sibling is NOT covered.
    assert.equal(isWriteAllowed(path.join(os.tmpdir(), "other-tree/file.txt")), false);
  });
});

describe("resolveBashEnv — secret shielding", () => {
  test("default (no trust, no overrides) hides ANTHROPIC_API_KEY", () => {
    withEnv({ ANTHROPIC_API_KEY: "sk-ant-secret" }, () => {
      const env = resolveBashEnv(false);
      assert.equal(env.ANTHROPIC_API_KEY, undefined);
      // Still carries the safe basics.
      assert.ok(env.PATH, "PATH should be forwarded");
      assert.ok(env.HOME, "HOME should be forwarded");
    });
  });

  test("trust=true forwards everything", () => {
    withEnv({ ANTHROPIC_API_KEY: "sk-ant-trust" }, () => {
      const env = resolveBashEnv(true);
      assert.equal(env.ANTHROPIC_API_KEY, "sk-ant-trust");
    });
  });

  test("SPRITE_FULL_ENV=1 forwards everything without trust", () => {
    withEnv(
      { SPRITE_FULL_ENV: "1", ANTHROPIC_API_KEY: "sk-ant-full" },
      () => {
        const env = resolveBashEnv(false);
        assert.equal(env.ANTHROPIC_API_KEY, "sk-ant-full");
      },
    );
  });

  test("SPRITE_EXPOSE_ENV widens only listed vars; others stay hidden", () => {
    withEnv(
      {
        SPRITE_EXPOSE_ENV: "SPRITE_TEST_FOO",
        SPRITE_TEST_FOO: "widened",
        ANTHROPIC_API_KEY: "sk-ant-stillhidden",
      },
      () => {
        const env = resolveBashEnv(false);
        assert.equal(env.SPRITE_TEST_FOO, "widened");
        assert.equal(env.ANTHROPIC_API_KEY, undefined);
      },
    );
  });

  test("SPRITE_EXPOSE_ENV accepts comma-separated list with whitespace", () => {
    withEnv(
      {
        SPRITE_EXPOSE_ENV: " SPRITE_TEST_A , SPRITE_TEST_B ",
        SPRITE_TEST_A: "a",
        SPRITE_TEST_B: "b",
      },
      () => {
        const env = resolveBashEnv(false);
        assert.equal(env.SPRITE_TEST_A, "a");
        assert.equal(env.SPRITE_TEST_B, "b");
      },
    );
  });
});
