/**
 * The inbox: read before adding. Photos (one thing's), a receipt, invoice or order, or something shared from another
 * app go in as an entry; its files are ordinary attachments (`attachment.inboxId`), read in the background by the same
 * job as a thing's (jobs/analyze.ts). Nothing is made until someone, once it's read:
 *   - adds it as a new thing, with what the AI read filled in for them to correct (POST /inbox/{id}/add);
 *   - puts its files on a thing they already have — offered when its barcode, model or name matches one (…/onto);
 *   - adds the things on a receipt, each with a copy of it, "Already in Ferret" ones unticked (…/lines);
 *   - or discards it, files and all (DELETE).
 * Accepted, its files move onto the thing and what's done with a thing's reading happens then: suggested maintenance
 * from a manual, filling in where the household lets the AI (lib/ai-fill.ts), search.
 *
 * Two ways of adding don't come here (the web app decides): without the vision model, "Add from photos" makes New
 * items straight away — there'd be nothing to read; and "Walk through a room" stays quick capture, named afterwards.
 */
import { type InboxCreate, type InboxEntry, type ReceiptLinesInput, inboxCreate, itemInput } from "@ferret/shared";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { attachment, category, inboxEntry, item, location, user } from "../db/schema";
import { autoFill } from "./ai-fill";
import { attachmentFields, blobsStillUsed } from "./attachments";
import { previewKey } from "../jobs/analyze";
import type { FileStore } from "./files";
import { fullTextSearch } from "./fulltext";
import { type Caller, createItem, getItem, itemChanged, itemScope, locationIn, locationPaths, logActivity, notFound, updateItem } from "./inventory";
import { PHOTO_ORDER } from "./photo-order";
import { addReceiptLines } from "./receipt-lines";
import { suggestTasks } from "./suggested-tasks";

type Entry = typeof inboxEntry.$inferSelect;
type FileRow = typeof attachment.$inferSelect;

/** How a new thing from it says it was added (item.origin). */
const ORIGIN = { photos: "photos", receipt: "receipt", shared: "shared" } as const;

async function entryOf(v: Caller, id: string) {
  const [row] = await v.db.select().from(inboxEntry).where(and(eq(inboxEntry.id, id), eq(inboxEntry.householdId, v.householdId)));
  if (!row) throw notFound("Inbox entry");
  return row;
}

const filesOf = (v: Caller, entryId: string) =>
  v.db
    .select()
    .from(attachment)
    .where(and(eq(attachment.householdId, v.householdId), eq(attachment.inboxId, entryId), isNull(attachment.deletedAt)))
    .orderBy(...PHOTO_ORDER);

/** A new entry, its files to follow (POST /inbox/{id}/files). Where a new thing goes is checked to be this household's. */
export async function createInboxEntry(v: Caller, given: InboxCreate) {
  const input = inboxCreate.parse(given);
  if (input.locationId) {
    const [place] = await v.db.select({ id: location.id }).from(location).where(locationIn(v, input.locationId));
    if (!place) throw notFound("Location");
  }
  if (input.containerItemId) {
    const [box] = await v.db.select({ id: item.id }).from(item).where(and(eq(item.id, input.containerItemId), itemScope(v)));
    if (!box) throw notFound("Box");
  }
  if (input.categoryId) {
    const [cat] = await v.db.select({ id: category.id }).from(category).where(and(eq(category.id, input.categoryId), eq(category.householdId, v.householdId)));
    if (!cat) throw notFound("Category");
  }
  const [row] = await v.db
    .insert(inboxEntry)
    .values({
      id: crypto.randomUUID(),
      householdId: v.householdId,
      kind: input.kind,
      locationId: input.containerItemId ? null : (input.locationId ?? null),
      containerItemId: input.containerItemId ?? null,
      categoryId: input.categoryId ?? null,
      tags: input.tags.length ? input.tags : null,
      note: input.note ?? null,
      link: input.link ?? null,
      createdBy: v.userId,
    })
    .returning();
  return describe(v, row!, []);
}

