/**
 * A household's categories as the models see them: each by its path ("Electronics › TV"), for a prompt to pick from,
 * and the way back from what a model wrote to the category's id (by path or by bare name, case aside). Used where a
 * model sorts things into the household's own categories: room scans, photos and receipts, things described in words.
 */
import { and, eq, isNull } from "drizzle-orm";
import { category } from "../db/schema";
import type { Db } from "../ports";

/** At most this many in a prompt (a household with more gets the first, alphabetically). */
const MAX_IN_PROMPT = 150;

export type CategoryPaths = { list: string[]; lookup: Map<string, string>; pathOf: Map<string, string> };

export async function categoryPaths(db: Db, householdId: string): Promise<CategoryPaths> {
  const rows = await db
    .select({ id: category.id, name: category.name, parentId: category.parentId })
    .from(category)
    .where(and(eq(category.householdId, householdId), isNull(category.deletedAt)));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const pathOf = (id: string) => {
    const parts: string[] = [];
    for (let at = byId.get(id), hops = 0; at && hops < 20; at = at.parentId ? byId.get(at.parentId) : undefined, hops++) parts.unshift(at.name);
    return parts.join(" › ");
  };
  const paths = rows.map((r) => ({ id: r.id, path: pathOf(r.id), name: r.name }));
  const lookup = new Map<string, string>();
  for (const p of paths) lookup.set(p.name.toLowerCase(), p.id);
  for (const p of paths) lookup.set(p.path.toLowerCase(), p.id); // a full path wins over a repeated name
  return { list: paths.map((p) => p.path).sort().slice(0, MAX_IN_PROMPT), lookup, pathOf: new Map(paths.map((p) => [p.id, p.path])) };
}

/** The category a model named, if it's one of the household's. */
export const categoryNamed = (paths: Pick<CategoryPaths, "lookup">, named: string | null | undefined) =>
  (named && paths.lookup.get(named.trim().toLowerCase())) || null;
