/**
 * The inventory service: what the REST API (routes/inventory.ts) and the MCP
 * tools (mcp/tools.ts) both do, so the app and Claude always agree. Every
 * function acts for one caller in one household and filters by its householdId.
 */
import { PHOTO_ORDER } from "./photo-order";
import { meaningSearchAllowed, recordUsage, requireAllowed, requireRoom } from "./plan";
import {
  type ItemDisposition,
  type ItemOrigin,
  type ItemsBulk,
  type ItemsBulkResult,
  type ItemInput,
  type ItemPatch,
  type LocationInput,
  barcodeVariants,
  type ItemListing,
  type LocationNode,
  type LocationPatch,
  type MissingDetail,
  type Overview,
  type PlacesTree,
  type PropertyInput,
  type PropertyPatch,
  type SearchHit,
  today,
  warrantyStatus,
} from "@ferret/shared";
import { and, asc, count, desc, eq, exists, inArray, isNotNull, isNull, notExists, type SQL, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { activity, attachment, category, collection, item, itemTag, itemTemplate, label, location, property, user, warranty } from "../db/schema";
import { INDEX_JOB } from "../jobs/index-item";
import type { Db, Deps } from "../ports";
import { countEvent } from "./analytics";
import { ASK_ITEMS, askInventory } from "./ask";
import { categoryInfo, setItemTags, tagsOf } from "./catalog";
import { listClaims } from "./claims";
import { queueProductLookup, rememberBarcode } from "./products";
import { recordMovement, shoppingList } from "./stock";
import { listMaintenance } from "./maintenance";
import { openLoansFor } from "./loans";
import { RECALL_CHECK_JOB } from "../jobs/recalls";
import { fullTextSearch, refreshFullText } from "./fulltext";
import { SEARCH_PROFILES, fuse, semanticSearch } from "./search";
import { todayFor } from "./household-time";
import { inList } from "./sql";

/** Who is acting, where, and through which client (recorded in the activity log). */
export interface Caller {
  deps: Deps;
  db: Db;
  householdId: string;
  userId: string;
  /** The household's time zone: what "today" is (lib/household-time.ts). */
  timeZone: string;
  via: "web" | "api" | "mcp";
  /** The API key's name, when it came with one (recorded as where things it adds came from). */
  keyName?: string | null;
}

export const notFound = (what: string) => new HTTPException(404, { message: `${what} not found` });

// ── Properties ──────────────────────────────────────────────────────────────
export async function listProperties(v: Caller) {
  return v.db
    .select()
    .from(property)
    .where(and(eq(property.householdId, v.householdId), isNull(property.deletedAt)))
    .orderBy(property.name);
}

export async function createProperty(v: Caller, input: PropertyInput) {
  const [row] = await v.db
    .insert(property)
    .values({ ...input, householdId: v.householdId })
    .returning();
  await logActivity(v, "property.create", row!.id, `Added ${row!.name}`);
  return row!;
}

const propertyIn = (v: Caller, id: string) =>
  and(eq(property.id, id), eq(property.householdId, v.householdId), isNull(property.deletedAt));

/** Rename a property (or change its details). Its items are re-indexed: their location path starts with its name. */
export async function updateProperty(v: Caller, id: string, input: PropertyPatch) {
  const [row] = await v.db.update(property).set(input).where(propertyIn(v, id)).returning();
  if (!row) throw notFound("Property");
  await logActivity(v, "property.update", row.id, `Updated ${row.name}`);
  const inside = await v.db
    .select({ id: location.id })
    .from(location)
    .where(and(eq(location.propertyId, id), eq(location.householdId, v.householdId), isNull(location.deletedAt)));
  await reindexItemsIn(v, inside.map((l) => l.id));
  return row;
}

/** Removes an empty property and its locations. Anything still kept there has to be moved first. */
/** A property's address on one line, as a map service reads it — or null without a street or city. */
export function propertyAddress(p: Pick<typeof property.$inferSelect, "street" | "city" | "region" | "postalCode" | "country">) {
  if (!p.street?.trim() && !p.city?.trim()) return null;
  const regionLine = [p.region, p.postalCode].filter((s) => s?.trim()).join(" ");
  return [p.street, p.city, regionLine, p.country].filter((s) => s?.trim()).join(", ");
}

/**
 * A map picture of a property's address (deps.maps — Apple Maps), fetched by the server so the browser never talks
 * to Apple. 404 without an address or with maps off; 502 if the map service fails.
 */
export async function propertyMap(v: Caller, id: string, scheme: "light" | "dark") {
  const [row] = await v.db
    .select()
    .from(property)
    .where(and(eq(property.id, id), eq(property.householdId, v.householdId), isNull(property.deletedAt)));
  if (!row) throw notFound("Property");
  const address = propertyAddress(row);
  if (!address || !v.deps.maps) throw new HTTPException(404, { message: "No map for this property" });
  return v.deps.maps.snapshot(address, { scheme }).catch((err: unknown) => {
    throw new HTTPException(502, { message: `Couldn't get the map (${err instanceof Error ? err.message : String(err)})` });
  });
}

export async function deleteProperty(v: Caller, id: string) {
  const [current] = await v.db.select().from(property).where(propertyIn(v, id));
  if (!current) throw notFound("Property");
  const inside = await v.db
    .select({ id: location.id })
    .from(location)
    .where(and(eq(location.propertyId, id), eq(location.householdId, v.householdId), isNull(location.deletedAt)));
  await refuseIfHoldsItems(v, inside.map((l) => l.id), current.name);
  const now = new Date();
  if (inside.length) {
    await v.db
      .update(location)
      .set({ deletedAt: now })
      .where(and(eq(location.householdId, v.householdId), inList(location.id, inside.map((l) => l.id))));
  }
  await v.db.update(property).set({ deletedAt: now }).where(propertyIn(v, id));
  await logActivity(v, "property.delete", id, `Removed ${current.name}`);
}

// ── Locations ───────────────────────────────────────────────────────────────
export async function listLocations(v: Caller, propertyId?: string) {
  const where: SQL[] = [eq(location.householdId, v.householdId), isNull(location.deletedAt)];
  if (propertyId) where.push(eq(location.propertyId, propertyId));
  return v.db
    .select()
    .from(location)
    .where(and(...where))
    .orderBy(location.name);
}

export async function createLocation(v: Caller, input: LocationInput) {
  const [parentProperty] = await v.db
    .select({ id: property.id })
    .from(property)
    .where(and(eq(property.id, input.propertyId), eq(property.householdId, v.householdId), isNull(property.deletedAt)));
  if (!parentProperty) throw notFound("Property");
  if (input.parentId) {
    const [parent] = await v.db.select().from(location).where(locationIn(v, input.parentId));
    if (!parent || parent.propertyId !== input.propertyId) throw notFound("Parent location");
  }
  const [row] = await v.db
    .insert(location)
    .values({ ...input, householdId: v.householdId })
    .returning();
  return row!;
}

export const locationIn = (v: Caller, id: string) =>
  and(eq(location.id, id), eq(location.householdId, v.householdId), isNull(location.deletedAt));

/** Rename or move a location. Items anywhere below it are re-indexed (their location path changed). */
export async function updateLocation(v: Caller, id: string, input: LocationPatch) {
  const [current] = await v.db.select().from(location).where(locationIn(v, id));
  if (!current) throw notFound("Location");

  const subtree = await descendants(v, id);
  if (input.parentId) {
    const [parent] = await v.db.select().from(location).where(locationIn(v, input.parentId));
    if (!parent || parent.propertyId !== current.propertyId) throw notFound("Parent location");
    if (subtree.includes(input.parentId)) throw new HTTPException(422, { message: "A location can't go inside itself" });
  }
  const [row] = await v.db.update(location).set(input).where(locationIn(v, id)).returning();
  await reindexItemsIn(v, subtree);
  return row!;
}

/** Removes an empty location and everything nested in it. Items kept anywhere inside have to be moved first. */
export async function deleteLocation(v: Caller, id: string) {
  const [current] = await v.db.select().from(location).where(locationIn(v, id));
  if (!current) throw notFound("Location");
  const subtree = await descendants(v, id);
  await refuseIfHoldsItems(v, subtree, current.name);
  await v.db
    .update(location)
    .set({ deletedAt: new Date() })
    .where(and(eq(location.householdId, v.householdId), inList(location.id, subtree)));
  await logActivity(v, "location.delete", id, `Removed ${current.name}`);
}

async function refuseIfHoldsItems(v: Caller, locationIds: string[], name: string) {
  if (!locationIds.length) return;
  const [held] = await v.db.select({ n: count() }).from(item).where(itemScope(v, { locationIds }));
  if (held?.n) {
    const message =
      held.n === 1
        ? `1 item is still kept in ${name} — move it first`
        : `${held.n} items are still kept in ${name} — move them first`;
    throw new HTTPException(409, { message });
  }
}

/** Their location path changed (a rename or a move): refresh search for every item kept in these locations. */
async function reindexItemsIn(v: Caller, locationIds: string[]) {
  if (!locationIds.length) return;
  const affected = await v.db.select({ id: item.id }).from(item).where(itemScope(v, { locationIds }));
  for (const { id: itemId } of affected) await itemChanged(v, itemId);
}

/** A location's id plus all the ids nested under it. */
export async function descendants(v: Caller, id: string) {
  const all = await v.db
    .select({ id: location.id, parentId: location.parentId })
    .from(location)
    .where(and(eq(location.householdId, v.householdId), isNull(location.deletedAt)));
  const ids = [id];
  for (let i = 0; i < ids.length; i++) ids.push(...all.filter((l) => l.parentId === ids[i]).map((l) => l.id));
  return ids;
}

/** Every property with its locations as a tree, and how many items each holds. */
export async function locationTree(v: Caller): Promise<PlacesTree> {
  const [properties, locations, counts] = await Promise.all([
    listProperties(v),
    listLocations(v),
    v.db
      .select({
        locationId: item.locationId,
        n: count(),
        cents: sql<number>`coalesce(sum(coalesce(${item.valueCents}, ${item.purchasePriceCents}) * max(${item.quantity}, 1)), 0)`,
      })
      .from(item)
      .where(itemScope(v))
      .groupBy(item.locationId),
  ]);
  const itemsAt = new Map(counts.map((r) => [r.locationId, r.n]));
  const valueAt = new Map(counts.map((r) => [r.locationId, Number(r.cents)]));
  const build = (propertyId: string, parentId: string | null, prefix: string): LocationNode[] =>
    locations
      .filter((l) => l.propertyId === propertyId && (l.parentId ?? null) === parentId)
      .map((l) => {
        const path = `${prefix} › ${l.name}`;
        const children = build(propertyId, l.id, path);
        const itemCount = itemsAt.get(l.id) ?? 0;
        const valueCents = valueAt.get(l.id) ?? 0;
        return {
          id: l.id,
          name: l.name,
          path,
          itemCount,
          valueCents,
          totalCount: children.reduce((n, c) => n + c.totalCount, itemCount),
          totalValueCents: children.reduce((n, c) => n + c.totalValueCents, valueCents),
          children,
        };
      });
  return {
    properties: properties.map((p) => ({
      id: p.id,
      name: p.name,
      type: p.type as PlacesTree["properties"][number]["type"],
      details: {
        street: p.street,
        city: p.city,
        region: p.region,
        postalCode: p.postalCode,
        country: p.country,
        yearBuilt: p.yearBuilt,
        valueCents: p.valueCents,
        notes: p.notes,
      },
      locations: build(p.id, null, p.name),
    })),
    unplacedItems: itemsAt.get(null) ?? 0,
    maps: Boolean(v.deps.maps),
  };
}

/** Location id → "Highland House › Garage › Shelf 2", for every location in the household. */
export async function locationPaths(v: Caller) {
  const { properties } = await locationTree(v);
  const paths = new Map<string, string>();
  const walk = (nodes: LocationNode[]) =>
    nodes.forEach((n) => {
      paths.set(n.id, n.path);
      walk(n.children);
    });
  properties.forEach((p) => walk(p.locations));
  return paths;
}

// ── Items ───────────────────────────────────────────────────────────────────
export interface ItemFilter {
  locationId?: string;
  /** Any of these locations (e.g. a room and everything in it). */
  locationIds?: string[];
  barcode?: string;
  /** Items without a photo, a value, a place, a document (receipt/manual) or a category. */
  missing?: MissingDetail;
  /** Any of these categories (e.g. one and its subcategories). */
  categoryIds?: string[];
  /** Items with this tag. */
  tagId?: string;
  /** What's directly inside this box. */
  containerItemId?: string;
  /** Things added this way ("claude": what Claude added). */
  origin?: ItemOrigin;
  /** Leave out things inside boxes. */
  topLevel?: boolean;
  /** Only boxes. */
  boxes?: boolean;
  /**
   * Things you no longer have (sold, given away, lost…): left out unless asked for — "include" for what's reached by
   * its id (its page, its files, restoring it), "only" for the list of past things.
   */
  gone?: "include" | "only";
  /** What's in this collection. */
  collectionId?: string;
  /**
   * The want list (things not owned yet): left out unless asked for — "include" it, or "only" it. What's reached by
   * its id (gone: "include") includes it too.
   */
  wanted?: "include" | "only";
}

export function itemScope(v: Caller, filter: ItemFilter = {}) {
  const where: SQL[] = [eq(item.householdId, v.householdId), isNull(item.deletedAt)];
  if (filter.gone === "only") where.push(isNotNull(item.disposition));
  else if (filter.gone !== "include") where.push(isNull(item.disposition));
  if (filter.wanted === "only") where.push(eq(item.wanted, true));
  else if (filter.wanted !== "include" && filter.gone !== "include") where.push(eq(item.wanted, false));
  if (filter.collectionId) where.push(eq(item.collectionId, filter.collectionId));
  if (filter.locationId) where.push(eq(item.locationId, filter.locationId));
  if (filter.locationIds) where.push(inList(item.locationId, filter.locationIds));
  if (filter.categoryIds) where.push(inList(item.categoryId, filter.categoryIds));
  if (filter.containerItemId) where.push(eq(item.containerItemId, filter.containerItemId));
  if (filter.origin) where.push(eq(item.origin, filter.origin));
  if (filter.topLevel) where.push(isNull(item.containerItemId));
  if (filter.boxes) where.push(eq(item.isContainer, true));
  if (filter.tagId) {
    where.push(
      exists(
        v.db
          .select({ one: sql`1` })
          .from(itemTag)
          .where(and(eq(itemTag.itemId, item.id), eq(itemTag.tagId, filter.tagId), eq(itemTag.householdId, v.householdId))),
      ),
    );
  }
  // A UPC-A and its EAN-13 spelling are the same code (and items keep whatever was typed or scanned).
  if (filter.barcode) where.push(inArray(item.barcode, [filter.barcode, ...barcodeVariants(filter.barcode)]));
  if (filter.missing) where.push(lacks(v, filter.missing));
  return and(...where);
}

function lacks(v: Caller, detail: MissingDetail): SQL {
  if (detail === "place") return isNull(item.locationId);
  if (detail === "category") return isNull(item.categoryId);
  if (detail === "value") return and(isNull(item.valueCents), isNull(item.purchasePriceCents))!;
  return notExists(
    v.db
      .select({ one: sql`1` })
      .from(attachment)
      .where(
        and(
          eq(attachment.itemId, item.id),
          eq(attachment.householdId, v.householdId),
          eq(attachment.kind, detail),
          isNull(attachment.deletedAt),
        ),
      ),
  );
}

const SORTS = {
  updated: item.updatedAt,
  name: sql`lower(${item.name})`,
  value: sql`coalesce(${item.valueCents}, ${item.purchasePriceCents})`,
  bought: item.purchaseDate,
  added: item.createdAt,
} as const;

export async function listItems(
  v: Caller,
  filter: ItemFilter,
  page: { limit: number; offset: number; sort?: keyof typeof SORTS; dir?: "asc" | "desc" },
) {
  const scope = itemScope(v, filter);
  const by = SORTS[page.sort ?? "updated"];
  // Things with no value or date sort last either way; ties by name.
  const order = page.dir === "asc" ? [sql`${by} is null`, asc(by), asc(item.name)] : [sql`${by} is null`, desc(by), asc(item.name)];
  const [rows, [totals]] = await Promise.all([
    v.db.select().from(item).where(scope).orderBy(...order).limit(page.limit).offset(page.offset),
    v.db
      .select({
        total: count(),
        cents: sql<number>`coalesce(sum(coalesce(${item.valueCents}, ${item.purchasePriceCents}) * max(${item.quantity}, 1)), 0)`,
      })
      .from(item)
      .where(scope),
  ]);
  return {
    data: await withTags(v, rows),
    total: totals?.total ?? 0,
    /** What all of them (not just this page) are worth. */
    valueCents: Number(totals?.cents ?? 0),
    limit: page.limit,
    offset: page.offset,
  };
}

/** Items as lists show them: with their first photo (for a thumbnail) and where they're kept. */
/** Item rows with their tag names (an item's tags live in item_tag). */
export async function withTags<T extends { id: string }>(v: Caller, rows: T[]) {
  const tags = await tagsOf(v, rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, tags: tags.get(r.id) ?? [] }));
}

