/**
 * Each household's signing key, for exports anyone can check (a thing's Markdown export, lib/item-sheet.ts).
 *
 * An Ed25519 key, made the first time it's needed: the private key (PKCS #8) is sealed with the household key in
 * `household_setting`, so it never leaves the server, and backups (the whole database) carry it — a restored server
 * signs with the same key, and old exports still check out. The public key is shown in Settings → Household.
 *
 * Signatures are OpenSSH's (SSHSIG, PROTOCOL.sshsig), so `ssh-keygen -Y verify` — on every Mac and Linux machine —
 * checks them with no Ferret in the way:
 *
 *   ssh-keygen -Y verify -f allowed_signers -I ferret -n ferret-export -s SHA256SUMS.sig < SHA256SUMS
 *   shasum -a 256 -c SHA256SUMS
 *
 * Web-standard crypto only (Ed25519 in WebCrypto), so it runs wherever Ferret does.
 */
import type { SigningKey } from "@ferret/shared";
import { and, eq, isNull } from "drizzle-orm";
import { householdSetting, serverSetting } from "../db/schema";
import type { Db } from "../ports";
import type { FileStore } from "./files";
import type { Caller } from "./inventory";

/** What exports are signed for (ssh-keygen -n): a signature made for one purpose can't pass as another's. */
export const EXPORT_NAMESPACE = "ferret-export";
/** What backups' manifests are signed for (the server's key, lib/backup.ts). */
export const BACKUP_NAMESPACE = "ferret-backup";
/** The name in allowed_signers (ssh-keygen -I). */
const PRINCIPAL = "ferret";
const SEAL_LABEL = "signing-key";

const utf8 = new TextEncoder();
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromB64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

function concat(...parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
/** SSH's `string`: a 4-byte big-endian length, then the bytes. */
function sshString(data: Uint8Array | string) {
  const bytes = typeof data === "string" ? utf8.encode(data) : data;
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, bytes.length);
  return concat(len, bytes);
}
/** The public key as SSH writes it (string "ssh-ed25519", string key). */
const publicBlob = (raw: Uint8Array) => concat(sshString("ssh-ed25519"), sshString(raw));

/** The household's key pair, made (and sealed away) the first time. */
async function keyPair(v: Caller, files: FileStore): Promise<{ privateKey: CryptoKey; publicRaw: Uint8Array }> {
  const read = async () => {
    const [row] = await v.db
      .select({ sealed: householdSetting.signingKeySealed, pub: householdSetting.signingPublicKey })
      .from(householdSetting)
      .where(eq(householdSetting.householdId, v.householdId));
    return row?.sealed && row.pub ? row : null;
  };
  let row = await read();
  if (!row) {
    const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as unknown as { privateKey: CryptoKey; publicKey: CryptoKey };
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    const sealed = await files.seal(v.householdId, SEAL_LABEL, b64(pkcs8));
    await v.db.insert(householdSetting).values({ householdId: v.householdId }).onConflictDoNothing();
    // Only where there's none yet: two first exports at once keep whichever was written first.
    await v.db
      .update(householdSetting)
      .set({ signingKeySealed: sealed, signingPublicKey: b64(raw), updatedAt: new Date() })
      .where(and(eq(householdSetting.householdId, v.householdId), isNull(householdSetting.signingKeySealed)));
    row = await read();
    if (!row) throw new Error("Couldn't keep the household's signing key");
  }
  const pkcs8 = fromB64(await files.open(v.householdId, SEAL_LABEL, row.sealed!));
  const privateKey = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
  return { privateKey, publicRaw: fromB64(row.pub!) };
}

function describe(publicRaw: Uint8Array, fingerprintBytes: Uint8Array, namespace = EXPORT_NAMESPACE): SigningKey {
  const publicKey = `ssh-ed25519 ${b64(publicBlob(publicRaw))} ${PRINCIPAL}`;
  return {
    publicKey,
    fingerprint: `SHA256:${b64(fingerprintBytes).replace(/=+$/, "")}`,
    allowedSigners: `${PRINCIPAL} namespaces="${namespace}" ${publicKey.split(" ").slice(0, 2).join(" ")}`,
    namespace,
  };
}
const describeKey = async (publicRaw: Uint8Array, namespace: string) =>
  describe(publicRaw, new Uint8Array(await crypto.subtle.digest("SHA-256", publicBlob(publicRaw))), namespace);

