/**
 * Bringing back a thing exported from Ferret (lib/item-sheet.ts): its ZIP — item.json, its files, SHA256SUMS and the
 * signature. First `checkItemZip` says what's in it and whether it can be trusted (signed by this household's key, by
 * another key, not signed, or changed since it was signed) — the app shows that and asks. Then `importItemZip` adds it
 * as a new thing: one more `import_batch` (lib/imports.ts — places and categories found or made by path, a plan's room
 * for things, undoable from Import), then its other fields, photos and documents, warranties and claims, maintenance
 * and when it was done, and repairs. Its loans, stock moves and history stay in the ZIP: they were another
 * household's. Anything not signed by this household's key is only imported when the caller says so (`anyway`).
 */
import { type ItemImportCheck, type ItemImportResult, type ItemPatch, itemPatch } from "@ferret/shared";
import { claimStatuses, intervalUnits, itemConditions } from "@ferret/shared/utils";
import { and, eq, isNull, sql } from "drizzle-orm";
import { unzipSync } from "fflate";
import { HTTPException } from "hono/http-exception";
import { item, maintenanceLog, property } from "../db/schema";
import { addAttachment } from "./attachments";
import { fileClaim } from "./claims";
import type { FileStore } from "./files";
import { importItems, splitPath } from "./imports";
import { type Caller, itemChanged, updateItem } from "./inventory";
import { ITEM_FORMAT } from "./item-sheet";
import { createTask } from "./maintenance";
import { createRepair } from "./repairs";
import { sshVerify } from "./signing";
import { trFor } from "./language";
import { createWarranty } from "./warranties";

/** Files that come with the signature rather than under it. */
const SIGNATURE_FILES = new Set(["SHA256SUMS", "SHA256SUMS.sig", "allowed_signers", "ferret-signing-key.pub", "VERIFY.txt"]);
/** A ZIP unpacked can't grow past this (a "ZIP bomb"). */
const MAX_UNPACKED = 512 * 1024 * 1024;

/** What item.json holds (ITEM_FORMAT, version 1) — read loosely: anything missing is left out. */
interface ItemJson {
  format: string;
  version: number;
  exportedAt?: string;
  item: Record<string, unknown> & { name: string; place?: string | null; category?: string | null; tags?: string[] };
  files?: { kind: string; filename: string; path: string }[];
  warranties?: { id: string; provider: string | null; startsOn: string | null; endsOn: string; coverage: string | null; notes: string | null }[];
  claims?: { warrantyId: string; filedOn: string; problem: string; reference: string | null; status: string; resolution: string | null; resolvedOn: string | null; costCents: number | null; notes: string | null }[];
  maintenance?: { title: string; notes: string | null; intervalCount: number | null; intervalUnit: string | null; dueOn: string | null; done?: { doneOn: string; by: string | null; provider: string | null; note: string | null; costCents: number | null }[] }[];
  repairs?: { repairedOn: string; work: string; problem: string | null; provider: string | null; parts: string | null; costCents: number | null }[];
}

const bad = (message: string) => new HTTPException(422, { message });
const str = (x: unknown, max: number) => (typeof x === "string" && x.trim() ? x.trim().slice(0, max) : null);
const int = (x: unknown) => (typeof x === "number" && Number.isInteger(x) && x >= 0 ? x : null);
const isoDay = (x: unknown) => (typeof x === "string" && /^\d{4}-\d{2}-\d{2}$/.test(x) ? x : null);
const hex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");

