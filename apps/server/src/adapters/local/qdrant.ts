import type { VectorPoint, Vectors } from "../../ports";

/**
 * Qdrant over its REST API — the Vectors port. The
 * collection is created on first use, sized to the embedding model, with
 * keyword indexes on the fields every search filters by.
 */
export class QdrantVectors implements Vectors {
  private ready?: Promise<void>;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string | undefined,
    private readonly collection: string,
  ) {}

  async upsert(points: VectorPoint[]) {
    if (points.length === 0) return;
    await this.ensureCollection(points[0]!.vector.length);
    await this.call("PUT", `/points?wait=true`, { points });
  }

  async query(vector: number[], opts: { limit: number; filter: Record<string, string> }) {
    await this.ensureCollection(vector.length);
    const res = await this.call<{ result: { points: { id: string; score: number; payload: VectorPoint["payload"] }[] } }>(
      "POST",
      "/points/query",
      { query: vector, limit: opts.limit, filter: toFilter(opts.filter), with_payload: true },
    );
    return res.result.points;
  }

  async deleteWhere(filter: Record<string, string>) {
    if (!(await this.exists())) return;
    await this.call("POST", "/points/delete?wait=true", { filter: toFilter(filter) });
  }

  private ensureCollection(size: number) {
    this.ready ??= (async () => {
      if (!(await this.exists())) {
        await this.call("PUT", "", { vectors: { size, distance: "Cosine" } });
        for (const field of ["householdId", "itemId"]) {
          await this.call("PUT", "/index?wait=true", { field_name: field, field_schema: "keyword" });
        }
      }
    })().catch((err) => {
      this.ready = undefined; // try again next time
      throw err;
    });
    return this.ready;
  }

  private async exists() {
    const res = await this.call<{ result: { exists: boolean } }>("GET", "/exists");
    return res.result.exists;
  }

  private async call<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(new URL(`/collections/${encodeURIComponent(this.collection)}${path}`, this.baseUrl), {
      method,
      headers: { "Content-Type": "application/json", ...(this.apiKey ? { "api-key": this.apiKey } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`Qdrant ${method} ${path || "/"} returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as T;
  }
}

const toFilter = (filter: Record<string, string>) => ({
  must: Object.entries(filter).map(([key, value]) => ({ key, match: { value } })),
});