export async function asListing<T extends typeof item.$inferSelect>(
  v: Caller,
  rows: T[],
): Promise<(T & Pick<ItemListing, "photoId" | "place" | "category" | "container" | "contents" | "labelCode" | "loan">)[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const boxIds = [...new Set(rows.flatMap((r) => (r.containerItemId ? [r.containerItemId] : [])))];
  const [photos, paths, categories, boxes, inside, labels, loans] = await Promise.all([
    v.db
      .select({ id: attachment.id, itemId: attachment.itemId })
      .from(attachment)
      .where(
        and(
          eq(attachment.householdId, v.householdId),
          inList(attachment.itemId, rows.map((r) => r.id)),
          eq(attachment.kind, "photo"),
          isNull(attachment.deletedAt),
        ),
      )
      .orderBy(...PHOTO_ORDER),
    locationPaths(v),
    categoryInfo(v),
    boxIds.length ? v.db.select({ id: item.id, name: item.name }).from(item).where(and(itemScope(v), inList(item.id, boxIds))) : [],
    v.db
      .select({ boxId: item.containerItemId, n: count() })
      .from(item)
      .where(and(itemScope(v), inList(item.containerItemId, ids)))
      .groupBy(item.containerItemId),
    v.db
      .select({ itemId: label.itemId, code: label.code })
      .from(label)
      .where(and(eq(label.householdId, v.householdId), inList(label.itemId, ids))),
    openLoansFor(v, ids),
  ]);
  const boxName = new Map(boxes.map((b) => [b.id, b.name]));
  const contentCount = new Map(inside.map((c) => [c.boxId, c.n]));
  const codeOf = new Map(labels.map((l) => [l.itemId, l.code]));
  const firstPhoto = new Map<string, string>();
  for (const p of photos) if (!firstPhoto.has(p.itemId)) firstPhoto.set(p.itemId, p.id);
  return rows.map((r) => ({
    ...r,
    photoId: firstPhoto.get(r.id) ?? null,
    place: r.locationId ? (paths.get(r.locationId) ?? null) : null,
    category: r.categoryId ? (categories.get(r.categoryId)?.path ?? null) : null,
    container: r.containerItemId && boxName.has(r.containerItemId) ? { id: r.containerItemId, name: boxName.get(r.containerItemId)! } : null,
    contents: contentCount.get(r.id) ?? 0,
    labelCode: codeOf.get(r.id) ?? null,
    loan: loans.has(r.id) ? (({ direction, person, since, dueOn }) => ({ direction, person, since, dueOn }))(loans.get(r.id)!) : null,
  }));
}

