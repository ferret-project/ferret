import type { Ai } from "../../ports";
import { apiUrl, modelHeaders, OpenAiChat } from "./chat";

/**
 * A vision model and an embedding model behind OpenAI-compatible APIs (Ollama, llama.cpp's llama-server, LM Studio,
 * vLLM…; e.g. qwen3-vl and qwen3-embedding) — the Ai port. The two can be on different servers (VISION_URL,
 * EMBED_URL). Errors are thrown so the job runner retries later, which covers the model server being busy, asleep or
 * loading a model.
 */
export class OpenAiModels implements Ai {
  private readonly chat: OpenAiChat;

  constructor(
    private readonly servers: { vision: string; embed: string; apiKey?: string },
    private readonly models: { vision: string; embed: string },
    private readonly timeoutMs = 300_000, // a cold model load plus a busy GPU can take minutes
  ) {
    this.chat = new OpenAiChat(servers.vision, models.vision, { timeoutMs, apiKey: servers.apiKey });
  }

  async embed(texts: string[], purpose: "document" | "query") {
    // Qwen3-Embedding is instruction-tuned: queries get a task prefix, stored text doesn't.
    const input =
      purpose === "query"
        ? texts.map((t) => `Instruct: Given a search for something in a home inventory, find the matching items\nQuery: ${t}`)
        : texts;
    const res = await fetch(apiUrl(this.servers.embed, "/v1/embeddings"), {
      method: "POST",
      headers: modelHeaders(this.servers.apiKey),
      // Queries run while someone waits on the search box.
      signal: AbortSignal.timeout(purpose === "query" ? 15_000 : this.timeoutMs),
      body: JSON.stringify({ model: this.models.embed, input }),
    });
    if (!res.ok) throw new Error(`${this.models.embed} /v1/embeddings returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { data: { embedding: number[]; index: number }[] };
    return body.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }

  json(request: Parameters<Ai["json"]>[0]) {
    return this.chat.json(request);
  }
}
