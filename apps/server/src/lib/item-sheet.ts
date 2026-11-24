/**
 * Everything about one thing, written out: its printable sheet (GET /items/:id/sheet, the web's ItemSheet.tsx) and
 * its export (GET /items/:id/export.zip) — the same sheet as Markdown, with its photos and documents, a
 * machine-readable item.json, and a signature from the household's key (lib/signing.ts):
 *
 *   <name>/
 *     <name>.md          the sheet, its photos shown and documents linked
 *     <name>.pdf         the sheet as a PDF the server drew, itself signed too (lib/item-pdf.ts)
 *     item.json          the same thing as data (format "ferret-item", version 1), for bringing it back in
 *     files/…            its photos and documents, decrypted
 *     SHA256SUMS         every file above with its SHA-256
 *     SHA256SUMS.sig     SHA256SUMS signed with the household's key (OpenSSH: ssh-keygen -Y verify)
 *     allowed_signers    the household's public key, as ssh-keygen -Y verify wants it
 *     ferret-signing-key.pub  the same key on its own: `ssh-keygen -lf` shows its fingerprint, to compare with one
 *                        got another way (Settings → Household, a printed sheet)
 *     VERIFY.txt         how to check it, in words
 *
 * `parts` leaves out what the person unticked (photos, notes, history…); the details are always there. Written in
 * the asker's language, amounts in the household's currency, times in its zone. Streamed as it's made, one file
 * decrypted at a time; nothing is kept on the server.
 */
import { formatMoney, type ItemSheet, type ItemSheetPart, type ItemSheetSection } from "@ferret/shared";
import { youtubeWatchUrl } from "@ferret/shared/utils";
import { and, eq, isNull } from "drizzle-orm";
import { attachment } from "../db/schema";
import { PHOTO_ORDER } from "./photo-order";
import { categoryInfo } from "./catalog";
import { listClaims } from "./claims";
import type { FileStore } from "./files";
import { itemHistory } from "./history";
import { itemDetail } from "./item-detail";
import type { Caller } from "./inventory";
import { type Tr, trFor } from "./language";
import { listLoans } from "./loans";
import { listMaintenance, taskHistory } from "./maintenance";
import { listRepairs } from "./repairs";
import { signingKey, sshSign } from "./signing";
import { stockSummary } from "./stock";
import { getTemplate } from "./templates";
import { itemWarranties } from "./warranties";
import { safeName, zipStream } from "./household-export";
import { type SheetPhoto, sheetPdf, withSignature } from "./item-pdf";
import { previewKey } from "../jobs/analyze";
import { sniffContentType } from "./sniff";

/** item.json's format: what an import of a thing reads. */
export const ITEM_FORMAT = { format: "ferret-item", version: 1 } as const;
/** History lines on a sheet: plenty for one thing. */
const HISTORY_LINES = 1000;

type Row = [string, string];
const rows = (list: (Row | false | null | undefined)[]) => list.filter((r): r is Row => Boolean(r && r[1]));
const joined = (parts: unknown[]) => parts.filter((p) => p != null && p !== false && p !== "").join(" · ");

function words(tr: Tr) {
  return {
    condition: { new: tr("New"), excellent: tr("Excellent"), good: tr("Good"), fair: tr("Fair"), poor: tr("Poor") } as Record<string, string>,
    gone: { sold: tr("Sold"), given: tr("Given away"), donated: tr("Donated"), discarded: tr("Thrown out"), lost: tr("Lost"), stolen: tr("Stolen") } as Record<string, string>,
    claim: { filed: tr("Filed"), in_progress: tr("In progress"), approved: tr("Approved"), denied: tr("Denied"), resolved: tr("Resolved") } as Record<string, string>,
    stock: { scan: tr("scanned"), manual: tr("by hand"), edit: tr("edited"), undo: tr("undo"), maintenance: tr("maintenance") } as Record<string, string>,
  };
}

function every(tr: Tr, count: number | null, unit: string | null) {
  if (!count || !unit) return tr("once");
  switch (unit) {
    case "day":
      return tr("{count, plural, one {every day} other {every # days}}", { count });
    case "week":
      return tr("{count, plural, one {every week} other {every # weeks}}", { count });
    case "month":
      return tr("{count, plural, one {every month} other {every # months}}", { count });
    default:
      return tr("{count, plural, one {every year} other {every # years}}", { count });
  }
}

