/** Unit tests for the /export transcript parser (issue #3). */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { PROGRESS_DIRECTIVE } from "../render/progress.js";
import { parseTranscript, readTranscript, toolPreview } from "./transcript.js";

/** Log lines shaped like real Kiro CLI session events. */
const prompt = (text: string, ts?: number): string =>
  JSON.stringify({
    kind: "Prompt",
    data: { message_id: "p", content: [{ kind: "text", data: text }], ...(ts ? { meta: { timestamp: ts } } : {}) },
  });
const assistant = (...content: unknown[]): string =>
  JSON.stringify({ kind: "AssistantMessage", data: { message_id: "a", content } });
const text = (data: string) => ({ kind: "text", data });
const thinking = (t: string) => ({ kind: "thinking", data: { text: t, signature: null } });
const toolUse = (name: string, input: unknown) => ({ kind: "toolUse", data: { toolUseId: "t1", name, input } });
const toolResults = (): string =>
  JSON.stringify({
    kind: "ToolResults",
    data: { content: [{ kind: "toolResult", data: { toolUseId: "t1", content: [{ text: "raw output" }], status: "success" } }] },
  });

describe("parseTranscript", () => {
  test("builds ordered user / assistant turns from real event shapes", () => {
    const turns = parseTranscript([
      prompt(`Fix the failing test\n\n${PROGRESS_DIRECTIVE}`, 1_790_667_789),
      assistant(thinking("let me look"), text("Looking at the test first. {progress: 10%}"), toolUse("shell", { command: "npm test", working_dir: "/repo" })),
      toolResults(),
      assistant(text("Found it — a typo."), toolUse("write", { command: "strReplace", path: "src/a.ts" }), text("Fixed. {progress: 100%}")),
    ]);

    assert.equal(turns.length, 2);
    assert.deepEqual(turns[0], {
      role: "user",
      parts: [{ kind: "text", text: "Fix the failing test" }],
      timestamp: 1_790_667_789_000,
    });
    // Consecutive agent messages fold into ONE turn, in order; markers, thinking
    // and raw tool results are dropped; adjacent prose is merged.
    assert.deepEqual(turns[1], {
      role: "assistant",
      parts: [
        { kind: "text", text: "Looking at the test first." },
        { kind: "tool", name: "shell", preview: "npm test" },
        { kind: "text", text: "Found it — a typo." },
        { kind: "tool", name: "write", preview: "strReplace src/a.ts" },
        { kind: "text", text: "Fixed." },
      ],
    });
  });

  test("merges adjacent prose across agent events", () => {
    const turns = parseTranscript([prompt("hi"), assistant(text("Part one.")), assistant(text("Part two."))]);
    assert.deepEqual(turns[1]?.parts, [{ kind: "text", text: "Part one.\n\nPart two." }]);
  });

  test("starts a new turn for every prompt", () => {
    const turns = parseTranscript([prompt("one"), assistant(text("a")), prompt("two"), prompt("three"), assistant(text("b"))]);
    assert.deepEqual(
      turns.map((t) => t.role),
      ["user", "assistant", "user", "user", "assistant"],
    );
  });

  test("skips torn lines, unknown kinds and thinking-only messages", () => {
    const turns = parseTranscript([
      "",
      "{not json",
      JSON.stringify({ kind: "Checkpoint", data: {} }),
      "42",
      prompt("hello"),
      assistant(thinking("only thinking")),
      '{"kind":"AssistantMessage","data":{"content":[{"kind":"text","data":"cut of',
    ]);
    assert.deepEqual(turns, [{ role: "user", parts: [{ kind: "text", text: "hello" }] }]);
  });

  test("accepts legacy UserMessage / Response kinds and the {text} block shape", () => {
    const turns = parseTranscript([
      JSON.stringify({ kind: "UserMessage", data: { content: [{ text: "legacy question" }], meta: { timestamp: 1_700_000_000_000 } } }),
      JSON.stringify({ kind: "Response", data: { content: [{ kind: "text", data: { text: "legacy answer" } }] } }),
    ]);
    assert.deepEqual(turns, [
      { role: "user", parts: [{ kind: "text", text: "legacy question" }], timestamp: 1_700_000_000_000 },
      { role: "assistant", parts: [{ kind: "text", text: "legacy answer" }] },
    ]);
  });

  test("names unnamed tools generically and omits empty previews", () => {
    const turns = parseTranscript([prompt("go"), assistant({ kind: "toolUse", data: { input: {} } })]);
    assert.deepEqual(turns[1]?.parts, [{ kind: "tool", name: "tool" }]);
  });
});

describe("toolPreview", () => {
  test("shows the most telling field per tool", () => {
    assert.equal(toolPreview({ command: "npm  run\n test", working_dir: "/repo" }), "npm run test");
    assert.equal(toolPreview({ command: "create", path: "src/new.ts", file_text: "…" }), "create src/new.ts");
    assert.equal(toolPreview({ pattern: "TODO", path: "src", output_mode: "content" }), "TODO");
    assert.equal(toolPreview({ query: "grammy InputFile" }), "grammy InputFile");
    assert.equal(toolPreview({ url: "https://example.com" }), "https://example.com");
    assert.equal(toolPreview({ operations: [{ mode: "Line", path: "a.ts" }, { mode: "Line", path: "b.ts" }] }), "a.ts, b.ts");
  });

  test("falls back to compact JSON and caps the length", () => {
    assert.equal(toolPreview({ tasks: [1, 2] }), '{"tasks":[1,2]}');
    const long = toolPreview({ command: "x".repeat(500) })!;
    assert.equal(long.length, 160);
    assert.ok(long.endsWith("\u2026"));
  });

  test("returns undefined when there is nothing useful", () => {
    for (const empty of [undefined, null, {}, [], "   "]) {
      assert.equal(toolPreview(empty), undefined, JSON.stringify(empty));
    }
  });
});

describe("readTranscript", () => {
  const dir = mkdtempSync(join(tmpdir(), "kiro-tg-transcript-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  test("reads a whole log", () => {
    const file = join(dir, "whole.jsonl");
    writeFileSync(file, [prompt("q1"), assistant(text("a1")), prompt("q2"), assistant(text("a2"))].join("\n") + "\n");
    const { turns, truncated } = readTranscript(file);
    assert.equal(truncated, false);
    assert.equal(turns.length, 4);
  });

  test("keeps only the most recent part of a log larger than the cap", () => {
    const file = join(dir, "big.jsonl");
    const lines = Array.from({ length: 50 }, (_, i) => [prompt(`question ${i}`), assistant(text(`answer ${i}`))]).flat();
    writeFileSync(file, lines.join("\n") + "\n");
    const { turns, truncated } = readTranscript(file, 2_000);
    assert.equal(truncated, true);
    assert.ok(turns.length > 0 && turns.length < 100);
    const last = turns.at(-1)!;
    assert.deepEqual(last.parts, [{ kind: "text", text: "answer 49" }]);
  });

  test("returns nothing for a missing or empty log", () => {
    assert.deepEqual(readTranscript(join(dir, "missing.jsonl")), { turns: [], truncated: false });
    const empty = join(dir, "empty.jsonl");
    writeFileSync(empty, "");
    assert.deepEqual(readTranscript(empty), { turns: [], truncated: false });
  });
});
