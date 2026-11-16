/**
 * Paperless-ngx as a source (help: guide/paperless). A household connects its Paperless (address + an API token,
 * owners/admins with a real sign-in); documents there with the watched tag (`ferret` by default) come to Ferret's
 * **Paperless inbox**, where someone adds each as a new thing, attaches it to one, or dismisses it. A thing's page can
 * also attach any document found by a search of Paperless.
 *
 * - Ferret only reads Paperless: it never changes, tags or deletes anything there. What was done with each document is
 *   remembered here (`paperless_document`), so a document stays sorted even though it keeps its tag.
 * - Attaching copies the file in (a PDF or picture — Paperless's archived PDF when it made one), so it's read like any
 *   upload (suggestions on the thing) and kept in Ferret's backups — unless the household chose links only. Either
 *   way the thing gets a link back to the document in Paperless.
 * - The token is sealed with the household key and never shown again. The address may be on the server's own network
 *   only when whoever runs this Ferret (the server admin) set it up, as with webhooks.
 * - Synced by a job (`PAPERLESS_SYNC_JOB`, every 10 minutes for each connected household). Its failures are the
 *   household's Paperless (not an outside service of the server's), so they go on the connection — Settings shows the
 *   last error, the bell says so after a day — rather than the service error log.
 */
import {
  type PaperlessAddInput,
  type PaperlessConnection,
  type PaperlessDocument,
  type PaperlessDocumentStatus,
  type PaperlessInput,
  itemInput,
} from "@ferret/shared";
import { and, desc, eq, isNull } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { attachment, item, paperlessConnection, paperlessDocument } from "../db/schema";
import { type Deps, type JobHandler, type PaperlessDoc, PaperlessError, type PaperlessServer } from "../ports";
import { addAttachment } from "./attachments";
import type { FileStore } from "./files";
import { fullTextSearch } from "./fulltext";
import { type Caller, createItem, itemScope, logActivity, notFound, updateItem } from "./inventory";
import { localHostName } from "./notifications";
import { isServerAdmin } from "./server-admin";
import { inList } from "./sql";

export const PAPERLESS_SYNC_JOB = "paperless.sync";

/** How many of the newest tagged documents a sync looks at (a first sync of a big archive takes the newest). */
const SYNC_PAGES = 4;
const PAGE_SIZE = 50;
const EXCERPT = 400;
/** Syncing failing this long without a success → the bell. */
export const FAILING_MS = 24 * 60 * 60 * 1000;

type Row = typeof paperlessConnection.$inferSelect;
type DocRow = typeof paperlessDocument.$inferSelect;
type Manager = Caller & { files: FileStore };

const tokenLabel = (householdId: string) => `paperless:${householdId}:token`;
const cleanUrl = (url: string) => url.trim().replace(/\/+$/, "");
export const documentUrl = (base: string, id: number) => `${cleanUrl(base)}/documents/${id}/details`;

function available(deps: Deps) {
  if (!deps.paperless) throw new HTTPException(409, { message: "This server can't connect to Paperless" });
  return deps.paperless;
}

/** Paperless's own words when it refused, as a 400 a person can act on. */
const refused = (err: unknown) => (err instanceof PaperlessError ? new HTTPException(400, { message: err.message }) : err);

async function connectionRow(v: Pick<Caller, "db" | "householdId">) {
  const [row] = await v.db.select().from(paperlessConnection).where(eq(paperlessConnection.householdId, v.householdId));
  return row ?? null;
}

async function serverOf(files: FileStore, row: Row): Promise<PaperlessServer> {
  return { url: row.url, token: await files.open(row.householdId, tokenLabel(row.householdId), row.tokenSealed), allowLocal: row.allowLocal };
}

