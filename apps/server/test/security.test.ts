/** Settings → Security: sessions, sign-in history, and two-step sign-in (TOTP). */
import type { SessionSummary, SignInEntry } from "@ferret/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { job } from "../src/db/schema";
import { NEW_PLACE_JOB, newPlaceAlert } from "../src/jobs/security-alert";
import { FakeNotifier, config, setup } from "./helpers";

type App = Awaited<ReturnType<typeof setup>>["app"];

const json = async <T>(res: Response | Promise<Response>) => (await (await res).json()) as T;
function client(app: App, ip = "203.0.113.7", userAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1") {
  const jar = new Map<string, string>(); // like a browser: a cookie set again replaces the old one
  const call = async (url: string, init: RequestInit = {}) => {
    const res = await app.request(url, {
      ...init,
      headers: {
        ...(typeof init.body === "string" ? { "Content-Type": "application/json" } : {}),
        Origin: config.PUBLIC_URL,
        "X-Forwarded-For": ip,
        "User-Agent": userAgent,
        ...(jar.size ? { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") } : {}),
        ...init.headers,
      },
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(";");
      const [name, value] = [pair!.slice(0, pair!.indexOf("=")), pair!.slice(pair!.indexOf("=") + 1)];
      if (!value || attrs.some((a) => /max-age=0/i.test(a))) jar.delete(name);
      else jar.set(name, value);
    }
    return res;
  };
  const post = (url: string, body: object) => call(url, { method: "POST", body: JSON.stringify(body) });
  return { call, post };
}

const signIn = (app: App, ip?: string, ua?: string) => {
  const c = client(app, ip, ua);
  return c.post("/api/auth/sign-in/email", { email: "ann@example.com", password: "correct-horse-battery" }).then((res) => ({ res, ...c }));
};

/** RFC 6238 TOTP (SHA-1, 6 digits, 30 s), as authenticator apps make it. */
async function totp(base32: string, at = Date.now()) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of base32.replace(/=+$/, "").toUpperCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, "0");
  const key = Uint8Array.from(bits.match(/.{8}/g)!.map((b) => Number.parseInt(b, 2)));
  const counter = new DataView(new ArrayBuffer(8));
  counter.setBigUint64(0, BigInt(Math.floor(at / 30_000)));
  const hmacKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", hmacKey, counter.buffer));
  const offset = mac[19]! & 0xf;
  const code = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(code % 1_000_000).padStart(6, "0");
}

describe("security", () => {
  it("lists your sessions, signs out one or all the others, and keeps your sign-ins", async () => {
    const { app, user } = await setup();
    const ann = await user("ann");
    const bob = await user("bob");
    const mac = await signIn(app, "192.168.1.20", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/140.0");
    const phone = await signIn(app, "203.0.113.7");
    expect(mac.res.status).toBe(200);

    const sessions = await json<{ data: SessionSummary[] }>(phone.call("/api/v1/security/sessions"));
    expect(sessions.data).toHaveLength(3); // sign-up, Mac, phone
    expect(sessions.data[0]).toMatchObject({ current: true, ipAddress: "203.0.113.7" });
    expect(sessions.data.filter((s) => s.current)).toHaveLength(1);

    const signIns = await json<{ data: SignInEntry[] }>(phone.call("/api/v1/security/sign-ins"));
    expect(signIns.data.map((s) => [s.method, s.ipAddress])).toEqual([
      ["password", "203.0.113.7"],
      ["password", "192.168.1.20"],
      ["password", "127.0.0.1"], // test requests without X-Forwarded-For fall back to localhost
    ]);
    expect(signIns.data[1]!.userAgent).toContain("Macintosh");

    // Sign out the Mac from the phone; someone else's session isn't yours to end.
    const macSession = sessions.data.find((s) => s.ipAddress === "192.168.1.20")!;
    expect((await bob.as(`/api/v1/security/sessions/${macSession.id}`, { method: "DELETE" })).status).toBe(404);
    expect((await phone.call(`/api/v1/security/sessions/${sessions.data[0]!.id}`, { method: "DELETE" })).status).toBe(400);
    expect((await phone.call(`/api/v1/security/sessions/${macSession.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await mac.call("/api/v1/security/sessions")).status).toBe(401);

    expect(await json(phone.post("/api/v1/security/sessions/revoke-others", {}))).toEqual({ signedOut: 1 });
    expect((await ann.as("/api/v1/security/sessions")).status).toBe(401);
    expect((await json<{ data: SessionSummary[] }>(phone.call("/api/v1/security/sessions"))).data).toHaveLength(1);
    expect((await json<{ data: SessionSummary[] }>(bob.as("/api/v1/security/sessions"))).data).toHaveLength(1);
  });

  it("asks for an authenticator code once two-step sign-in is on, and logs only finished sign-ins", async () => {
    const { app, user } = await setup();
    await user("ann");
    const me = await signIn(app);

    // Turning it on: password → secret (QR) + backup codes, then a code from the app confirms it.
    const enabled = await json<{ totpURI: string; backupCodes: string[] }>(
      me.post("/api/auth/two-factor/enable", { password: "correct-horse-battery" }),
    );
    expect(enabled.totpURI).toMatch(/^otpauth:\/\/totp\/Ferret:ann%40example\.com\?/);
    expect(enabled.backupCodes).toHaveLength(10);
    const secret = new URL(enabled.totpURI).searchParams.get("secret")!;
    expect((await me.post("/api/auth/two-factor/verify-totp", { code: await totp(secret) })).status).toBe(200);
    expect((await json<{ user: { twoFactorEnabled: boolean } }>(me.call("/api/auth/get-session"))).user.twoFactorEnabled).toBe(true);

    // A password alone isn't a sign-in any more: no session, nothing logged.
    const next = await signIn(app, "198.51.100.4");
    expect(await next.res.json()).toMatchObject({ twoFactorRedirect: true, twoFactorMethods: ["totp"] });
    expect((await next.call("/api/v1/security/sessions")).status).toBe(401);
    const before = await json<{ data: SignInEntry[] }>(me.call("/api/v1/security/sign-ins"));
    expect(before.data.map((s) => s.method)).toEqual(["password", "password"]); // turning it on wasn't a sign-in

    expect((await next.post("/api/auth/two-factor/verify-totp", { code: "000000" })).status).toBe(401);
    expect((await next.post("/api/auth/two-factor/verify-totp", { code: await totp(secret) })).status).toBe(200);
    expect((await next.call("/api/v1/security/sessions")).status).toBe(200);

    // A backup code works once instead of the app.
    const lost = await signIn(app, "198.51.100.9");
    expect((await lost.post("/api/auth/two-factor/verify-backup-code", { code: enabled.backupCodes[0] })).status).toBe(200);
    const again = await signIn(app);
    expect((await again.post("/api/auth/two-factor/verify-backup-code", { code: enabled.backupCodes[0] })).status).toBe(401);

    const after = await json<{ data: SignInEntry[] }>(me.call("/api/v1/security/sign-ins"));
    expect(after.data.map((s) => [s.method, s.ipAddress])).toEqual([
      ["password+backup-code", "198.51.100.9"],
      ["password+code", "198.51.100.4"],
      ["password", "203.0.113.7"],
      ["password", "127.0.0.1"],
    ]);
  });

  it("isn't open to API keys", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    const key = await json<{ key: string }>(ann.as("/api/v1/api-keys", { method: "POST", body: JSON.stringify({ name: "Claude" }) }));
    const res = await ann.as("/api/v1/security/sessions", { headers: { Cookie: "", Authorization: `Bearer ${key.key}` } });
    expect(res.status).toBe(403);
  });
});

describe("sign-ins from somewhere new", () => {
  it("alerts the account's owner when a sign-in comes from another network — not the first, not a known one", async () => {
    const { app, db, files, user } = await setup();
    await user("ann");
    const queued = async () =>
      (await db.select().from(job).where(eq(job.type, NEW_PLACE_JOB))).map((j) => (typeof j.payload === "string" ? JSON.parse(j.payload) : j.payload) as { ipAddress: string; userAgent: string });

    await signIn(app, "192.168.1.20"); // the first with an address: nothing to compare with
    await signIn(app, "192.168.1.44"); // the same network
    expect(await queued()).toEqual([]);
    await signIn(app, "198.51.100.9", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile/15E148 Safari/604.1");
    expect(await queued()).toEqual([expect.objectContaining({ ipAddress: "198.51.100.9" })]);
    await signIn(app, "198.51.100.200"); // now known
    expect(await queued()).toHaveLength(1);

    // The message: by email (and push, Apprise) to them.
    const notifier = new FakeNotifier();
    const [payload] = await queued();
    await newPlaceAlert({ db, blobs: undefined as never, notifier, files, appUrl: config.PUBLIC_URL, mailUrl: "mailtos://x:y@mail.example.com" })(payload, { lastAttempt: true });
    expect(notifier.sent).toEqual([
      expect.objectContaining({ url: expect.stringContaining("to=ann%40example.com"), title: "New sign-in to Ferret", body: expect.stringContaining("Safari on iPhone at 198.51.100.9") }),
    ]);
  });
});