/**
 * Words + meaning, merged by reciprocal rank fusion: full-text matches (every word,
 * stemmed, in the item's fields, location or documents) and semantic matches each
 * vote by rank, so items both find rise to the top. One page of results; if the
 * embedding model or vector store is down, it's words only.
 */
/**
 * `judge`: how unsure meaning matches are decided when there's a chat model (lib/search.ts). "hold" (the app's first
 * request) leaves them out and says how many are `checking`; "now" asks the judge before answering (the app's second
 * request, Ask, Claude). Without a chat model, the cut-off decides either way.
 */
export async function searchItems(v: Caller, query: string, filter: ItemFilter, limit: number, judge: "hold" | "now" = "now") {
  const words = await fullTextSearch(v.db, v.householdId, query, limit);
  const hits: Record<string, SearchHit> = Object.fromEntries(
    words.map(({ itemId, rank: _, ...where }) => [itemId, { via: "words" as const, ...where }]),
  );
  let ids = words.map((w) => w.itemId);
  let checking = 0;

  // Search by meaning is AI: a plan without it (lib/plan.ts) searches by words only.
  if (searchEnabled(v.deps) && (await meaningSearchAllowed(v))) {
    try {
      const { ai, vectors, reranker } = v.deps;
      const profile = v.deps.searchProfile ?? SEARCH_PROFILES.home;
      const meaning = await semanticSearch({ ai: ai!, vectors: vectors!, reranker, profile }, v.householdId, query, {
        limit,
        // Alongside word matches, only strong meaning matches are worth adding.
        minScore: words.length ? profile.strongScore : profile.minScore,
        // The chat model decides the unsure ones — when words found nothing (alongside word matches the strong cut-off
        // is enough) — now, or after the first answer.
        ...(words.length || !v.deps.chat ? {} : judge === "hold" ? { hold: true } : { judge: v.deps.chat }),
      });
      checking = meaning.held;
      for (const [id, hit] of meaning.hits) {
        // A word match keeps "words", and its own passage if it has one.
        hits[id] = hits[id] ? { ...hit, ...hits[id], via: "words" } : hit;
      }
      ids = fuse([ids, [...meaning.hits.keys()]]);
    } catch (err) {
      console.warn(`Semantic search unavailable, using words only: ${String(err)}`);
    }
  }

  ids = ids.slice(0, limit);
  const found = ids.length ? await v.db.select().from(item).where(and(itemScope(v, filter), inList(item.id, ids))) : [];
  const byId = new Map(found.map((r) => [r.id, r]));
  const rows = await withTags(v, ids.flatMap((id) => byId.get(id) ?? [])); // keeps the ranking; drops other locations/deleted
  return { data: rows, total: rows.length, limit, offset: 0, hits: Object.fromEntries(rows.map((r) => [r.id, hits[r.id]!])), ...(checking ? { checking } : {}) };
}

