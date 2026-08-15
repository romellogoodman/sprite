/**
 * Invariants for edit_file, the highest-blast-radius tool. If this file ever
 * goes quiet under refactor, one bad commit could silently corrupt a user's
 * repo — so these lean on behavior, not implementation.
 *
 * Scratch work lives under .test-tmp/ (gitignored) inside the repo so it's
 * inside the workspace root (no confirmation gate); paths under /tmp in
 * the "out-of-workspace writes" suite exercise the confirmWrite gate.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  TOOLS,
  executeTool,
  headlessContext,
  type ToolContext,
} from "./tools.js";
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
  test("path inside sprite config dir refused (never gateable)", async () => {
    // This is hard-refusal: --trust can't override it, confirmWrite is never
    // asked, the allowlist can't cover it. If this ever regresses, a
    // model could rewrite projects.json and grant itself silent writes.
    const inside = path.join(configDir(), "hacked.txt");
    await assert.rejects(
      edit({ path: inside, old_str: "", new_str: "hi" }),
      /sprite's own config/,
    );
    // Even with an alternate ctx that approves everything, config dir stays
    // refused.
    const approveAllCtx: ToolContext = {
      ...headlessContext(),
      trust: true,
      confirmWrite: async () => "always",
    };
    await assert.rejects(
      executeTool(
        "edit_file",
        { path: inside, old_str: "", new_str: "hi" },
        approveAllCtx,
      ),
      /sprite's own config/,
    );
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

/**
 * Symlinks are the way a cloned repo reaches outside itself: git stores
 * them, so a hostile checkout can ship `cfg -> ~/.config/sprite`. Every
 * check must run on where the bytes would actually land, not on the
 * lexical spelling under the repo. These were a real bypass before
 * canonicalization was added to the write path.
 */
describe("edit_file — symlinks resolve before every check", () => {
  let outTmp: string;
  before(() => {
    outTmp = fs.mkdtempSync(path.join(os.tmpdir(), "sprite-symlink-"));
  });
  after(() => {
    fs.rmSync(outTmp, { recursive: true, force: true });
  });

  test("in-tree symlink to the config dir is refused (never gateable)", async () => {
    // Works whether or not the config dir exists: a dangling link still
    // canonicalizes to the config path, which is what the refusal keys on.
    fs.symlinkSync(configDir(), abs("link-cfg"));
    const approveAllCtx: ToolContext = {
      ...headlessContext(),
      trust: true,
      confirmWrite: async () => "always",
    };
    await assert.rejects(
      executeTool(
        "edit_file",
        { path: rel("link-cfg/hacked.txt"), old_str: "", new_str: "hi" },
        approveAllCtx,
      ),
      /sprite's own config/,
    );
    assert.equal(fs.existsSync(path.join(configDir(), "hacked.txt")), false);
  });

  test("in-tree symlink to a dir outside the workspace goes through the gate", async () => {
    fs.symlinkSync(outTmp, abs("link-out"));
    let asked = 0;
    const denyCtx: ToolContext = {
      ...headlessContext(),
      confirmWrite: async () => {
        asked += 1;
        return "no";
      },
    };
    await assert.rejects(
      executeTool(
        "edit_file",
        { path: rel("link-out/pwned.txt"), old_str: "", new_str: "x\n" },
        denyCtx,
      ),
      /denied/,
    );
    assert.equal(asked, 1);
    assert.equal(fs.existsSync(path.join(outTmp, "pwned.txt")), false);
  });

  test("dangling in-tree symlink to an outside file goes through the gate", async () => {
    // writeFileSync on a dangling link creates the target — so the check has
    // to follow the link by hand even though nothing exists at its end yet.
    const ghost = path.join(outTmp, "ghost.txt");
    fs.symlinkSync(ghost, abs("link-dangling"));
    const denyCtx: ToolContext = {
      ...headlessContext(),
      confirmWrite: async () => "no",
    };
    await assert.rejects(
      executeTool(
        "edit_file",
        { path: rel("link-dangling"), old_str: "", new_str: "x\n" },
        denyCtx,
      ),
      /denied/,
    );
    assert.equal(fs.existsSync(ghost), false);
  });

  test("in-tree symlink to an in-tree dir writes silently (no false prompt)", async () => {
    fs.mkdirSync(abs("real-dir"));
    fs.symlinkSync(abs("real-dir"), abs("link-in"));
    const neverAskCtx: ToolContext = {
      ...headlessContext(),
      confirmWrite: async () => {
        throw new Error("confirmWrite must not be called for in-tree targets");
      },
    };
    const out = await executeTool(
      "edit_file",
      { path: rel("link-in/note.txt"), old_str: "", new_str: "ok\n" },
      neverAskCtx,
    );
    assert.match(out, /Created/);
    assert.equal(fs.readFileSync(abs("real-dir/note.txt"), "utf8"), "ok\n");
  });

  test("read_file through an in-tree symlink pointing outside is refused", async () => {
    fs.writeFileSync(path.join(outTmp, "secret.txt"), "s3cret\n");
    fs.symlinkSync(path.join(outTmp, "secret.txt"), abs("link-secret"));
    await assert.rejects(
      executeTool("read_file", { path: rel("link-secret") }, ctx),
      /outside the workspace/,
    );
  });
});

