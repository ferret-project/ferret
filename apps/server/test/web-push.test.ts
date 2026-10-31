import { createECDH, randomBytes } from "node:crypto";
// @ts-expect-error — no types; http_ece is web-push's own decryption (RFC 8188/8291), used here as an independent check.
import ece from "http_ece";
import { describe, expect, it } from "vitest";
import { WebCryptoPush } from "../src/lib/web-push";

const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");

/** A VAPID key pair in web-push's format (base64url: 65-byte public point, 32-byte private scalar). */
async function vapidKeys() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as { publicKey: Awaited<ReturnType<typeof crypto.subtle.importKey>>; privateKey: Awaited<ReturnType<typeof crypto.subtle.importKey>> };
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return { publicKey: b64url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))), privateKey: jwk.d!, verify: pair.publicKey };
}

/** A browser's subscription: its ECDH key pair (kept to decrypt) and the auth secret. */
function browser() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return { ecdh, auth, target: { endpoint: "https://fcm.googleapis.com/fcm/send/abc123", p256dh: b64url(ecdh.getPublicKey()), auth: b64url(auth) } };
}

describe("Web Push with WebCrypto", () => {
  it("encrypts so the browser can read it (checked with http_ece) and signs a VAPID token for the push service", async () => {
    const keys = await vapidKeys();
    const b = browser();
    let sent: { url: string; init: RequestInit } | undefined;
    const push = new WebCryptoPush(keys.publicKey, keys.privateKey, "mailto:admin@ferret.test", async (url, init) => {
      sent = { url: String(url), init: init! };
      return new Response(null, { status: 201 });
    });
    const message = { title: "Maintenance due today", body: "Replace filter (Furnace)", url: "https://ferret.test/#/maintenance", tag: "ferret-reminders" };
    expect(await push.send(b.target, message)).toBe("sent");

    const headers = sent!.init.headers as Record<string, string>;
    expect(sent!.url).toBe(b.target.endpoint);
    expect(headers["Content-Encoding"]).toBe("aes128gcm");
    expect(Number(headers.TTL)).toBeGreaterThan(0);

    // The browser's side: decrypt with its own private key and auth secret.
    const plain = ece.decrypt(Buffer.from(sent!.init.body as Uint8Array), { version: "aes128gcm", privateKey: b.ecdh, authSecret: b.auth });
    expect(JSON.parse(plain.toString("utf8"))).toEqual(message);

    // The push service's side: the VAPID token is ours, for its origin, and the key is named.
    const m = /^vapid t=([^,]+), k=(.+)$/.exec(headers.Authorization!)!;
    expect(m[2]).toBe(keys.publicKey);
    const [h, c, s] = m[1]!.split(".");
    const claims = JSON.parse(Buffer.from(c!, "base64url").toString());
    expect(claims).toMatchObject({ aud: "https://fcm.googleapis.com", sub: "mailto:admin@ferret.test" });
    expect(claims.exp).toBeGreaterThan(Date.now() / 1000);
    const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, keys.verify, Buffer.from(s!, "base64url"), new TextEncoder().encode(`${h}.${c}`));
    expect(ok).toBe(true);
  });

  it("forgets a subscription the push service says is gone, and throws on other trouble", async () => {
    const keys = await vapidKeys();
    const answer = (status: number) =>
      new WebCryptoPush(keys.publicKey, keys.privateKey, "mailto:admin@ferret.test", async () => new Response("nope", { status })).send(browser().target, {
        title: "t",
        body: "b",
        url: "u",
      });
    expect(await answer(410)).toBe("gone");
    expect(await answer(404)).toBe("gone");
    await expect(answer(500)).rejects.toThrow(/500/);
  });
});