/** What a sheet and an export are made from: the thing and everything about it that `parts` asks for. */
async function gather(v: Caller, itemId: string, parts: Set<ItemSheetPart>) {
  const it = await itemDetail(v, itemId);
  const want = (p: ItemSheetPart) => parts.has(p);
  const [files, warranties, claims, tasks, repairs, loans, stock, history, categories, template] = await Promise.all([
    want("photos") || want("documents")
      ? v.db
          .select()
          .from(attachment)
          .where(and(eq(attachment.itemId, itemId), eq(attachment.householdId, v.householdId), isNull(attachment.deletedAt)))
          .orderBy(...PHOTO_ORDER)
      : [],
    want("warranties") ? itemWarranties(v, itemId) : [],
    want("warranties") ? listClaims(v, { itemId }) : [],
    want("maintenance") ? listMaintenance(v, { itemId, status: "all" }) : [],
    want("repairs") ? listRepairs(v, itemId) : [],
    want("loans") ? listLoans(v, { all: true, itemId }) : [],
    want("stock") ? stockSummary(v, itemId, 200) : null,
    want("history") ? itemHistory(v, itemId, { limit: HISTORY_LINES, offset: 0 }).then((h) => h.data) : [],
    it.categoryId ? categoryInfo(v) : null,
    it.templateId ? getTemplate(v, it.templateId).catch(() => null) : null,
  ]);
  const logs = new Map(await Promise.all(tasks.map(async (t) => [t.id, await taskHistory(v, t.id)] as const)));
  const catFields = (it.categoryId && categories?.get(it.categoryId)?.fields) || [];
  const fields = [...catFields, ...(template?.fields ?? []).filter((f) => !catFields.some((c) => c.key === f.key))];
  const photos = want("photos") ? files.filter((f) => f.kind === "photo") : [];
  const documents = want("documents") ? files.filter((f) => f.kind !== "photo") : [];
  return { it, fields, photos, documents, warranties, claims, tasks, logs, repairs, loans, stock, history, parts };
}
type Gathered = Awaited<ReturnType<typeof gather>>;