/** The first value any of its files read for a field (photos first, as files are ordered). */
function proposalOf(entry: Entry, files: FileRow[]): InboxEntry["proposal"] {
  const read = files.filter((f) => f.analysisStatus === "done" && f.analysis).map((f) => f.analysis!);
  const first = <K extends keyof NonNullable<FileRow["analysis"]>["suggestions"]>(key: K) => {
    for (const a of read) {
      const value = a.suggestions[key];
      if (value !== undefined && value !== null && value !== "") return value;
    }
    return null;
  };
  return {
    name: (first("name") as string | null) ?? null,
    brand: (first("brand") as string | null) ?? null,
    model: (first("model") as string | null) ?? null,
    serialNumber: (first("serialNumber") as string | null) ?? null,
    barcode: (first("barcode") as string | null) ?? null,
    purchaseDate: (first("purchaseDate") as string | null) ?? null,
    purchasePriceCents: (first("purchasePriceCents") as number | null) ?? null,
    categoryId: entry.categoryId ?? (first("categoryId") as string | null) ?? null,
    description: read.find((a) => a.description)?.description ?? null,
  };
}

/** Things already in Ferret it may be: the same barcode or model, else its name's best keyword matches. */
async function matchesOf(v: Caller, p: InboxEntry["proposal"]) {
  const found = new Map<string, { id: string; name: string; locationId: string | null }>();
  const fields = { id: item.id, name: item.name, locationId: item.locationId };
  if (p.barcode) for (const r of await v.db.select(fields).from(item).where(and(itemScope(v), eq(item.barcode, p.barcode))).limit(3)) found.set(r.id, r);
  if (p.model && found.size < 3) {
    for (const r of await v.db.select(fields).from(item).where(and(itemScope(v), sql`lower(${item.model}) = ${p.model.toLowerCase()}`)).limit(3)) found.set(r.id, r);
  }
  // Its brand and name, else its name alone (a drill already in Ferret under another brand's name), else its first two
  // words ("Cordless Drill/Driver" is the "Cordless drill" already there: every word must match).
  const nameWords = (p.name ?? "").match(/[\p{L}\p{N}]+/gu) ?? [];
  const tries = [[p.brand, p.name].filter(Boolean).join(" "), p.name ?? "", nameWords.length > 2 ? nameWords.slice(0, 2).join(" ") : ""];
  for (const words of [...new Set(tries)].filter(Boolean)) {
    if (found.size >= 3) break;
    const hits = await fullTextSearch(v.db, v.householdId, words, 5, { documents: false }).catch(() => []);
    const ids = hits.map((h) => h.itemId).filter((id) => !found.has(id));
    if (ids.length) {
      const rows = await v.db.select(fields).from(item).where(and(itemScope(v), inArray(item.id, ids.slice(0, 5))));
      for (const id of ids) {
        const r = rows.find((x) => x.id === id);
        // Not an unnamed "New item": nothing to recognise it by.
        if (r && r.name !== "New item" && found.size < 3) found.set(r.id, r);
      }
    }
  }
  if (!found.size) return [];
  const paths = await locationPaths(v);
  return [...found.values()].map((r) => ({ id: r.id, name: r.name, place: r.locationId ? (paths.get(r.locationId) ?? null) : null }));
}

/**
 * Its receipt listing several products: a document, or a photo that's the entry's only file (a receipt photographed
 * with "Add from photos" — not one thing's photos, of which its receipt is one).
 */
const receiptOf = (files: FileRow[]) => files.find((f) => (f.kind === "document" || files.length === 1) && (f.analysis?.suggestions.lines?.length ?? 0) > 1);

