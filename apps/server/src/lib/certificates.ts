import { t as translateText } from "./i18n";
/**
 * Certificates for Ferret's own connections (Settings → Server → Certificates, the server admin): certificate
 * authorities to trust for your own services (a self-signed Home Assistant, a step-ca on the LAN…), and client
 * certificates to present to the hosts that ask for one (mutual TLS). Applied through `deps.tls` (adapters/local/
 * certificates.ts) at start and after every change; a runtime without it has none.
 *
 * Kept in `server_setting` "certificates" (so backups keep them). A client certificate's file and password are sealed
 * with a key made from FILES_KEY (HKDF) — they're a private key; nothing ever sends them back out.
 */
import type { ServerCertificate, ServerCertificates } from "@ferret/shared";
import { eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { serverSetting } from "../db/schema";
import type { CertificateDetails, Db, Deps } from "../ports";

const KEY = "certificates";
export const MAX_TRUSTED = 20;
export const MAX_CLIENTS = 10;
/** A certificate (or a .p12) is a few KB; this is plenty. */
export const MAX_FILE_BYTES = 64 * 1024;

interface Kept {
  trusted: (ServerCertificate & { pem: string })[];
  clients: (ServerCertificate & { hosts: string[]; sealed: string })[];
}

const utf8 = new TextEncoder();
const IV_BYTES = 12;

/** The certificates' sealing key: made from FILES_KEY, never stored. */
async function sealingKey(filesKey: string) {
  const raw = Uint8Array.from(atob(filesKey), (c) => c.charCodeAt(0));
  const base = await crypto.subtle.importKey("raw", raw, "HKDF", false, ["deriveKey"]);
  raw.fill(0);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: utf8.encode("ferret-certificates-v1") },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

const toBase64 = (bytes: Uint8Array) => btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""));
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

async function seal(filesKey: string, id: string, secret: { pkcs12: string; password: string }) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: utf8.encode(id) }, await sealingKey(filesKey), utf8.encode(JSON.stringify(secret)));
  const out = new Uint8Array(IV_BYTES + sealed.byteLength);
  out.set(iv);
  out.set(new Uint8Array(sealed), IV_BYTES);
  return toBase64(out);
}

async function open(filesKey: string, id: string, sealed: string) {
  const bytes = fromBase64(sealed);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes.subarray(0, IV_BYTES), additionalData: utf8.encode(id) },
    await sealingKey(filesKey),
    bytes.subarray(IV_BYTES),
  );
  return JSON.parse(new TextDecoder().decode(plain)) as { pkcs12: string; password: string };
}

async function load(db: Db): Promise<Kept> {
  const [row] = await db.select().from(serverSetting).where(eq(serverSetting.key, KEY));
  if (!row) return { trusted: [], clients: [] };
  const kept = JSON.parse(row.value) as Partial<Kept>;
  return { trusted: kept.trusted ?? [], clients: kept.clients ?? [] };
}

async function save(db: Db, kept: Kept) {
  const value = JSON.stringify(kept);
  await db.insert(serverSetting).values({ key: KEY, value }).onConflictDoUpdate({ target: serverSetting.key, set: { value } });
}

const shown = ({ pem: _pem, sealed: _sealed, ...c }: ServerCertificate & { pem?: string; sealed?: string }): ServerCertificate => c;

const described = (d: CertificateDetails, name: string, id = crypto.randomUUID()): ServerCertificate => ({
  id,
  name: name.trim() || (/CN=([^,]+)/.exec(d.subject)?.[1] ?? d.subject),
  subject: d.subject,
  issuer: d.issuer,
  notAfter: d.notAfter.toISOString(),
  fingerprint: d.fingerprint,
  addedAt: new Date().toISOString(),
});

export async function listCertificates(deps: Pick<Deps, "db" | "tls">): Promise<ServerCertificates> {
  const kept = await load(deps.db);
  return { available: Boolean(deps.tls), trusted: kept.trusted.map(shown), clients: kept.clients.map(shown) };
}

function needTls(deps: Pick<Deps, "tls">) {
  if (!deps.tls) throw new HTTPException(404, { message: translateText("This server can't use certificates of its own") });
  return deps.tls;
}

const refused = (err: unknown) => new HTTPException(400, { message: err instanceof Error ? err.message : String(err) });

