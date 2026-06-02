import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findTrigger, fuzzy, getCompletions, listProjectFiles, invalidateFileCache } from "./completion.js";

describe("findTrigger", () => {
  test("leading slash triggers command completion", () => {
    const t = findTrigger("/com", 4);
    assert.deepEqual(t, { type: "slash", query: "com", start: 0, end: 4 });
  });

  test("slash with a space after the command is no longer a trigger", () => {
    assert.equal(findTrigger("/model llama", 12), null);
  });

  test("@token at the cursor triggers file completion", () => {
    const t = findTrigger("see @src/ind please", 11);
    assert.deepEqual(t, { type: "at", query: "src/ind", start: 4, end: 12 });
  });

  test("plain text yields no trigger", () => {
    assert.equal(findTrigger("hello world", 5), null);
  });
});

describe("fuzzy", () => {
  const files = ["src/index.ts", "src/config.ts", "README.md", "docs/intro.md"];

  test("prefix matches rank first", () => {
    assert.equal(fuzzy(files, "src")[0], "src/index.ts");
  });

  test("substring beats scattered subsequence", () => {
    const out = fuzzy(files, "config");
    assert.equal(out[0], "src/config.ts");
  });

  test("subsequence still matches", () => {
    assert.ok(fuzzy(files, "rdme").includes("README.md"));
  });

  test("no match returns empty", () => {
    assert.deepEqual(fuzzy(files, "zzz"), []);
  });

  test("empty query returns capped passthrough", () => {
    assert.deepEqual(fuzzy(files, ""), files);
  });
});

describe("getCompletions / listProjectFiles", () => {
  test("slash completions filter built-ins by prefix", () => {
    const out = getCompletions({ type: "slash", query: "c", start: 0, end: 2 });
    const names = out.map((c) => c.value);
    assert.ok(names.includes("/clear"));
    assert.ok(names.includes("/compact"));
    assert.ok(!names.includes("/model"));
  });

  test("file listing skips junk dirs and caches until invalidated", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sprite-completion-test-"));
    try {
      fs.mkdirSync(path.join(dir, "node_modules", "x"), { recursive: true });
      fs.mkdirSync(path.join(dir, "src"));
      fs.writeFileSync(path.join(dir, "src", "a.ts"), "");
      invalidateFileCache();
      const files = listProjectFiles(dir);
      assert.ok(files.includes("src/a.ts"));
      assert.ok(!files.some((f) => f.startsWith("node_modules")));
      // Cached: a new file doesn't appear until invalidated.
      fs.writeFileSync(path.join(dir, "src", "b.ts"), "");
      assert.ok(!listProjectFiles(dir).includes("src/b.ts"));
      invalidateFileCache();
      assert.ok(listProjectFiles(dir).includes("src/b.ts"));
    } finally {
      invalidateFileCache();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