async function describe(v: Caller, entry: Entry, files: FileRow[], opts: { matches?: boolean } = {}): Promise<InboxEntry> {
  const [by] = entry.createdBy ? await v.db.select({ name: user.name }).from(user).where(eq(user.id, entry.createdBy)) : [];
  const proposal = proposalOf(entry, files);
  const reading = files.some((f) => f.analysisStatus === "pending");
  const receiptFile = receiptOf(files);
  let placeName: string | null = null;
  if (entry.containerItemId) {
    const [box] = await v.db.select({ name: item.name }).from(item).where(and(eq(item.id, entry.containerItemId), itemScope(v)));
    placeName = box?.name ?? null;
  } else if (entry.locationId) placeName = (await locationPaths(v)).get(entry.locationId) ?? null;
  const shown = files.length ? await v.db.select(attachmentFields).from(attachment).where(inArray(attachment.id, files.map((f) => f.id))).orderBy(...PHOTO_ORDER) : [];
  return {
    id: entry.id,
    kind: entry.kind,
    status: !files.length ? "empty" : reading ? "reading" : "ready",
    into: { locationId: entry.locationId, containerItemId: entry.containerItemId, categoryId: entry.categoryId, tags: entry.tags ?? [], placeName },
    note: entry.note,
    link: entry.link,
    files: shown as unknown as InboxEntry["files"],
    proposal,
    receipt: receiptFile ? { attachmentId: receiptFile.id, lines: receiptFile.analysis!.suggestions.lines! } : null,
    matches: opts.matches && !reading && !receiptFile ? await matchesOf(v, proposal) : [],
    by: by?.name ?? null,
    createdAt: entry.createdAt.toISOString(),
  };
}

/** What's waiting, newest first. */
export async function listInbox(v: Caller): Promise<InboxEntry[]> {
  const entries = await v.db.select().from(inboxEntry).where(eq(inboxEntry.householdId, v.householdId)).orderBy(desc(inboxEntry.createdAt), asc(inboxEntry.id));
  if (!entries.length) return [];
  const files = await v.db
    .select()
    .from(attachment)
    .where(and(eq(attachment.householdId, v.householdId), inArray(attachment.inboxId, entries.map((e) => e.id)), isNull(attachment.deletedAt)))
    .orderBy(...PHOTO_ORDER);
  return Promise.all(entries.map((e) => describe(v, e, files.filter((f) => f.inboxId === e.id), { matches: true })));
}

export async function getInboxEntry(v: Caller, id: string) {
  const entry = await entryOf(v, id);
  return describe(v, entry, await filesOf(v, id), { matches: true });
}

/** How many are waiting (the menu's count, To confirm). */
export async function inboxCount(v: Caller) {
  const [row] = await v.db.select({ n: sql<number>`count(*)` }).from(inboxEntry).where(eq(inboxEntry.householdId, v.householdId));
  return Number(row?.n ?? 0);
}

/**
 * Its files onto a thing, and what's done with a thing's reading done now: suggested maintenance from a manual, the
 * AI filling in where the household lets it, search. A file still being read gets that when it's done (the job checks).
 */
async function moveFiles(v: Caller, entry: Entry, itemId: string) {
  const files = await filesOf(v, entry.id);
  if (files.length) await v.db.update(attachment).set({ itemId, inboxId: null }).where(and(eq(attachment.householdId, v.householdId), eq(attachment.inboxId, entry.id)));
  for (const f of files) {
    if (f.analysisStatus !== "done" || !f.analysis) continue;
    const maintenance = f.analysis.suggestions.maintenance;
    if (maintenance?.length) await suggestTasks(v.db, { householdId: v.householdId, itemId, attachmentId: f.id, source: "manual" }, maintenance);
    await autoFill(v.deps, { ...f, itemId }, f.analysis).catch((err) => console.warn(`Filling in from ${f.id} failed: ${String(err)}`));
  }
  await v.db.delete(inboxEntry).where(eq(inboxEntry.id, entry.id));
  await itemChanged(v, itemId);
  return files;
}

/**
 * Add it as a new thing: the fields as the person corrected them (an item, as for POST /items). Where it goes, its
 * category, note and link are the entry's for whatever they left out; its tags are added to theirs.
 */