/** Ask Ferret: a question answered from the household's own items and documents, with sources. */
export async function ask(v: Caller, question: string) {
  const model = v.deps.chat ?? v.deps.ai; // the stronger text model, when there is one
  if (!model) throw new HTTPException(409, { message: "Ask Ferret needs an AI model (CHAT_URL or OLLAMA_URL)" });
  const plan = await requireAllowed(v, "ai.ask"); // in the plan, and within its AI actions (lib/plan.ts)
  countEvent(v.deps, "ask");
  const results = await searchItems(v, question, {}, ASK_ITEMS);
  try {
    const onModel = () => recordUsage(v, "ai.ask", 1, plan); // counted only when the model is asked
    return await askInventory({ db: v.db, model, timeZone: v.timeZone, onModel }, v.householdId, question, results);
  } catch (err) {
    console.warn(`Ask Ferret failed: ${String(err)}`);
    throw new HTTPException(503, { message: "Ferret couldn't answer right now — try again in a moment" });
  }
}

/** Semantic search needs an embedding model, a vector store, and jobs to keep the index fresh. */
const searchEnabled = (deps: Deps) => Boolean(deps.ai && deps.vectors && deps.jobs);

/** After an item (or its attachments or location) changed: refresh full-text now, re-embed in the background. */
export async function itemChanged(v: Pick<Caller, "db" | "deps">, itemId: string) {
  await refreshFullText(v.db, itemId);
  if (searchEnabled(v.deps)) await v.deps.jobs!.enqueue(INDEX_JOB, { itemId });
}

