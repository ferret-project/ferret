import type { Ai } from "../../ports";
import { OpenAiChat } from "./chat";

/**
 * Ollama via its OpenAI-compatible API (e.g. qwen3-vl and qwen3-embedding)
 * — the Ai port. Errors are thrown so the job runner
 * retries later, which covers the model server being busy, asleep or loading a model.
 */
export class OllamaAi implements Ai {
  private readonly chat: OpenAiChat;

  constructor(
    private readonly baseUrl: string,
    private readonly models: { vision: string; embed: string },
    private readonly timeoutMs = 300_000, // a cold model load plus a busy GPU can take minutes
  ) {
    this.chat = new OpenAiChat(baseUrl, models.vision, { timeoutMs });
  }

  async embed(texts: string[], purpose: "document" | "query") {
    // Qwen3-Embedding is instruction-tuned: queries get a task prefix, stored text doesn't.
    const input =
      purpose === "query"
        ? texts.map((t) => `Instruct: Given a search for something in a home inventory, find the matching items\nQuery: ${t}`)
        : texts;
    const body = await this.post<{ data: { embedding: number[]; index: number }[] }>(
      "/v1/embeddings",
      { model: this.models.embed, input },
      // Queries run while someone waits on the search box.
      purpose === "query" ? 15_000 : this.timeoutMs,
    );
    return body.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }

  json(request: Parameters<Ai["json"]>[0]) {
    return this.chat.json(request);
  }

  private async post<T>(path: string, payload: unknown, timeoutMs = this.timeoutMs): Promise<T> {
    const res = await fetch(new URL(path, this.baseUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`Ollama ${path} returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as T;
  }
}
