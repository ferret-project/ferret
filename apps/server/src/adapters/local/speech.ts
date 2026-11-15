import { ServiceFailure, type Speech } from "../../ports";
import { apiUrl, modelHeaders } from "./chat";

/**
 * Speech to text through an OpenAI-compatible /v1/audio/transcriptions endpoint — a Whisper server such as speaches
 * (faster-whisper) or vLLM serving whisper-large-v3 — the Speech port. Short recordings only (naming things on a
 * walkthrough); the audio is sent, the text comes back, nothing is kept.
 */
export class OpenAiSpeech implements Speech {
  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly apiKey?: string,
    private readonly timeoutMs = 30_000,
  ) {}

  async transcribe(audio: Uint8Array, contentType: string) {
    const form = new FormData();
    const ext = contentType.includes("mp4") || contentType.includes("m4a") ? "m4a" : contentType.includes("ogg") ? "ogg" : contentType.includes("wav") ? "wav" : "webm";
    form.set("file", new Blob([new Uint8Array(audio)], { type: contentType }), `speech.${ext}`);
    form.set("model", this.model);
    form.set("response_format", "json");
    const started = Date.now();
    const res = await fetch(apiUrl(this.baseUrl, "/v1/audio/transcriptions"), { method: "POST", headers: modelHeaders(this.apiKey, false), body: form, signal: AbortSignal.timeout(this.timeoutMs) });
    if (!res.ok) {
      throw new ServiceFailure(`Speech server returned ${res.status}: ${(await res.text()).slice(0, 200)}`, { model: this.model, ms: Date.now() - started, bytes: audio.length, contentType });
    }
    const body = (await res.json()) as { text?: string };
    return (body.text ?? "").trim();
  }
}