export async function getItem(v: Caller, id: string) {
  const [row] = await v.db.select().from(item).where(and(eq(item.id, id), itemScope(v, { gone: "include" })));
  if (!row) throw notFound("Item");
  return (await withTags(v, [row]))[0]!;
}

/**
 * Where an item goes. Its category, location and box must be in the household;
 * a box must be marked as one and can't go inside itself. Inside a box, an item
 * is wherever the box is; given a different place directly, it comes out of
 * its box. Returns the fields to store besides the input.
 */
async function placement(
  v: Caller,
  input: Pick<ItemPatch, "locationId" | "containerItemId" | "categoryId">,
  current?: typeof item.$inferSelect,
): Promise<Partial<typeof item.$inferInsert>> {
  if (input.categoryId) {
    const [found] = await v.db
      .select({ id: category.id })
      .from(category)
      .where(and(eq(category.id, input.categoryId), eq(category.householdId, v.householdId), isNull(category.deletedAt)));
    if (!found) throw notFound("Category");
  }
  if (input.locationId) {
    const [found] = await v.db.select({ id: location.id }).from(location).where(locationIn(v, input.locationId));
    if (!found) throw notFound("Location");
  }
  if (input.containerItemId) {
    const [box] = await v.db.select().from(item).where(and(eq(item.id, input.containerItemId), itemScope(v)));
    if (!box) throw notFound("Box");
    if (!box.isContainer) throw new HTTPException(422, { message: `${box.name} isn't a box — mark it as one first` });
    if (current && (box.id === current.id || (await insideOf(v, current.id)).includes(box.id))) {
      throw new HTTPException(422, { message: "A box can't go inside itself" });
    }
    return { locationId: box.locationId };
  }
  const moved = input.locationId !== undefined && (input.locationId ?? null) !== (current?.locationId ?? null);
  if (current?.containerItemId && moved && input.containerItemId === undefined) return { containerItemId: null };
  return {};
}

/** Everything inside a box, boxes within it included (their ids). */
export async function insideOf(v: Caller, boxId: string) {
  const ids: string[] = [];
  let frontier = [boxId];
  for (let depth = 0; frontier.length && depth < 20; depth++) {
    const rows = await v.db.select({ id: item.id }).from(item).where(and(itemScope(v), inList(item.containerItemId, frontier)));
    frontier = rows.map((r) => r.id);
    ids.push(...frontier);
  }
  return ids;
}

/** Where a new thing came from: Claude and scripts as the server knows them; the app says which of its ways. */
export function originOf(v: Caller, said?: ItemOrigin): { origin: ItemOrigin; originDetail: string | null } {
  if (v.via === "mcp") return { origin: "claude", originDetail: v.keyName ?? null };
  if (v.via === "api") return { origin: "api", originDetail: v.keyName ?? null };
  return { origin: said ?? "app", originDetail: null };
}

/** The household's collection (null for none); one that isn't theirs is a 404. */
async function collectionOf(v: Caller, id: string | null | undefined) {
  if (!id) return null;
  const [row] = await v.db
    .select()
    .from(collection)
    .where(and(eq(collection.id, id), eq(collection.householdId, v.householdId), isNull(collection.deletedAt)));
  if (!row) throw notFound("Collection");
  return row;
}

/** The household's template (null for none); one that isn't theirs is a 404. */
async function templateOf(v: Caller, id: string | null | undefined) {
  if (!id) return null;
  const [row] = await v.db
    .select()
    .from(itemTemplate)
    .where(and(eq(itemTemplate.id, id), eq(itemTemplate.householdId, v.householdId), isNull(itemTemplate.deletedAt)));
  if (!row) throw notFound("Template");
  return row;
}

/**
 * `found`: what the server itself knows about where it came from — a room scan (its origin and id, and the history's
 * line say so). Clients can't claim it.
 */
export async function createItem(v: Caller, given: ItemInput, found?: { roomScanId: string }) {
  await requireRoom(v, { items: 1 }); // a plan's limit on things (lib/plan.ts)
  // In a collection: its template, unless another was given (lib/collections.ts).
  const inCollection = await collectionOf(v, given.collectionId);
  if (inCollection?.templateId && given.templateId === undefined) given = { ...given, templateId: inCollection.templateId };
  // Made from a template: its category and tags, unless others were given (lib/templates.ts).
  const template = await templateOf(v, given.templateId);
  const input = template
    ? { ...given, categoryId: given.categoryId === undefined ? template.categoryId : given.categoryId, tags: given.tags.length ? given.tags : (template.tags ?? []) }
    : given;
  const placed = await placement(v, input);
  const { tags, origin, ...fields } = input;
  const from = found ? { ...originOf(v, "roomscan"), roomScanId: found.roomScanId } : originOf(v, origin);
  const [row] = await v.db
    .insert(item)
    .values({ ...fields, ...placed, ...from, householdId: v.householdId, createdBy: v.userId })
    .returning();
  if (tags.length) await setItemTags(v, row!.id, tags);
  await logActivity(v, "item.create", row!.id, found ? `Added ${row!.name} from a room scan` : `Added ${row!.name}`);
  countEvent(v.deps, "item.add");
  if (row!.brand || row!.barcode) await queueRecallCheck(v);
  await itemChanged(v, row!.id);
  await rememberBarcode(v, row!);
  await queueProductLookup(v, row!.barcode);
  if (row!.containerItemId) await itemChanged(v, row!.containerItemId); // the box's contents changed
  return getItem(v, row!.id);
}

/** Words for what happened to something ("Sold Kayak"), for its history. */
const DISPOSAL_WORDS: Record<ItemDisposition, string> = { sold: "Sold", given: "Gave away", discarded: "Threw out", lost: "Lost", stolen: "Stolen:" };

/**
 * Marking something gone (or bringing it back): the date defaults to today; bringing it back clears what happened.
 * Returns the fields to set, whether it's going, and a line for its history.
 */