export async function addFromInbox(v: Caller, id: string, raw: unknown) {
  const entry = await entryOf(v, id);
  const given = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const where = "locationId" in given || "containerItemId" in given ? {} : { locationId: entry.containerItemId ? null : entry.locationId, containerItemId: entry.containerItemId };
  const parsed = itemInput.safeParse({
    categoryId: entry.categoryId,
    notes: entry.note,
    links: entry.link ? [{ url: entry.link }] : [],
    ...where,
    ...given,
    tags: [...new Set([...(Array.isArray(given.tags) ? (given.tags as string[]) : []), ...(entry.tags ?? [])])],
    origin: ORIGIN[entry.kind],
  });
  if (!parsed.success) throw new HTTPException(422, { message: parsed.error.issues[0]?.message ?? "Check the thing's fields" });
  const created = await createItem(v, parsed.data);
  await moveFiles(v, entry, created.id);
  return getItem(v, created.id);
}

/** Put its files (and a shared link) on a thing already in Ferret; their suggestions then wait on that thing's page. */
export async function putInboxOnto(v: Caller, id: string, itemId: string) {
  const entry = await entryOf(v, id);
  const [thing] = await v.db.select({ id: item.id, name: item.name, links: item.links }).from(item).where(and(eq(item.id, itemId), itemScope(v, { gone: "include" })));
  if (!thing) throw notFound("Item");
  if (entry.link && !(thing.links ?? []).some((l) => l.url === entry.link) && (thing.links ?? []).length < 10) {
    await updateItem(v, thing.id, { links: [...(thing.links ?? []), { url: entry.link }] });
  }
  const files = await moveFiles(v, entry, thing.id);
  if (files.length) await logActivity(v, "item.update", thing.id, `Added ${files.length === 1 ? files[0]!.filename : `${files.length} files`} from the inbox`, thing.id);
  return { id: thing.id, name: thing.name };
}

/**
 * Add the things on its receipt: the first one ticked is made from the entry (with the receipt and any photos), each
 * other a thing of its own with a copy of the receipt — lib/receipt-lines.ts, as for a receipt on a New item.
 */
export async function addInboxLines(v: Caller, files: FileStore, id: string, input: ReceiptLinesInput) {
  const entry = await entryOf(v, id);
  const receipt = receiptOf(await filesOf(v, id));
  if (!receipt) throw new HTTPException(409, { message: "That isn't a receipt with several things on it (or it's still being read)" });
  const placeholder = await createItem(
    v,
    itemInput.parse({
      name: "New item",
      locationId: input.locationId !== undefined ? input.locationId : entry.containerItemId ? undefined : entry.locationId,
      containerItemId: input.locationId !== undefined ? undefined : (entry.containerItemId ?? undefined),
      categoryId: entry.categoryId,
      tags: entry.tags ?? [],
      notes: entry.note,
      origin: "receipt",
    }),
  );
  await v.db.update(attachment).set({ itemId: placeholder.id, inboxId: null }).where(and(eq(attachment.householdId, v.householdId), eq(attachment.inboxId, entry.id)));
  const made = await addReceiptLines(v, files, receipt.id, { ...input, intoItem: true, ownLine: null });
  await v.db.delete(inboxEntry).where(eq(inboxEntry.id, entry.id));
  await itemChanged(v, placeholder.id);
  return made;
}

/** Discard it: the entry and its files, now (nothing was made of it to keep them for). */
export async function discardInboxEntry(v: Caller, files: FileStore, id: string) {
  const entry = await entryOf(v, id);
  const rows = await v.db.select().from(attachment).where(and(eq(attachment.householdId, v.householdId), eq(attachment.inboxId, entry.id)));
  if (rows.length) await v.db.delete(attachment).where(inArray(attachment.id, rows.map((r) => r.id)));
  await v.db.delete(inboxEntry).where(eq(inboxEntry.id, entry.id));
  const keys = rows.flatMap((r) => [r.blobKey, r.thumbnailKey].filter((k): k is string => Boolean(k)));
  const kept = await blobsStillUsed(v.db, keys, rows.map((r) => r.id));
  for (const r of rows) {
    if (!kept.has(r.blobKey)) await files.delete(r.blobKey).catch(() => {});
    if (r.thumbnailKey && !kept.has(r.thumbnailKey)) await files.delete(r.thumbnailKey).catch(() => {});
    await files.delete(previewKey(r.blobKey)).catch(() => {});
  }
}