function buildSheet(v: Caller, tr: Tr, g: Gathered, publicUrl: string): ItemSheet {
  const w = words(tr);
  const it = g.it;
  const day = (iso: string) => tr.date(iso.slice(0, 10), { year: "numeric", month: "short", day: "numeric" });
  const moment = (when: string | Date) =>
    new Date(when).toLocaleString(tr.locale, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: v.timeZone });
  const money = (cents: number) => formatMoney(cents, v.currency, { exact: true, locale: tr.locale });
  const want = (p: ItemSheetPart) => g.parts.has(p);
  const sections: ItemSheetSection[] = [];

  const custom = g.fields
    .filter((f) => it.customFields?.[f.key] !== undefined && it.customFields?.[f.key] !== "")
    .map((f): Row => [f.label, `${String(it.customFields![f.key])}${f.unit ? ` ${f.unit}` : ""}`]);
  sections.push({
    id: "details",
    title: tr("Details"),
    rows: rows([
      [tr("Description"), it.description ?? ""],
      [tr("Brand"), it.brand ?? ""],
      [tr("Model"), it.model ?? ""],
      [tr("Serial number"), it.serialNumber ?? ""],
      [tr("Barcode"), it.barcode ?? ""],
      [tr("Quantity"), it.quantity !== 1 ? String(it.quantity) : ""],
      [tr("Condition"), it.condition ? (w.condition[it.condition] ?? it.condition) : ""],
      [tr("Where"), joined([it.place, it.container && tr("in {box}", { box: it.container.name })])],
      [tr("Category"), it.category ?? ""],
      [tr("Tags"), it.tags.join(", ")],
      ...custom,
      [tr("QR label"), it.labelCode ?? ""],
      [tr("Other labels"), (it.ownLabels ?? []).map((l) => l.code).join(", ")],
      [tr("Bought"), joined([it.purchaseDate && day(it.purchaseDate), it.purchasePriceCents != null && money(it.purchasePriceCents)])],
      [tr("Return by"), it.returnBy ? day(it.returnBy) : ""],
      [tr("Value"), it.valueCents != null ? money(it.valueCents) : ""],
      [tr("Replacement cost"), it.replacementCents != null ? money(it.replacementCents) : ""],
      [tr("Expected life"), it.lifespan ? tr("about {years} years", { years: it.lifespan.years }) : ""],
      [tr("Goes to"), it.heir ?? ""],
      [tr("Last seen"), it.lastSeen ? joined([moment(it.lastSeen.at), it.lastSeen.by]) : ""],
      [tr("Added"), joined([day(new Date(it.createdAt).toISOString()), it.addedBy])],
      it.disposition && [
        tr("No longer have it"),
        joined([w.gone[it.disposition] ?? it.disposition, it.disposedOn && day(it.disposedOn), it.disposalCents != null && money(it.disposalCents), it.disposedTo, it.disposalNote]),
      ],
    ]),
  });
  if (want("notes") && it.notes) sections.push({ id: "notes", title: tr("Notes"), text: it.notes });

  if (want("links")) {
    const links = [
      ...(it.links ?? []).map((l) => ({ label: l.label || l.url, url: l.url })),
      ...(it.videos ?? []).map((vid) => ({ label: vid.title ? tr("Video: {title}", { title: vid.title }) : tr("Video"), url: youtubeWatchUrl(vid.videoId) })),
      ...(it.repairGuide ? [{ label: tr("Repair guide: {title}", { title: it.repairGuide.title }), url: it.repairGuide.url }] : []),
    ];
    if (links.length) sections.push({ id: "links", title: tr("Links"), links });
  }

  if (g.warranties.length) {
    sections.push({
      id: "warranties",
      title: tr("Warranties"),
      entries: g.warranties.map((wr) => ({
        title: wr.provider || tr("Warranty"),
        rows: rows([
          [tr("Covered"), wr.startsOn ? tr("{from} to {to}", { from: day(wr.startsOn), to: day(wr.endsOn) }) : tr("until {to}", { to: day(wr.endsOn) })],
          [tr("Covers"), wr.coverage ?? ""],
        ]),
        text: wr.notes,
        lines: g.claims
          .filter((c) => c.warrantyId === wr.id)
          .map((c) =>
            joined([
              tr("Claim filed {date}: {problem}", { date: day(c.filedOn), problem: c.problem }),
              w.claim[c.status] ?? c.status,
              c.reference && tr("ref. {reference}", { reference: c.reference }),
              c.resolution,
              c.costCents != null && money(c.costCents),
            ]),
          ),
      })),
    });
  }

  if (g.tasks.length) {
    sections.push({
      id: "maintenance",
      title: tr("Maintenance"),
      entries: g.tasks.map((task) => ({
        title: task.title,
        rows: rows([
          [tr("How often"), every(tr, task.intervalCount, task.intervalUnit)],
          [tr("Next due"), task.dueOn ? day(task.dueOn) : ""],
          [tr("Last done"), task.lastDoneOn ? day(task.lastDoneOn) : ""],
          [tr("Done by"), task.providerName ?? ""],
          [tr("Uses"), task.part ? `${task.part.uses} × ${task.part.name}` : ""],
        ]),
        text: task.notes,
        lines: (g.logs.get(task.id) ?? []).map((l) => joined([tr("Done {date}", { date: day(l.doneOn) }), l.doneByName ?? l.providerName, l.costCents != null && money(l.costCents), l.note])),
      })),
    });
  }

  if (g.repairs.length) {
    sections.push({
      id: "repairs",
      title: tr("Repairs"),
      entries: g.repairs.map((r) => ({
        title: `${day(r.repairedOn)} — ${r.work}`,
        rows: rows([
          [tr("Problem"), r.problem ?? ""],
          [tr("Done by"), r.providerName ?? ""],
          [tr("Parts"), r.parts ?? ""],
          [tr("Cost"), r.costCents != null ? money(r.costCents) : ""],
          [tr("Repair warranty until"), r.warrantyEndsOn ? day(r.warrantyEndsOn) : ""],
        ]),
      })),
    });
  }

  if (g.loans.length) {
    sections.push({
      id: "loans",
      title: tr("Lent and borrowed"),
      lines: g.loans.map((l) =>
        joined([
          l.direction === "lent" ? tr("Lent to {person} on {date}", { person: l.person, date: day(l.since) }) : tr("Borrowed from {person} on {date}", { person: l.person, date: day(l.since) }),
          l.dueOn && tr("due back {date}", { date: day(l.dueOn) }),
          l.returnedOn ? tr("back {date}", { date: day(l.returnedOn) }) : tr("not back yet"),
          l.note,
        ]),
      ),
    });
  }

  const moves = g.stock?.movements.filter((m) => !m.undone) ?? [];
  if (g.stock && (moves.length || it.minQuantity != null)) {
    sections.push({
      id: "stock",
      title: tr("Stock"),
      rows: rows([
        [tr("In stock"), String(g.stock.quantity)],
        [tr("Keep at least"), it.minQuantity != null ? String(it.minQuantity) : ""],
      ]),
      lines: moves.map((m) => joined([moment(m.at), `${m.delta > 0 ? "+" : ""}${m.delta}`, tr("{left} left", { left: m.quantityAfter }), w.stock[m.reason] ?? m.reason, m.by, m.note])),
    });
  }

  if (g.history.length) {
    sections.push({ id: "history", title: tr("History"), lines: g.history.map((h) => joined([moment(h.at), h.summary, h.by])) });
  }

  return {
    name: it.name,
    subtitle: [it.place && (it.container ? `${it.place} › ${it.container.name}` : it.place), it.category].filter((s): s is string => Boolean(s)),
    sections,
    photos: g.photos.map((p) => ({ id: p.id, filename: p.filename, description: p.analysis?.description ?? null })),
    documents: g.documents.map((d) => ({ id: d.id, filename: d.filename })),
    url: `${publicUrl.replace(/\/$/, "")}/#/items/${encodeURIComponent(it.id)}`,
  };
}