function disposalChange(current: typeof item.$inferSelect, input: ItemPatch, on: string) {
  if (input.disposition === undefined) return { fields: {}, gone: false, summary: undefined };
  if (input.disposition === null) {
    return {
      fields: { disposition: null, disposedOn: null, disposalCents: null, disposalNote: null },
      gone: false,
      summary: current.disposition ? (name: string) => `Brought back ${name}` : undefined,
    };
  }
  const reason = input.disposition;
  return {
    fields: { disposedOn: input.disposedOn ?? current.disposedOn ?? on },
    gone: true,
    summary: (name: string) => `${DISPOSAL_WORDS[reason]} ${name}`,
  };
}

export async function updateItem(v: Caller, id: string, input: ItemPatch, summary?: (name: string) => string) {
  const [current] = await v.db.select().from(item).where(and(eq(item.id, id), itemScope(v, { gone: "include" })));
  if (!current) throw notFound("Item");
  await templateOf(v, input.templateId);
  await collectionOf(v, input.collectionId);
  const placed = await placement(v, input, current);
  if (input.isContainer === false && current.isContainer && (await insideOf(v, id)).length) {
    throw new HTTPException(409, { message: `Take the things out of ${current.name} first` });
  }
  const disposal = disposalChange(current, input, todayFor(v));
  if (disposal.gone && current.isContainer && (await insideOf(v, id)).length) {
    throw new HTTPException(409, { message: `Take the things out of ${current.name} first` });
  }
  const { tags, ...fields } = input;
  const tagsBefore = tags ? ((await tagsOf(v, [id])).get(id) ?? []) : [];
  // A tags-only change still bumps updatedAt (lists sort by it).
  const [row] = await v.db
    .update(item)
    .set({ ...fields, ...disposal.fields, ...placed, updatedAt: new Date() })
    .where(and(eq(item.id, id), itemScope(v, { gone: "include" })))
    .returning();
  if (!row) throw notFound("Item");
  if (tags) await setItemTags(v, row.id, tags);
  // A count typed in is part of the item's stock history too (lib/stock.ts).
  if (row.quantity !== current.quantity) await recordMovement(v, row.id, row.quantity - current.quantity, row.quantity, "edit");
  await rememberBarcode(v, row);
  if (row.barcode !== current.barcode) await queueProductLookup(v, row.barcode);
  if (row.brand !== current.brand || row.model !== current.model || row.barcode !== current.barcode || row.name !== current.name) await queueRecallCheck(v);
  await logActivity(
    v,
    "item.update",
    row.id,
    summary?.(row.name) ?? disposal.summary?.(row.name) ?? (await describeChanges(v, current, row, tags ? { before: tagsBefore, after: tags } : undefined)),
  );
  await itemChanged(v, row.id);
  // A box that moved takes its contents along.
  if (row.isContainer && row.locationId !== current.locationId) {
    const inside = await insideOf(v, row.id);
    if (inside.length) {
      await v.db
        .update(item)
        .set({ locationId: row.locationId })
        .where(and(eq(item.householdId, v.householdId), inList(item.id, inside)));
      for (const itemId of inside) await itemChanged(v, itemId);
    }
  }
  // Boxes it left or went into: their contents changed (search reads them).
  for (const box of new Set([current.containerItemId, row.containerItemId])) {
    if (box && current.containerItemId !== row.containerItemId) await itemChanged(v, box);
  }
  return getItem(v, row.id);
}

const dollars = (c: number | null) => (c == null ? null : `$${(c / 100).toFixed(2)}`);
const TEXT_FIELDS = [
  ["brand", "brand"],
  ["model", "model"],
  ["serialNumber", "serial number"],
  ["barcode", "barcode"],
  ["condition", "condition"],
  ["purchaseDate", "bought on"],
  ["heir", "goes to"],
] as const;

/**
 * An edit in words, for the item's history: "Moved Drill: Garage → Basement", "Drill: value $80.00 → $95.00; brand
 * set to DeWalt". Only what changed; long text (notes) just says it was edited.
 */
