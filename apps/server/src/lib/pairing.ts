/**
 * Smart-home pairing codes on items — HomeKit (X-HM://…, 123-45-678) and Matter (MT:…, 3497-011-2332), decoded by
 * @ferret/shared's parsePairing. The code is what lets someone pair with a reset accessory, so it's sealed with the
 * household key, never sent to the barcode lookup, shown only on request (and that's logged), and never to viewers or
 * API keys (routes/pairing.ts).
 */
import type { PairingCodeRevealed, PairingCodeSummary, PairingInput } from "@ferret/shared";
import { parsePairing } from "@ferret/shared/utils";
import { and, asc, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { item, pairingCode } from "../db/schema";
import type { FileStore } from "./files";
import { type Caller, itemScope, logActivity, notFound } from "./inventory";

const sealLabel = (id: string) => `pairing:${id}`;
const KIND_NAME = { homekit: "HomeKit", matter: "Matter" } as const;

interface Sealed {
  code: string;
  payload: string | null;
  details: Record<string, string | number>;
}

const summary = (r: typeof pairingCode.$inferSelect): PairingCodeSummary => ({
  id: r.id,
  kind: r.kind,
  label: r.label,
  category: r.category,
  hasQr: r.hasQr,
  addedAt: r.createdAt.toISOString(),
});

async function itemOf(v: Caller, itemId: string) {
  const [row] = await v.db.select({ id: item.id, name: item.name }).from(item).where(and(eq(item.id, itemId), itemScope(v, { gone: "include" })));
  if (!row) throw notFound("Item");
  return row;
}

/** Every code in the household, opened — few enough to compare in memory (the codes can't be looked up sealed). */
async function openAll(v: Caller, files: FileStore) {
  const rows = await v.db.select().from(pairingCode).where(eq(pairingCode.householdId, v.householdId));
  return Promise.all(rows.map(async (r) => ({ row: r, secret: JSON.parse(await files.open(v.householdId, sealLabel(r.id), r.sealed)) as Sealed })));
}

const sameCode = (a: Sealed, b: { code: string; payload: string | null }) => (a.payload && b.payload ? a.payload === b.payload : a.code === b.code);

export async function listPairing(v: Caller, itemId: string): Promise<PairingCodeSummary[]> {
  await itemOf(v, itemId);
  const rows = await v.db
    .select()
    .from(pairingCode)
    .where(and(eq(pairingCode.householdId, v.householdId), eq(pairingCode.itemId, itemId)))
    .orderBy(asc(pairingCode.createdAt));
  return rows.map(summary);
}

export async function addPairing(v: Caller, files: FileStore, itemId: string, input: PairingInput): Promise<PairingCodeSummary> {
  const target = await itemOf(v, itemId);
  const info = parsePairing(input.code);
  if (!info) throw new HTTPException(422, { message: "That isn't a HomeKit or Matter code — scan its QR code, or type the code as printed" });
  for (const { row, secret } of await openAll(v, files)) {
    if (!sameCode(secret, info)) continue;
    if (row.itemId === itemId) throw new HTTPException(409, { message: "That code is already saved here" });
    const [other] = await v.db.select({ name: item.name }).from(item).where(eq(item.id, row.itemId));
    throw new HTTPException(409, { message: `That code is already saved on ${other?.name ?? "another item"}` });
  }
  const id = crypto.randomUUID();
  const sealed = await files.seal(v.householdId, sealLabel(id), JSON.stringify({ code: info.code, payload: info.payload, details: info.details } satisfies Sealed));
  const [row] = await v.db
    .insert(pairingCode)
    .values({ id, householdId: v.householdId, itemId, kind: info.kind, label: input.label || null, category: info.category, hasQr: info.payload !== null, sealed, createdBy: v.userId })
    .returning();
  await logActivity(v, "item.pairing", itemId, `Saved a ${KIND_NAME[info.kind]} code for ${target.name}`);
  return summary(row!);
}

/** The code itself — logged, so the household can see who looked. */
export async function revealPairing(v: Caller, files: FileStore, itemId: string, pairingId: string): Promise<PairingCodeRevealed> {
  const target = await itemOf(v, itemId);
  const [row] = await v.db
    .select()
    .from(pairingCode)
    .where(and(eq(pairingCode.id, pairingId), eq(pairingCode.itemId, itemId), eq(pairingCode.householdId, v.householdId)));
  if (!row) throw notFound("Pairing code");
  const secret = JSON.parse(await files.open(v.householdId, sealLabel(row.id), row.sealed)) as Sealed;
  await logActivity(v, "item.pairing", itemId, `Showed the ${KIND_NAME[row.kind]} code for ${target.name}`);
  return secret;
}

export async function deletePairing(v: Caller, itemId: string, pairingId: string) {
  const target = await itemOf(v, itemId);
  const gone = await v.db
    .delete(pairingCode)
    .where(and(eq(pairingCode.id, pairingId), eq(pairingCode.itemId, itemId), eq(pairingCode.householdId, v.householdId)))
    .returning({ kind: pairingCode.kind });
  if (!gone.length) throw notFound("Pairing code");
  await logActivity(v, "item.pairing", itemId, `Removed a ${KIND_NAME[gone[0]!.kind]} code from ${target.name}`);
}

/** A scanned pairing QR: the item it's saved on (if it still exists), and what it is. Null if it isn't a pairing code. */
export async function findPairing(v: Caller, files: FileStore, raw: string) {
  const info = parsePairing(raw);
  if (!info) return null;
  const match = (await openAll(v, files)).find(({ secret }) => sameCode(secret, info));
  if (match) {
    const [owner] = await v.db.select().from(item).where(and(eq(item.id, match.row.itemId), itemScope(v, { gone: "include" })));
    if (owner) return { info, item: owner };
  }
  return { info, item: null };
}

/** For Download everything: every code, opened, by item. */
export async function pairingByItem(v: Caller, files: FileStore) {
  const out = new Map<string, { kind: string; label: string | null; category: string | null; code: string; qr: string | null }[]>();
  for (const { row, secret } of await openAll(v, files)) {
    const list = out.get(row.itemId) ?? [];
    list.push({ kind: KIND_NAME[row.kind], label: row.label, category: row.category, code: secret.code, qr: secret.payload });
    out.set(row.itemId, list);
  }
  return out;
}
