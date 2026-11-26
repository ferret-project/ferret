/**
 * "Did you mean vacuum?" — when a search's words match nothing, each word is compared with the words the household
 * itself uses (its things' names, brands and models, its places, categories and tags), and a close spelling offered —
 * only if the corrected search finds something by its words. Nothing leaves the server; no dictionary.
 */
import { and, eq, isNull } from "drizzle-orm";
import { category, item, location, tag } from "../db/schema";
import type { Db } from "../ports";
import { fullTextSearch } from "./fulltext";

const WORD = /[\p{L}\p{N}]+/gu;

/** Edits between two words (insert, delete, change, or swap two neighbours), stopping once past `max`. */
export function editDistance(a: string, b: string, max: number) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    let best = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2]![j - 2]! + 1);
      d[i]![j] = v;
      best = Math.min(best, v);
    }
    if (best > max) return max + 1;
  }
  return d[a.length]![b.length]!;
}

/**
 * Everyday words of a question or a search — never "corrected" to a word the household happens to use ("How many…" isn't
 * "How man…" because something is called "Man cave").
 */
const EVERYDAY = new Set(
  ("about after again also always another any anything around away back been before being below between both bought could " +
    "does doing done down each else even ever every from gave give goes going gone have here into just keep kept kind last left " +
    "like long look made make many more most much must need never next none only other over own part same should show since " +
    "some spare still such than that their them then there these they thing things this those through under until used very " +
    "want was were what when where which while whose why will with would year years your yours").split(" "),
);

/** How many edits a word of this length may be off by: none for short ones (too many near-misses), then 1, then 2. */
const allowed = (length: number) => (length < 4 ? 0 : length < 7 ? 1 : 2);

/** The words the household uses, and how often. */
async function vocabulary(db: Db, householdId: string) {
  const [items, places, categories, tags] = await Promise.all([
    db.select({ name: item.name, brand: item.brand, model: item.model }).from(item).where(and(eq(item.householdId, householdId), isNull(item.deletedAt))),
    db.select({ name: location.name }).from(location).where(and(eq(location.householdId, householdId), isNull(location.deletedAt))),
    db.select({ name: category.name }).from(category).where(eq(category.householdId, householdId)),
    db.select({ name: tag.name }).from(tag).where(eq(tag.householdId, householdId)),
  ]);
  const counts = new Map<string, number>();
  const texts = [...items.flatMap((i) => [i.name, i.brand, i.model]), ...places.map((p) => p.name), ...categories.map((c) => c.name), ...tags.map((t) => t.name)];
  for (const text of texts) {
    for (const m of (text ?? "").toLowerCase().matchAll(WORD)) if (m[0].length >= 3) counts.set(m[0], (counts.get(m[0]) ?? 0) + 1);
  }
  return counts;
}

/** The search with its misspelt words corrected, if that finds something by its words; else undefined. */
export async function suggestSpelling(db: Db, householdId: string, query: string): Promise<string | undefined> {
  const words = [...query.matchAll(WORD)].map((m) => ({ text: m[0], at: m.index }));
  if (!words.length || words.length > 8) return undefined;
  const vocab = await vocabulary(db, householdId);
  if (!vocab.size) return undefined;
  let changed = false;
  let corrected = query;
  // From the end, so earlier positions stay right as words change length.
  for (const w of [...words].reverse()) {
    const lower = w.text.toLowerCase();
    const max = allowed(lower.length);
    if (!max || /\d/.test(lower) || EVERYDAY.has(lower) || vocab.has(lower) || [...vocab.keys()].some((v) => v.startsWith(lower))) continue;
    let best: { word: string; distance: number; count: number } | undefined;
    for (const [word, count] of vocab) {
      const distance = editDistance(lower, word, max);
      if (distance > max) continue;
      if (!best || distance < best.distance || (distance === best.distance && count > best.count)) best = { word, distance, count };
    }
    if (!best) continue;
    changed = true;
    corrected = corrected.slice(0, w.at) + best.word + corrected.slice(w.at + w.text.length);
  }
  if (!changed) return undefined;
  const found = await fullTextSearch(db, householdId, corrected, 1).catch(() => []);
  return found.length ? corrected : undefined;
}