/** Adds each certificate in a PEM (an authority's, or a self-signed server's) to those trusted. */
export async function addTrusted(deps: Pick<Deps, "db" | "tls">, filesKey: string, input: { name: string; pem: string }) {
  const tls = needTls(deps);
  let found: CertificateDetails[];
  try {
    found = tls.readPem(input.pem);
  } catch (err) {
    throw refused(err);
  }
  const blocks = input.pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
  const kept = await load(deps.db);
  const fresh = found
    .map((d, i) => ({ ...described(d, found.length > 1 ? "" : input.name), pem: blocks[i]! }))
    .filter((c) => !kept.trusted.some((t) => t.fingerprint === c.fingerprint));
  if (!fresh.length) throw new HTTPException(409, { message: translateText("Ferret already trusts that certificate") });
  if (kept.trusted.length + fresh.length > MAX_TRUSTED) throw new HTTPException(400, { message: translateText("Up to {v0} trusted certificates", { v0: MAX_TRUSTED }) });
  kept.trusted.push(...fresh);
  await save(deps.db, kept);
  await applyCertificates(deps, filesKey);
  return listCertificates(deps);
}

/** A host a client certificate goes to: a name, `*.example.lan`, or an address. */
export function cleanHost(host: string) {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  const name = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
  const ipv4 = /^\d{1,3}(\.\d{1,3}){3}$/;
  const ipv6 = /^[0-9a-f:]+$/;
  if (!h || h === "*" || h.length > 253 || !(name.test(h) || ipv4.test(h) || (h.includes(":") && ipv6.test(h)))) {
    throw new HTTPException(400, { message: translateText("\"{v0}\" isn't a host name (e.g. ha.example.lan or *.example.lan) or an address", { v0: host.trim() }) });
  }
  return h;
}

/** Adds a client certificate (a .p12 and its password), presented only to `hosts`. */
export async function addClient(
  deps: Pick<Deps, "db" | "tls">,
  filesKey: string,
  input: { name: string; hosts: string[]; pkcs12: string; password: string },
) {
  const tls = needTls(deps);
  const hosts = [...new Set(input.hosts.map(cleanHost))];
  if (!hosts.length) throw new HTTPException(400, { message: translateText("Say which hosts it's for") });
  const bytes = fromBase64(input.pkcs12);
  if (bytes.byteLength > MAX_FILE_BYTES) throw new HTTPException(400, { message: translateText("That file is too big for a certificate") });
  let d: CertificateDetails;
  try {
    d = tls.readPkcs12(bytes, input.password);
  } catch (err) {
    throw refused(err);
  }
  const kept = await load(deps.db);
  if (kept.clients.length >= MAX_CLIENTS) throw new HTTPException(400, { message: translateText("Up to {v0} client certificates", { v0: MAX_CLIENTS }) });
  const taken = kept.clients.flatMap((c) => c.hosts.filter((h) => hosts.includes(h)).map((h) => `${h} (${c.name})`));
  if (taken.length) throw new HTTPException(409, { message: translateText("Another certificate already goes to {v0}", { v0: taken.join(", ") }) });
  const c = described(d, input.name);
  kept.clients.push({ ...c, hosts, sealed: await seal(filesKey, c.id, { pkcs12: input.pkcs12, password: input.password }) });
  await save(deps.db, kept);
  await applyCertificates(deps, filesKey);
  return listCertificates(deps);
}

export async function removeCertificate(deps: Pick<Deps, "db" | "tls">, filesKey: string, id: string) {
  const kept = await load(deps.db);
  const next = { trusted: kept.trusted.filter((c) => c.id !== id), clients: kept.clients.filter((c) => c.id !== id) };
  if (next.trusted.length === kept.trusted.length && next.clients.length === kept.clients.length) throw new HTTPException(404, { message: translateText("No such certificate") });
  await save(deps.db, next);
  await applyCertificates(deps, filesKey);
  return listCertificates(deps);
}

/** Hands what's kept to the runtime: at start, and after each change. One that won't open (FILES_KEY changed) is skipped. */
export async function applyCertificates(deps: Pick<Deps, "db" | "tls">, filesKey: string) {
  if (!deps.tls) return;
  const kept = await load(deps.db);
  const clients: { hosts: string[]; pkcs12: Uint8Array; password: string }[] = [];
  for (const c of kept.clients) {
    try {
      const secret = await open(filesKey, c.id, c.sealed);
      clients.push({ hosts: c.hosts, pkcs12: fromBase64(secret.pkcs12), password: secret.password });
    } catch {
      console.error(`Client certificate "${c.name}" couldn't be opened (was FILES_KEY changed?) — skipped. Remove it and add it again.`);
    }
  }
  deps.tls.apply(kept.trusted.map((t) => t.pem), clients);
}

/** For the server admin's bell: certificates that have run out, or will within 30 days. */
export async function certificatesEnding(db: Db, now = new Date()) {
  const kept = await load(db);
  const soon = now.getTime() + 30 * 86_400_000;
  return [...kept.trusted, ...kept.clients]
    .filter((c) => Date.parse(c.notAfter) < soon)
    .map((c) => ({ id: c.id, name: c.name, notAfter: c.notAfter, ended: Date.parse(c.notAfter) <= now.getTime() }));
}