/** Opens the ZIP: its folder's files by path (without the folder), item.json read. */
function open(bytes: Uint8Array) {
  let total = 0;
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes, {
      filter: (f) => {
        total += f.originalSize;
        if (total > MAX_UNPACKED) throw new Error("too big");
        return !f.name.endsWith("/");
      },
    });
  } catch (e) {
    throw bad(e instanceof Error && e.message === "too big" ? "That ZIP is too big to import" : "That isn't a ZIP Ferret can read");
  }
  const json = Object.keys(entries).find((n) => n === "item.json" || /^[^/]+\/item\.json$/.test(n));
  if (!json) throw bad("That ZIP isn't a thing exported from Ferret (it has no item.json)");
  const root = json.slice(0, -"item.json".length);
  const files = new Map<string, Uint8Array>();
  for (const [name, data] of Object.entries(entries)) if (name.startsWith(root)) files.set(name.slice(root.length), data);
  let data: ItemJson;
  try {
    data = JSON.parse(new TextDecoder().decode(files.get("item.json")!)) as ItemJson;
  } catch {
    throw bad("Its item.json can't be read");
  }
  if (data.format !== ITEM_FORMAT.format || typeof data.item?.name !== "string") throw bad("That ZIP isn't a thing exported from Ferret");
  if (data.version > ITEM_FORMAT.version) throw bad("That export is from a newer Ferret — update this one to import it");
  return { files, data };
}

/** Whether the files match SHA256SUMS and SHA256SUMS its signature. */
async function trust(v: Caller, files: Map<string, Uint8Array>) {
  const tr = await trFor(v.deps, v.userId);
  const sums = files.get("SHA256SUMS");
  const sig = files.get("SHA256SUMS.sig");
  if (!sums || !sig) return { signature: "unsigned" as const, fingerprint: null, problems: [] };
  const problems: string[] = [];
  const signed = await sshVerify(v, new TextDecoder().decode(sig), sums);
  if (!signed) problems.push(tr("The signature doesn't match SHA256SUMS"));
  const listed = new Map<string, string>();
  for (const line of new TextDecoder().decode(sums).split("\n")) {
    const m = line.match(/^([0-9a-f]{64}) {2}(.+)$/);
    if (m) listed.set(m[2]!, m[1]!);
  }
  for (const [path, hash] of listed) {
    const data = files.get(path);
    if (!data) problems.push(tr("{file} is missing", { file: path }));
    else if (hex(await crypto.subtle.digest("SHA-256", data as Uint8Array<ArrayBuffer>)) !== hash) problems.push(tr("{file} has changed", { file: path }));
  }
  for (const path of files.keys()) if (!listed.has(path) && !SIGNATURE_FILES.has(path)) problems.push(tr("{file} was added", { file: path }));
  if (problems.length) return { signature: "changed" as const, fingerprint: signed?.fingerprint ?? null, problems };
  return { signature: signed!.ours ? ("ours" as const) : ("other" as const), fingerprint: signed!.fingerprint, problems };
}

/** The property here a path starts with ("Highland House › Garage"), if there's one by that name. */
async function propertyFor(v: Caller, place: string | null) {
  const first = place ? splitPath(place)[0] : null;
  if (!first) return null;
  const [p] = await v.db
    .select({ id: property.id })
    .from(property)
    .where(and(eq(property.householdId, v.householdId), isNull(property.deletedAt), sql`lower(${property.name}) = lower(${first})`));
  return p?.id ?? null;
}

async function check(v: Caller, bytes: Uint8Array) {
  const { files, data } = open(bytes);
  const t = await trust(v, files);
  const it = data.item;
  const place = str(it.place, 400);
  const serial = str(it.serialNumber, 120);
  const [same] = serial
    ? await v.db
        .select({ id: item.id, name: item.name })
        .from(item)
        .where(and(eq(item.householdId, v.householdId), isNull(item.deletedAt), sql`lower(${item.serialNumber}) = lower(${serial})`))
        .limit(1)
    : [];
  const result: ItemImportCheck = {
    name: it.name,
    ...t,
    exportedAt: typeof data.exportedAt === "string" ? data.exportedAt : null,
    place,
    propertyId: await propertyFor(v, place),
    category: str(it.category, 200),
    counts: {
      photos: (data.files ?? []).filter((f) => f.kind === "photo").length,
      documents: (data.files ?? []).filter((f) => f.kind !== "photo").length,
      warranties: data.warranties?.length ?? 0,
      maintenance: data.maintenance?.length ?? 0,
      repairs: data.repairs?.length ?? 0,
    },
    sameSerial: same ?? null,
  };
  return { result, files, data };
}