/** A thing's sheet, in the asker's language. */
export async function itemSheet(v: Caller, itemId: string, parts: Set<ItemSheetPart>, publicUrl: string) {
  const tr = await trFor(v.deps, v.userId);
  return buildSheet(v, tr, await gather(v, itemId, parts), publicUrl);
}

/** Each file's path in the ZIP (files/<name>, numbered when two share a name). */
function filePaths(files: { id: string; filename: string }[]) {
  const used = new Set<string>();
  const paths = new Map<string, string>();
  for (const f of files) {
    const name = safeName(f.filename);
    const dot = name.lastIndexOf(".");
    let path = `files/${name}`;
    for (let n = 2; used.has(path.toLowerCase()); n++) path = `files/${dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`}`;
    used.add(path.toLowerCase());
    paths.set(f.id, path);
  }
  return paths;
}

/** The sheet as Markdown: photos shown and documents linked from `paths`. */
export function sheetMarkdown(tr: Tr, s: ItemSheet, paths: Map<string, string>, madeAt: string) {
  const out: string[] = [`# ${s.name}`, ""];
  if (s.subtitle.length) out.push(s.subtitle.join(" · "), "");
  const field = ([label, value]: Row) => `- **${label}:** ${value.replace(/\n+/g, " ")}`;
  if (s.photos.length) {
    for (const p of s.photos) out.push(`![${(p.description || p.filename).replace(/[[\]]/g, "")}](${encodeURI(paths.get(p.id)!)})`);
    out.push("");
  }
  for (const sec of s.sections) {
    out.push(`## ${sec.title}`, "");
    if (sec.rows?.length) out.push(...sec.rows.map(field), "");
    if (sec.text) out.push(sec.text, "");
    if (sec.links?.length) out.push(...sec.links.map((l) => `- [${l.label.replace(/[[\]]/g, "")}](${l.url})`), "");
    for (const e of sec.entries ?? []) {
      out.push(`### ${e.title}`, "");
      if (e.rows.length) out.push(...e.rows.map(field), "");
      if (e.text) out.push(e.text, "");
      if (e.lines?.length) out.push(...e.lines.map((l) => `- ${l}`), "");
    }
    if (sec.lines?.length) out.push(...sec.lines.map((l) => `- ${l}`), "");
  }
  if (s.documents.length) out.push(`## ${tr("Documents")}`, "", ...s.documents.map((f) => `- [${f.filename.replace(/[[\]]/g, "")}](${encodeURI(paths.get(f.id)!)})`), "");
  out.push("---", "", tr("From Ferret, {date}: {url}", { date: madeAt, url: s.url }), "");
  return out.join("\n");
}

