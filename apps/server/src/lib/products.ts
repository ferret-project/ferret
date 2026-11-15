/**
 * Ferret's barcode books: what a barcode is.
 *
 * - Each household's own book (household_barcode) learns from items its people
 *   save with a barcode. Those are the household's words, so they stay in it.
 * - The shared book (barcode_product) holds only what the online product
 *   database (deps.products, e.g. UPCitemdb) said — public facts, asked once
 *   and kept for every household on this server. Books (an ISBN: EAN-13 978/979)
 *   are asked of Open Library instead (deps.books), when the server admin has
 *   switched book look-ups on — free, so not counted against a plan's lookups.
 *
 * A name the household saved wins. What the database says is only ever
 * offered; a person applies it.
 */
import { type BarcodeLookupStatus, type BarcodeMatch, type BookLookupStatus, type ItemProduct, uploadTypes } from "@ferret/shared";
import { and, count, eq, isNotNull } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { barcodeProduct, householdBarcode, item, serverSetting } from "../db/schema";
import { type Db, type Deps, DownloadError, type JobHandler, type ProductLookup } from "../ports";
import { addAttachment } from "./attachments";
import { allow, recordUsage } from "./plan";
import type { FileStore } from "./files";
import { type Caller, getItem, itemScope, notFound } from "./inventory";
import { sniffContentType } from "./sniff";
import { isPairingPayload } from "@ferret/shared/utils";

export const PRODUCT_JOB = "product.lookup";
/** A code the database didn't know is asked about again after this long. */
const RETRY_UNKNOWN_MS = 30 * 86_400_000;
/** What "Add from photos" calls a thing before anyone names it — not worth remembering. */
const PLACEHOLDER = "New item";

/** UPC/EAN as digits (8–14), a 12-digit UPC-A as its 13-digit EAN form, or null if it isn't one (or is a pairing code). */
export function productCode(raw: string | null | undefined) {
  // A HomeKit/Matter pairing QR holds digits too — it's a secret, never a product: not looked up, not remembered.
  if (raw && isPairingPayload(raw)) return null;
  const digits = (raw ?? "").replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 14) return null;
  return digits.length === 12 ? `0${digits}` : digits;
}

async function entry(db: Db, barcode: string) {
  const [row] = await db.select().from(barcodeProduct).where(eq(barcodeProduct.barcode, barcode));
  return row;
}

/**
 * Worth asking (this source): never asked, or it didn't know and that was a while ago — or the "didn't know" was
 * another source's (a book's ISBN asked of the product database before book look-ups were switched on).
 */
const worthAsking = (row: typeof barcodeProduct.$inferSelect | undefined, source?: Source | null) =>
  !row ||
  (!row.external && (!row.notFoundAt || Date.now() - row.notFoundAt.getTime() > RETRY_UNKNOWN_MS || (source != null && (row.source ?? "upcitemdb") !== source.name)));

/** What a barcode is: the household's own name for it if it has one, with the online database's photos and price. */
function toMatch(
  barcode: string,
  own: typeof householdBarcode.$inferSelect | undefined,
  shared: typeof barcodeProduct.$inferSelect | undefined,
): BarcodeMatch | null {
  const name = own?.name ?? shared?.name;
  if (!name) return null;
  return {
    barcode,
    name,
    brand: own ? own.brand : (shared?.brand ?? null),
    model: own ? own.model : (shared?.model ?? null),
    source: own ? "ferret" : (shared?.source ?? "upcitemdb"),
    images: shared?.external?.images ?? [],
    typicalPriceCents: shared?.external?.typicalPriceCents,
    category: shared?.external?.category,
  };
}

async function ownEntry(v: Pick<Caller, "db" | "householdId">, barcode: string) {
  const [row] = await v.db
    .select()
    .from(householdBarcode)
    .where(and(eq(householdBarcode.householdId, v.householdId), eq(householdBarcode.barcode, barcode)));
  return row;
}

// ── The online database's allowance (Settings → Server) ─────────────────────────────────────────────────────────

const QUOTA_KEY = "products.quota";

/** Keeps what the database last said about its allowance (a used-up one included: the lookup then throws). */
async function keepQuota(deps: Pick<Deps, "db" | "products">) {
  const q = deps.products?.quota?.();
  if (!q) return;
  const value = JSON.stringify({ limit: q.limit, remaining: q.remaining, resetsAt: q.resetsAt.toISOString(), checkedAt: new Date().toISOString() });
  await deps.db.insert(serverSetting).values({ key: QUOTA_KEY, value }).onConflictDoUpdate({ target: serverSetting.key, set: { value } });
}

