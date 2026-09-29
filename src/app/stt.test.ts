/** Regression tests for Whisper-compatible speech-to-text (issue #4). The
 *  network is stubbed: no request leaves the process. */
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { SttService } from "./stt.js";

interface Captured {
  url: string;
  init: RequestInit;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(response: Response): Captured[] {
  const calls: Captured[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return response;
  }) as typeof fetch;
  return calls;
}

describe("SttService", () => {
  test("is disabled without STT_API_URL", async () => {
    const stt = new SttService({ model: "whisper-1" });
    assert.equal(stt.enabled, false);
    await assert.rejects(stt.transcribe(Buffer.from("x"), "audio/ogg", "voice.ogg"), /STT_API_URL/);
  });

  test("posts the audio as multipart to <base>/audio/transcriptions and returns trimmed text", async () => {
    const calls = stubFetch(Response.json({ text: "  привет, как дела?  " }));
    const stt = new SttService({ apiUrl: "https://stt.example.com/v1/", apiKey: "sk-test", model: "whisper-1", language: "ru" });
    assert.equal(stt.enabled, true);

    const text = await stt.transcribe(Buffer.from("OggS-fake-audio"), "audio/ogg", "voice.ogg");

    assert.equal(text, "привет, как дела?");
    assert.equal(calls.length, 1);
    const { url, init } = calls[0]!;
    assert.equal(url, "https://stt.example.com/v1/audio/transcriptions");
    assert.equal(init.method, "POST");
    assert.deepEqual(init.headers, { Authorization: "Bearer sk-test" });
    const form = init.body as FormData;
    assert.equal(form.get("model"), "whisper-1");
    assert.equal(form.get("language"), "ru");
    const file = form.get("file") as File;
    assert.equal(file.name, "voice.ogg");
    assert.equal(file.type, "audio/ogg");
    assert.equal(await file.text(), "OggS-fake-audio");
  });

  test("auto-detects the language and sends no auth header when unset; accepts a full endpoint URL", async () => {
    const calls = stubFetch(Response.json({ text: "hello" }));
    const stt = new SttService({ apiUrl: "http://localhost:9000/v1/audio/transcriptions", model: "large-v3" });
    assert.equal(await stt.transcribe(Buffer.from("a"), "audio/mpeg", "a.mp3"), "hello");
    const { url, init } = calls[0]!;
    assert.equal(url, "http://localhost:9000/v1/audio/transcriptions");
    assert.deepEqual(init.headers, {});
    assert.equal((init.body as FormData).get("language"), null);
  });

  test("surfaces HTTP errors with status and detail", async () => {
    stubFetch(new Response("invalid api key", { status: 401 }));
    const stt = new SttService({ apiUrl: "https://stt.example.com/v1", model: "whisper-1" });
    await assert.rejects(stt.transcribe(Buffer.from("a"), "audio/ogg", "v.ogg"), /STT HTTP 401: invalid api key/);
  });
});
