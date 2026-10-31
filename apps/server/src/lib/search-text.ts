/**
 * What an item "says" to search: its fields, where it lives, and what its
 * photos and documents contain. Full-text search and the vector index both
 * read items through here, so they always agree.
 */
import { and, eq, isNull } from "drizzle-orm";
import type { CategoryField } from "@ferret/shared";
import { attachment, category, collection, item, itemTag, itemTemplate, label, location, ownLabel, property, tag, warranty } from "../db/schema";
import type { Db } from "../ports";

export type SearchDoc = NonNullable<Awaited<ReturnType<typeof loadSearchDoc>>>;

/** The item with its location path and attachments, or null if it's gone. */
export async function loadSearchDoc(db: Db, itemId: string) {
  const [it] = await db.select().from(item).where(eq(item.id, itemId));
  if (!it || it.deletedAt) return null;
  const files = await db
    .select()
    .from(attachment)
    .where(and(eq(attachment.itemId, itemId), isNull(attachment.deletedAt)));
  const warranties = await db
    .select()
    .from(warranty)
    .where(and(eq(warranty.itemId, itemId), isNull(warranty.deletedAt)));
  const tags = await db
    .select({ name: tag.name })
    .from(itemTag)
    .innerJoin(tag, eq(tag.id, itemTag.tagId))
    .where(eq(itemTag.itemId, itemId));
  const kind = await categoryChain(db, it.categoryId);
  const [box] = it.containerItemId ? await db.select({ name: item.name }).from(item).where(eq(item.id, it.containerItemId)) : [];
  const contents = it.isContainer
    ? await db
        .select({ name: item.name })
        .from(item)
        .where(and(eq(item.containerItemId, itemId), isNull(item.deletedAt)))
    : [];
  const codes = [
    ...(await db.select({ code: label.code }).from(label).where(eq(label.itemId, itemId))),
    ...(await db.select({ code: ownLabel.code }).from(ownLabel).where(eq(ownLabel.itemId, itemId))),
  ];
  return {
    item: it,
    locationPath: await locationPath(db, it.locationId),
    categoryPath: kind.names.join(" › ") || null,
    categoryFields: [...kind.fields, ...(await templateFields(db, it.templateId))],
    collectionName: it.collectionId
      ? ((await db.select({ name: collection.name }).from(collection).where(eq(collection.id, it.collectionId)))[0]?.name ?? null)
      : null,
    tags: tags.map((t) => t.name),
    boxName: box?.name ?? null,
    contents: contents.map((c) => c.name),
    labelCodes: codes.map((c) => c.code),
    files,
    warranties,
  };
}

/** A category's names from the top down, and the extra fields it and its parents define. */
async function categoryChain(db: Db, categoryId: string | null) {
  const names: string[] = [];
  const fields: CategoryField[] = [];
  for (let id = categoryId, depth = 0; id && depth < 20; depth++) {
    const [c] = await db
      .select({ name: category.name, parentId: category.parentId, fields: category.fields, deletedAt: category.deletedAt })
      .from(category)
      .where(eq(category.id, id));
    if (!c || c.deletedAt) break;
    names.unshift(c.name);
    fields.push(...(c.fields ?? []));
    id = c.parentId;
  }
  return { names, fields };
}

/** "Highland House › Garage › Shelf 2" — the property, then each location from the top down. */
export async function locationPath(db: Db, locationId: string | null) {
  const names: string[] = [];
  let propertyId: string | undefined;
  for (let id = locationId, depth = 0; id && depth < 20; depth++) {
    const [loc] = await db
      .select({ name: location.name, parentId: location.parentId, propertyId: location.propertyId })
      .from(location)
      .where(eq(location.id, id));
    if (!loc) break;
    names.unshift(loc.name);
    propertyId = loc.propertyId;
    id = loc.parentId;
  }
  if (propertyId) {
    const [prop] = await db.select({ name: property.name }).from(property).where(eq(property.id, propertyId));
    if (prop) names.unshift(prop.name);
  }
  return names.length ? names.join(" › ") : null;
}

/** The item's own fields and location, as lines of text. */
export function itemFields({ item: it, locationPath, categoryPath, categoryFields, collectionName, tags, boxName, contents, labelCodes, warranties }: SearchDoc) {
  const custom = Object.entries(it.customFields ?? {}).map(([key, value]) => {
    const field = categoryFields.find((f) => f.key === key);
    return `${field?.label ?? key}: ${value}${field?.unit ? ` ${field.unit}` : ""}`;
  });
  return [
    categoryPath && `Category: ${categoryPath}`,
    collectionName && `Collection: ${collectionName}`,
    boxName && `In box: ${boxName}`,
    it.isContainer && `Box${contents.length ? ` holding: ${contents.join(", ")}` : " (empty)"}`,
    labelCodes.length && `Label: ${labelCodes.join(", ")}`,
    tags.length && `Tags: ${tags.join(", ")}`,
    ...custom,
    it.brand && `Brand: ${it.brand}`,
    it.model && `Model: ${it.model}`,
    it.serialNumber && `Serial number: ${it.serialNumber}`,
    it.barcode && `Barcode: ${it.barcode}`,
    // The site and label, not the whole address: "Link: Manual — dewalt.com".
    ...(it.links ?? []).map((l) => `Link: ${l.label ? `${l.label} — ` : ""}${new URL(l.url).hostname.replace(/^www\./, "")}`),
    locationPath && `Kept in: ${locationPath}`,
    it.purchaseDate && `Purchased: ${it.purchaseDate}`,
    it.purchasePriceCents != null && `Price paid: $${(it.purchasePriceCents / 100).toFixed(2)}`,
    // Dates, not "active/expired": the index shouldn't go stale as time passes.
    ...warranties.map((w) =>
      [`Warranty${w.provider ? ` (${w.provider})` : ""}`, w.startsOn && `from ${w.startsOn}`, `until ${w.endsOn}`, w.coverage && `— ${w.coverage}`]
        .filter(Boolean)
        .join(" "),
    ),
    it.description,
    it.notes,
  ].filter(Boolean) as string[];
}

/** One paragraph summing up the item, for its main vector. */
export function itemSummary(doc: SearchDoc) {
  const analysed = doc.files.filter((f) => f.analysisStatus === "done" && f.analysis);
  return [
    doc.item.name,
    ...itemFields(doc),
    ...analysed
      .filter((f) => f.kind === "photo")
      .map((p) => [p.analysis!.description, p.analysis!.text.slice(0, 300)].filter(Boolean).join(" — ")),
    ...analysed.filter((f) => f.kind === "document" && f.analysis!.description).map((d) => `Document: ${d.analysis!.description}`),
  ]
    .filter(Boolean)
    .join("\n");
}

/** A template's fields, for naming its values ("Mint mark: D"). */
async function templateFields(db: Db, templateId: string | null) {
  if (!templateId) return [];
  const [row] = await db.select({ fields: itemTemplate.fields }).from(itemTemplate).where(eq(itemTemplate.id, templateId));
  return row?.fields ?? [];
}
