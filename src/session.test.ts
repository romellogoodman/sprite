import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import {
  startSession,
  loadLastSession,
  notesPath,
  loadNotes,
  appendNote,
  sanitizeNote,
} from "./session.js";

let tmp: string;
let cwd: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sprite-session-test-"));
  // Point the config dir at the sandbox so nothing touches ~/.config/sprite.
  process.env.SPRITE_CONFIG_DIR = path.join(tmp, "config");
  cwd = path.join(tmp, "project");
  fs.mkdirSync(cwd, { recursive: true });
});

afterEach(() => {
  delete process.env.SPRITE_CONFIG_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("startSession / loadLastSession", () => {
  test("save() round-trips history through JSONL", () => {
    const sess = startSession(cwd);
    const history: Anthropic.MessageParam[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    sess.save(history);
    assert.ok(fs.existsSync(sess.file));
    assert.deepEqual(loadLastSession(cwd), history);
  });

  test("session files live under SPRITE_CONFIG_DIR, not ~/.config", () => {
    const sess = startSession(cwd);
    sess.save([{ role: "user", content: "x" }]);
    assert.ok(sess.file.startsWith(process.env.SPRITE_CONFIG_DIR!));
  });

  test("returns [] when no sessions exist", () => {
    assert.deepEqual(loadLastSession(cwd), []);
  });

  test("returns [] on corrupt JSONL", () => {
    const sess = startSession(cwd);
    fs.writeFileSync(sess.file, "not json\n{also not json\n");
    assert.deepEqual(loadLastSession(cwd), []);
  });

  test("closes an interrupted turn ending on a tool_result batch", () => {
    const sess = startSession(cwd);
    sess.save([
      { role: "user", content: "do it" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "bash", input: {} }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
      },
    ]);
    const loaded = loadLastSession(cwd);
    assert.equal(loaded.length, 4);
    const tail = loaded[loaded.length - 1];
    assert.equal(tail.role, "assistant");
    assert.match(String(tail.content), /interrupted mid-turn/);
  });

  test("does not append a closer when the turn ended cleanly", () => {
    const sess = startSession(cwd);
    sess.save([
      { role: "user", content: "hi" },
      { role: "assistant", content: "done" },
    ]);
    assert.equal(loadLastSession(cwd).length, 2);
  });

  test("prunes old sessions beyond the cap", () => {
    const first = startSession(cwd);
    const dir = path.dirname(first.file);
    // Seed 25 fake sessions with sortable names older than anything real.
    for (let i = 0; i < 25; i++) {
      fs.writeFileSync(
        path.join(dir, `2000-01-01T00-00-${String(i).padStart(2, "0")}.jsonl`),
        JSON.stringify({ role: "user", content: `old ${i}` }) + "\n",
      );
    }
    startSession(cwd); // triggers pruning
    const left = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    assert.ok(left.length <= 20, `expected <=20 sessions, got ${left.length}`);
  });

  test("sessions are keyed per-cwd", () => {
    const other = path.join(tmp, "other-project");
    fs.mkdirSync(other, { recursive: true });
    startSession(cwd).save([{ role: "user", content: "project A" }]);
    startSession(other).save([{ role: "user", content: "project B" }]);
    assert.deepEqual(loadLastSession(cwd), [{ role: "user", content: "project A" }]);
    assert.deepEqual(loadLastSession(other), [{ role: "user", content: "project B" }]);
  });
});

describe("notes", () => {
  test("notesPath is under the config dir and keyed by cwd", () => {
    const p = notesPath(cwd);
    assert.ok(p.startsWith(process.env.SPRITE_CONFIG_DIR!));
    assert.notEqual(p, notesPath(tmp));
  });

  test("loadNotes returns '' when absent", () => {
    assert.equal(loadNotes(cwd), "");
  });

  test("appendNote creates the file and loadNotes reads it back", () => {
    const file = appendNote("uses npm test, not jest", cwd);
    assert.equal(file, notesPath(cwd));
    assert.equal(loadNotes(cwd), "- uses npm test, not jest");
    appendNote("second note", cwd);
    assert.match(loadNotes(cwd), /second note/);
  });

  test("appendNote rejects notes that sanitize to empty", () => {
    assert.throws(() => appendNote("\x1b[2K\r", cwd));
  });
});

describe("sanitizeNote", () => {
  test("strips ANSI CSI sequences wholesale", () => {
    assert.equal(sanitizeNote("\x1b[31mred\x1b[0m text"), "red text");
  });

  test("replaces control chars and collapses whitespace", () => {
    assert.equal(sanitizeNote("a\rb\nc\td"), "a b c d");
  });

  test("caps length at 200", () => {
    assert.equal(sanitizeNote("x".repeat(300)).length, 200);
  });

  test("trims to empty for control-only input", () => {
    assert.equal(sanitizeNote("\x1b[2K\x07\r\n"), "");
  });
});