async function describeChanges(
  v: Caller,
  was: typeof item.$inferSelect,
  now: typeof item.$inferSelect,
  tagChange?: { before: string[]; after: string[] },
): Promise<string> {
  const out: string[] = [];
  let moved: string | null = null;
  if (was.name !== now.name) out.push(`renamed from “${was.name}”`);
  if (was.locationId !== now.locationId || was.containerItemId !== now.containerItemId) {
    const paths = await locationPaths(v);
    const boxIds = [was.containerItemId, now.containerItemId].filter((x): x is string => Boolean(x));
    const boxes = new Map(
      boxIds.length ? (await v.db.select({ id: item.id, name: item.name }).from(item).where(and(eq(item.householdId, v.householdId), inList(item.id, boxIds)))).map((b) => [b.id, b.name]) : [],
    );
    const where = (r: typeof item.$inferSelect) => {
      const place = r.locationId ? (paths.get(r.locationId)?.replace(/^[^›]+› /, "") ?? "a removed place") : null;
      const box = r.containerItemId ? `in ${boxes.get(r.containerItemId) ?? "a box"}` : null;
      return [box, place].filter(Boolean).join(", ") || "no place";
    };
    moved = `${where(was)} → ${where(now)}`;
  }
  for (const [k, label] of TEXT_FIELDS) {
    const [a, b] = [was[k] ?? null, now[k] ?? null];
    if (a === b) continue;
    out.push(a == null ? `${label} set to ${b}` : b == null ? `${label} removed` : `${label} ${a} → ${b}`);
  }
  for (const [k, label] of [["purchasePriceCents", "price paid"], ["valueCents", "value"]] as const) {
    const [a, b] = [was[k] ?? null, now[k] ?? null];
    if (a !== b) out.push(a == null ? `${label} set to ${dollars(b)}` : b == null ? `${label} removed` : `${label} ${dollars(a)} → ${dollars(b)}`);
  }
  if (was.quantity !== now.quantity) out.push(`quantity ${was.quantity} → ${now.quantity}`);
  if ((was.minQuantity ?? null) !== (now.minQuantity ?? null)) out.push(now.minQuantity == null ? "no minimum kept" : `keep at least ${now.minQuantity}`);
  if ((was.usageUnit ?? null) !== (now.usageUnit ?? null)) out.push(now.usageUnit ? `counts ${now.usageUnit}` : "doesn't count use any more");
  if (was.isContainer !== now.isContainer) out.push(now.isContainer ? "now a box" : "no longer a box");
  if (was.categoryId !== now.categoryId) {
    const info = await categoryInfo(v);
    const name = (cid: string | null) => (cid ? (info.get(cid)?.path ?? "a removed category") : "none");
    out.push(`category ${name(was.categoryId)} → ${name(now.categoryId)}`);
  }
  if (was.collectionId !== now.collectionId) {
    const ids = [was.collectionId, now.collectionId].filter((x): x is string => Boolean(x));
    const names = new Map(
      (await v.db.select({ id: collection.id, name: collection.name }).from(collection).where(and(eq(collection.householdId, v.householdId), inList(collection.id, ids)))).map((c) => [c.id, c.name]),
    );
    out.push(now.collectionId ? `added to the ${names.get(now.collectionId) ?? "a"} collection` : `taken out of the ${names.get(was.collectionId!) ?? "its"} collection`);
  }
  if (was.wanted !== now.wanted) out.push(now.wanted ? "on the want list" : "got it — off the want list");
  if (was.templateId !== now.templateId) out.push(now.templateId ? "template changed" : "template removed");
  if (tagChange) {
    const lower = (xs: string[]) => new Set(xs.map((x) => x.toLowerCase()));
    const [b, a] = [lower(tagChange.before), lower(tagChange.after)];
    const added = tagChange.after.filter((t) => !b.has(t.toLowerCase()));
    const removed = tagChange.before.filter((t) => !a.has(t.toLowerCase()));
    if (added.length) out.push(`tagged ${added.join(", ")}`);
    if (removed.length) out.push(`untagged ${removed.join(", ")}`);
  }
  for (const [k, label] of [["description", "description"], ["notes", "notes"]] as const) {
    if ((was[k] ?? "") !== (now[k] ?? "")) out.push(`${label} edited`);
  }
  if (JSON.stringify(was.links ?? []) !== JSON.stringify(now.links ?? [])) out.push("links edited");
  if (JSON.stringify(was.customFields ?? {}) !== JSON.stringify(now.customFields ?? {})) out.push("details edited");
  if (was.favorite !== now.favorite) out.push(now.favorite ? "marked a favourite" : "no longer a favourite");
  const text = moved && !out.length ? `Moved ${now.name}: ${moved}` : moved ? `Moved ${now.name}: ${moved}; ${out.join("; ")}` : out.length ? `${now.name}: ${out.join("; ")}` : `Updated ${now.name}`;
  return text.length > 500 ? `${text.slice(0, 499)}…` : text;
}

export async function deleteItem(v: Caller, id: string) {
  const [row] = await v.db
    .update(item)
    .set({ deletedAt: new Date() })
    .where(and(eq(item.id, id), itemScope(v, { gone: "include" })))
    .returning({ id: item.id, name: item.name, containerItemId: item.containerItemId });
  if (!row) throw notFound("Item");
  // A removed box's contents stay where they are, no longer in a box.
  const loose = await v.db
    .update(item)
    .set({ containerItemId: null })
    .where(and(itemScope(v), eq(item.containerItemId, row.id)))
    .returning({ id: item.id });
  for (const { id: itemId } of loose) await itemChanged(v, itemId);
  if (row.containerItemId) await itemChanged(v, row.containerItemId);
  await logActivity(v, "item.delete", row.id, `Removed ${row.name}`);
  await itemChanged(v, row.id); // drops it from search
  return { id: row.id, name: row.name };
}

/**
 * One change to many things (the table view): move them, set their category, add or remove a tag, or delete them —
 * each through the same path as one at a time (placement checks, history, search), so a box moved takes its contents.
 */
export async function bulkItems(v: Caller, input: ItemsBulk): Promise<ItemsBulkResult> {
  const out: ItemsBulkResult = { done: 0, failed: [] };
  for (const id of [...new Set(input.ids)]) {
    try {
      if (input.action === "delete") await deleteItem(v, id);
      else if (input.action === "move") await updateItem(v, id, { locationId: input.locationId, containerItemId: null });
      else if (input.action === "category") await updateItem(v, id, { categoryId: input.categoryId });
      else {
        const current = await getItem(v, id);
        const has = current.tags.some((t) => t.toLowerCase() === input.tag.toLowerCase());
        if (input.action === "tag" && has) continue;
        if (input.action === "untag" && !has) continue;
        const tags = input.action === "tag" ? [...current.tags, input.tag] : current.tags.filter((t) => t.toLowerCase() !== input.tag.toLowerCase());
        await updateItem(v, id, { tags });
      }
      out.done++;
    } catch (err) {
      out.failed.push({ id, reason: err instanceof HTTPException ? err.message : "Couldn't be changed" });
    }
  }
  return out;
}

// ── Warranties ──────────────────────────────────────────────────────────────
export const withStatus = <T extends { endsOn: string }>(w: T) => ({ ...w, status: warrantyStatus(w.endsOn) });

/** Every warranty in the household, soonest to end first. `status` narrows it. */
export async function listWarranties(v: Caller, status?: "active" | "expiring" | "expired") {
  const rows = await v.db
    .select({ warranty, itemName: item.name })
    .from(warranty)
    .innerJoin(item, eq(item.id, warranty.itemId))
    .where(and(eq(warranty.householdId, v.householdId), isNull(warranty.deletedAt), isNull(item.deletedAt), isNull(item.disposition)))
    .orderBy(warranty.endsOn);
  return (
    rows
      .map((r) => ({ ...withStatus(r.warranty), itemName: r.itemName }))
      // "active" includes ones that are expiring soon — they're still covered.
      .filter((w) => !status || w.status === status || (status === "active" && w.status === "expiring"))
  );
}

// ── Reports ─────────────────────────────────────────────────────────────────
/**
 * What everything is worth, for insurance: by property and by room (the
 * top-level location in a property). An item counts at its current value, or
 * what was paid for it, times its quantity.
 */
