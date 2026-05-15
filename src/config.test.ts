/**
 * Bash sandboxing surface: the shell-meta short-circuit, the
 * prefix-matching rules, and the env narrowing. These are the layers that
 * sit between "the model suggests a command" and "arbitrary code runs with
 * the user's environment," so changes here warrant explicit coverage.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isBashAllowed, suggestBashPrefix } from "./config.js";
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