/**
 * The out-of-workspace write gate mirrors the bash confirmation flow:
 * trust bypasses, allowlist matches bypass, otherwise ctx.confirmWrite
 * decides. These tests drive it directly via mock ctx; persistence of
 * "always" approvals is covered by the config.test.ts suite.
 */
describe("edit_file — out-of-workspace writes", () => {
  let outTmp: string;
  before(() => {
    outTmp = fs.mkdtempSync(path.join(os.tmpdir(), "sprite-oow-"));
  });
  after(() => {
    fs.rmSync(outTmp, { recursive: true, force: true });
  });

  test("trust=true writes out-of-tree silently; confirmWrite never called", async () => {
    let called = 0;
    const trustCtx: ToolContext = {
      ...headlessContext(),
      trust: true,
      confirmWrite: async () => {
        called += 1;
        return "no";
      },
    };
    const target = path.join(outTmp, "trusted.md");
    await executeTool(
      "edit_file",
      { path: target, old_str: "", new_str: "ok\n" },
      trustCtx,
    );
    assert.equal(fs.readFileSync(target, "utf8"), "ok\n");
    assert.equal(called, 0);
  });

  test("confirmWrite → 'no' throws, file not created", async () => {
    const denyCtx: ToolContext = {
      ...headlessContext(),
      confirmWrite: async () => "no",
    };
    const target = path.join(outTmp, "denied.md");
    await assert.rejects(
      executeTool(
        "edit_file",
        { path: target, old_str: "", new_str: "nope\n" },
        denyCtx,
      ),
      /denied by user/,
    );
    assert.equal(fs.existsSync(target), false);
  });

  test("confirmWrite → 'yes' writes once; no allowlist persistence", async () => {
    let askedFor: string | null = null;
    const yesCtx: ToolContext = {
      ...headlessContext(),
      confirmWrite: async (p) => {
        askedFor = p;
        return "yes";
      },
    };
    const target = path.join(outTmp, "one-shot.md");
    await executeTool(
      "edit_file",
      { path: target, old_str: "", new_str: "once\n" },
      yesCtx,
    );
    assert.equal(fs.readFileSync(target, "utf8"), "once\n");
    // The prompt sees the canonical absolute path — where the bytes actually
    // land — so a symlink can't make an out-of-tree write look in-tree to
    // the human approving it. (On macOS os.tmpdir() is under /var, which is
    // itself a symlink to /private/var.)
    assert.equal(
      askedFor,
      path.join(fs.realpathSync.native(outTmp), "one-shot.md"),
    );
  });

  test("confirmWrite asked exactly once per call (not re-asked mid-write)", async () => {
    let n = 0;
    const countCtx: ToolContext = {
      ...headlessContext(),
      confirmWrite: async () => {
        n += 1;
        return "yes";
      },
    };
    const target = path.join(outTmp, "count.md");
    await executeTool(
      "edit_file",
      { path: target, old_str: "", new_str: "x\n" },
      countCtx,
    );
    assert.equal(n, 1);
  });

  test("abs path with absolute string input resolves and writes correctly", async () => {
    // The model can pass either a relative or absolute path. Absolute paths
    // outside the workspace must also go through the gate.
    const yesCtx: ToolContext = {
      ...headlessContext(),
      confirmWrite: async () => "yes",
    };
    const target = path.join(outTmp, "abs.md");
    await executeTool(
      "edit_file",
      { path: target, old_str: "", new_str: "abs\n" },
      yesCtx,
    );
    assert.equal(fs.readFileSync(target, "utf8"), "abs\n");
  });
});

/**
 * The tool list is part of the cached prompt prefix (tools → system →
 * messages). If it varied by permission mode, every shift+tab flip would
 * re-bill the whole conversation. So the list is constant and mode-specific
 * behavior is enforced at execution time instead.
 */
describe("tool list is mode-independent", () => {
  test("exit_plan_mode is always listed and refused outside plan mode", async () => {
    assert.ok(TOOLS.some((t) => t.name === "exit_plan_mode"));
    const defaultCtx: ToolContext = { ...ctx, getMode: () => "default" };
    const out = await executeTool(
      "exit_plan_mode",
      { plan: "# Plan\n- do the thing" },
      defaultCtx,
    );
    assert.match(out, /Refused: exit_plan_mode/);
  });
});