export async function inventoryReport(v: Caller) {
  const [items, { properties }, categories] = await Promise.all([
    v.db.select().from(item).where(itemScope(v)),
    locationTree(v),
    categoryInfo(v),
  ]);
  // Each location → its property and room.
  const placeOf = new Map<string, { property: string; room: string }>();
  for (const p of properties) {
    const walk = (nodes: LocationNode[], room?: string) =>
      nodes.forEach((n) => {
        placeOf.set(n.id, { property: p.name, room: room ?? n.name });
        walk(n.children, room ?? n.name);
      });
    walk(p.locations);
  }
  type Group = { valueCents: number; items: number; itemsWithoutValue: number };
  const add = (groups: Map<string, Group>, key: string, cents: number | null) => {
    const g = groups.get(key) ?? { valueCents: 0, items: 0, itemsWithoutValue: 0 };
    g.items++;
    if (cents == null) g.itemsWithoutValue++;
    else g.valueCents += cents;
    groups.set(key, g);
  };
  const total = new Map<string, Group>();
  const byProperty = new Map<string, Group>();
  const byRoom = new Map<string, Group>();
  const byCategory = new Map<string, Group>();
  const valued: { id: string; name: string; valueCents: number }[] = [];
  // When what's here now came in (bought, else added), month by month: the dashboard's "worth over time".
  const byMonth = new Map<string, number>();
  for (const it of items) {
    const each = it.valueCents ?? it.purchasePriceCents;
    const cents = each == null ? null : each * Math.max(1, it.quantity);
    const place = it.locationId ? placeOf.get(it.locationId) : undefined;
    add(total, "all", cents);
    add(byProperty, place?.property ?? "Not placed", cents);
    add(byRoom, place ? `${place.property} › ${place.room}` : "Not placed", cents);
    add(byCategory, (it.categoryId && categories.get(it.categoryId)?.topName) || "No category", cents);
    if (cents != null) {
      valued.push({ id: it.id, name: it.name, valueCents: cents });
      const month = (it.purchaseDate ?? todayFor(v, it.createdAt)).slice(0, 7);
      byMonth.set(month, (byMonth.get(month) ?? 0) + cents);
    }
  }
  const list = (groups: Map<string, Group>) =>
    [...groups].map(([name, g]) => ({ name, ...g })).sort((a, b) => b.valueCents - a.valueCents);
  return {
    total: total.get("all") ?? { valueCents: 0, items: 0, itemsWithoutValue: 0 },
    byProperty: list(byProperty),
    byRoom: list(byRoom),
    byCategory: list(byCategory),
    mostValuable: valued.sort((a, b) => b.valueCents - a.valueCents).slice(0, 10),
    byMonth: [...byMonth].map(([month, valueCents]) => ({ month, valueCents })).sort((a, b) => a.month.localeCompare(b.month)),
  };
}

/**
 * The Overview screen: what it's all worth, warranties to act on, what's
 * missing for an insurance claim, and recent changes (including Claude's).
 */
export async function overview(v: Caller): Promise<Overview> {
  const countMissing = async (detail: MissingDetail) =>
    (await v.db.select({ n: count() }).from(item).where(itemScope(v, { missing: detail })))[0]?.n ?? 0;
  const today = new Date();
  const monthAgo = new Date(today.getTime() - 30 * 86_400_000).toISOString().slice(0, 10);
  const [report, tree, warranties, photo, value, place, document, uncategorised, recent, tasks] = await Promise.all([
    inventoryReport(v),
    locationTree(v),
    listWarranties(v),
    countMissing("photo"),
    countMissing("value"),
    countMissing("place"),
    countMissing("document"),
    countMissing("category"),
    v.db
      .select({
        id: activity.id,
        action: activity.action,
        summary: activity.summary,
        via: activity.via,
        actorName: user.name,
        entityType: activity.entityType,
        entityId: activity.entityId,
        createdAt: activity.createdAt,
      })
      .from(activity)
      .leftJoin(user, eq(user.id, activity.actorId))
      .where(eq(activity.householdId, v.householdId))
      .orderBy(desc(activity.createdAt))
      .limit(8),
    listMaintenance(v),
  ]);
  const openClaims = await listClaims(v, { open: true });
  let locations = 0;
  const countNodes = (nodes: LocationNode[]): void =>
    nodes.forEach((n) => {
      locations++;
      countNodes(n.children);
    });
  tree.properties.forEach((p) => countNodes(p.locations));
  return {
    ...report,
    properties: tree.properties.length,
    locations,
    warranties: warranties
      .filter((w) => w.status === "expiring" || (w.status === "expired" && w.endsOn >= monthAgo))
      .slice(0, 6)
      .map((w) => ({ id: w.id, itemId: w.itemId, itemName: w.itemName, provider: w.provider, endsOn: w.endsOn, status: w.status })),
    missing: { photo, value, place, document, category: uncategorised },
    openClaims,
    maintenance: {
      overdue: tasks.filter((t) => t.status === "overdue").length,
      due: tasks.filter((t) => t.status === "due").length,
      next: tasks.slice(0, 4),
    },
    activity: recent.map((a) => ({ ...a, createdAt: a.createdAt.toISOString() })),
    shopping: await shoppingList(v).then(({ items }) => ({ count: items.length, out: items.filter((i) => i.quantity === 0).length, next: items.slice(0, 5) })),
  };
}

/** Things changed that a recall could be about: check the household (one pending check at a time). */
async function queueRecallCheck(v: Caller) {
  if (v.deps.recalls && v.deps.jobs) await v.deps.jobs.enqueue(RECALL_CHECK_JOB, { householdId: v.householdId });
}

// ── Activity ────────────────────────────────────────────────────────────────
/** One line in the household's activity (and, with `itemId` — implied for `item.*` — that item's history). */
export async function logActivity(v: Caller, action: string, entityId: string, summary: string, itemId?: string | null) {
  await v.db.insert(activity).values({
    itemId: itemId ?? (action.startsWith("item.") ? entityId : null),
    householdId: v.householdId,
    actorId: v.userId || null, // jobs (the recall check) act for nobody
    via: v.via,
    action,
    entityType: action.split(".")[0]!,
    entityId,
    summary,
  });
}