/** The thing as data, for bringing it back in (ITEM_FORMAT). Ids are kept so its parts can point at each other. */
function itemData(v: Caller, g: Gathered, paths: Map<string, string>, madeAt: Date) {
  const it = g.it;
  return {
    ...ITEM_FORMAT,
    exportedAt: madeAt.toISOString(),
    currency: v.currency,
    parts: [...g.parts],
    item: {
      id: it.id,
      name: it.name,
      description: it.description ?? null,
      brand: it.brand ?? null,
      model: it.model ?? null,
      serialNumber: it.serialNumber ?? null,
      barcode: it.barcode ?? null,
      quantity: it.quantity,
      minQuantity: it.minQuantity ?? null,
      usageUnit: it.usageUnit ?? null,
      condition: it.condition ?? null,
      purchaseDate: it.purchaseDate ?? null,
      returnBy: it.returnBy ?? null,
      purchasePriceCents: it.purchasePriceCents ?? null,
      valueCents: it.valueCents ?? null,
      replacementCents: it.replacementCents ?? null,
      lifespanYears: it.lifespanYears ?? null,
      notes: g.parts.has("notes") ? (it.notes ?? null) : null,
      favorite: it.favorite,
      heir: it.heir ?? null,
      isContainer: it.isContainer,
      wanted: it.wanted ?? false,
      place: it.place,
      box: it.container?.name ?? null,
      category: it.category,
      tags: it.tags,
      customFields: it.customFields ?? null,
      links: g.parts.has("links") ? (it.links ?? []) : [],
      videos: g.parts.has("links") ? (it.videos ?? []).map((vid) => vid.videoId) : [],
      disposition: it.disposition ?? null,
      disposedOn: it.disposedOn ?? null,
      disposalCents: it.disposalCents ?? null,
      disposedTo: it.disposedTo ?? null,
      disposalNote: it.disposalNote ?? null,
      createdAt: it.createdAt,
    },
    files: [...g.photos, ...g.documents].map((f) => ({ id: f.id, kind: f.kind, filename: f.filename, contentType: f.contentType, path: paths.get(f.id)!, createdAt: f.createdAt.toISOString() })),
    warranties: g.warranties.map((w) => ({ id: w.id, provider: w.provider ?? null, startsOn: w.startsOn ?? null, endsOn: w.endsOn, coverage: w.coverage ?? null, notes: w.notes ?? null })),
    claims: g.claims.map((c) => ({ id: c.id, warrantyId: c.warrantyId, filedOn: c.filedOn, problem: c.problem, reference: c.reference, status: c.status, resolution: c.resolution, resolvedOn: c.resolvedOn, costCents: c.costCents, notes: c.notes })),
    maintenance: g.tasks.map((t) => ({
      id: t.id,
      title: t.title,
      notes: t.notes,
      intervalCount: t.intervalCount,
      intervalUnit: t.intervalUnit,
      dueOn: t.dueOn,
      lastDoneOn: t.lastDoneOn,
      done: (g.logs.get(t.id) ?? []).map((l) => ({ doneOn: l.doneOn, by: l.doneByName, provider: l.providerName, note: l.note, costCents: l.costCents })),
    })),
    repairs: g.repairs.map((r) => ({ id: r.id, repairedOn: r.repairedOn, work: r.work, problem: r.problem, provider: r.providerName, parts: r.parts, costCents: r.costCents })),
    loans: g.loans.map((l) => ({ direction: l.direction, person: l.person, since: l.since, dueOn: l.dueOn, returnedOn: l.returnedOn, note: l.note })),
    stock: g.stock ? { quantity: g.stock.quantity, movements: g.stock.movements.filter((m) => !m.undone).map((m) => ({ at: m.at, delta: m.delta, quantityAfter: m.quantityAfter, reason: m.reason, note: m.note })) } : null,
    history: g.history.map((h) => ({ at: h.at, action: h.action, summary: h.summary, by: h.by })),
  };
}

/** Each photo in a shape a PDF takes: its JPEG preview copy, else the original (JPEG/PNG), else its thumbnail. */
async function pdfPhotos(v: Caller, files: FileStore, g: Gathered): Promise<SheetPhoto[]> {
  const out: SheetPhoto[] = [];
  for (const p of g.photos) {
    const tries = [previewKey(p.blobKey), ...(p.originalRemovedAt ? [] : [p.blobKey]), ...(p.thumbnailKey ? [p.thumbnailKey] : [])];
    let found: SheetPhoto = { id: p.id, filename: p.filename, bytes: null, type: null };
    for (const key of tries) {
      const bytes = await files.get(v.householdId, key).catch(() => null);
      const type = bytes ? sniffContentType(bytes) : null;
      if (bytes && (type === "image/jpeg" || type === "image/png")) {
        found = { ...found, bytes, type: type === "image/jpeg" ? "jpeg" : "png" };
        break;
      }
    }
    out.push(found);
  }
  return out;
}

/** The signed PDF of what `g` holds. */
async function signedPdf(v: Caller, files: FileStore, tr: Tr, g: Gathered, sheet: ItemSheet, madeAt: Date) {
  const key = await signingKey(v, files);
  const madeOn = tr.date(madeAt, { year: "numeric", month: "long", day: "numeric", timeZone: v.timeZone });
  const pdf = await sheetPdf(tr, sheet, await pdfPhotos(v, files, g), { currency: v.currency, madeOn, madeAt, fingerprint: key.fingerprint, publicKey: key.publicKey });
  return withSignature(pdf, await sshSign(v, files, pdf));
}

