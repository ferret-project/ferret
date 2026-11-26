/** The security audit's fixes (2026-10-18): client addresses, headers, body size, logs, CSV, SSRF, push and Apprise. */
import { describe, expect, it } from "vitest";
import { isPublicAddress } from "../src/adapters/local/download";
import { clientAddress, proxyList, withClientAddress } from "../src/adapters/local/proxy";
import { readFileSync } from "node:fs";
import path from "node:path";
import { LABEL_PAGE_STYLE_HASHES, redactTokens } from "../src/app";
import { trustedOrigins } from "../src/config";
import { toCsv } from "../src/lib/export";
import { isPushService } from "../src/routes/push";
import { FakeNotifier, setup } from "./helpers";

describe("client address", () => {
  const trusted = proxyList("10.0.0.2, 127.0.0.1, ::1");

  it("believes X-Forwarded-For only from a trusted proxy, and takes the address the proxy added", () => {
    expect(clientAddress("10.0.0.2", "198.51.100.7", trusted)).toBe("198.51.100.7");
    expect(clientAddress("::ffff:10.0.0.2", "203.0.113.1, 198.51.100.7", trusted)).toBe("198.51.100.7");
    // Straight to the port: whatever the client claims, it's the connection's own address.
    expect(clientAddress("192.168.1.50", "203.0.113.9", trusted)).toBe("192.168.1.50");
    expect(clientAddress("192.168.1.50", null, trusted)).toBe("192.168.1.50");
    expect(clientAddress("10.0.0.2", "not an address", trusted)).toBe("10.0.0.2");
  });

  it("walks back through a chain of trusted proxies, and no further", () => {
    // A tunnel's connector (172.18.0.5) in front of Traefik (10.0.0.2): Traefik adds the connector last.
    const chain = proxyList("10.0.0.2, 172.18.0.0/16");
    expect(clientAddress("10.0.0.2", "198.51.100.7, 172.18.0.5", chain)).toBe("198.51.100.7");
    // Whatever the visitor wrote before that is theirs, not ours: never believed.
    expect(clientAddress("10.0.0.2", "10.0.0.2, 203.0.113.1, 198.51.100.7, 172.18.0.5", chain)).toBe("198.51.100.7");
    expect(clientAddress("10.0.0.2", "172.18.0.9, 198.51.100.7, 172.18.0.5", chain)).toBe("198.51.100.7");
    // A hop that isn't listed stops the walk at its own address (so all its visitors look alike — list it).
    expect(clientAddress("10.0.0.2", "198.51.100.7, 192.168.5.5", chain)).toBe("192.168.5.5");
    // Only trusted hops, or rubbish, left: the furthest one we could believe.
    expect(clientAddress("10.0.0.2", "172.18.0.5", chain)).toBe("172.18.0.5");
    expect(clientAddress("10.0.0.2", "junk, 172.18.0.5", chain)).toBe("172.18.0.5");
  });

  it("passes on exactly one address", () => {
    const req = new Request("http://ferret.test/api/auth/sign-in/email", { headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" } });
    expect(withClientAddress(req, "192.168.1.50", trusted).headers.get("x-forwarded-for")).toBe("192.168.1.50");
  });

  it("refuses a TRUSTED_PROXIES entry that isn't an address", () => {
    expect(() => proxyList("traefik.lan")).toThrow(/TRUSTED_PROXIES/);
  });
});

describe("origins", () => {
  it("trusts the Vite dev server only outside production, unless told otherwise", () => {
    expect(trustedOrigins({ NODE_ENV: "development", TRUSTED_ORIGINS: undefined })).toEqual(["http://localhost:5173"]);
    expect(trustedOrigins({ NODE_ENV: "production", TRUSTED_ORIGINS: undefined })).toEqual([]);
    expect(trustedOrigins({ NODE_ENV: "production", TRUSTED_ORIGINS: "https://a.example, https://b.example" })).toEqual([
      "https://a.example",
      "https://b.example",
    ]);
  });
});

describe("responses", () => {
  it("carry a Content-Security-Policy that runs only Ferret's own code", async () => {
    const { app } = await setup();
    const csp = (await app.request("/healthz")).headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'self'");
  });

  it("allow the label pages' print styles by their hashes — and the hashes still match Labels.tsx", async () => {
    const source = readFileSync(path.resolve(__dirname, "../../web/src/Labels.tsx"), "utf8");
    const block = /export const PAGE_STYLES = \{([\s\S]*?)\} as const;/.exec(source)?.[1] ?? "";
    const styles = [...block.matchAll(/"(@page[^"]+)"/g)].map((m) => m[1]!);
    expect(styles).toHaveLength(4);
    const hashes = await Promise.all(
      styles.map(async (s) => `sha256-${btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))))}`),
    );
    expect(hashes).toEqual(LABEL_PAGE_STYLE_HASHES);
    const { app } = await setup();
    expect((await app.request("/healthz")).headers.get("content-security-policy")).toContain(`style-src 'self' ${LABEL_PAGE_STYLE_HASHES.map((h) => `'${h}'`).join(" ")}`);
  });

  it("turn away JSON bodies over 1 MB (uploads have their own limit)", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    const big = await ann.as("/api/v1/items", { method: "POST", body: JSON.stringify({ name: "x".repeat(1_100_000) }) });
    expect(big.status).toBe(413);
  });

  it("log share, borrower and emailed links without their token", () => {
    expect(redactTokens("<-- GET /api/v1/shared/AbCdEfGhIjKlMnOpQrStUv_-123/items.csv")).toBe("<-- GET /api/v1/shared/…/items.csv");
    expect(redactTokens("<-- GET /s/AbCdEfGhIjKlMnOpQrStUv_-123")).toBe("<-- GET /s/…");
    expect(redactTokens("<-- POST /api/v1/borrowed/AbCdEfGhIjKlMnOpQrStUv/stop")).toBe("<-- POST /api/v1/borrowed/…/stop");
    expect(redactTokens("<-- GET /api/auth/verify-email?token=eyJ.x.y&callbackURL=/")).toBe("<-- GET /api/auth/verify-email?token=…&callbackURL=/");
  });

  it("log calendar feeds without their token", () => {
    expect(redactTokens("<-- GET /calendar/AbC_123-xyzxyzxyzxyzxyz.ics")).toBe("<-- GET /calendar/…ics");
    expect(redactTokens("--> GET /api/v1/items 200 3ms")).toBe("--> GET /api/v1/items 200 3ms");
  });
});

describe("the spreadsheet export", () => {
  it("defuses cells a spreadsheet would run, tab and carriage return included", () => {
    const csv = toCsv([{ name: "\t=1+1", brand: "\r=cmd", tags: [] } as never], { currency: "USD" });
    expect(csv).not.toMatch(/(^|,)"?[\t\r]=/m);
  });
});

describe("downloads", () => {
  it("count IPv4 hidden in old IPv6 forms (::a.b.c.d, 6to4, Teredo) as private", () => {
    for (const address of ["::c0a8:101", "2002:c0a8:101::1", "2001:0:4136:e378::1", "::1", "::"]) expect(isPublicAddress(address)).toBe(false);
    expect(isPublicAddress("2606:4700::1111")).toBe(true);
  });
});

describe("push subscriptions", () => {
  it("are only the browsers' push services", async () => {
    expect(isPushService("https://fcm.googleapis.com/fcm/send/abc")).toBe(true);
    expect(isPushService("https://web.push.apple.com/QGuQ")).toBe(true);
    expect(isPushService("https://updates.push.services.mozilla.com/wpush/v2/x")).toBe(true);
    expect(isPushService("https://wns2-bl2p.notify.windows.com/w/?token=x")).toBe(true);
    expect(isPushService("http://fcm.googleapis.com/fcm/send/abc")).toBe(false);
    expect(isPushService("https://192.168.1.1/admin")).toBe(false);
    expect(isPushService("https://fcm.googleapis.com.evil.example/x")).toBe(false);

    const { user } = await setup({ push: { publicKey: "BKey", send: async () => "sent" } });
    const ann = await user("ann");
    const res = await ann.as("/api/v1/push/subscribe", {
      method: "POST",
      body: JSON.stringify({ endpoint: "https://192.168.1.1/admin", keys: { p256dh: "BKey", auth: "secret" } }),
    });
    expect(res.status).toBe(422);
  });

  it("can't take over someone else's device", async () => {
    const { user, db } = await setup({ push: { publicKey: "BKey", send: async () => "sent" } });
    const ann = await user("ann");
    const bob = await user("bob");
    const device = { endpoint: "https://fcm.googleapis.com/fcm/send/ann-phone", keys: { p256dh: "BKey", auth: "secret" } };
    expect((await ann.as("/api/v1/push/subscribe", { method: "POST", body: JSON.stringify(device) })).status).toBe(204);
    expect((await bob.as("/api/v1/push/subscribe", { method: "POST", body: JSON.stringify(device) })).status).toBe(409);
    const { pushSubscription } = await import("../src/db/schema");
    const rows = await db.select({ userId: pushSubscription.userId }).from(pushSubscription);
    expect(rows).toHaveLength(1);
    // Ann subscribing again is fine.
    expect((await ann.as("/api/v1/push/subscribe", { method: "POST", body: JSON.stringify(device) })).status).toBe(204);
  });
});

describe("notification channels", () => {
  it("only go to known services — no generic webhooks to any address", async () => {
    const { user } = await setup({ notifier: new FakeNotifier() });
    const ann = await user("ann");
    const add = (url: string) => ann.as("/api/v1/notifications", { method: "POST", body: JSON.stringify({ name: "x", url }) });
    for (const url of ["json://192.168.1.1:8080/hook", "jsons://router.lan/x", "form://10.0.0.1/", "xml://host/", "apprise://host/key"]) {
      expect((await add(url)).status).toBe(422);
    }
    expect((await add("ntfys://ntfy.sh/topic")).status).toBe(201);
    expect((await add("hassio://ha.lan/token")).status).toBe(201); // ann set Ferret up: her network is hers to name
  });

  it("to an address on the server's own network are only for whoever runs it", async () => {
    const { user } = await setup({ notifier: new FakeNotifier() });
    await user("admin");
    const bo = await user("bo");
    const add = (url: string) => bo.as("/api/v1/notifications", { method: "POST", body: JSON.stringify({ name: "x", url }) });
    for (const url of ["ntfy://10.0.0.5:8080/topic", "hassio://ha.lan/token", "gotify://box/token", "ntfys://localhost/x", "ntfy://[::1]/x", "ntfy://2130706433/x", "ntfy://0x7f.1/x", "mailtos://u:p@example.com?smtp=192.168.1.2", "ntfy://user:pw@169.254.169.254/x"]) {
      expect((await add(url)).status, url).toBe(403);
    }
    for (const url of ["ntfys://ntfy.sh/topic", "ntfy://mytopic", "pover://user@token", "tgram://bottoken/chat", "mailtos://u:p@gmail.com"]) {
      expect((await add(url)).status, url).toBe(201);
    }
  });
});

describe("changes with the session cookie", () => {
  it("come only from Ferret's own pages; API keys and scripts without a browser are unaffected", async () => {
    const { app, user } = await setup();
    const ann = await user("ann");
    const add = (headers: Record<string, string>) => ann.as("/api/v1/items", { method: "POST", body: JSON.stringify({ name: "Lamp" }), headers });
    expect((await add({ Origin: "https://other.example", "Sec-Fetch-Site": "same-site" })).status).toBe(403);
    expect((await add({ Origin: "null" })).status).toBe(403);
    expect((await add({ Origin: "", "Sec-Fetch-Site": "cross-site", "Content-Type": "text/plain" })).status).toBe(403);
    expect((await add({ "Sec-Fetch-Site": "same-origin" })).status).toBe(201);
    expect((await add({})).status).toBe(201); // the app's own Origin
    expect((await ann.as("/api/v1/items", { headers: { Origin: "https://other.example" } })).status).toBe(200); // reading isn't a change
    const { key } = (await (await ann.as("/api/v1/api-keys", { method: "POST", body: JSON.stringify({ name: "script" }) })).json()) as { key: string };
    const scripted = await app.request("/api/v1/items", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Origin: "https://other.example" },
      body: JSON.stringify({ name: "Kettle" }),
    });
    expect(scripted.status).toBe(201);
  });
});
