/**
 * Importing things: rows from a spreadsheet (the web app reads the CSV and maps its columns — @ferret/shared's
 * draftRows) or devices from Home Assistant (lib/home-assistant.ts). Places and categories come by name or path and
 * are found or made; every import is an `import_batch` its items point back to, so it can be undone (its items go to
 * Recently deleted). Big files arrive in several requests of up to 100 rows, all in one batch.
 */
import { itemsRoom } from "./plan";
import type { HomeAssistantApply, ImportBatchSummary, ImportInput, ImportResult, ImportRow, ItemPatch } from "@ferret/shared";
import { and, count, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { category, importBatch, item, location, property, user, warranty } from "../db/schema";
import { setItemTags } from "./catalog";
import { type Caller, deleteItem, itemChanged, logActivity, notFound, updateItem } from "./inventory";
import { rememberBarcode } from "./products";

/** "Main › Kitchen", "Garage / Shelf 2", "Basement > Storage" — `/` and `>` only between spaces ("A/V closet" is one name). */
export const splitPath = (path: string) =>
  path
    .split(/\s*›\s*|\s+[/>]\s+/)
    .map((s) => s.trim().slice(0, 120))
    .filter(Boolean);

const same = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "accent" }) === 0;

interface Node {
  id: string;
  name: string;
  parentId: string | null;
}

/**
 * Finds a path in a tree of named nodes, making what's missing. A first step that isn't at the top but names exactly
 * one node anywhere ("Kitchen" for Main › Kitchen) starts there.
 */
async function resolvePath(
  nodes: Node[],
  path: string[],
  make: (name: string, parentId: string | null) => Promise<Node>,
  start: string | null = null,
) {
  let parentId: string | null = start;
  let made = 0;
  const ids: string[] = [];
  for (const [i, name] of path.entries()) {
    let found: Node | undefined = nodes.find((n) => n.parentId === parentId && same(n.name, name));
    if (!found && i === 0 && start === null) {
      const anywhere = nodes.filter((n) => same(n.name, name));
      if (anywhere.length === 1) found = anywhere[0];
    }
    if (!found) {
      found = await make(name, parentId);
      nodes.push(found);
      made++;
    }
    parentId = found.id;
    ids.push(found.id);
  }
  return { id: parentId, made, ids };
}

async function batchFor(v: Caller, input: ImportInput) {
  if (!input.rows.length && !input.batchId) return ""; // only places: nothing to undo
  if (input.batchId) {
    const [b] = await v.db.select().from(importBatch).where(and(eq(importBatch.id, input.batchId), eq(importBatch.householdId, v.householdId)));
    if (!b) throw notFound("Import");
    if (b.undoneAt) throw new HTTPException(409, { message: "That import was undone" });
    return b.id;
  }
  const [b] = await v.db.insert(importBatch).values({ householdId: v.householdId, source: input.source, name: input.name, createdBy: v.userId }).returning();
  return b!.id;
}