/** A thing's sheet as a PDF the server drew, signed with the household's key (lib/item-pdf.ts). */
export async function itemPdf(v: Caller, files: FileStore, itemId: string, parts: Set<ItemSheetPart>, publicUrl: string) {
  const tr = await trFor(v.deps, v.userId);
  const g = await gather(v, itemId, parts);
  const sheet = buildSheet(v, tr, g, publicUrl);
  return { filename: `${safeName(g.it.name, "item")}.pdf`, bytes: await signedPdf(v, files, tr, g, sheet, new Date()) };
}

const hex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");

/** The signed export: a ZIP, streamed (see the top of this file). */
export async function itemExport(v: Caller, files: FileStore, itemId: string, parts: Set<ItemSheetPart>, publicUrl: string) {
  const tr = await trFor(v.deps, v.userId);
  const g = await gather(v, itemId, parts);
  const sheet = buildSheet(v, tr, g, publicUrl);
  const madeAt = new Date();
  const madeOn = tr.date(madeAt, { year: "numeric", month: "long", day: "numeric", timeZone: v.timeZone });
  const uploads = [...g.photos, ...g.documents];
  const paths = filePaths(uploads);
  const folder = safeName(g.it.name, "item");
  const key = await signingKey(v, files);
  const text = new TextEncoder();
  const stream = zipStream(async (add) => {
    // Each file's hash as it goes in; SHA256SUMS and its signature come last.
    const sums: string[] = [];
    const put = async (path: string, data: Uint8Array, opts: { compress?: boolean; mtime?: Date } = {}) => {
      sums.push(`${hex(await crypto.subtle.digest("SHA-256", data as Uint8Array<ArrayBuffer>))}  ${path}`);
      await add(`${folder}/${path}`, data, opts);
    };
    await put(`${folder}.md`, text.encode(sheetMarkdown(tr, sheet, paths, madeOn)), { compress: true });
    await put(`${folder}.pdf`, await signedPdf(v, files, tr, g, sheet, madeAt));
    await put("item.json", text.encode(JSON.stringify(itemData(v, g, paths, madeAt), null, 2)), { compress: true });
    for (const f of uploads) {
      // An original removed to free space: its small copy instead.
      const bytes = await files.get(v.householdId, f.originalRemovedAt && f.thumbnailKey ? f.thumbnailKey : f.blobKey);
      if (bytes) await put(paths.get(f.id)!, bytes, { mtime: f.createdAt });
    }
    const manifest = text.encode(`${sums.join("\n")}\n`);
    await add(`${folder}/SHA256SUMS`, manifest, { compress: true });
    await add(`${folder}/SHA256SUMS.sig`, text.encode(await sshSign(v, files, manifest)), { compress: true });
    await add(`${folder}/allowed_signers`, text.encode(`${key.allowedSigners}\n`), { compress: true });
    await add(`${folder}/ferret-signing-key.pub`, text.encode(`${key.publicKey}\n`), { compress: true });
    await add(`${folder}/VERIFY.txt`, text.encode(verifyText(tr, key.fingerprint, key.namespace, madeOn)), { compress: true });
  });
  return { filename: `${folder}.zip`, stream };
}

function verifyText(tr: Tr, fingerprint: string, namespace: string, madeOn: string) {
  return [
    tr("This was exported from Ferret on {date} and signed with your household's key.", { date: madeOn }),
    "",
    tr("Key fingerprint: {fingerprint}", { fingerprint }),
    "",
    tr("Don't take this file's word for it: work the fingerprint out from the key itself,"),
    "",
    "  ssh-keygen -lf ferret-signing-key.pub",
    "",
    tr("and compare it with one you got another way — Settings → Household → Signing key in Ferret, or the bottom of a sheet printed earlier. If they match, the key here is your household's."),
    "",
    tr("To check that nothing has changed since, open a terminal in this folder and run:"),
    "",
    `  ssh-keygen -Y verify -f allowed_signers -I ferret -n ${namespace} -s SHA256SUMS.sig < SHA256SUMS`,
    "  shasum -a 256 -c SHA256SUMS",
    "",
    tr('The first says "Good signature"; the second says "OK" for every file.'),
    "",
  ].join("\n");
}