/** What's in an exported thing's ZIP, and whether it can be trusted — to show before importing it. */
export async function checkItemZip(v: Caller, bytes: Uint8Array): Promise<ItemImportCheck> {
  return (await check(v, bytes)).result;
}

/**
 * Adds the thing in the ZIP as a new one. Unless it's signed by this household's key and unchanged, only with
 * `anyway` (the person saw the check and said yes). `propertyId`: where its place goes (default: the property of
 * the same name, as `checkItemZip` found).
 */
export async function importItemZip(v: Caller, store: FileStore, bytes: Uint8Array, opts: { anyway?: boolean; propertyId?: string | null; filename?: string } = {}): Promise<ItemImportResult> {
  const { result: seen, files, data } = await check(v, bytes);
  if (seen.signature !== "ours" && !opts.anyway) {
    throw new HTTPException(409, { message: "It isn't signed by this household's key — check it, then import it anyway", cause: seen });
  }
  const it = data.item;
  const propertyId = opts.propertyId ?? seen.propertyId;
  const condition = itemConditions.find((c) => c === it.condition) ?? null;
  // Through the importer: places and categories by path, a plan's room, an import to undo. Without its serial
  // number there, so one already here doesn't stop it (the check said so); it's set just after.
  const imported = await importItems(v, {
    source: "ferret",
    name: opts.filename?.slice(0, 200) || `${it.name}.zip`,
    propertyId: propertyId ?? null,
    rows: [
      {
        name: it.name.slice(0, 200),
        description: str(it.description, 5000),
        brand: str(it.brand, 120),
        model: str(it.model, 120),
        barcode: str(it.barcode, 64),
        quantity: int(it.quantity),
        condition,
        purchaseDate: isoDay(it.purchaseDate),
        returnBy: isoDay(it.returnBy),
        purchasePriceCents: int(it.purchasePriceCents),
        valueCents: int(it.valueCents),
        notes: str(it.notes, 10000),
        place: propertyId ? str(it.place, 400) : null,
        category: str(it.category, 200),
        tags: (Array.isArray(it.tags) ? it.tags : []).filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim().slice(0, 40)).slice(0, 30),
      },
    ],
  });
  if (!imported.created) throw new HTTPException(422, { message: imported.skipped[0]?.reason ?? "It couldn't be imported" });
  const [row] = await v.db.select({ id: item.id }).from(item).where(eq(item.importBatchId, imported.batchId));
  const itemId = row!.id;

  // The rest of its own fields, as one change — each checked against the same schema as an edit (a ZIP that isn't
  // ours may hold anything: a `javascript:` link, a custom field of the wrong shape); one that doesn't fit is left out.
  const raw: Record<string, unknown> = {};
  const serial = str(it.serialNumber, 120);
  if (serial) raw.serialNumber = serial;
  if (int(it.replacementCents) != null) raw.replacementCents = int(it.replacementCents);
  if (int(it.lifespanYears) != null) raw.lifespanYears = int(it.lifespanYears);
  if (int(it.minQuantity) != null) raw.minQuantity = int(it.minQuantity);
  if (it.favorite === true) raw.favorite = true;
  if (str(it.heir, 120)) raw.heir = str(it.heir, 120);
  if (it.customFields && typeof it.customFields === "object") raw.customFields = it.customFields;
  if (Array.isArray(it.links) && it.links.length) raw.links = it.links;
  const patch: ItemPatch = {};
  for (const [key, value] of Object.entries(raw)) {
    const one = itemPatch.safeParse({ [key]: value });
    if (one.success) Object.assign(patch, one.data);
  }
  if (typeof it.disposition === "string" && isoDay(it.disposedOn)) {
    const gone = itemPatch.safeParse({
      disposition: it.disposition,
      disposedOn: isoDay(it.disposedOn),
      disposalCents: int(it.disposalCents),
      disposedTo: str(it.disposedTo, 200),
      disposalNote: str(it.disposalNote, 2000),
    });
    if (gone.success) Object.assign(patch, gone.data);
  }
  if (Object.keys(patch).length) {
    try {
      await updateItem(v, itemId, patch);
    } catch {
      // A field this Ferret doesn't take as it was: the thing is in; leave that one out.
    }
  }

  const skippedFiles: string[] = [];
  for (const f of data.files ?? []) {
    const bytes = files.get(f.path);
    if (!bytes) {
      skippedFiles.push(f.filename);
      continue;
    }
    try {
      await addAttachment(v, store, { itemId }, { bytes, filename: f.filename.slice(0, 255), kind: f.kind === "photo" ? "photo" : "document" });
    } catch {
      skippedFiles.push(f.filename);
    }
  }

  const warrantyIds = new Map<string, string>();
  for (const w of data.warranties ?? []) {
    const endsOn = isoDay(w.endsOn);
    if (!endsOn) continue;
    const startsOn = isoDay(w.startsOn);
    const made = await createWarranty(v, itemId, { endsOn, startsOn: startsOn && startsOn <= endsOn ? startsOn : null, provider: str(w.provider, 120), coverage: str(w.coverage, 2000), notes: str(w.notes, 5000) });
    warrantyIds.set(w.id, made.id);
  }
  for (const c of data.claims ?? []) {
    const warrantyId = warrantyIds.get(c.warrantyId);
    const problem = str(c.problem, 2000);
    if (!warrantyId || !problem) continue;
    await fileClaim(v, warrantyId, {
      problem,
      filedOn: isoDay(c.filedOn) ?? undefined,
      status: claimStatuses.find((s) => s === c.status),
      reference: str(c.reference, 120),
      resolution: str(c.resolution, 2000),
      resolvedOn: isoDay(c.resolvedOn),
      costCents: int(c.costCents),
      notes: str(c.notes, 5000),
    });
  }

  for (const m of data.maintenance ?? []) {
    const title = str(m.title, 200);
    if (!title) continue;
    const unit = intervalUnits.find((u) => u === m.intervalUnit);
    const count = int(m.intervalCount);
    const task = await createTask(v, {
      title,
      notes: str(m.notes, 5000),
      itemId,
      ...(unit && count ? { intervalCount: count, intervalUnit: unit } : {}),
      ...(isoDay(m.dueOn) ? { dueOn: isoDay(m.dueOn)! } : {}),
    });
    // When it was done, as it was: who did it was someone in the other household, so in words.
    const done = (m.done ?? []).filter((d) => isoDay(d.doneOn));
    if (done.length) {
      await v.db.insert(maintenanceLog).values(
        done.map((d) => ({
          householdId: v.householdId,
          taskId: task.id,
          doneOn: d.doneOn,
          note: [str(d.note, 2000), d.provider ? `(${d.provider})` : d.by ? `(${d.by})` : null].filter(Boolean).join(" ") || null,
          costCents: int(d.costCents),
        })),
      );
    }
  }

  for (const r of data.repairs ?? []) {
    const repairedOn = isoDay(r.repairedOn);
    const work = str(r.work, 300);
    if (!repairedOn || !work) continue;
    await createRepair(v, itemId, { repairedOn, work, problem: str(r.problem, 2000), parts: [str(r.parts, 1000), r.provider ? `(${r.provider})` : null].filter(Boolean).join(" ") || null, costCents: int(r.costCents) });
  }

  await itemChanged(v, itemId);
  return { itemId, batchId: imported.batchId, skippedFiles };
}
