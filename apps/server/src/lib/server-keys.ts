/**
 * Outside services' keys the server admin pastes in Settings → Server (the collector catalogs, Google Books): kept in
 * `server_setting` under their name, sealed with a key made from FILES_KEY (HKDF), so backups keep them and nothing
 * sends them back out — Settings shows only their last four characters.
 */
import { eq, like } from "drizzle-orm";
import { serverSetting } from "../db/schema";
import type { Db } from "../ports";

const utf8 = new TextEncoder();
const IV_BYTES = 12;
type Saved = { sealed: string; hint: string };

async function sealingKey(filesKey: string) {
  const raw = Uint8Array.from(atob(filesKey), (c) => c.charCodeAt(0));
  const base = await crypto.subtle.importKey("raw", raw, "HKDF", false, ["deriveKey"]);
  raw.fill(0);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: utf8.encode("ferret-catalog-keys-v1") }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

const toBase64 = (bytes: Uint8Array) => btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""));
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

async function seal(filesKey: string, name: string, secret: string) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: utf8.encode(name) }, await sealingKey(filesKey), utf8.encode(secret));
  const out = new Uint8Array(IV_BYTES + sealed.byteLength);
  out.set(iv);
  out.set(new Uint8Array(sealed), IV_BYTES);
  return toBase64(out);
}

async function unseal(filesKey: string, name: string, sealed: string) {
  const bytes = fromBase64(sealed);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.subarray(0, IV_BYTES), additionalData: utf8.encode(name) }, await sealingKey(filesKey), bytes.subarray(IV_BYTES));
  return new TextDecoder().decode(plain);
}

/** The saved keys whose names match (`%` as a wildcard): name → its hint ("…b7e2"). Nothing is opened. */
export async function savedKeyHints(db: Db, pattern: string): Promise<Map<string, string>> {
  const rows = await db.select().from(serverSetting).where(like(serverSetting.key, pattern));
  return new Map(rows.map((r) => [r.key, (JSON.parse(r.value) as Saved).hint]));
}

/** A saved key, opened. Null without one. */
export async function serverKey(db: Db, filesKey: string, name: string): Promise<string | null> {
  const [row] = await db.select().from(serverSetting).where(eq(serverSetting.key, name));
  return row ? unseal(filesKey, name, (JSON.parse(row.value) as Saved).sealed) : null;
}

/** Save a key sealed (checking it is the caller's job), or remove it with null. */
export async function saveServerKey(db: Db, filesKey: string, name: string, key: string | null) {
  if (key == null) {
    await db.delete(serverSetting).where(eq(serverSetting.key, name));
    return;
  }
  const value = JSON.stringify({ sealed: await seal(filesKey, name, key), hint: `…${key.slice(-4)}` } satisfies Saved);
  await db.insert(serverSetting).values({ key: name, value }).onConflictDoUpdate({ target: serverSetting.key, set: { value } });
}