/** The household's public key, to check its exports with (made now if it has none yet). */
export async function signingKey(v: Caller, files: FileStore): Promise<SigningKey> {
  return describeKey((await keyPair(v, files)).publicRaw, EXPORT_NAMESPACE);
}

/** Signs `message` for `namespace` with the household's key: an armoured OpenSSH signature. */
export async function sshSign(v: Caller, files: FileStore, message: Uint8Array, namespace = EXPORT_NAMESPACE) {
  return signWith(await keyPair(v, files), message, namespace);
}

/** An armoured OpenSSH signature (-----BEGIN SSH SIGNATURE-----) of `message` for `namespace`. */
async function signWith({ privateKey, publicRaw }: { privateKey: CryptoKey; publicRaw: Uint8Array }, message: Uint8Array, namespace: string) {
  const magic = utf8.encode("SSHSIG");
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-512", message as Uint8Array<ArrayBuffer>));
  const signed = concat(magic, sshString(namespace), sshString(""), sshString("sha512"), sshString(hash));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, privateKey, signed));
  const version = new Uint8Array([0, 0, 0, 1]);
  const blob = concat(magic, version, sshString(publicBlob(publicRaw)), sshString(namespace), sshString(""), sshString("sha512"), sshString(concat(sshString("ssh-ed25519"), sshString(sig))));
  const lines = b64(blob).match(/.{1,70}/g)!;
  return `-----BEGIN SSH SIGNATURE-----\n${lines.join("\n")}\n-----END SSH SIGNATURE-----\n`;
}

/** A fingerprint as ssh-keygen -l shows it ("SHA256:…"), from the public key's raw bytes. */
async function fingerprintOf(publicRaw: Uint8Array) {
  return describe(publicRaw, new Uint8Array(await crypto.subtle.digest("SHA-256", publicBlob(publicRaw)))).fingerprint;
}

/**
 * Checks an armoured OpenSSH signature of `message` for `namespace`, against the Ed25519 key inside it. Returns that
 * key's fingerprint and whether it's this household's own key — or null when the signature doesn't hold (or isn't one).
 */
export async function sshVerify(v: Caller, armoured: string, message: Uint8Array, namespace = EXPORT_NAMESPACE): Promise<{ fingerprint: string; ours: boolean } | null> {
  const signed = await verifySignature(armoured, message, namespace);
  if (!signed) return null;
  const [row] = await v.db.select({ pub: householdSetting.signingPublicKey }).from(householdSetting).where(eq(householdSetting.householdId, v.householdId));
  return { fingerprint: signed.fingerprint, ours: row?.pub === signed.publicKey };
}

