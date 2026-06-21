/**
 * Speech-to-text via any OpenAI/Whisper-compatible endpoint.
 *
 * Language handling: when STT_LANGUAGE is unset, Whisper auto-detects the
 * spoken language (covers English, Russian, Romanian/Moldovan, and ~100 more),
 * so multilingual voice notes work out of the box.
 */
import { createLogger } from "../logger.js";

const log = createLogger("stt");

export interface SttConfig {
  apiUrl?: string;
  apiKey?: string;
  model: string;
  language?: string;
}

export class SttService {
  constructor(private readonly cfg: SttConfig) {}

  get enabled(): boolean {
    return Boolean(this.cfg.apiUrl);
  }

  /** Transcribe audio bytes; returns the recognized text (may be empty). */
  async transcribe(bytes: Buffer, mimeType: string, filename: string): Promise<string> {
    if (!this.cfg.apiUrl) throw new Error("STT is not configured (set STT_API_URL).");
    const url = endpoint(this.cfg.apiUrl);

    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(bytes)], { type: mimeType }), filename);
    form.append("model", this.cfg.model);
    if (this.cfg.language) form.append("language", this.cfg.language);

    const headers: Record<string, string> = {};
    if (this.cfg.apiKey) headers.Authorization = `Bearer ${this.cfg.apiKey}`;

    const res = await fetch(url, { method: "POST", headers, body: form });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`STT HTTP ${res.status}: ${detail.slice(0, 200)}`);
    }
    const data = (await res.json()) as { text?: string };
    log.debug("transcribed", (data.text ?? "").length, "chars");
    return (data.text ?? "").trim();
  }
}

function endpoint(base: string): string {
  const b = base.replace(/\/$/, "");
  return b.endsWith("/audio/transcriptions") ? b : `${b}/audio/transcriptions`;
}
