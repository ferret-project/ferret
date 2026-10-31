/**
 * Semantic search: embeds the query and asks the vector store for the nearest
 * item summaries and document chunks in this household, best hit per item.
 *
 * With a reranker, a second pass scores each candidate passage against the
 * query. The embedding cut-off still decides what's shown — the reranker is
 * poor at intent ("reach the gutters" → ladder scored 0.0002) — but it's very
 * good at exact text, so strong reranker matches are added even below the
 * cut-off, listed first, and used to pick the snippet.
 *
 * The matches nobody is sure of — by meaning only, the reranker unconvinced, the embedding not strong — can be decided
 * by a judge (the chat model): asked once which of them are what the person is looking for. Embeddings put a circular
 * saw near "chainsaw" and a stand mixer near "sewing machine" (~0.45–0.54, above the cut-off); a model that reads the
 * candidates says no. It takes a second or two, so search runs in two steps (lib/inventory.ts searchItems):
 * `hold: true` answers at once with the sure matches and says how many are being held; then `judge` decides those.
 * Without a chat model, or if the judge is slow or fails, the cut-off decides as before.
 */
import type { SearchHit } from "@ferret/shared";
import type { Ai, Reranker, SearchProfile, TextModel, Vectors } from "../ports";

/**
 * Below this cosine similarity, matches are mostly noise. Calibrated on qwen3-embedding:8b:
 * right answers scored 0.47–0.60 ("make coffee" → espresso machine 0.60), unrelated items
 * up to ~0.41 ("toaster", owning none, topped out at 0.41). Re-check if EMBED_MODEL changes.
 */
export const MIN_SCORE = 0.43;
/** When the words already matched something, only add meaning matches this strong ("dewalt" ≠ snow blower). */
export const STRONG_SCORE = 0.5;
/**
 * Reranker relevance that counts as a real match on its own. Calibrated on bge-reranker-v2-m3:
 * passages that actually answer the query scored 0.89–0.98; everything else stayed under 0.05.
 */
export const RERANK_MATCH = 0.5;
/** With a judge, meaning matches down to this go to it (a little under the cut-off). */
export const JUDGE_FLOOR = 0.33;
/**
 * A meaning match this strong is sure: shown at once, never judged ("cut the grass" → lawn mower 0.62). The worst
 * false alarm seen ("chainsaw" → circular saw) was 0.54.
 */
export const SURE_SCORE = 0.58;
/**
 * The cut-offs for each set of models. Change one only with `eval:search` numbers before and after.
 * - home: qwen3-embedding:8b + bge-reranker-v2-m3 (the constants above).
 * Other models need their own, measured with eval/run.ts and passed in as `deps.searchProfile`.
 */
export const SEARCH_PROFILES = {
  home: { minScore: MIN_SCORE, strongScore: STRONG_SCORE, rerankMatch: RERANK_MATCH, judgeFloor: JUDGE_FLOOR, sureScore: SURE_SCORE },
} satisfies Record<string, SearchProfile>;

/** At most this many candidates are judged (the nearest). */
const JUDGE_MAX = 8;
/** A judge slower than this is skipped (the cut-off decides). It runs behind the first answer, so it can take a while. */
const JUDGE_TIMEOUT_MS = 12_000;

type Point = { score: number; payload: Record<string, string | number> };

