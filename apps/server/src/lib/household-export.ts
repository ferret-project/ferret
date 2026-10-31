/**
 * "Download everything": one household's data as a ZIP anyone can open without Ferret — Settings → Household,
 * owners and admins. Unlike a backup (the whole server, encrypted, for Ferret to restore), this is for people:
 *
 *   ferret-export-<household>-<date>/
 *     README.txt                     what's inside, in words
 *     ferret.json                    everything (format "ferret-export", version 1): places, items, warranties and
 *                                    claims, maintenance and its history, stock and its history, HomeKit/Matter
 *                                    pairing codes, providers, categories, tags, labels
 *     items.csv                      the insurance list, for a spreadsheet
 *     files/<item>/<filename>        the photos and documents, decrypted, as they were uploaded
 *
 * It's streamed as it's made — one file decrypted at a time, nothing written on the server — so a decrypted copy
 * never sits anywhere but the download. Deleted things (Recently deleted) are left out.
 */
import { listTemplates } from "./templates";
import { listCollections } from "./collections";
import { and, asc, eq, isNull } from "drizzle-orm";
import { Zip, ZipDeflate, ZipPassThrough } from "fflate";
import { organization } from "../db/schema/auth";
import {
  attachment,
  category,
  item,
  itemTag,
  label,
  ownLabel,
  location,
  maintenanceLog,
  maintenanceTask,
  property,
  provider,
  stockMovement,
  usageReading,
  stockRule,
  tag,
  user,
  warranty,
  warrantyClaim,
  loan,
} from "../db/schema";
import { exportRows, toCsv } from "./export";
import { pairingByItem } from "./pairing";
import type { FileStore } from "./files";
import type { Caller } from "./inventory";
import { todayFor } from "./household-time";
import { inList } from "./sql";

export const EXPORT_FORMAT = { format: "ferret-export", version: 1 } as const;

const live = <T extends { deletedAt: unknown }>(rows: T[]) => rows.filter((r) => r.deletedAt == null);
const iso = (d: Date | null | undefined) => d?.toISOString() ?? null;

/** A name that's safe as one part of a path in a ZIP on any computer. */
export function safeName(name: string, fallback = "file") {
  const cleaned = name
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, "_")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 80);
  return cleaned || fallback;
}