/**
 * Whether online lookups are on, and what's left of the database's allowance as of the last lookup — counted as full
 * again once its reset time has passed. Null quota: nothing asked yet (or the database doesn't say).
 */
export async function barcodeLookupStatus(deps: Pick<Deps, "db" | "products">, now = new Date()): Promise<BarcodeLookupStatus> {
  if (!deps.products) return { on: false, quota: null };
  const [row] = await deps.db.select().from(serverSetting).where(eq(serverSetting.key, QUOTA_KEY));
  if (!row) return { on: true, quota: null };
  const q = JSON.parse(row.value) as NonNullable<BarcodeLookupStatus["quota"]>;
  return { on: true, quota: new Date(q.resetsAt) <= now ? { ...q, remaining: q.limit } : q };
}

// ── Books (Open Library, by ISBN) ─────────────────────────────────────────────────────────────────────────────

const BOOKS_KEY = "books.enabled";

/** An ISBN as a barcode: EAN-13 starting 978 or 979 ("Bookland"). */
export const isIsbn = (barcode: string) => /^97[89]\d{10}$/.test(barcode);

export async function booksEnabled(db: Db) {
  const [row] = await db.select().from(serverSetting).where(eq(serverSetting.key, BOOKS_KEY));
  return row?.value === "true";
}

export async function setBooksEnabled(db: Db, enabled: boolean) {
  await db.insert(serverSetting).values({ key: BOOKS_KEY, value: String(enabled) }).onConflictDoUpdate({ target: serverSetting.key, set: { value: String(enabled) } });
}

/** For Settings → Server. */
export async function bookLookupStatus(deps: Pick<Deps, "db" | "books">): Promise<BookLookupStatus> {
  const [kept] = await deps.db.select({ n: count() }).from(barcodeProduct).where(and(eq(barcodeProduct.source, "openlibrary"), isNotNull(barcodeProduct.external)));
  return { available: Boolean(deps.books), enabled: await booksEnabled(deps.db), books: kept?.n ?? 0 };
}

type Source = { lookup: ProductLookup; name: "upcitemdb" | "openlibrary"; counted: boolean };

/** Who to ask about a code: Open Library for an ISBN (books switched on), else the online product database, or nobody. */
async function sourceFor(deps: Pick<Deps, "db" | "products" | "books">, barcode: string): Promise<Source | null> {
  if (isIsbn(barcode) && deps.books && (await booksEnabled(deps.db))) return { lookup: deps.books, name: "openlibrary", counted: false };
  return deps.products ? { lookup: deps.products, name: "upcitemdb", counted: true } : null;
}

/** Ask the source about a code (and remember the answer, found or not). */
async function askDatabase(deps: Pick<Deps, "db" | "products">, barcode: string, source: Source) {
  let product;
  try {
    product = await source.lookup.lookup(barcode);
  } finally {
    if (source.name === "upcitemdb") await keepQuota(deps).catch(() => {});
  }
  if (!product) {
    await deps.db
      .insert(barcodeProduct)
      .values({ barcode, notFoundAt: new Date(), source: source.name })
      .onConflictDoUpdate({ target: barcodeProduct.barcode, set: { notFoundAt: new Date(), source: source.name } });
    return;
  }
  const fields = { name: product.title, brand: product.brand ?? null, model: product.model ?? null, source: source.name, external: product };
  await deps.db
    .insert(barcodeProduct)
    .values({ barcode, ...fields })
    .onConflictDoUpdate({ target: barcodeProduct.barcode, set: { ...fields, notFoundAt: null } });
}

/**
 * What a scanned barcode is, for this household: its own book, else the shared
 * one, else (if configured) asked of the online database now — the person is
 * waiting at the scanner, and it's one request with a timeout. Null when nobody knows.
 */
export async function lookupBarcode(v: Pick<Caller, "db" | "deps" | "householdId" | "userId">, raw: string): Promise<BarcodeMatch | null> {
  const barcode = productCode(raw);
  if (!barcode) return null;
  const deps = { db: v.db, products: v.deps.products };
  const own = await ownEntry(v, barcode);
  let row = await entry(deps.db, barcode);
  const source = await sourceFor({ ...deps, books: v.deps.books }, barcode);
  // A plan may limit the online lookups (lib/plan.ts; books are free); Ferret's own barcode book always answers.
  if (!own && !row?.name && source && worthAsking(row, source) && (!source.counted || (await allow(v, "barcode.lookup")).ok)) {
    try {
      if (source.counted) await recordUsage(v, "barcode.lookup");
      await askDatabase(deps, barcode, source);
    } catch (err) {
      console.warn(`Barcode lookup failed for ${barcode}: ${String(err)}`);
    }
    row = await entry(deps.db, barcode);
  }
  return toMatch(barcode, own, row);
}

