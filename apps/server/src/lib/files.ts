/**
 * Encrypted file storage for photos and documents.
 *
 * Each household has its own AES-256-GCM data key, stored in household_key
 * wrapped by the server master key (FILES_KEY). Files are encrypted before
 * they reach the Blobs port, so the folder on disk (or any other store) only ever
 * holds ciphertext. Deleting a household deletes its key, which makes its
 * files unreadable even in old backups. Web Crypto only.
 *
 * Stored blob format: [version = 1][12-byte IV][ciphertext + 16-byte GCM tag].
 * The blob key is bound in as additional data, so ciphertext can't be moved
 * onto another attachment's (or household's) key.
 */
import { eq } from "drizzle-orm";
import { householdKey } from "../db/schema";
import type { Blobs, Db } from "../ports";

const FORMAT_V1 = 1;
const IV_BYTES = 12;
const utf8 = new TextEncoder();

/** Web Crypto key type, without depending on DOM or Node typings. */
type Key = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

export class FileStore {
  private kek?: Promise<{ id: string; key: Key }>;
  private readonly keys = new Map<string, Promise<Key>>();

  constructor(
    private readonly db: Db,
    private readonly blobs: Blobs,
    /** FILES_KEY: 32 random bytes, base64. */
    private readonly filesKey: string,
  ) {}

  async put(householdId: string, blobKey: string, data: Uint8Array) {
    const key = await this.householdKey(householdId);
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const sealed = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: utf8.encode(blobKey) },
      key,
      data as Uint8Array<ArrayBuffer>,
    );
    await this.blobs.put(blobKey, concat(Uint8Array.of(FORMAT_V1), iv, new Uint8Array(sealed)), "application/octet-stream");
  }

  /** Returns the decrypted bytes, or null if the blob is missing. Throws if it was tampered with. */
  async get(householdId: string, blobKey: string): Promise<Uint8Array<ArrayBuffer> | null> {
    const blob = await this.blobs.get(blobKey);
    if (!blob) return null;
    const bytes = new Uint8Array(await new Response(blob.body).arrayBuffer());
    if (bytes[0] !== FORMAT_V1) throw new Error(`Unknown file format ${bytes[0]} for ${blobKey}`);
    const key = await this.householdKey(householdId);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.subarray(1, 1 + IV_BYTES), additionalData: utf8.encode(blobKey) },
      key,
      bytes.subarray(1 + IV_BYTES),
    );
    return new Uint8Array(plain);
  }

  delete(blobKey: string) {
    return this.blobs.delete(blobKey);
  }

  /**
   * A small secret (e.g. a calendar link's token) encrypted with the household's
   * key, as base64, for a database column. `label` is bound in like a blob key,
   * so a sealed value only opens in the place it was sealed for.
   */
  async seal(householdId: string, label: string, text: string) {
    const key = await this.householdKey(householdId);
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: utf8.encode(label) }, key, utf8.encode(text));
    const bytes = concat(Uint8Array.of(FORMAT_V1), iv, new Uint8Array(sealed));
    return btoa(String.fromCharCode(...bytes));
  }

  /** Opens what `seal` made; throws if it was tampered with or moved. */
  async open(householdId: string, label: string, sealed: string) {
    const bytes = Uint8Array.from(atob(sealed), (c) => c.charCodeAt(0));
    if (bytes[0] !== FORMAT_V1) throw new Error(`Unknown sealed format ${bytes[0]}`);
    const key = await this.householdKey(householdId);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.subarray(1, 1 + IV_BYTES), additionalData: utf8.encode(label) },
      key,
      bytes.subarray(1 + IV_BYTES),
    );
    return new TextDecoder().decode(plain);
  }

  private householdKey(householdId: string) {
    let key = this.keys.get(householdId);
    if (!key) {
      key = this.loadOrCreateKey(householdId);
      this.keys.set(householdId, key);
      key.catch(() => this.keys.delete(householdId)); // don't cache failures
    }
    return key;
  }

  private async loadOrCreateKey(householdId: string) {
    const kek = await this.masterKey();
    const aad = utf8.encode(householdId);
    let [row] = await this.db.select().from(householdKey).where(eq(householdKey.householdId, householdId));
    if (!row) {
      const raw = crypto.getRandomValues(new Uint8Array(32));
      const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
      const wrapped = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, kek.key, raw);
      raw.fill(0);
      // Two first uploads can race: whichever insert lands first wins, and both read it back.
      await this.db
        .insert(householdKey)
        .values({ householdId, kekId: kek.id, wrappedKey: toBase64(concat(iv, new Uint8Array(wrapped))) })
        .onConflictDoNothing();
      [row] = await this.db.select().from(householdKey).where(eq(householdKey.householdId, householdId));
    }
    if (!row) throw new Error(`Could not create a file key for household ${householdId}`);
    if (row.kekId !== kek.id) {
      throw new Error(`Household ${householdId} files were sealed with master key ${row.kekId}, but FILES_KEY is ${kek.id}`);
    }
    const sealed = fromBase64(row.wrappedKey);
    const raw = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: sealed.subarray(0, IV_BYTES), additionalData: aad },
        kek.key,
        sealed.subarray(IV_BYTES),
      ),
    );
    const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
    raw.fill(0);
    return key;
  }

  /** The master key plus a short, non-secret id for it (stored as kek_id, for future rotation). */
  private masterKey() {
    this.kek ??= (async () => {
      const raw = fromBase64(this.filesKey);
      const id = await masterKeyId(this.filesKey);
      const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
      raw.fill(0);
      return { id, key };
    })();
    return this.kek;
  }
}

/** A short, non-secret name for a FILES_KEY (household_key.kek_id), so a wrong key is told apart from damage. */
export async function masterKeyId(filesKey: string) {
  const digest = await crypto.subtle.digest("SHA-256", concat(utf8.encode("ferret-kek-id:"), fromBase64(filesKey)));
  return [...new Uint8Array(digest).subarray(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function concat(...parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function toBase64(bytes: Uint8Array) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromBase64(value: string) {
  return Uint8Array.from(atob(value), (ch) => ch.charCodeAt(0));
}