export async function semanticSearch(
  deps: { ai: Ai; vectors: Vectors; reranker?: Reranker; profile?: SearchProfile },
  householdId: string,
  query: string,
  opts: { limit: number; minScore?: number; judge?: TextModel; hold?: boolean },
): Promise<{ hits: Map<string, SearchHit>; held: number }> {
  const p = deps.profile ?? SEARCH_PROFILES.home;
  const minScore = opts.minScore ?? p.minScore;
  const floor = opts.judge || opts.hold ? Math.min(p.judgeFloor, minScore) : minScore;
  const [vector] = await deps.ai.embed([query], "query");
  const points: Point[] = await deps.vectors.query(vector!, { limit: opts.limit * 3, filter: { householdId } });

  const relevance = deps.reranker ? await rerank(deps.reranker, query, points) : undefined;

  // Group passages by item: an item is in if any passage clears a bar.
  const items = new Map<string, { best: Point; evidence: Point; relevance: number }>();
  points.forEach((point, i) => {
    const r = relevance?.[i] ?? 0;
    if (point.score < floor && r < p.rerankMatch) return;
    const itemId = String(point.payload.itemId);
    const seen = items.get(itemId);
    if (!seen) return void items.set(itemId, { best: point, evidence: point, relevance: r });
    if (point.score > seen.best.score) seen.best = point;
    if (r > seen.relevance) Object.assign(seen, { evidence: point, relevance: r });
  });

  // The unsure ones (meaning only, the reranker unconvinced): the judge says which are wanted; else the cut-off.
  const unsure = [...items].filter(([, it]) => it.relevance < p.rerankMatch && it.best.score < p.sureScore).sort(([, a], [, b]) => b.best.score - a.best.score);
  const verdict = opts.judge && unsure.length ? await judged(opts.judge, query, unsure.slice(0, JUDGE_MAX).map(([id, it]) => [id, String(it.best.payload.text)])) : null;
  // Held for the judge: how many would go to it (beyond JUDGE_MAX it doesn't look).
  const held = opts.hold ? Math.min(unsure.length, JUDGE_MAX) : 0;
  for (const [id, it] of unsure) {
    const keep = opts.hold ? false : verdict ? verdict.has(id) : it.best.score >= minScore;
    if (!keep) items.delete(id);
  }

  // When the reranker found a clear answer, drop the weak tail ("mixer warranty" ≠ espresso machine).
  const clearAnswer = [...items.values()].some((it) => it.relevance >= p.rerankMatch);
  if (clearAnswer && !verdict && !opts.hold) {
    for (const [id, it] of items) if (it.relevance < p.rerankMatch && it.best.score < p.strongScore) items.delete(id);
  }

  // Strong reranker matches first (most relevant first), then the rest by embedding similarity.
  const ranked = [...items].sort(([, a], [, b]) => {
    const strongA = a.relevance >= p.rerankMatch;
    const strongB = b.relevance >= p.rerankMatch;
    if (strongA !== strongB) return strongA ? -1 : 1;
    return strongA ? b.relevance - a.relevance : b.best.score - a.best.score;
  });

  const hits = new Map<string, SearchHit>();
  for (const [itemId, { best, evidence, relevance: r }] of ranked.slice(0, opts.limit)) {
    // The snippet is the passage that best answers the query: the reranker's pick, else the nearest one.
    const shown = relevance ? evidence : best;
    hits.set(itemId, {
      via: "meaning",
      score: round(best.score),
      ...(relevance ? { relevance: round(r) } : {}),
      ...(shown.payload.source === "document"
        ? {
            attachmentId: String(shown.payload.attachmentId),
            filename: String(shown.payload.filename),
            snippet: String(shown.payload.text),
          }
        : {}),
    });
  }
  return { hits, held };
}

const judgeCache = new Map<string, { at: number; ids: Set<string> }>();

/**
 * Which candidates are what the person searching for `query` wants: a set of their ids, or null if the judge didn't
 * answer in time (the cut-off decides then). Kept 10 minutes per query and candidates.
 */
async function judged(judge: TextModel, query: string, candidates: [string, string][]): Promise<Set<string> | null> {
  const key = `${query.toLowerCase()}\u0000${candidates.map(([id]) => id).join(",")}`;
  const hit = judgeCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.ids;
  // Worded after trying several on a set of yes/no cases (eval/search.ts): asking what someone is "looking for" made
  // the model refuse a kayak for "go out on the lake"; asking whether they'd be glad to see it gets both kinds right.
  const prompt =
    `Home inventory search. Query: "${query}"\nCandidates:\n` +
    candidates.map(([, text], i) => `${i + 1}. ${text.replace(/\s+/g, " ").slice(0, 300)}`).join("\n") +
    `\n\nKeep a candidate if a person typing that query would be glad to see it: it's the thing named, holds it, or is ` +
    `the tool for the task described. Drop it if the query names a different kind of object that this candidate merely ` +
    `resembles or shares a category with. Return the numbers to keep.`;
  const schema = { type: "object", properties: { matches: { type: "array", items: { type: "integer" } } }, required: ["matches"] };
  try {
    const answer = (await Promise.race([
      judge.json({ prompt, schema }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("judge timed out")), JUDGE_TIMEOUT_MS)),
    ])) as { matches?: unknown };
    // A debugging switch for eval/search.ts (Node); Node only.
    if ((globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.DEBUG_JUDGE) console.log(`[judge] ${query}\n${prompt.split("\n\n").at(-1)}\n→ ${JSON.stringify(answer)}`);
    if (!Array.isArray(answer?.matches)) return null;
    const ids = new Set(answer.matches.filter((n): n is number => Number.isInteger(n) && n >= 1 && n <= candidates.length).map((n) => candidates[n - 1]![0]));
    if (judgeCache.size > 500) judgeCache.clear();
    judgeCache.set(key, { at: Date.now(), ids });
    return ids;
  } catch (err) {
    console.warn(`Search judge unavailable, using the cut-off: ${String(err)}`);
    return null;
  }
}

/** Reranker scores per point, or undefined if it's unavailable (search then works without it). */
async function rerank(reranker: Reranker, query: string, points: Point[]) {
  try {
    return await reranker.rerank(
      query,
      points.map((p) => String(p.payload.text)),
    );
  } catch (err) {
    console.warn(`Reranker unavailable, using embeddings only: ${String(err)}`);
    return undefined;
  }
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Reciprocal rank fusion: merges ranked lists of ids, scoring each id
 * Σ 1/(k + rank) over the lists it appears in. Items ranked well by both
 * keyword and meaning search rise to the top; ties keep the earlier list's order.
 */
export function fuse(lists: string[][], k = 60): string[] {
  const scores = new Map<string, number>();
  for (const list of lists) list.forEach((id, i) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1)));
  const firstSeen = [...new Set(lists.flat())];
  return firstSeen.sort((a, b) => scores.get(b)! - scores.get(a)! || firstSeen.indexOf(a) - firstSeen.indexOf(b));
}
