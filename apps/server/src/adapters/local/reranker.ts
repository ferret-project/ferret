import type { Reranker } from "../../ports";

/**
 * A cross-encoder reranker (e.g. bge-reranker-v2-m3) behind vLLM's
 * /v1/rerank API — the Reranker port.
 */
export class VllmReranker implements Reranker {
  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly timeoutMs = 5_000, // it runs while someone waits on the search box
  ) {}

  async rerank(query: string, documents: string[]) {
    if (documents.length === 0) return [];
    const res = await fetch(new URL("/v1/rerank", this.baseUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(this.timeoutMs),
      body: JSON.stringify({ model: this.model, query, documents }),
    });
    if (!res.ok) throw new Error(`Reranker returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { results: { index: number; relevance_score: number }[] };
    const scores = new Array<number>(documents.length).fill(0);
    for (const r of body.results) scores[r.index] = r.relevance_score;
    return scores;
  }
}
