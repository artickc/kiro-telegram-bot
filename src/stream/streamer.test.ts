import assert from "node:assert/strict";
import test from "node:test";
import { ResponseStreamer } from "./streamer.js";

interface SentMessage {
  text: string;
}

function fakeApi(messages: SentMessage[]): unknown {
  return {
    async sendMessage(_chatId: number, text: string) {
      messages.push({ text });
      return { message_id: 1 };
    },
    async editMessageText(_chatId: number, _messageId: number, text: string) {
      messages.push({ text });
      return true;
    },
  };
}

test("agent progress wins when completion arrives before the final stream flush", async () => {
  const messages: SentMessage[] = [];
  const streamer = new ResponseStreamer(
    fakeApi(messages) as never,
    1,
    60_000,
    undefined,
    undefined,
    undefined,
    true,
    Date.now(),
  );

  streamer.appendOutput("Working first step\n\n{progress: 5%}");
  // SessionRuntime currently observes prompt completion before finalizing buffered
  // stream chunks, so this call can race the marker parser.
  streamer.completeFallback();
  await streamer.finalize();

  const final = messages.at(-1)?.text ?? "";
  assert.match(final, /5%/);
  assert.doesNotMatch(final, /100%/);
});
