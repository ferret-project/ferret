/**
 * Web Push with web-standard APIs only (fetch + WebCrypto), so the same code sends from Node and from a Worker:
 * VAPID (RFC 8292) to say who's sending, and the message encrypted for the browser (RFC 8291, aes128gcm).
 */
import type { Push, PushTarget } from "../ports";

const utf8 = new TextEncoder();
/** Text as bytes on a plain ArrayBuffer (what the Web Crypto types want). */
const text = (s: string): Bytes => new Uint8Array(utf8.encode(s));
type Key = Awaited<ReturnType<typeof crypto.subtle.importKey>>;
type Bytes = Uint8Array<ArrayBuffer>;

const fromB64url = (s: string) => {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
};
const toB64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const concat = (...parts: Uint8Array[]): Bytes => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

/** HKDF-SHA-256: `length` bytes from `ikm`, salted, for `info`. */
async function hkdf(salt: Bytes, ikm: Bytes, info: Bytes, length: number) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: salt, info: info }, key, length * 8));
}

/** The VAPID key pair as WebCrypto keys (from web-push's base64url format: a 65-byte public point and a 32-byte scalar). */
async function vapidSigningKey(publicKey: string, privateKey: string) {
  const pub = fromB64url(publicKey);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error("VAPID_PUBLIC_KEY isn't an uncompressed P-256 public key");
  const jwk = { kty: "EC", crv: "P-256", x: toB64url(pub.slice(1, 33)), y: toB64url(pub.slice(33, 65)), d: privateKey, ext: true };
  return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

/** A VAPID JWT for the push service at `endpoint` (ES256), good for 12 hours. */
export async function vapidToken(endpoint: string, subject: string, key: Key, now = Date.now()) {
  const header = toB64url(text(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = toB64url(text(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })));
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, text(`${header}.${claims}`)));
  return `${header}.${claims}.${toB64url(signature)}`;
}

/** The message encrypted for one browser (RFC 8291): the request body, Content-Encoding aes128gcm. */
export async function encryptForBrowser(target: Pick<PushTarget, "p256dh" | "auth">, plaintext: Bytes) {
  const browserKey = fromB64url(target.p256dh);
  const authSecret = fromB64url(target.auth);
  // A fresh key pair for this message; the browser derives the same secret from its half.
  const ours = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as { publicKey: Key; privateKey: Key };
  const ourPublic = new Uint8Array((await crypto.subtle.exportKey("raw", ours.publicKey)) as ArrayBuffer); // "raw" is never a JWK
  const theirs = await crypto.subtle.importKey("raw", browserKey, { name: "ECDH", namedCurve: "P-256" }, false, []);
  // The standard `public` field. Some runtimes' types call it `$public` but want `public` at run time — so the type is
  // cast, not the field renamed.
  const ecdh = { name: "ECDH", public: theirs } as unknown as Parameters<typeof crypto.subtle.deriveBits>[0];
  const shared = new Uint8Array(await crypto.subtle.deriveBits(ecdh, ours.privateKey, 256));

  const ikm = await hkdf(authSecret, shared, concat(text("WebPush: info\0"), browserKey, ourPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, text("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, text("Content-Encoding: nonce\0"), 12);

  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  // One record: the message, then 0x02 (the last record's delimiter), no padding.
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, concat(plaintext, new Uint8Array([2]))));
  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, 4096);
  return concat(salt, recordSize, new Uint8Array([ourPublic.length]), ourPublic, sealed);
}

/** Web Push to browsers' push services (needs VAPID keys: `npx web-push generate-vapid-keys`). */
export class WebCryptoPush implements Push {
  private key: Promise<Key>;

  constructor(
    readonly publicKey: string,
    privateKey: string,
    private readonly subject: string,
    private readonly fetcher: typeof fetch = (input, init) => fetch(input, init),
  ) {
    this.key = vapidSigningKey(publicKey, privateKey);
  }

  async send(target: PushTarget, message: { title: string; body: string; url: string; tag?: string }) {
    const res = await this.fetcher(target.endpoint, {
      method: "POST",
      headers: {
        Authorization: `vapid t=${await vapidToken(target.endpoint, this.subject, await this.key)}, k=${this.publicKey}`,
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: String(12 * 3600),
      },
      body: await encryptForBrowser(target, text(JSON.stringify(message))),
    });
    if (res.status === 404 || res.status === 410) return "gone" as const;
    if (!res.ok) throw new Error(`Push service answered ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
    return "sent" as const;
  }
}
