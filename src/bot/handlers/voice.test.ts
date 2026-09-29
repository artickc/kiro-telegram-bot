/** End-to-end test of the voice pipeline (issue #4): Telegram voice note →
 *  download → speech-to-text → prompt. Runs offline: Bot API calls are
 *  intercepted and the file download is served by a stubbed fetch. */
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { Bot } from "grammy";
import type { PromptInput } from "../../app/types.js";
import type { BotDeps } from "../deps.js";
import { registerVoice } from "./voice.js";

const TOKEN = "0:offline-test";
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

interface Harness {
  bot: Bot;
  api: Array<{ method: string; payload: Record<string, unknown> }>;
  downloads: string[];
  transcribed: Array<{ bytes: string; mime: string; name: string }>;
  submitted: PromptInput[];
}

function setup(opts: { sttEnabled?: boolean; outcome?: string } = {}): Harness {
  const h: Harness = { bot: new Bot(TOKEN, { botInfo: { id: 1, is_bot: true, first_name: "T", username: "t_bot" } as never }), api: [], downloads: [], transcribed: [], submitted: [] };
  h.bot.api.config.use(async (_prev, method, payload) => {
    h.api.push({ method, payload: payload as Record<string, unknown> });
    const result =
      method === "getFile" ? { file_id: "f1", file_unique_id: "u1", file_path: "voice/file_1.oga" } : method === "sendChatAction" ? true : { message_id: 99 };
    return { ok: true, result } as never;
  });
  globalThis.fetch = (async (url: string | URL | Request) => {
    h.downloads.push(String(url));
    return new Response(Buffer.from("OggS-voice-bytes"));
  }) as typeof fetch;

  const deps = {
    cfg: { token: TOKEN },
    wizard: { isActive: () => false },
    stt: {
      enabled: opts.sttEnabled ?? true,
      transcribe: async (bytes: Buffer, mime: string, name: string) => {
        h.transcribed.push({ bytes: bytes.toString(), mime, name });
        return "run the tests please";
      },
    },
    registry: {
      get: () => ({
        submit: async (input: PromptInput) => {
          h.submitted.push(input);
          return opts.outcome ?? "started";
        },
      }),
    },
  } as unknown as BotDeps;
  registerVoice(h.bot, deps);
  return h;
}

const voiceUpdate = {
  update_id: 1,
  message: {
    message_id: 10,
    date: 0,
    chat: { id: 42, type: "private" as const, first_name: "U" },
    from: { id: 7, is_bot: false, first_name: "U" },
    voice: { file_id: "f1", file_unique_id: "u1", duration: 3, mime_type: "audio/ogg" },
  },
};

describe("voice messages", () => {
  test("downloads the OGG, transcribes it and submits the text as a prompt", async () => {
    const h = setup();
    await h.bot.handleUpdate(voiceUpdate);

    assert.deepEqual(h.downloads, [`https://api.telegram.org/file/bot${TOKEN}/voice/file_1.oga`]);
    assert.deepEqual(h.transcribed, [{ bytes: "OggS-voice-bytes", mime: "audio/ogg", name: "voice.ogg" }]);
    assert.deepEqual(h.submitted, [{ text: "run the tests please", images: [], replyTo: 10, quotedText: undefined }]);
    const replies = h.api.filter((c) => c.method === "sendMessage").map((c) => c.payload.text);
    assert.deepEqual(replies, ["\u{1F399} \u201Crun the tests please\u201D"]);
  });

  test("tells the user it's queued when a turn is already running", async () => {
    const h = setup({ outcome: "queued" });
    await h.bot.handleUpdate(voiceUpdate);
    const replies = h.api.filter((c) => c.method === "sendMessage").map((c) => String(c.payload.text));
    assert.equal(replies.length, 2);
    assert.match(replies[1] ?? "", /^\u{1F4E5} Queued/u);
  });

  test("explains how to enable it when STT isn't configured", async () => {
    const h = setup({ sttEnabled: false });
    await h.bot.handleUpdate(voiceUpdate);
    assert.equal(h.downloads.length, 0);
    assert.equal(h.submitted.length, 0);
    assert.deepEqual(
      h.api.map((c) => c.method),
      ["sendMessage"],
    );
    assert.match(String(h.api[0]?.payload.text), /STT_API_URL/);
  });
});