export async function importItems(v: Caller, input: ImportInput): Promise<ImportResult> {
  let propertyRow: { id: string; name: string } | undefined;
  if (input.propertyId) {
    [propertyRow] = await v.db
      .select({ id: property.id, name: property.name })
      .from(property)
      .where(and(eq(property.id, input.propertyId), eq(property.householdId, v.householdId), isNull(property.deletedAt)));
    if (!propertyRow) throw notFound("Property");
  } else if (input.rows.some((r) => r.place) || input.places?.some((p) => p.path)) {
    throw new HTTPException(422, { message: "Choose the property new places go in" });
  }
  const batchId = await batchFor(v, input);

  const everywhere = await v.db
    .select({ id: location.id, name: location.name, parentId: location.parentId, propertyId: location.propertyId, ha: location.haAreaId })
    .from(location)
    .where(and(eq(location.householdId, v.householdId), isNull(location.deletedAt)));
  const places: Node[] = propertyRow ? everywhere.filter((l) => l.propertyId === propertyRow.id) : [];
  /** Home Assistant area (or `floor:<id>`) → its place, in any property. */
  const haPlaces = new Map(everywhere.filter((l) => l.ha).map((l) => [l.ha!, l]));
  const categories: Node[] = await v.db
    .select({ id: category.id, name: category.name, parentId: category.parentId })
    .from(category)
    .where(and(eq(category.householdId, v.householdId), isNull(category.deletedAt)));

  // What's already here, so running an import twice doesn't make everything twice.
  const haIds = input.rows.map((r) => r.haDeviceId).filter((x): x is string => Boolean(x));
  const haHere = new Set(
    haIds.length
      ? (
          await v.db
            .select({ ha: item.haDeviceId })
            .from(item)
            .where(and(eq(item.householdId, v.householdId), isNull(item.deletedAt), isNotNull(item.haDeviceId)))
        ).map((r) => r.ha!)
      : [],
  );
  const serialsHere = new Set(
    input.rows.some((r) => r.serialNumber?.trim())
      ? (
          await v.db
            .select({ s: sql<string>`lower(${item.serialNumber})` })
            .from(item)
            .where(and(eq(item.householdId, v.householdId), isNull(item.deletedAt), isNotNull(item.serialNumber)))
        ).map((r) => r.s)
      : [],
  );

  const result: ImportResult = { batchId, created: 0, skipped: [], placesCreated: 0, categoriesCreated: 0 };
  const placeCache = new Map<string, string | null>();
  const categoryCache = new Map<string, string | null>();

  const remember = async (locationId: string, ha: string) => {
    const l = everywhere.find((x) => x.id === locationId);
    if (!l || l.ha) return;
    await v.db.update(location).set({ haAreaId: ha }).where(eq(location.id, locationId));
    l.ha = ha;
    haPlaces.set(ha, l);
  };
  const makePlace = async (name: string, parentId: string | null) => {
    const [l] = await v.db.insert(location).values({ householdId: v.householdId, propertyId: propertyRow!.id, parentId, name }).returning();
    everywhere.push({ id: l!.id, name, parentId, propertyId: propertyRow!.id, ha: null });
    return { id: l!.id, name, parentId };
  };

  // Places first (Home Assistant's rooms, with or without things in them).
  for (const p of input.places ?? []) {
    if (p.haAreaId && haPlaces.has(p.haAreaId)) continue;
    if (p.locationId) {
      if (!everywhere.some((l) => l.id === p.locationId)) throw notFound("Place");
      if (p.haAreaId) await remember(p.locationId, p.haAreaId);
      continue;
    }
    const path = splitPath(p.path!);
    if (!path.length) continue;
    // Its floor's place, if an earlier import made one in this property.
    const floor = p.haFloorId ? haPlaces.get(`floor:${p.haFloorId}`) : undefined;
    const underFloor = floor && floor.propertyId === propertyRow!.id && path.length > 1;
    const { ids, made } = await resolvePath(places, underFloor ? path.slice(1) : path, makePlace, underFloor ? floor.id : null);
    result.placesCreated += made;
    if (p.haFloorId && path.length > 1 && !underFloor) await remember(ids[0]!, `floor:${p.haFloorId}`);
    if (p.haAreaId) await remember(ids.at(-1)!, p.haAreaId);
  }

  const placeOf = async (row: ImportRow) => {
    if (row.haAreaId && haPlaces.has(row.haAreaId)) return haPlaces.get(row.haAreaId)!.id;
    if (row.locationId) {
      const [found] = await v.db
        .select({ id: location.id })
        .from(location)
        .where(and(eq(location.id, row.locationId), eq(location.householdId, v.householdId), isNull(location.deletedAt)));
      if (!found) throw notFound("Place");
      return found.id;
    }
    if (!row.place || !propertyRow) return null;
    let path = splitPath(row.place);
    // Ferret's own export starts with the property ("Highland House › Garage").
    if (path.length > 1 && same(path[0]!, propertyRow.name)) path = path.slice(1);
    if (!path.length) return null;
    const k = path.join("\u0000").toLowerCase();
    if (!placeCache.has(k)) {
      const { id, made } = await resolvePath(places, path, makePlace);
      result.placesCreated += made;
      placeCache.set(k, id);
    }
    return placeCache.get(k)!;
  };
  const categoryOf = async (name: string | null | undefined) => {
    const path = name ? splitPath(name) : [];
    if (!path.length) return null;
    const k = path.join("\u0000").toLowerCase();
    if (!categoryCache.has(k)) {
      const { id, made } = await resolvePath(categories, path, async (n, parentId) => {
        const [c] = await v.db.insert(category).values({ householdId: v.householdId, parentId, name: n }).returning();
        return { id: c!.id, name: n, parentId };
      });
      result.categoriesCreated += made;
      categoryCache.set(k, id);
    }
    return categoryCache.get(k)!;
  };

  // A plan's limit on things (lib/plan.ts): rows past it are skipped, saying why.
  let room = await itemsRoom(v);
  for (const [index, row] of input.rows.entries()) {
    try {
      if (room !== null && room <= 0) {
        result.skipped.push({ index, reason: "Your plan's room for things is full — upgrade to import more" });
        continue;
      }
      if (row.haDeviceId && haHere.has(row.haDeviceId)) {
        result.skipped.push({ index, reason: "Already in Ferret" });
        continue;
      }
      const serial = row.serialNumber?.trim().toLowerCase();
      if (serial && serialsHere.has(serial)) {
        result.skipped.push({ index, reason: `Already in Ferret (serial number ${row.serialNumber})` });
        continue;
      }
      const { place, locationId: _l, haAreaId, category: categoryName, tags, warrantyEnds, soldOn, soldCents, quantity, ...fields } = row;
      const [created] = await v.db
        .insert(item)
        .values({
          ...fields,
          quantity: quantity ?? 1,
          locationId: await placeOf(row),
          categoryId: await categoryOf(categoryName),
          ...(soldOn ? { disposition: "sold" as const, disposedOn: soldOn, disposalCents: soldCents ?? null } : {}),
          householdId: v.householdId,
          createdBy: v.userId,
          importBatchId: batchId,
          origin: input.source === "homeassistant" ? ("homeassistant" as const) : ("spreadsheet" as const),
          originDetail: input.name,
          ...(row.haDeviceId
            ? { haSnapshot: { name: row.name, manufacturer: row.brand ?? null, model: row.model ?? null, serialNumber: row.serialNumber ?? null, areaId: haAreaId ?? null } }
            : {}),
        })
        .returning();
      if (tags?.length) await setItemTags(v, created!.id, tags);
      if (warrantyEnds) await v.db.insert(warranty).values({ householdId: v.householdId, itemId: created!.id, endsOn: warrantyEnds, startsOn: row.purchaseDate && row.purchaseDate <= warrantyEnds ? row.purchaseDate : null });
      await rememberBarcode(v, created!);
      await itemChanged(v, created!.id);
      if (row.haDeviceId) haHere.add(row.haDeviceId);
      if (serial) serialsHere.add(serial);
      result.created++;
      if (room !== null) room--;
    } catch (e) {
      result.skipped.push({ index, reason: e instanceof HTTPException ? e.message : "Couldn't be saved" });
    }
  }
  if (result.created) {
    await logActivity(v, "import.items", batchId, `Imported ${result.created} ${result.created === 1 ? "thing" : "things"} from ${input.name}`);
  }
  return result;
}