/** Learn from an item someone saved: in this household, its barcode is that thing. */
export async function rememberBarcode(
  v: Pick<Caller, "db" | "householdId">,
  it: { barcode: string | null; name: string; brand: string | null; model: string | null },
) {
  const barcode = productCode(it.barcode);
  if (!barcode || !it.name.trim() || it.name === PLACEHOLDER) return;
  const fields = { name: it.name, brand: it.brand, model: it.model };
  await v.db
    .insert(householdBarcode)
    .values({ householdId: v.householdId, barcode, ...fields })
    .onConflictDoUpdate({ target: [householdBarcode.householdId, householdBarcode.barcode], set: fields });
}

/** Background job: ask the online database about a code (for an item page's photos and price). Retried on errors. */
export function productLookupJob(deps: Pick<Deps, "db" | "products" | "books">): JobHandler {
  return async (payload) => {
    const barcode = productCode((payload as { barcode?: string }).barcode);
    const source = barcode ? await sourceFor(deps, barcode) : null;
    if (barcode && source && worthAsking(await entry(deps.db, barcode), source)) await askDatabase(deps, barcode, source);
  };
}

/** After an item gets a barcode: ask the online database in the background, unless it's been asked. */
export async function queueProductLookup(v: Pick<Caller, "db" | "deps" | "householdId" | "userId">, raw: string | null | undefined) {
  const barcode = productCode(raw);
  if (!barcode || !v.deps.jobs) return;
  const source = await sourceFor({ db: v.db, products: v.deps.products, books: v.deps.books }, barcode);
  if (!source || !worthAsking(await entry(v.db, barcode), source)) return;
  if (source.counted) {
    if (!(await allow(v, "barcode.lookup")).ok) return;
    await recordUsage(v, "barcode.lookup");
  }
  await v.deps.jobs.enqueue(PRODUCT_JOB, { barcode });
}

/** The online database's details for an item's barcode, offered on its page. */
export async function itemProduct(v: Caller, itemId: string): Promise<ItemProduct> {
  const it = await getItem(v, itemId);
  const barcode = productCode(it.barcode);
  if (!barcode) return v.deps.products ? { status: "none" } : { status: "off" };
  const source = await sourceFor({ db: v.db, products: v.deps.products, books: v.deps.books }, barcode);
  if (!source) return { status: "off" };
  const row = await entry(v.db, barcode);
  if (row?.external) return { status: it.productDismissedFor === barcode ? "dismissed" : "found", product: row.external };
  if (worthAsking(row, source)) {
    await queueProductLookup(v, barcode); // e.g. a barcode saved before lookups were turned on
    return { status: "pending" };
  }
  return { status: "none" };
}

/** Hide an item's product suggestions (until its barcode changes). */
export async function dismissProduct(v: Caller, itemId: string) {
  const it = await getItem(v, itemId);
  await v.db.update(item).set({ productDismissedFor: productCode(it.barcode) }).where(and(eq(item.id, it.id), itemScope(v, { gone: "include" })));
}

/**
 * "Use this photo": download one of the product's images and attach it. The URL
 * comes from the stored lookup (the client only picks an index), must be https,
 * and goes through deps.downloader like "add from a web address" — public
 * internet only, photo types only, capped in size and time — since a third-party
 * database chose it. Inline rather than a job: one bounded request the person is waiting for.
 */
export async function useProductPhoto(v: Caller, files: FileStore, itemId: string, index: number) {
  const it = await getItem(v, itemId);
  const barcode = productCode(it.barcode);
  const product = barcode ? (await entry(v.db, barcode))?.external : undefined;
  const url = product?.images[index];
  if (!url) throw notFound("Product photo");
  if (!url.startsWith("https://")) throw new HTTPException(422, { message: "That photo isn't on a secure address" });
  if (!v.deps.downloader) throw new HTTPException(409, { message: "Downloading from the web isn't available on this server" });
  const got = await v.deps.downloader
    .get(url, {
      maxBytes: 8 * 1024 * 1024,
      contentTypes: uploadTypes.photo,
      accepts: (head) => uploadTypes.photo.includes(sniffContentType(head) ?? ""),
    })
    .catch((err: unknown) => {
      if (err instanceof DownloadError) throw new HTTPException(502, { message: `Couldn't fetch that photo — try another (${err.message})` });
      throw err;
    });
  return addAttachment(v, files, it.id, { bytes: got.bytes, filename: `${(product?.title ?? "product").slice(0, 60)}.jpg`, kind: "photo" });
}
