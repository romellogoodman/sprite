/**
 * Invariants for edit_file, the highest-blast-radius tool. If this file ever
 * goes quiet under refactor, one bad commit could silently corrupt a user's
 * repo — so these lean on behavior, not implementation.
 *
 * Scratch work lives under .test-tmp/ (gitignored) inside the repo so it's
 * inside the workspace root; paths under /tmp are used to exercise the
 * refusal branch in assertWritable.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { executeTool, headlessContext, type ToolContext } from "./tools.js";
import { configDir } from "./config.js";

const SCRATCH = path.join(process.cwd(), ".test-tmp");
const ctx: ToolContext = { ...headlessContext(), trust: true };

before(() => {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  fs.mkdirSync(SCRATCH, { recursive: true });
});
after(() => {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
});

const abs = (name: string) => path.join(SCRATCH, name);
const rel = (name: string) => path.relative(process.cwd(), abs(name));
const edit = (input: Record<string, unknown>) =>
  executeTool("edit_file", input, ctx);

describe("edit_file — single edit", () => {
  test("unique match replaces once", async () => {
    fs.writeFileSync(abs("one.txt"), "hello world\n");
    const out = await edit({
      path: rel("one.txt"),
      old_str: "world",
      new_str: "sprite",
    });
    assert.equal(fs.readFileSync(abs("one.txt"), "utf8"), "hello sprite\n");
    assert.match(out, /Edited/);
  });

  test("zero matches throws; file untouched", async () => {
    fs.writeFileSync(abs("zero.txt"), "aaa\n");
    await assert.rejects(
      edit({ path: rel("zero.txt"), old_str: "bbb", new_str: "ccc" }),
      /not found/,
    );
    assert.equal(fs.readFileSync(abs("zero.txt"), "utf8"), "aaa\n");
  });

  test("ambiguous match (>1 occurrences) throws with count", async () => {
    fs.writeFileSync(abs("dup.txt"), "foo\nfoo\n");
    await assert.rejects(
      edit({ path: rel("dup.txt"), old_str: "foo", new_str: "bar" }),
      /matched 2 times/,
    );
    assert.equal(fs.readFileSync(abs("dup.txt"), "utf8"), "foo\nfoo\n");
  });
});

describe("edit_file — multi-edit atomicity", () => {
  test("one failing edit aborts the whole batch", async () => {
    fs.writeFileSync(abs("atomic.txt"), "alpha beta gamma\n");
    await assert.rejects(
      edit({
        path: rel("atomic.txt"),
        edits: [
          { old_str: "alpha", new_str: "A" },
          { old_str: "NOPE", new_str: "X" },
        ],
      }),
      /not found/,
    );
    // The valid first edit must NOT have landed.
    assert.equal(
      fs.readFileSync(abs("atomic.txt"), "utf8"),
      "alpha beta gamma\n",
    );
  });

  test("overlapping edits refused", async () => {
    fs.writeFileSync(abs("overlap.txt"), "shared-prefix-tail\n");
    await assert.rejects(
      edit({
        path: rel("overlap.txt"),
        edits: [
          { old_str: "shared-prefix", new_str: "A" },
          { old_str: "prefix-tail", new_str: "B" },
        ],
      }),
      /overlap/,
    );
    assert.equal(
      fs.readFileSync(abs("overlap.txt"), "utf8"),
      "shared-prefix-tail\n",
    );
  });

  test("two non-overlapping edits both apply", async () => {
    fs.writeFileSync(abs("two.txt"), "one\ntwo\nthree\n");
    await edit({
      path: rel("two.txt"),
      edits: [
        { old_str: "one", new_str: "ONE" },
        { old_str: "three", new_str: "THREE" },
      ],
    });
    assert.equal(
      fs.readFileSync(abs("two.txt"), "utf8"),
      "ONE\ntwo\nTHREE\n",
    );
  });
});

describe("edit_file — creation", () => {
  test("empty old_str on missing file creates it (recursive mkdir)", async () => {
    const p = abs("new-dir/nested/new.txt");
    fs.rmSync(path.dirname(abs("new-dir")), { recursive: true, force: true });
    const out = await edit({
      path: rel("new-dir/nested/new.txt"),
      old_str: "",
      new_str: "brand new\n",
    });
    assert.equal(fs.readFileSync(p, "utf8"), "brand new\n");
    assert.match(out, /Created/);
  });

  test("non-empty old_str on missing file refused", async () => {
    const p = abs("missing.txt");
    fs.rmSync(p, { force: true });
    await assert.rejects(
      edit({ path: rel("missing.txt"), old_str: "x", new_str: "y" }),
      /not found/,
    );
    assert.equal(fs.existsSync(p), false);
  });

  test("empty old_str on existing file refused (not a stealth overwrite)", async () => {
    fs.writeFileSync(abs("exists.txt"), "stuff\n");
    await assert.rejects(
      edit({ path: rel("exists.txt"), old_str: "", new_str: "blown away" }),
      /already exists/,
    );
    assert.equal(fs.readFileSync(abs("exists.txt"), "utf8"), "stuff\n");
  });
});

describe("edit_file — encoding round-trips", () => {
  test("CRLF file stays CRLF after LF-formatted edit", async () => {
    fs.writeFileSync(abs("crlf.txt"), "line-a\r\nline-b\r\nline-c\r\n");
    // Model always sends LF; disk must keep CRLF.
    await edit({
      path: rel("crlf.txt"),
      old_str: "line-b",
      new_str: "line-B",
    });
    assert.equal(
      fs.readFileSync(abs("crlf.txt"), "utf8"),
      "line-a\r\nline-B\r\nline-c\r\n",
    );
  });

  test("BOM preserved across edit", async () => {
    fs.writeFileSync(abs("bom.txt"), "﻿hello\n");
    await edit({ path: rel("bom.txt"), old_str: "hello", new_str: "hi" });
    const raw = fs.readFileSync(abs("bom.txt"), "utf8");
    assert.equal(raw.charCodeAt(0), 0xfeff);
    assert.equal(raw.slice(1), "hi\n");
  });
});

describe("edit_file — sandboxing", () => {
  test("path outside workspace refused", async () => {
    const outside = path.join(os.tmpdir(), `sprite-test-${Date.now()}.txt`);
    await assert.rejects(
      edit({ path: outside, old_str: "", new_str: "hi" }),
      /outside the workspace/,
    );
    assert.equal(fs.existsSync(outside), false);
  });

  test("path inside sprite config dir refused", async () => {
    const inside = path.join(configDir(), "hacked.txt");
    await assert.rejects(
      edit({ path: inside, old_str: "", new_str: "hi" }),
      /sprite's own config/,
    );
    // Don't assert non-existence — user's real config dir is off-limits.
  });

  test("plan mode returns refusal string (not a throw)", async () => {
    const planCtx: ToolContext = { ...ctx, getMode: () => "plan" };
    fs.writeFileSync(abs("plan.txt"), "x\n");
    const out = await executeTool(
      "edit_file",
      { path: rel("plan.txt"), old_str: "x", new_str: "y" },
      planCtx,
    );
    assert.match(out, /Refused: plan mode/);
    assert.equal(fs.readFileSync(abs("plan.txt"), "utf8"), "x\n");
  });
});