export async function listImports(v: Caller): Promise<ImportBatchSummary[]> {
  const batches = await v.db
    .select({ b: importBatch, by: user.name })
    .from(importBatch)
    .leftJoin(user, eq(user.id, importBatch.createdBy))
    .where(eq(importBatch.householdId, v.householdId))
    .orderBy(desc(importBatch.createdAt))
    .limit(20);
  const ids = batches.map((r) => r.b.id);
  const counts = ids.length
    ? await v.db
        .select({ id: item.importBatchId, n: count() })
        .from(item)
        .where(and(eq(item.householdId, v.householdId), isNull(item.deletedAt), inArray(item.importBatchId, ids)))
        .groupBy(item.importBatchId)
    : [];
  const n = new Map(counts.map((c) => [c.id, c.n]));
  return batches
    .map(({ b, by }) => ({
      id: b.id,
      source: b.source,
      name: b.name,
      items: n.get(b.id) ?? 0,
      importedAt: b.createdAt.toISOString(),
      by,
      undoneAt: b.undoneAt?.toISOString() ?? null,
    }))
    .filter((b) => b.items > 0 || b.undoneAt);
}

/** Everything an import added that's still here goes to Recently deleted (places and categories it made stay). */
export async function undoImport(v: Caller, id: string) {
  const [b] = await v.db.select().from(importBatch).where(and(eq(importBatch.id, id), eq(importBatch.householdId, v.householdId)));
  if (!b) throw notFound("Import");
  if (b.undoneAt) throw new HTTPException(409, { message: "That import was already undone" });
  const rows = await v.db
    .select({ id: item.id })
    .from(item)
    .where(and(eq(item.householdId, v.householdId), eq(item.importBatchId, id), isNull(item.deletedAt)));
  for (const r of rows) await deleteItem(v, r.id);
  await v.db.update(importBatch).set({ undoneAt: new Date() }).where(eq(importBatch.id, id));
  await logActivity(v, "import.undo", id, `Undid the import of ${b.name} (${rows.length} ${rows.length === 1 ? "thing" : "things"} to Recently deleted)`);
  return { removed: rows.length };
}

/**
 * A Home Assistant re-import's changes: each update takes the fields given (an area → the place made for it) and
 * remembers what HA says now, so the same change isn't offered again. Updates with no fields just remember.
 */
export async function applyHomeAssistant(v: Caller, input: HomeAssistantApply) {
  let updated = 0;
  for (const u of input.updates) {
    const [row] = await v.db
      .select({ id: item.id })
      .from(item)
      .where(and(eq(item.id, u.itemId), eq(item.householdId, v.householdId), isNull(item.deletedAt), isNotNull(item.haDeviceId)));
    if (!row) throw notFound("Item");
    const patch: ItemPatch = {};
    if (u.name !== undefined) patch.name = u.name;
    if (u.brand !== undefined) patch.brand = u.brand;
    if (u.model !== undefined) patch.model = u.model;
    if (u.serialNumber !== undefined) patch.serialNumber = u.serialNumber;
    if (u.haAreaId) {
      const [place] = await v.db
        .select({ id: location.id })
        .from(location)
        .where(and(eq(location.householdId, v.householdId), eq(location.haAreaId, u.haAreaId), isNull(location.deletedAt)));
      if (!place) throw new HTTPException(422, { message: "That room isn't a place in Ferret yet — import it first" });
      patch.locationId = place.id;
    }
    if (Object.keys(patch).length) {
      await updateItem(v, row.id, patch);
      updated++;
    }
    await v.db.update(item).set({ haSnapshot: u.snapshot }).where(eq(item.id, row.id));
  }
  return { updated };
}