function summary(row: Row): PaperlessConnection {
  return {
    url: row.url,
    host: new URL(row.url).host,
    tag: row.tag,
    copyFiles: row.copyFiles,
    user: row.remoteUser,
    lastSyncAt: row.lastSyncAt?.toISOString() ?? null,
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function getConnection(v: Caller) {
  const row = await connectionRow(v);
  return row ? summary(row) : null;
}

/**
 * Connects (or changes) the household's Paperless: checks the token and the tag there first, so a mistake is said now
 * rather than at the first sync. Then syncs.
 */
export async function connectPaperless(v: Manager, input: PaperlessInput) {
  const paperless = available(v.deps);
  const url = cleanUrl(input.url);
  const existing = await connectionRow(v);
  const token = input.token ?? (existing ? (await serverOf(v.files, existing)).token : undefined);
  if (!token) throw new HTTPException(400, { message: "Paste Paperless's API token (Paperless → My profile → API auth token)" });
  const admin = await isServerAdmin(v.db, v.userId);
  if (!admin && localHostName(new URL(url).host)) {
    throw new HTTPException(403, { message: "Only whoever runs this Ferret can connect it to an address on its own network" });
  }
  const server = { url, token, allowLocal: admin };
  let who: { user: string };
  let tag: { id: number; name: string } | null;
  try {
    who = await paperless.whoAmI(server);
    tag = await paperless.findTag(server, input.tag);
  } catch (err) {
    throw refused(err);
  }
  if (!tag) throw new HTTPException(400, { message: `Paperless has no tag called "${input.tag}" — make it in Paperless first, or name another` });
  const values = {
    url,
    tokenSealed: await v.files.seal(v.householdId, tokenLabel(v.householdId), token),
    tag: tag.name,
    tagId: tag.id,
    copyFiles: input.copyFiles,
    allowLocal: admin,
    remoteUser: who.user,
    lastError: null,
    failingSince: null,
  };
  await v.db
    .insert(paperlessConnection)
    .values({ householdId: v.householdId, ...values, createdBy: v.userId })
    .onConflictDoUpdate({ target: paperlessConnection.householdId, set: values });
  await logActivity(v, "paperless.connect", v.householdId, `Connected Paperless at ${new URL(url).host}`);
  await v.deps.jobs?.enqueue(PAPERLESS_SYNC_JOB, { householdId: v.householdId });
  return summary((await connectionRow(v))!);
}

/** Disconnects: the token is dropped, and what Ferret remembered about the documents. Copied files stay on their things. */
export async function disconnectPaperless(v: Caller) {
  const row = await connectionRow(v);
  if (!row) throw notFound("Paperless connection");
  await v.db.delete(paperlessDocument).where(eq(paperlessDocument.householdId, v.householdId));
  await v.db.delete(paperlessConnection).where(eq(paperlessConnection.householdId, v.householdId));
  await logActivity(v, "paperless.disconnect", v.householdId, "Disconnected Paperless");
}

/** What's kept about a document Paperless listed. */
function docValues(d: PaperlessDoc, names: Map<number, string>) {
  return {
    title: d.title.slice(0, 300),
    correspondent: d.correspondent !== null ? (names.get(d.correspondent) ?? null) : null,
    created: d.created,
    excerpt: d.content.replace(/\s+/g, " ").trim().slice(0, EXCERPT),
    mimeType: d.mimeType,
  };
}

/** One household's sync: the newest documents with the tag that Ferret hasn't seen go into the inbox. */
export async function syncPaperless(deps: Pick<Deps, "db" | "paperless">, files: FileStore, householdId: string, now = new Date()) {
  if (!deps.paperless) return { added: 0 };
  const [row] = await deps.db.select().from(paperlessConnection).where(eq(paperlessConnection.householdId, householdId));
  if (!row) return { added: 0 };
  let added = 0;
  try {
    const server = await serverOf(files, row);
    // Found by name each time: renamed or remade in Paperless, it's still the one the household named.
    const tag = await deps.paperless.findTag(server, row.tag);
    if (!tag) throw new PaperlessError(`Paperless has no tag called "${row.tag}" any more — make it again, or name another in Settings`);
    for (let page = 1; page <= SYNC_PAGES; page++) {
      const listed = await deps.paperless.documents(server, { tagId: tag.id, page, pageSize: PAGE_SIZE });
      if (!listed.results.length) break;
      const known = new Set(
        (
          await deps.db
            .select({ paperlessId: paperlessDocument.paperlessId })
            .from(paperlessDocument)
            .where(and(eq(paperlessDocument.householdId, householdId), inList(paperlessDocument.paperlessId, listed.results.map((d) => d.id))))
        ).map((r) => r.paperlessId),
      );
      const fresh = listed.results.filter((d) => !known.has(d.id));
      if (fresh.length) {
        const names = await deps.paperless.correspondents(server, [...new Set(fresh.flatMap((d) => (d.correspondent !== null ? [d.correspondent] : [])))]);
        for (const d of fresh) {
          const made = await deps.db
            .insert(paperlessDocument)
            .values({ householdId, paperlessId: d.id, ...docValues(d, names) })
            .onConflictDoNothing()
            .returning({ id: paperlessDocument.id });
          added += made.length;
        }
      }
      // Newest first: a page with nothing new means the rest was seen before.
      if (!fresh.length || !listed.more) break;
    }
    await deps.db.update(paperlessConnection).set({ tagId: tag.id, lastSyncAt: now, lastError: null, failingSince: null }).where(eq(paperlessConnection.householdId, householdId));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await deps.db
      .update(paperlessConnection)
      .set({ lastError: message.slice(0, 300), failingSince: row.failingSince ?? now })
      .where(eq(paperlessConnection.householdId, householdId));
    if (!(err instanceof PaperlessError)) throw err;
  }
  return { added };
}

export function paperlessSyncJob(deps: Deps, files: FileStore): JobHandler {
  return async (payload) => {
    const householdId = (payload as { householdId?: string }).householdId;
    if (householdId) await syncPaperless(deps, files, householdId);
  };
}

/** Every connected household, for the 10-minute timer. */
export async function connectedHouseholds(db: Deps["db"]) {
  return (await db.select({ householdId: paperlessConnection.householdId }).from(paperlessConnection)).map((r) => r.householdId);
}

/** Ferret can keep a copy of it: Paperless gives a PDF (its archive) or the picture; plain text it can only link. */
const copyable = (mimeType: string | null) => !mimeType?.startsWith("text/");

/** Words in documents' titles that say what kind of paper it is, not what it's about. */
const PAPER_WORDS = new Set(
  "receipt receipts invoice invoices order orders confirmation manual manuals guide instructions instruction owner owners user users quick start warranty card registration statement bill letter scan document pdf copy the for and of a an your my".split(" "),
);

/** A thing whose words match the document's title, for a document not yet sorted: all its words, else the first that does. */
async function matchFor(v: Caller, d: Pick<DocRow, "title" | "correspondent">) {
  const words = (d.title.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length >= 3 && !PAPER_WORDS.has(w) && !/^\d{1,4}$/.test(w));
  if (!words.length) return null;
  const search = (q: string) => fullTextSearch(v.db, v.householdId, q, 1, { documents: false }).catch(() => []);
  let hit = (await search(words.join(" ")))[0];
  for (const w of words) {
    if (hit) break;
    if (w.length >= 4) hit = (await search(w))[0];
  }
  if (!hit) return null;
  const [found] = await v.db.select({ id: item.id, name: item.name }).from(item).where(and(eq(item.id, hit.itemId), itemScope(v)));
  return found ?? null;
}

async function shown(v: Caller, base: string, rows: DocRow[], withMatches: boolean): Promise<PaperlessDocument[]> {
  const itemIds = [...new Set(rows.flatMap((r) => (r.itemId ? [r.itemId] : [])))];
  const items = itemIds.length
    ? new Map((await v.db.select({ id: item.id, name: item.name }).from(item).where(and(eq(item.householdId, v.householdId), isNull(item.deletedAt), inList(item.id, itemIds)))).map((i) => [i.id, i]))
    : new Map<string, { id: string; name: string }>();
  return Promise.all(
    rows.map(async (r) => ({
      id: r.paperlessId,
      title: r.title,
      correspondent: r.correspondent,
      created: r.created,
      excerpt: r.excerpt,
      url: documentUrl(base, r.paperlessId),
      status: r.status,
      item: r.itemId ? (items.get(r.itemId) ?? null) : null,
      match: withMatches && r.status === "new" ? await matchFor(v, r) : null,
      copyable: copyable(r.mimeType),
    })),
  );
}

/** The inbox (status "new"), or what was done before (the rest), newest first. */
export async function listPaperlessDocuments(v: Caller, status: PaperlessDocumentStatus | "done" = "new") {
  const row = await connectionRow(v);
  if (!row) return { connected: false, data: [] as PaperlessDocument[] };
  const where =
    status === "done"
      ? and(eq(paperlessDocument.householdId, v.householdId), inList(paperlessDocument.status, ["added", "attached", "dismissed"]))
      : and(eq(paperlessDocument.householdId, v.householdId), eq(paperlessDocument.status, status));
  const rows = await v.db.select().from(paperlessDocument).where(where).orderBy(desc(paperlessDocument.createdAt), desc(paperlessDocument.paperlessId)).limit(100);
  return { connected: true, data: await shown(v, row.url, rows, status === "new") };
}

/** How many documents wait in the inbox (the bell, the dashboard). */
export async function inboxCount(v: Pick<Caller, "db" | "householdId">) {
  const rows = await v.db
    .select({ id: paperlessDocument.id })
    .from(paperlessDocument)
    .innerJoin(paperlessConnection, eq(paperlessConnection.householdId, paperlessDocument.householdId))
    .where(and(eq(paperlessDocument.householdId, v.householdId), eq(paperlessDocument.status, "new")));
  return rows.length;
}

/** The connection's trouble for the bell: syncing has failed for a day. */
export async function syncTrouble(v: Pick<Caller, "db" | "householdId">, now = Date.now()) {
  const row = await connectionRow(v);
  return row?.failingSince && now - row.failingSince.getTime() >= FAILING_MS ? { error: row.lastError ?? "Paperless couldn't be reached", since: row.failingSince } : null;
}

/** Paperless's full-text search, for "Attach from Paperless" on a thing: documents whatever their tags. */
export async function searchPaperless(v: Manager, query: string) {
  const paperless = available(v.deps);
  const row = await connectionRow(v);
  if (!row) throw new HTTPException(409, { message: "Connect Paperless first (Settings → Household)" });
  const server = await serverOf(v.files, row);
  let listed;
  try {
    listed = await paperless.documents(server, { query: query.trim(), pageSize: 20 });
  } catch (err) {
    throw refused(err);
  }
  const names = await paperless.correspondents(server, [...new Set(listed.results.flatMap((d) => (d.correspondent !== null ? [d.correspondent] : [])))]).catch(() => new Map<number, string>());
  const known = listed.results.length
    ? new Map(
        (
          await v.db
            .select()
            .from(paperlessDocument)
            .where(and(eq(paperlessDocument.householdId, v.householdId), inList(paperlessDocument.paperlessId, listed.results.map((d) => d.id))))
        ).map((r) => [r.paperlessId, r]),
      )
    : new Map<number, DocRow>();
  const rows: DocRow[] = listed.results.map(
    (d) =>
      known.get(d.id) ?? {
        id: "",
        householdId: v.householdId,
        paperlessId: d.id,
        ...docValues(d, names),
        status: "new",
        itemId: null,
        attachmentId: null,
        handledBy: null,
        handledAt: null,
        createdAt: new Date(),
      },
  );
  return shown(v, row.url, rows, false);
}

/** The document's row, made when it's attached straight from a search (it never had the tag). */
async function documentRow(v: Manager, server: PaperlessServer, paperlessId: number) {
  const [row] = await v.db.select().from(paperlessDocument).where(and(eq(paperlessDocument.householdId, v.householdId), eq(paperlessDocument.paperlessId, paperlessId)));
  if (row) return row;
  // Not seen before: look it up in Paperless (by its number — the household's own Paperless decides if it exists).
  const paperless = available(v.deps);
  let found: PaperlessDoc | undefined;
  try {
    found = (await paperless.documents(server, { query: `id:${paperlessId}`, pageSize: 5 })).results.find((d) => d.id === paperlessId);
  } catch (err) {
    throw refused(err);
  }
  if (!found) throw notFound("Document");
  const names = await paperless.correspondents(server, found.correspondent !== null ? [found.correspondent] : []).catch(() => new Map<number, string>());
  const [made] = await v.db
    .insert(paperlessDocument)
    .values({ householdId: v.householdId, paperlessId, ...docValues(found, names) })
    .onConflictDoNothing()
    .returning();
  return made ?? (await v.db.select().from(paperlessDocument).where(and(eq(paperlessDocument.householdId, v.householdId), eq(paperlessDocument.paperlessId, paperlessId))))[0]!;
}

async function setup(v: Manager) {
  available(v.deps);
  const row = await connectionRow(v);
  if (!row) throw new HTTPException(409, { message: "Connect Paperless first (Settings → Household)" });
  return { row, server: await serverOf(v.files, row) };
}

/**
 * Puts the document on a thing: its file copied in (when the household keeps copies and Paperless gives a PDF or a
 * picture) and a link back to it in Paperless. Returns whether the file was copied, and why not.
 */
async function putOnItem(v: Manager, conn: Row, server: PaperlessServer, doc: DocRow, itemId: string, maxBytes: number) {
  const [target] = await v.db.select({ id: item.id, name: item.name, links: item.links }).from(item).where(and(eq(item.id, itemId), itemScope(v, { gone: "include" })));
  if (!target) throw notFound("Item");
  let attachmentId: string | null = null;
  let note: string | null = null;
  if (conn.copyFiles && copyable(doc.mimeType)) {
    try {
      const file = await available(v.deps).download(server, doc.paperlessId, maxBytes);
      const name = file.filename || `${doc.title}.pdf`;
      const added = await addAttachment(v, v.files, { itemId }, { bytes: file.bytes, filename: name, kind: "document" });
      attachmentId = added.id;
    } catch (err) {
      // Too big, a type Ferret doesn't keep, Paperless gone for a moment: the link still goes on, and it says why.
      if (err instanceof HTTPException && (err.status === 402 || err.status === 503)) throw err; // a plan's room, the demo's pause
      note = err instanceof HTTPException && err.status === 415 ? "Ferret can't keep a copy of that kind of file — linked instead" : `Couldn't copy the file (${err instanceof Error ? err.message : String(err)}) — linked instead`;
    }
  } else if (conn.copyFiles) {
    note = "Paperless only has its text — linked instead";
  }
  const url = documentUrl(conn.url, doc.paperlessId);
  const links = target.links ?? [];
  if (!links.some((l) => l.url === url)) {
    await updateItem(v, itemId, { links: [...links, { url, label: `Paperless: ${doc.title}`.slice(0, 80) }] }, (name) => `Linked ${name} to a Paperless document`);
  }
  return { attachmentId, note, item: { id: target.id, name: target.name } };
}

async function handled(v: Caller, doc: DocRow, status: PaperlessDocumentStatus, itemId: string | null, attachmentId: string | null) {
  await v.db
    .update(paperlessDocument)
    .set({ status, itemId, attachmentId, handledBy: v.userId, handledAt: new Date() })
    .where(and(eq(paperlessDocument.id, doc.id), eq(paperlessDocument.householdId, v.householdId)));
}

/** Attaches the document (from the inbox or a search) to one of the household's things. */
export async function attachPaperless(v: Manager, paperlessId: number, itemId: string, maxBytes: number) {
  const { row, server } = await setup(v);
  const doc = await documentRow(v, server, paperlessId);
  const put = await putOnItem(v, row, server, doc, itemId, maxBytes);
  await handled(v, doc, "attached", itemId, put.attachmentId);
  await logActivity(v, "paperless.attach", itemId, `Attached "${doc.title}" from Paperless to ${put.item.name}`, itemId);
  return { item: put.item, copied: Boolean(put.attachmentId), note: put.note };
}

/** Makes a new thing from the document — named after it unless a name is given — with the document on it. */
export async function addFromPaperless(v: Manager, paperlessId: number, input: PaperlessAddInput, maxBytes: number) {
  const { row, server } = await setup(v);
  const doc = await documentRow(v, server, paperlessId);
  if (doc.status === "added" && doc.itemId) throw new HTTPException(409, { message: "A thing was already made from that document" });
  // The schema takes only the app's own origins from clients; this one is the server's to set.
  const fields = itemInput.parse({ name: (input.name ?? doc.title).slice(0, 200), locationId: input.locationId ?? null });
  const made = await createItem(v, { ...fields, origin: "paperless" as unknown as typeof fields.origin });
  await v.db.update(item).set({ originDetail: doc.title.slice(0, 200) }).where(eq(item.id, made.id));
  const put = await putOnItem(v, row, server, doc, made.id, maxBytes);
  await handled(v, doc, "added", made.id, put.attachmentId);
  return { item: put.item, copied: Boolean(put.attachmentId), note: put.note };
}

/** Out of the inbox without doing anything — or back into it (`undo`). */
export async function dismissPaperless(v: Caller, paperlessId: number, undo = false) {
  const [doc] = await v.db.select().from(paperlessDocument).where(and(eq(paperlessDocument.householdId, v.householdId), eq(paperlessDocument.paperlessId, paperlessId)));
  if (!doc) throw notFound("Document");
  if (undo) {
    if (doc.status !== "dismissed") throw new HTTPException(409, { message: "Only a dismissed document goes back to the inbox" });
    await handled(v, doc, "new", null, null);
  } else {
    if (doc.status !== "new") throw new HTTPException(409, { message: "That document was already sorted" });
    await handled(v, doc, "dismissed", null, null);
  }
}

/** Paperless's picture of a document — only one Ferret knows about (in the inbox, or attached), or one a search found. */
export async function paperlessThumbnail(v: Manager, paperlessId: number) {
  const { server } = await setup(v);
  try {
    return await available(v.deps).thumbnail(server, paperlessId);
  } catch (err) {
    if (err instanceof PaperlessError && err.status === 404) throw notFound("Document");
    throw refused(err);
  }
}

/** The Paperless document a file on a thing was copied from (its page links there too). */
export async function attachmentSource(v: Caller, attachmentId: string) {
  const [row] = await v.db
    .select({ paperlessId: paperlessDocument.paperlessId, url: paperlessConnection.url })
    .from(paperlessDocument)
    .innerJoin(paperlessConnection, eq(paperlessConnection.householdId, paperlessDocument.householdId))
    .innerJoin(attachment, eq(attachment.id, paperlessDocument.attachmentId))
    .where(and(eq(paperlessDocument.householdId, v.householdId), eq(paperlessDocument.attachmentId, attachmentId)));
  return row ? documentUrl(row.url, row.paperlessId) : null;
}
