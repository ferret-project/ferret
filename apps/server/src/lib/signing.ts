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
import { householdSetting } from "../db/schema";
import type { FileStore } from "./files";
import type { Caller } from "./inventory";

/** What exports are signed for (ssh-keygen -n): a signature made for one purpose can't pass as another's. */
export const EXPORT_NAMESPACE = "ferret-export";
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

function describe(publicRaw: Uint8Array, fingerprintBytes: Uint8Array): SigningKey {
  const publicKey = `ssh-ed25519 ${b64(publicBlob(publicRaw))} ${PRINCIPAL}`;
  return {
    publicKey,
    fingerprint: `SHA256:${b64(fingerprintBytes).replace(/=+$/, "")}`,
    allowedSigners: `${PRINCIPAL} namespaces="${EXPORT_NAMESPACE}" ${publicKey.split(" ").slice(0, 2).join(" ")}`,
    namespace: EXPORT_NAMESPACE,
  };
}

/** The household's public key, to check its exports with (made now if it has none yet). */
export async function signingKey(v: Caller, files: FileStore): Promise<SigningKey> {
  const { publicRaw } = await keyPair(v, files);
  return describe(publicRaw, new Uint8Array(await crypto.subtle.digest("SHA-256", publicBlob(publicRaw))));
}

/** Signs `message` for `namespace`: an armoured OpenSSH signature (-----BEGIN SSH SIGNATURE-----). */
export async function sshSign(v: Caller, files: FileStore, message: Uint8Array, namespace = EXPORT_NAMESPACE) {
  const { privateKey, publicRaw } = await keyPair(v, files);
  const magic = utf8.encode("SSHSIG");
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-512", message as Uint8Array<ArrayBuffer>));
  const signed = concat(magic, sshString(namespace), sshString(""), sshString("sha512"), sshString(hash));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, privateKey, signed));
  const version = new Uint8Array([0, 0, 0, 1]);
  const blob = concat(magic, version, sshString(publicBlob(publicRaw)), sshString(namespace), sshString(""), sshString("sha512"), sshString(concat(sshString("ssh-ed25519"), sshString(sig))));
  const lines = b64(blob).match(/.{1,70}/g)!;
  return `-----BEGIN SSH SIGNATURE-----\n${lines.join("\n")}\n-----END SSH SIGNATURE-----\n`;
}