/** Writes entries into a ZIP as a stream; the stream errors (a broken download) if `produce` throws. */
function zipStream(produce: (add: (name: string, data: Uint8Array, opts?: { compress?: boolean; mtime?: Date }) => Promise<void>) => Promise<void>) {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const ignore = () => {};
  const zip = new Zip((err, chunk, final) => {
    if (err) return void writer.abort(err).catch(ignore);
    writer.write(chunk).catch(ignore);
    if (final) writer.close().catch(ignore);
  });
  void (async () => {
    try {
      await produce(async (name, data, opts = {}) => {
        // Photos and PDFs are already compressed: stored as they are. Text is deflated.
        const entry = opts.compress ? new ZipDeflate(name, { level: 6 }) : new ZipPassThrough(name);
        if (opts.mtime) entry.mtime = opts.mtime;
        zip.add(entry);
        entry.push(data, true);
        await writer.ready; // let the download catch up before the next file
      });
      zip.end();
    } catch (err) {
      console.warn(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
      zip.terminate();
      await writer.abort(err).catch(ignore);
    }
  })();
  return readable;
}

/** Everything one household has, as plain data (ids kept so things can point at each other), with files' ZIP paths. */
export async function householdData(v: Caller, root: string, householdName: string | null, store: FileStore) {
  const h = v.householdId;
  const [properties, places, categories, tags, items, itemTags, files, warranties, claims, tasks, logs, providers, labels] = await Promise.all([
    v.db.select().from(property).where(eq(property.householdId, h)).orderBy(asc(property.name)),
    v.db.select().from(location).where(eq(location.householdId, h)).orderBy(asc(location.name)),
    v.db.select().from(category).where(eq(category.householdId, h)).orderBy(asc(category.name)),
    v.db.select().from(tag).where(eq(tag.householdId, h)).orderBy(asc(tag.name)),
    v.db.select().from(item).where(and(eq(item.householdId, h), isNull(item.deletedAt))).orderBy(asc(item.name), asc(item.createdAt)),
    v.db.select().from(itemTag).where(eq(itemTag.householdId, h)),
    v.db.select().from(attachment).where(and(eq(attachment.householdId, h), isNull(attachment.deletedAt))).orderBy(asc(attachment.createdAt)),
    v.db.select().from(warranty).where(and(eq(warranty.householdId, h), isNull(warranty.deletedAt))).orderBy(asc(warranty.endsOn)),
    v.db.select().from(warrantyClaim).where(and(eq(warrantyClaim.householdId, h), isNull(warrantyClaim.deletedAt))).orderBy(asc(warrantyClaim.filedOn)),
    v.db.select().from(maintenanceTask).where(and(eq(maintenanceTask.householdId, h), isNull(maintenanceTask.deletedAt))).orderBy(asc(maintenanceTask.title)),
    v.db.select().from(maintenanceLog).where(eq(maintenanceLog.householdId, h)).orderBy(asc(maintenanceLog.doneOn)),
    v.db.select().from(provider).where(and(eq(provider.householdId, h), isNull(provider.deletedAt))).orderBy(asc(provider.name)),
    v.db.select().from(label).where(eq(label.householdId, h)),
  ]);
  const pairings = await pairingByItem(v, store);
  const loans = await v.db.select().from(loan).where(eq(loan.householdId, v.householdId)).orderBy(loan.since);
  const templates = await listTemplates(v);
  const collections = await listCollections(v);
  const owned = await v.db.select().from(ownLabel).where(eq(ownLabel.householdId, h)).orderBy(asc(ownLabel.createdAt));
  const [rules, moves, readings] = await Promise.all([
    v.db.select().from(stockRule).where(eq(stockRule.householdId, h)),
    v.db.select().from(stockMovement).where(eq(stockMovement.householdId, h)).orderBy(asc(stockMovement.createdAt)),
    v.db.select().from(usageReading).where(eq(usageReading.householdId, h)).orderBy(asc(usageReading.readOn)),
  ]);
  const doers = [...new Set([...logs.map((l) => l.doneBy), ...moves.map((m) => m.userId), ...readings.map((r) => r.userId)].filter((id): id is string => !!id))];
  const people = doers.length ? await v.db.select({ id: user.id, name: user.name }).from(user).where(inList(user.id, doers)) : [];
  const liveProperties = live(properties);
  const livePlaces = live(places);
  const liveCategories = live(categories);
  const itemIds = new Set(items.map((i) => i.id));
  const who = new Map(people.map((p) => [p.id, p.name]));
  const providerName = new Map(providers.map((p) => [p.id, p.name]));

  const propertyName = new Map(liveProperties.map((p) => [p.id, p.name]));
  const placeById = new Map(livePlaces.map((p) => [p.id, p]));
  const placePath = (id: string | null): string | null => {
    const parts: string[] = [];
    let at = id ? placeById.get(id) : undefined;
    const top = at?.propertyId;
    for (let hops = 0; at && hops < 50; hops++) {
      parts.unshift(at.name);
      at = at.parentId ? placeById.get(at.parentId) : undefined;
    }
    if (!parts.length) return null;
    return [propertyName.get(top!) ?? null, ...parts].filter(Boolean).join(" › ");
  };
  const categoryById = new Map(liveCategories.map((c) => [c.id, c]));
  const categoryPath = (id: string | null) => {
    const parts: string[] = [];
    for (let at = id ? categoryById.get(id) : undefined, hops = 0; at && hops < 50; at = at.parentId ? categoryById.get(at.parentId) : undefined, hops++) parts.unshift(at.name);
    return parts.length ? parts.join(" › ") : null;
  };
  const tagName = new Map(tags.map((t) => [t.id, t.name]));
  const labelFor = (key: "itemId" | "locationId", id: string) => labels.find((l) => l[key] === id)?.code ?? null;

  // A folder per item that has files (its name, made unique), a file per upload (its name, made unique in the folder).
  const folders = new Map<string, string>();
  const usedFolders = new Set<string>();
  const withFiles = new Set(files.map((f) => f.itemId));
  for (const i of items.filter((i) => withFiles.has(i.id))) {
    let folder = safeName(i.name, "item");
    if (usedFolders.has(folder.toLowerCase())) folder = `${folder} (${i.id.slice(0, 8)})`;
    usedFolders.add(folder.toLowerCase());
    folders.set(i.id, folder);
  }
  const used = new Set<string>();
  const filePaths = new Map<string, string>();
  for (const f of files) {
    if (!itemIds.has(f.itemId)) continue;
    const name = safeName(f.filename);
    const dot = name.lastIndexOf(".");
    let path = `${root}/files/${folders.get(f.itemId)}/${name}`;
    for (let n = 2; used.has(path.toLowerCase()); n++) {
      path = `${root}/files/${folders.get(f.itemId)}/${dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`}`;
    }
    used.add(path.toLowerCase());
    filePaths.set(f.id, path);
  }
  const inZip = (path: string | undefined) => (path ? path.slice(root.length + 1) : null);

  const data = {
    ...EXPORT_FORMAT,
    exportedAt: new Date().toISOString(),
    household: { name: householdName },
    notes: "Money is in cents (12900 = $129.00); dates are yyyy-mm-dd; `file` paths are relative to this folder.",
    properties: liveProperties.map((p) => ({
      id: p.id,
      name: p.name,
      type: p.type,
      address: { street: p.street, city: p.city, region: p.region, postalCode: p.postalCode, country: p.country },
      yearBuilt: p.yearBuilt,
      valueCents: p.valueCents,
      notes: p.notes,
    })),
    places: livePlaces.map((p) => ({
      id: p.id,
      propertyId: p.propertyId,
      parentId: p.parentId,
      name: p.name,
      path: placePath(p.id),
      notes: p.notes,
      label: labelFor("locationId", p.id),
    })),
    categories: liveCategories.map((c) => ({ id: c.id, parentId: c.parentId, name: c.name, path: categoryPath(c.id), fields: c.fields ?? [] })),
    /** Kinds of thing with their own fields (a coin's year, mint mark…): items' templateId, values in customFields. */
    templates: templates.map((t) => ({ id: t.id, name: t.name, fields: t.fields, categoryId: t.categoryId, tags: t.tags })),
    /** Collections: items' collectionId; `wanted` items are its want list (not owned). */
    collections: collections.map((c) => ({ id: c.id, name: c.name, description: c.description, templateId: c.templateId })),
    tags: tags.map((t) => t.name),
    providers: providers.map((p) => ({
      id: p.id,
      name: p.name,
      trade: p.trade,
      contactName: p.contactName,
      phone: p.phone,
      email: p.email,
      website: p.website,
      address: p.address,
      notes: p.notes,
    })),
    items: items.map((i) => ({
      id: i.id,
      name: i.name,
      description: i.description,
      brand: i.brand,
      model: i.model,
      serialNumber: i.serialNumber,
      barcode: i.barcode,
      quantity: i.quantity,
      keepAtLeast: i.minQuantity,
      condition: i.condition,
      purchaseDate: i.purchaseDate,
      purchasePriceCents: i.purchasePriceCents,
      valueCents: i.valueCents,
      notes: i.notes,
      favorite: i.favorite,
      heir: i.heir,
      /** Null while you still have it. */
      gone: i.disposition ? { what: i.disposition, on: i.disposedOn, amountCents: i.disposalCents, note: i.disposalNote } : null,
      categoryId: categoryById.has(i.categoryId ?? "") ? i.categoryId : null,
      category: categoryPath(i.categoryId),
      placeId: placeById.has(i.locationId ?? "") ? i.locationId : null,
      place: placePath(i.locationId),
      isBox: i.isContainer,
      inBoxId: i.containerItemId && itemIds.has(i.containerItemId) ? i.containerItemId : null,
      tags: itemTags.filter((t) => t.itemId === i.id).map((t) => tagName.get(t.tagId)).filter(Boolean),
      customFields: i.customFields ?? {},
      templateId: i.templateId,
      collectionId: i.collectionId,
      wanted: i.wanted,
      links: i.links ?? [],
      label: labelFor("itemId", i.id),
      /** Labels people brought (asset tags, stickers from elsewhere), as scanned. */
      ownLabels: owned.filter((o) => o.itemId === i.id).map((o) => o.code),
      /** HomeKit / Matter pairing codes, opened (`qr` is the QR code's text). */
      pairingCodes: pairings.get(i.id) ?? [],
      /** Lent out or borrowed, now and before. */
      loans: loans
        .filter((l) => l.itemId === i.id)
        .map((l) => ({ direction: l.direction, person: l.person, email: l.email, since: l.since, dueOn: l.dueOn, returnedOn: l.returnedOn, note: l.note })),
      /** Maintenance by use: what it counts (miles, hours…) and every reading. */
      usage: i.usageUnit
        ? {
            unit: i.usageUnit,
            readings: readings.filter((r) => r.itemId === i.id).map((r) => ({ on: r.readOn, value: r.value, by: r.userId ? (who.get(r.userId) ?? null) : null, note: r.note })),
          }
        : null,
      /** Scan to count: what scanning each code does, and every change to the count. */
      stock: {
        codes: rules.filter((r) => r.itemId === i.id).map((r) => ({ code: r.code, does: r.behaviour, step: r.step })),
        history: moves
          .filter((m) => m.itemId === i.id)
          .map((m) => ({ at: iso(m.createdAt), change: m.delta, left: m.quantityAfter, how: m.reason, by: m.userId ? (who.get(m.userId) ?? null) : null, note: m.note, undone: m.undoneAt != null })),
      },
      addedAt: iso(i.createdAt),
      /** How it was added (app, photos, walkthrough, scan, label, spreadsheet, homeassistant, claude, api) and the file's or key's name. */
      addedFrom: i.origin ? { how: i.origin, detail: i.originDetail } : null,
      updatedAt: iso(i.updatedAt),
      files: files
        .filter((f) => f.itemId === i.id)
        .map((f) => ({
          id: f.id,
          kind: f.kind,
          filename: f.filename,
          contentType: f.contentType,
          size: f.size,
          file: inZip(filePaths.get(f.id)),
          addedAt: iso(f.createdAt),
          /** What the photo shows / the document says, as read by Ferret (empty if never read). */
          description: f.analysis?.description || null,
          text: f.analysis?.text || null,
        })),
      warranties: warranties
        .filter((w) => w.itemId === i.id)
        .map((w) => ({
          id: w.id,
          provider: w.provider,
          startsOn: w.startsOn,
          endsOn: w.endsOn,
          coverage: w.coverage,
          notes: w.notes,
          documentId: w.attachmentId,
          claims: claims
            .filter((c) => c.warrantyId === w.id)
            .map((c) => ({
              id: c.id,
              filedOn: c.filedOn,
              problem: c.problem,
              reference: c.reference,
              status: c.status,
              resolution: c.resolution,
              resolvedOn: c.resolvedOn,
              costCents: c.costCents,
              notes: c.notes,
            })),
        })),
    })),
    maintenance: tasks
      .filter((t) => !t.itemId || itemIds.has(t.itemId))
      .map((t) => ({
        id: t.id,
        title: t.title,
        notes: t.notes,
        itemId: t.itemId,
        placeId: t.locationId && placeById.has(t.locationId) ? t.locationId : null,
        repeats: t.intervalCount && t.intervalUnit ? { every: t.intervalCount, unit: t.intervalUnit } : null,
        /** Also (or only) by use of its item: every so much (in the item's usage unit), next at `dueAt`. */
        byUse: t.usageEvery ? { every: t.usageEvery, dueAt: t.usageDueAt } : null,
        dueOn: t.dueOn,
        lastDoneOn: t.lastDoneOn,
        usuallyDoneBy: t.providerId ? (providerName.get(t.providerId) ?? null) : null,
        manualId: t.attachmentId,
        history: logs
          .filter((l) => l.taskId === t.id)
          .map((l) => ({
            doneOn: l.doneOn,
            by: l.doneBy ? (who.get(l.doneBy) ?? null) : null,
            provider: l.providerId ? (providerName.get(l.providerId) ?? null) : null,
            note: l.note,
            costCents: l.costCents,
          })),
      })),
  };
  return { data, files: files.filter((f) => filePaths.has(f.id)).map((f) => ({ ...f, path: filePaths.get(f.id)! })) };
}

const README = (household: string, counts: { items: number; files: number }) => `Ferret export — ${household}
Made ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC: ${counts.items} items, ${counts.files} photos and documents.

ferret.json   Everything: properties and places, items (with their warranties and claims, files, tags,
              custom fields and links), maintenance and its history, service providers, categories.
              Money is in cents (12900 = $129.00); dates are yyyy-mm-dd.
items.csv     The insurance list (one row per item, as in Ferret's report) — opens in any spreadsheet.
files/        Every photo and document, in a folder per item, as they were uploaded.

These files are not encrypted: keep this somewhere safe.
`;

/** The ZIP download: its file name, and the stream that makes it. */
export async function householdExport(v: Caller, files: FileStore) {
  const date = todayFor(v);
  const [home] = await v.db.select({ name: organization.name }).from(organization).where(eq(organization.id, v.householdId));
  const householdName = home?.name ?? "household";
  // Plain ASCII: it's also the download's name (a header).
  const slug = householdName.normalize("NFKD").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase().slice(0, 40) || "household";
  const root = `ferret-export-${slug}-${date}`;
  const { data, files: uploads } = await householdData(v, root, home?.name ?? null, files);
  const csv = toCsv(await exportRows(v));
  const text = new TextEncoder();
  const stream = zipStream(async (add) => {
    await add(`${root}/README.txt`, text.encode(README(householdName, { items: data.items.length, files: uploads.length })), { compress: true });
    await add(`${root}/ferret.json`, text.encode(JSON.stringify(data, null, 2)), { compress: true });
    await add(`${root}/items.csv`, text.encode(csv), { compress: true });
    for (const f of uploads) {
      // An original removed to free space: its small copy instead.
      const bytes = await files.get(v.householdId, f.originalRemovedAt && f.thumbnailKey ? f.thumbnailKey : f.blobKey);
      if (bytes) await add(f.path, bytes, { mtime: f.createdAt });
    }
  });
  return { filename: `${root}.zip`, stream };
}
