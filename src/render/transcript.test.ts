/** Unit tests for the /export document renderer (issue #3). */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { TranscriptTurn } from "../sessions/types.js";
import {
  describeStats,
  formatLocal,
  renderTranscript,
  type TranscriptInfo,
  transcriptFilename,
  transcriptStats,
  transcriptTitle,
} from "./transcript.js";

const PROMPT_AT = new Date(2026, 8, 29, 10, 15).getTime(); // local 2026-09-29 10:15
const info: TranscriptInfo = {
  sessionId: "1a2b3c4d-0000-4000-8000-000000000000",
  title: "Fix flaky tests",
  cwd: "/home/me/projects/Kiro Telegram Bot",
  exportedAt: new Date(2026, 8, 29, 11, 30),
};
const turns: TranscriptTurn[] = [
  { role: "user", parts: [{ kind: "text", text: "Why does `npm test` fail?" }], timestamp: PROMPT_AT },
  {
    role: "assistant",
    parts: [
      { kind: "text", text: "Let me check." },
      { kind: "tool", name: "shell", preview: "npm test" },
      { kind: "tool", name: "grep", preview: "a `backtick` pattern" },
      { kind: "text", text: "A date parser was too lenient." },
      { kind: "tool", name: "todo_list" },
    ],
  },
];

describe("renderTranscript (markdown)", () => {
  const md = renderTranscript(turns, info, "md");

  test("has a title and a metadata header", () => {
    assert.ok(md.startsWith("# \u{1F4DC} Fix flaky tests\n"));
    assert.match(md, /^- \*\*Project:\*\* Kiro Telegram Bot \(`\/home\/me\/projects\/Kiro Telegram Bot`\)$/m);
    assert.match(md, /^- \*\*Session:\*\* `1a2b3c4d-0000-4000-8000-000000000000`$/m);
    assert.match(md, /^- \*\*Exported:\*\* 2026-09-29 11:30$/m);
    assert.match(md, /^- \*\*Messages:\*\* 1 prompt · 1 reply · 3 tool calls$/m);
  });

  test("renders turns in order with timestamps, prose and grouped tool calls", () => {
    const body = md.slice(md.indexOf("---"));
    assert.equal(
      body,
      [
        "---",
        "",
        "## \u{1F464} You \u00B7 2026-09-29 10:15",
        "",
        "Why does `npm test` fail?",
        "",
        "## \u{1F916} Kiro",
        "",
        "Let me check.",
        "",
        "- \u{1F527} `shell` \u2014 `npm test`",
        "- \u{1F527} `grep` \u2014 `` a `backtick` pattern ``",
        "",
        "A date parser was too lenient.",
        "",
        "- \u{1F527} `todo_list`",
        "",
      ].join("\n"),
    );
  });

  test("flags a truncated (tail-only) export", () => {
    const out = renderTranscript(turns, { ...info, truncated: true, maxLabel: "32 MB" }, "md");
    assert.match(out, /^> \u26A0\uFE0F This session's log is larger than 32 MB, so only its most recent part is included\.$/m);
    assert.doesNotMatch(md, /larger than/);
  });
});

describe("renderTranscript (plain text)", () => {
  test("uses simple labels and no Markdown markup", () => {
    const txt = renderTranscript(turns, info, "txt");
    assert.ok(txt.startsWith("Kiro session transcript \u2014 Fix flaky tests\nProject: Kiro Telegram Bot (/home/me/projects/Kiro Telegram Bot)\n"));
    assert.match(txt, /^YOU \u00B7 2026-09-29 10:15$/m);
    assert.match(txt, /^KIRO$/m);
    assert.match(txt, /^ {2}\[tool\] shell \u2014 npm test$/m);
    assert.match(txt, /^ {2}\[tool\] todo_list$/m);
    assert.doesNotMatch(txt, /\*\*|^#/m);
  });
});

describe("helpers", () => {
  test("transcriptFilename is filesystem-safe and descriptive", () => {
    assert.equal(transcriptFilename(info, "md"), "kiro-transcript-kiro-telegram-bot-1a2b3c4d-20260929-1130.md");
    assert.equal(transcriptFilename({ ...info, cwd: undefined }, "txt"), "kiro-transcript-session-1a2b3c4d-20260929-1130.txt");
    // Non-Latin project names can't be slugged, so the generic label is used.
    assert.equal(transcriptFilename({ ...info, cwd: "/home/me/Проект" }, "md"), "kiro-transcript-session-1a2b3c4d-20260929-1130.md");
  });

  test("transcriptTitle falls back to the short session id", () => {
    assert.equal(transcriptTitle(info), "Fix flaky tests");
    assert.equal(transcriptTitle({ ...info, title: "(untitled)" }), "Session 1a2b3c4d");
    assert.equal(transcriptTitle({ ...info, title: "  " }), "Session 1a2b3c4d");
  });

  test("stats count prompts, replies and tool calls with correct plurals", () => {
    assert.deepEqual(transcriptStats(turns), { prompts: 1, replies: 1, toolCalls: 3 });
    assert.equal(describeStats({ prompts: 2, replies: 0, toolCalls: 1 }), "2 prompts \u00B7 0 replies \u00B7 1 tool call");
  });

  test("formatLocal prints local YYYY-MM-DD HH:MM", () => {
    assert.equal(formatLocal(PROMPT_AT), "2026-09-29 10:15");
    assert.equal(formatLocal(new Date(2027, 0, 2, 3, 4)), "2027-01-02 03:04");
  });
});