/** Checks an armoured OpenSSH signature against the Ed25519 key inside it: that key (base64 raw) and its fingerprint, or null. */
export async function verifySignature(armoured: string, message: Uint8Array, namespace: string): Promise<{ fingerprint: string; publicKey: string } | null> {
  try {
    const body = armoured.match(/-----BEGIN SSH SIGNATURE-----([\s\S]*?)-----END SSH SIGNATURE-----/)?.[1];
    if (!body) return null;
    const blob = fromB64(body.replace(/\s+/g, ""));
    let at = 0;
    const take = (n: number) => {
      if (at + n > blob.length) throw new Error("short");
      return blob.subarray(at, (at += n));
    };
    const u32 = () => {
      const n = new DataView(blob.buffer, blob.byteOffset + at, 4).getUint32(0);
      take(4);
      return n;
    };
    const str = () => take(u32());
    const fields = (b: Uint8Array) => {
      const out: Uint8Array[] = [];
      for (let p = 0; p < b.length; ) {
        const len = new DataView(b.buffer, b.byteOffset + p, 4).getUint32(0);
        out.push(b.subarray(p + 4, p + 4 + len));
        p += 4 + len;
      }
      return out;
    };
    const text = (b: Uint8Array) => new TextDecoder().decode(b);
    if (text(take(6)) !== "SSHSIG" || u32() !== 1) return null;
    const pub = str();
    const [pubType, publicRaw] = fields(pub);
    if (text(str()) !== namespace) return null;
    str(); // reserved
    const hashAlg = text(str());
    const [sigType, sig] = fields(str());
    if (!pubType || text(pubType) !== "ssh-ed25519" || !sigType || text(sigType) !== "ssh-ed25519" || publicRaw?.length !== 32 || sig?.length !== 64) return null;
    if (hashAlg !== "sha512" && hashAlg !== "sha256") return null;
    const hash = new Uint8Array(await crypto.subtle.digest(hashAlg === "sha512" ? "SHA-512" : "SHA-256", message as Uint8Array<ArrayBuffer>));
    const signed = concat(utf8.encode("SSHSIG"), sshString(namespace), sshString(""), sshString(hashAlg), sshString(hash));
    const key = await crypto.subtle.importKey("raw", publicRaw as Uint8Array<ArrayBuffer>, { name: "Ed25519" }, false, ["verify"]);
    if (!(await crypto.subtle.verify({ name: "Ed25519" }, key, sig as Uint8Array<ArrayBuffer>, signed as Uint8Array<ArrayBuffer>))) return null;
    return { fingerprint: await fingerprintOf(publicRaw), publicKey: b64(publicRaw) };
  } catch {
    return null;
  }
}

// ── The server's own key: for backups, which hold every household ─────────────────────────────────────────────────

const SERVER_KEY = "signing-key";

/** What seals the server's private key: made from FILES_KEY (HKDF), never stored. */
async function serverSealKey(filesKey: string) {
  const raw = fromB64(filesKey);
  const base = await crypto.subtle.importKey("raw", raw as Uint8Array<ArrayBuffer>, "HKDF", false, ["deriveKey"]);
  raw.fill(0);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: utf8.encode("ferret-signing-v1") }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

/**
 * The server's key pair, made the first time (a backup, or Settings → Server asking): the private key sealed with a
 * key made from FILES_KEY, in `server_setting` — so backups carry it, and a restored server signs with the same key.
 */
async function serverKeyPair(db: Db, filesKey: string) {
  const read = async () => {
    const [row] = await db.select({ value: serverSetting.value }).from(serverSetting).where(eq(serverSetting.key, SERVER_KEY));
    return row ? (JSON.parse(row.value) as { sealed: string; pub: string }) : null;
  };
  let kept = await read();
  if (!kept) {
    const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as unknown as { privateKey: CryptoKey; publicKey: CryptoKey };
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: utf8.encode(SERVER_KEY) }, await serverSealKey(filesKey), pkcs8));
    // Only if there's none yet: two at once keep whichever was written first.
    await db.insert(serverSetting).values({ key: SERVER_KEY, value: JSON.stringify({ sealed: b64(concat(iv, sealed)), pub: b64(raw) }) }).onConflictDoNothing();
    kept = await read();
    if (!kept) throw new Error("Couldn't keep the server's signing key");
  }
  const bytes = fromB64(kept.sealed);
  const pkcs8 = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.subarray(0, 12), additionalData: utf8.encode(SERVER_KEY) }, await serverSealKey(filesKey), bytes.subarray(12)),
  );
  const privateKey = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
  return { privateKey, publicRaw: fromB64(kept.pub) };
}

/** The server's public key, to check its backups with (made now if it has none yet). */
export async function serverSigningKey(db: Db, filesKey: string): Promise<SigningKey> {
  return describeKey((await serverKeyPair(db, filesKey)).publicRaw, BACKUP_NAMESPACE);
}

/** Signs a backup's manifest with the server's key. */
export async function signBackup(db: Db, filesKey: string, manifest: Uint8Array) {
  return signWith(await serverKeyPair(db, filesKey), manifest, BACKUP_NAMESPACE);
}

