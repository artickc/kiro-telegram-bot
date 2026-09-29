/** Tests for the /export command: argument parsing, caption, and the full
 *  grammY handler wired to fake deps + an intercepted (offline) Bot API. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { Bot, InputFile } from "grammy";
import type { TranscriptInfo } from "../../render/transcript.js";
import type { TranscriptTurn } from "../../sessions/types.js";
import type { BotDeps } from "../deps.js";
import { exportCaption, parseExportFormat, registerExport } from "./export.js";

describe("parseExportFormat", () => {
  test("defaults to Markdown and accepts common aliases", () => {
    for (const md of [undefined, "", "  ", "md", "MD", ".md", "markdown"]) assert.equal(parseExportFormat(md), "md", String(md));
    for (const txt of ["txt", ".txt", "TXT", "text", "plain"]) assert.equal(parseExportFormat(txt), "txt", txt);
  });

  test("rejects anything else so the user sees the usage hint", () => {
    for (const bad of ["pdf", "json", "md txt"]) assert.equal(parseExportFormat(bad), undefined, bad);
  });
});

describe("exportCaption", () => {
  const info: TranscriptInfo = { sessionId: "1a2b3c4d-rest", title: "Fix tests", cwd: "/work/app", exportedAt: new Date() };
  const turns: TranscriptTurn[] = [
    { role: "user", parts: [{ kind: "text", text: "q" }] },
    { role: "assistant", parts: [{ kind: "text", text: "a" }, { kind: "tool", name: "shell" }] },
  ];

  test("summarizes the session and carries its hashtags", () => {
    assert.equal(
      exportCaption(info, turns, "#proj_app #sess_1a2b3c4d"),
      "\u{1F4DC} Transcript \u2014 Fix tests (app)\n1 prompt \u00B7 1 reply \u00B7 1 tool call\n\n#proj_app #sess_1a2b3c4d",
    );
  });

  test("notes truncated exports", () => {
    assert.match(exportCaption({ ...info, truncated: true }, turns, ""), /only the most recent part is included\.$/);
  });

  test("never exceeds Telegram's 1024-character caption limit (the title is shortened)", () => {
    const caption = exportCaption({ ...info, title: "t".repeat(3000) }, turns, "#proj_app");
    assert.equal(caption.length, 1024);
    assert.ok(caption.endsWith("\n\n#proj_app"));
  });
});

describe("/export handler", () => {
  const dir = mkdtempSync(join(tmpdir(), "kiro-tg-export-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, "abcd1234-5678.jsonl");
  writeFileSync(
    log,
    [
      JSON.stringify({ kind: "Prompt", data: { content: [{ kind: "text", data: "List the files" }], meta: { timestamp: 1_790_667_789 } } }),
      JSON.stringify({
        kind: "AssistantMessage",
        data: { content: [{ kind: "toolUse", data: { name: "shell", input: { command: "ls" } } }, { kind: "text", data: "Two files." }] },
      }),
    ].join("\n") + "\n",
  );

  interface Call {
    method: string;
    payload: Record<string, unknown>;
  }

  /** A Bot whose API calls are recorded instead of sent, plus fake deps. */
  function setup(sessionId: string | undefined): { bot: Bot; calls: Call[] } {
    const bot = new Bot("0:offline-test", {
      botInfo: { id: 1, is_bot: true, first_name: "Test", username: "test_bot" } as never,
    });
    const calls: Call[] = [];
    bot.api.config.use(async (_prev, method, payload) => {
      calls.push({ method, payload: payload as Record<string, unknown> });
      return { ok: true, result: method === "sendChatAction" ? true : { message_id: calls.length } } as never;
    });
    const deps = {
      registry: { get: () => ({ sessionId, cwd: "/work/demo", tags: "#proj_demo #sess_abcd1234" }) },
      store: { jsonlPath: () => log, get: () => ({ title: "Demo session", cwd: "/work/demo" }) },
    } as unknown as BotDeps;
    registerExport(bot, deps);
    return { bot, calls };
  }

  const command = (text: string) => ({
    update_id: 1,
    message: {
      message_id: 10,
      date: 0,
      chat: { id: 42, type: "private" as const, first_name: "U" },
      from: { id: 7, is_bot: false, first_name: "U" },
      text,
      entities: [{ type: "bot_command" as const, offset: 0, length: text.split(" ")[0]!.length }],
    },
  });

  test("sends the transcript as a document with a summary caption", async () => {
    const { bot, calls } = setup("abcd1234-5678");
    await bot.handleUpdate(command("/export txt"));
    const send = calls.find((c) => c.method === "sendDocument");
    assert.ok(send, `expected sendDocument, got ${calls.map((c) => c.method).join(", ")}`);
    assert.equal(send.payload.chat_id, 42);
    assert.match(String(send.payload.caption), /^\u{1F4DC} Transcript \u2014 Demo session \(demo\)\n1 prompt · 1 reply · 1 tool call\n\n#proj_demo #sess_abcd1234$/u);
    const doc = send.payload.document;
    assert.ok(doc instanceof InputFile);
    assert.match(doc.filename ?? "", /^kiro-transcript-demo-abcd1234-\d{8}-\d{4}\.txt$/);
    const body = String((doc as unknown as { fileData: Buffer }).fileData);
    assert.match(body, /^YOU · \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/m);
    assert.match(body, /^List the files$/m);
    assert.match(body, /^ {2}\[tool\] shell — ls$/m);
    assert.match(body, /^Two files\.$/m);
  });

  test("defaults to Markdown", async () => {
    const { bot, calls } = setup("abcd1234-5678");
    await bot.handleUpdate(command("/export"));
    const doc = calls.find((c) => c.method === "sendDocument")?.payload.document as InputFile | undefined;
    assert.match(doc?.filename ?? "", /\.md$/);
  });

  test("explains when there is no session, or the format is unknown", async () => {
    const none = setup(undefined);
    await none.bot.handleUpdate(command("/export"));
    assert.deepEqual(
      none.calls.map((c) => [c.method, c.payload.text]),
      [["sendMessage", "No active session. Use /sessions or send a message first."]],
    );

    const bad = setup("abcd1234-5678");
    await bad.bot.handleUpdate(command("/export pdf"));
    assert.equal(bad.calls.length, 1);
    assert.match(String(bad.calls[0]?.payload.text), /^Usage: \/export/);
  });
});
