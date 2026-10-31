/**
 * Categories (what a thing is, nested) and tags (free labels — a tag is also a
 * collection, with its own page). Same Caller pattern as lib/inventory.ts:
 * every function acts for one caller in one household.
 */
import { PHOTO_ORDER } from "./photo-order";
import type { CategoryField, CategoryInput, CategoryNode, CategoryPatch, TagSummary } from "@ferret/shared";
import { and, count, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { attachment, category, item, itemTag, tag } from "../db/schema";
import { type Caller, itemChanged, itemScope, logActivity, notFound } from "./inventory";
import { inList } from "./sql";

const categoryIn = (v: Pick<Caller, "householdId">, id: string) =>
  and(eq(category.id, id), eq(category.householdId, v.householdId), isNull(category.deletedAt));

async function allCategories(v: Caller) {
  return v.db
    .select()
    .from(category)
    .where(and(eq(category.householdId, v.householdId), isNull(category.deletedAt)))
    .orderBy(category.name);
}

/** Every category as a tree, with paths, how many items each holds directly, and a photo from inside it. */
export async function categoryTree(v: Caller): Promise<CategoryNode[]> {
  const [rows, counts, photos] = await Promise.all([
    allCategories(v),
    v.db.select({ categoryId: item.categoryId, n: count() }).from(item).where(itemScope(v)).groupBy(item.categoryId),
    // Photos of filed things, the most recently changed thing first.
    v.db
      .select({ categoryId: item.categoryId, photoId: attachment.id })
      .from(attachment)
      .innerJoin(item, eq(item.id, attachment.itemId))
      .where(and(itemScope(v), isNotNull(item.categoryId), eq(attachment.kind, "photo"), isNull(attachment.deletedAt)))
      .orderBy(desc(item.updatedAt), ...PHOTO_ORDER),
  ]);
  const itemsIn = new Map(counts.map((c) => [c.categoryId, c.n]));
  const photoIn = new Map<string, string>();
  for (const p of photos) if (p.categoryId && !photoIn.has(p.categoryId)) photoIn.set(p.categoryId, p.photoId);
  const build = (parentId: string | null, prefix: string): CategoryNode[] =>
    rows
      .filter((c) => (c.parentId ?? null) === parentId)
      .map((c) => {
        const path = prefix ? `${prefix} › ${c.name}` : c.name;
        const children = build(c.id, path);
        // Its own things' photo, else one from a subcategory.
        const photoId = photoIn.get(c.id) ?? children.find((k) => k.photoId)?.photoId ?? null;
        return { id: c.id, name: c.name, icon: c.icon, path, fields: c.fields ?? [], itemCount: itemsIn.get(c.id) ?? 0, photoId, children };
      });
  return build(null, "");
}

/** Category id → { path, fields (its own and its ancestors') }. */
export async function categoryInfo(v: Caller) {
  const info = new Map<string, { path: string; topId: string; topName: string; fields: CategoryField[] }>();
  const walk = (nodes: CategoryNode[], top?: CategoryNode, inherited: CategoryField[] = []) =>
    nodes.forEach((n) => {
      const fields = [...inherited, ...n.fields.filter((f) => !inherited.some((i) => i.key === f.key))];
      info.set(n.id, { path: n.path, topId: (top ?? n).id, topName: (top ?? n).name, fields });
      walk(n.children, top ?? n, fields);
    });
  walk(await categoryTree(v));
  return info;
}

/** A category's id plus all the ids nested under it. */
export async function categoryDescendants(v: Caller, id: string) {
  const rows = await allCategories(v);
  const ids = [id];
  for (let i = 0; i < ids.length; i++) ids.push(...rows.filter((c) => c.parentId === ids[i]).map((c) => c.id));
  return ids;
}

export async function createCategory(v: Caller, input: CategoryInput) {
  if (input.parentId) {
    const [parent] = await v.db.select({ id: category.id }).from(category).where(categoryIn(v, input.parentId));
    if (!parent) throw notFound("Parent category");
  }
  const [row] = await v.db
    .insert(category)
    .values({ householdId: v.householdId, name: input.name, parentId: input.parentId ?? null, icon: input.icon ?? null, fields: input.fields ?? [] })
    .returning();
  await logActivity(v, "category.create", row!.id, `Added category ${row!.name}`);
  return row!;
}

/** Rename, move (not inside itself) or change fields. Items in it are re-indexed: search reads the category path. */
export async function updateCategory(v: Caller, id: string, input: CategoryPatch) {
  const subtree = await categoryDescendants(v, id);
  if (input.parentId) {
    if (subtree.includes(input.parentId)) throw new HTTPException(422, { message: "A category can't go inside itself" });
    const [parent] = await v.db.select({ id: category.id }).from(category).where(categoryIn(v, input.parentId));
    if (!parent) throw notFound("Parent category");
  }
  const [row] = await v.db.update(category).set(input).where(categoryIn(v, id)).returning();
  if (!row) throw notFound("Category");
  await reindex(v, await itemsInCategories(v, subtree));
  return row;
}

/** Removes a category; its subcategories and items move up to its parent (or to no category). */
export async function deleteCategory(v: Caller, id: string) {
  const [current] = await v.db.select().from(category).where(categoryIn(v, id));
  if (!current) throw notFound("Category");
  const affected = await itemsInCategories(v, await categoryDescendants(v, id));
  await v.db
    .update(category)
    .set({ parentId: current.parentId })
    .where(and(eq(category.householdId, v.householdId), eq(category.parentId, id)));
  await v.db
    .update(item)
    .set({ categoryId: current.parentId })
    .where(and(eq(item.householdId, v.householdId), eq(item.categoryId, id)));
  await v.db.update(category).set({ deletedAt: new Date() }).where(categoryIn(v, id));
  await logActivity(v, "category.delete", id, `Removed category ${current.name}`);
  await reindex(v, affected);
}

async function itemsInCategories(v: Caller, ids: string[]) {
  const rows = await v.db.select({ id: item.id }).from(item).where(and(itemScope(v), inList(item.categoryId, ids)));
  return rows.map((r) => r.id);
}

async function reindex(v: Caller, itemIds: string[]) {
  for (const itemId of itemIds) await itemChanged(v, itemId);
}

/**
 * A starting set for insurance-minded households (only when there are none
 * yet). Everyone can rename, nest or remove them.
 */
export const STARTER_CATEGORIES: { name: string; icon: string; children?: { name: string; icon: string }[]; fields?: CategoryField[] }[] = [
  { name: "Appliances", icon: "fridge", children: [{ name: "Kitchen", icon: "microwave" }, { name: "Laundry", icon: "wash-machine" }, { name: "Heating & cooling", icon: "air-conditioning" }] },
  { name: "Electronics", icon: "device-tv",
    children: [{ name: "TVs", icon: "device-tv" }, { name: "Computers", icon: "device-laptop" }, { name: "Phones & tablets", icon: "device-mobile" }, { name: "Audio", icon: "headphones" }, { name: "Cameras", icon: "camera" }],
    fields: [{ key: "screen_size", label: "Screen size", type: "number", unit: "in" }] },
  { name: "Furniture", icon: "armchair" },
  { name: "Tools", icon: "tool", children: [{ name: "Power tools", icon: "plug" }, { name: "Hand tools", icon: "hammer" }, { name: "Garden", icon: "plant-2" }] },
  { name: "Kitchen", icon: "tools-kitchen-2" },
  { name: "Jewelry & watches", icon: "diamond", fields: [{ key: "material", label: "Material", type: "text" }] },
  { name: "Art & collectibles", icon: "palette", fields: [{ key: "artist", label: "Artist / maker", type: "text" }] },
  { name: "Clothing", icon: "shirt" },
  { name: "Sports & outdoors", icon: "bike" },
  { name: "Vehicles", icon: "car", fields: [{ key: "vin", label: "VIN", type: "text" }, { key: "plate", label: "Plate", type: "text" }] },
  { name: "Documents & valuables", icon: "file-certificate" },
  { name: "Seasonal & decorations", icon: "christmas-tree" },
];

export async function addStarterCategories(v: Caller) {
  const existing = await allCategories(v);
  if (existing.length) throw new HTTPException(409, { message: "There are categories already" });
  for (const c of STARTER_CATEGORIES) {
    const [parent] = await v.db
      .insert(category)
      .values({ householdId: v.householdId, name: c.name, icon: c.icon, fields: c.fields ?? [] })
      .returning();
    for (const child of c.children ?? []) {
      await v.db.insert(category).values({ householdId: v.householdId, name: child.name, icon: child.icon, parentId: parent!.id, fields: [] });
    }
  }
  await logActivity(v, "category.create", v.householdId, "Added the starter categories");
  return categoryTree(v);
}

// ── Tags ────────────────────────────────────────────────────────────────────
const tagKey = (name: string) => name.trim().replace(/\s+/g, " ").toLowerCase();

export async function listTags(v: Caller): Promise<TagSummary[]> {
  const rows = await v.db
    .select({ id: tag.id, name: tag.name, items: count(item.id) })
    .from(tag)
    .leftJoin(itemTag, eq(itemTag.tagId, tag.id))
    .leftJoin(item, and(eq(item.id, itemTag.itemId), isNull(item.deletedAt)))
    .where(eq(tag.householdId, v.householdId))
    .groupBy(tag.id)
    .orderBy(tag.name);
  return rows;
}

/** Tag names → ids, creating the new ones (first spelling wins). */
export async function ensureTags(v: Caller, names: string[]) {
  const wanted = [...new Map(names.map((n) => [tagKey(n), n.trim().replace(/\s+/g, " ")])).entries()].filter(([k]) => k);
  if (!wanted.length) return [];
  for (const [key, name] of wanted) {
    await v.db.insert(tag).values({ householdId: v.householdId, name, key }).onConflictDoNothing();
  }
  const rows = await v.db
    .select({ id: tag.id })
    .from(tag)
    .where(and(eq(tag.householdId, v.householdId), inList(tag.key, wanted.map(([k]) => k))));
  return rows.map((r) => r.id);
}

/** Replaces an item's tags. */
export async function setItemTags(v: Caller, itemId: string, names: string[]) {
  const ids = await ensureTags(v, names);
  await v.db.delete(itemTag).where(and(eq(itemTag.itemId, itemId), eq(itemTag.householdId, v.householdId)));
  if (ids.length) await v.db.insert(itemTag).values(ids.map((tagId) => ({ itemId, tagId, householdId: v.householdId })));
}

/** Item id → its tag names (sorted). */
export async function tagsOf(v: Caller, itemIds: string[]) {
  const map = new Map<string, string[]>(itemIds.map((id) => [id, []]));
  if (!itemIds.length) return map;
  const rows = await v.db
    .select({ itemId: itemTag.itemId, name: tag.name })
    .from(itemTag)
    .innerJoin(tag, eq(tag.id, itemTag.tagId))
    .where(and(eq(itemTag.householdId, v.householdId), inList(itemTag.itemId, itemIds)))
    .orderBy(tag.name);
  for (const r of rows) map.get(r.itemId)?.push(r.name);
  return map;
}

export async function findTag(v: Caller, name: string) {
  const [row] = await v.db
    .select()
    .from(tag)
    .where(and(eq(tag.householdId, v.householdId), eq(tag.key, tagKey(name))));
  return row;
}

/** Rename a tag; renaming onto an existing tag merges them. */
export async function renameTag(v: Caller, id: string, name: string) {
  const [current] = await v.db.select().from(tag).where(and(eq(tag.id, id), eq(tag.householdId, v.householdId)));
  if (!current) throw notFound("Tag");
  const target = await findTag(v, name);
  const tagged = await v.db.select({ itemId: itemTag.itemId }).from(itemTag).where(eq(itemTag.tagId, id));
  if (target && target.id !== id) {
    for (const { itemId } of tagged) {
      await v.db.insert(itemTag).values({ itemId, tagId: target.id, householdId: v.householdId }).onConflictDoNothing();
    }
    await v.db.delete(itemTag).where(eq(itemTag.tagId, id));
    await v.db.delete(tag).where(eq(tag.id, id));
  } else {
    await v.db.update(tag).set({ name: name.trim(), key: tagKey(name) }).where(eq(tag.id, id));
  }
  await reindex(v, tagged.map((t) => t.itemId));
  return findTag(v, name);
}

export async function deleteTag(v: Caller, id: string) {
  const [current] = await v.db.select().from(tag).where(and(eq(tag.id, id), eq(tag.householdId, v.householdId)));
  if (!current) throw notFound("Tag");
  const tagged = await v.db.select({ itemId: itemTag.itemId }).from(itemTag).where(eq(itemTag.tagId, id));
  await v.db.delete(itemTag).where(eq(itemTag.tagId, id));
  await v.db.delete(tag).where(eq(tag.id, id));
  await reindex(v, tagged.map((t) => t.itemId));
}
