/** Regression tests for the history-entry parser shared by /history, unread
 *  catch-up, previews and fork priming. */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { PROGRESS_DIRECTIVE } from "../render/progress.js";
import { blockText, cleanStoredText, parseEventLine } from "./history.js";

describe("parseEventLine", () => {
  test("parses a prompt, stripping the progress directive", () => {
    const line = JSON.stringify({
      kind: "Prompt",
      data: { content: [{ kind: "text", data: `Fix it\n\n${PROGRESS_DIRECTIVE}` }], meta: { timestamp: 1_790_667_789 } },
    });
    assert.deepEqual(parseEventLine(line), { role: "user", text: "Fix it", tool: undefined, timestamp: 1_790_667_789 });
  });

  test("joins an agent message's text blocks and ignores thinking / tool blocks", () => {
    const line = JSON.stringify({
      kind: "AssistantMessage",
      data: {
        content: [
          { kind: "thinking", data: { text: "hmm" } },
          { kind: "text", data: "Done. " },
          { kind: "toolUse", data: { name: "shell", input: { command: "ls" } } },
          { kind: "text", data: { text: "All good. {progress: 100%}" } },
        ],
      },
    });
    assert.deepEqual(parseEventLine(line), { role: "assistant", text: "Done. All good.", tool: undefined, timestamp: undefined });
  });

  test("returns undefined for blank, torn or unknown lines", () => {
    for (const line of ["", "   ", "{torn", JSON.stringify({ kind: "Checkpoint", data: {} })]) {
      assert.equal(parseEventLine(line), undefined, line);
    }
  });
});

describe("blockText", () => {
  test("reads both block shapes and ignores non-prose blocks", () => {
    assert.equal(blockText({ kind: "text", data: "a" }), "a");
    assert.equal(blockText({ kind: "text", data: { text: "b" } }), "b");
    assert.equal(blockText({ text: "legacy" }), "legacy");
    assert.equal(blockText({ kind: "text", data: null }), "");
    assert.equal(blockText({ kind: "thinking", data: { text: "private" } }), "");
    assert.equal(blockText({ kind: "toolUse", data: { name: "x" } }), "");
  });
});

describe("cleanStoredText", () => {
  test("removes progress markers and the directive but keeps the prose", () => {
    assert.equal(cleanStoredText("Working {progress: 40%}\n\nstill going {progress: 60%}"), "Working\n\nstill going");
    assert.equal(cleanStoredText(`Question?\n\n${PROGRESS_DIRECTIVE}`), "Question?");
    assert.equal(cleanStoredText(""), "");
  });
});
