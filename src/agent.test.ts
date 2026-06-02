import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { withCacheMarker, expandFileMentions } from "./agent.js";

describe("withCacheMarker", () => {
  test("empty history passes through", () => {
    assert.deepEqual(withCacheMarker([]), []);
  });

  test("wraps string content into a cached text block", () => {
    const msgs: Anthropic.MessageParam[] = [{ role: "user", content: "hi" }];
    const out = withCacheMarker(msgs);
    assert.deepEqual(out[0].content, [
      { type: "text", text: "hi", cache_control: { type: "ephemeral" } },
    ]);
    // Original untouched.
    assert.equal(msgs[0].content, "hi");
  });

  test("marks only the final block of the final message", () => {
    const msgs: Anthropic.MessageParam[] = [
      { role: "user", content: "first" },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "a", content: "one" },
          { type: "tool_result", tool_use_id: "b", content: "two" },
        ],
      },
    ];
    const out = withCacheMarker(msgs);
    assert.equal(out[0].content, "first"); // earlier message untouched
    const blocks = out[1].content as Anthropic.ToolResultBlockParam[];
    assert.equal((blocks[0] as { cache_control?: unknown }).cache_control, undefined);
    assert.deepEqual((blocks[1] as { cache_control?: unknown }).cache_control, {
      type: "ephemeral",
    });
  });

  test("skips the marker when the tail block is thinking", () => {
    const msgs = [
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "hmm", signature: "s" }],
      },
    ] as Anthropic.MessageParam[];
    const out = withCacheMarker(msgs);
    const block = (out[0].content as unknown as Array<Record<string, unknown>>)[0];
    assert.equal(block.cache_control, undefined);
  });

  test("does not mutate the stored history", () => {
    const msgs: Anthropic.MessageParam[] = [
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "a", content: "x" }],
      },
    ];
    const snapshot = JSON.stringify(msgs);
    withCacheMarker(msgs);
    assert.equal(JSON.stringify(msgs), snapshot);
  });
});

describe("expandFileMentions", () => {
  test("expands an existing file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sprite-agent-test-"));
    const prev = process.cwd();
    try {
      process.chdir(dir);
      fs.writeFileSync("notes.txt", "file body");
      const out = expandFileMentions("see @notes.txt please");
      assert.match(out, /<file path="notes.txt">/);
      assert.match(out, /file body/);
    } finally {
      process.chdir(prev);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("leaves missing paths and email-like strings alone", () => {
    assert.equal(
      expandFileMentions("email me@example.com about @nonexistent-file-xyz"),
      "email me@example.com about @nonexistent-file-xyz",
    );
  });
});
