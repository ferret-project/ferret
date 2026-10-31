/** Single sign-on, self-hosted (lib/sso.ts): OpenID Connect, and a forward-auth proxy's headers. */
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { markAuthProxy, proxyList } from "../src/adapters/local/proxy";
import { PROXY_MARK } from "../src/lib/sso";
import { setup, verifiedAccount } from "./helpers";

const ISSUER = "https://idp.test";
const CLIENT = "ferret";

/** An OpenID provider in a box: discovery, a signed ID token for whoever `next` says, userinfo. */
async function fakeProvider() {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  const state = { next: { sub: "u-1", email: "pat@example.com", email_verified: true, name: "Pat" } as Record<string, unknown>, nonce: "", down: false };
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== ISSUER) return realFetch(input, init);
    if (state.down) throw new TypeError("fetch failed");
    if (url.pathname === "/.well-known/openid-configuration") {
      return Response.json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        userinfo_endpoint: `${ISSUER}/userinfo`,
        jwks_uri: `${ISSUER}/jwks`,
        id_token_signing_alg_values_supported: ["RS256"],
      });
    }
    if (url.pathname === "/jwks") return Response.json({ keys: [jwk] });
    if (url.pathname === "/token") {
      const idToken = await new SignJWT({ ...state.next, nonce: state.nonce || undefined })
        .setProtectedHeader({ alg: "RS256", kid: "k1" })
        .setIssuer(ISSUER)
        .setAudience(CLIENT)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey);
      return Response.json({ access_token: "at", token_type: "Bearer", expires_in: 300, id_token: idToken });
    }
    if (url.pathname === "/userinfo") return Response.json(state.next);
    return new Response("not found", { status: 404 });
  });
  return state;
}

const cookiesOf = (res: Response) => res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

/** The whole round trip: ask to sign in, "go" to the provider, come back with a code. Returns the callback's answer. */
async function signInWithSso(app: { request: (url: string, init?: RequestInit) => Response | Promise<Response> }, provider: Awaited<ReturnType<typeof fakeProvider>>, callbackURL = "/#/items") {
  const start = await app.request("/api/auth/sign-in/social", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost:8787" },
    body: JSON.stringify({ provider: "oidc", callbackURL, errorCallbackURL: "/?sso=failed" }),
  });
  expect(start.status).toBe(200);
  const { url } = (await start.json()) as { url: string };
  const authorize = new URL(url);
  expect(authorize.origin + authorize.pathname).toBe(`${ISSUER}/authorize`);
  expect(authorize.searchParams.get("code_challenge_method")).toBe("S256"); // PKCE
  provider.nonce = authorize.searchParams.get("nonce") ?? "";
  return app.request(`/api/auth/callback/oidc?code=c0de&state=${encodeURIComponent(authorize.searchParams.get("state")!)}`, {
    headers: { Cookie: cookiesOf(start) },
  });
}

afterEach(() => vi.unstubAllGlobals());

const OIDC = { OIDC_ISSUER: ISSUER, OIDC_CLIENT_ID: CLIENT, OIDC_CLIENT_SECRET: "s3cret", OIDC_NAME: "Pocket ID" };

describe("OpenID Connect", () => {
  it("signs in by the provider's sub, back to the page asked for; a changed email is still the same person", async () => {
    const provider = await fakeProvider();
    const { app } = await setup({ config: OIDC });
    expect(await (await app.request("/api/v1/auth-options")).json()).toMatchObject({ sso: { providerId: "oidc", name: "Pocket ID" }, trustedHeader: false });

    const back = await signInWithSso(app, provider, "/#/items/abc");
    expect(back.status).toBe(302);
    expect(back.headers.get("location")).toBe("/#/items/abc");
    const me = await app.request("/api/v1/me", { headers: { Cookie: cookiesOf(back) } });
    const who = ((await me.json()) as { user: { id: string; email: string } }).user;
    expect(who.email).toBe("pat@example.com");

    // The provider now says another address for the same sub: the same account.
    provider.next = { ...provider.next, email: "pat@new.example" };
    const again = await signInWithSso(app, provider);
    const me2 = await app.request("/api/v1/me", { headers: { Cookie: cookiesOf(again) } });
    expect(((await me2.json()) as { user: { id: string } }).user.id).toBe(who.id);

    // In the sign-in log as single sign-on.
    const log = (await (await app.request("/api/v1/security/sign-ins", { headers: { Cookie: cookiesOf(again) } })).json()) as { data: { method: string }[] };
    expect(log.data[0]!.method).toBe("sso");
  });

  it("links to an existing account by its verified email the first time; refuses unverified emails and uninvited people", async () => {
    const provider = await fakeProvider();
    const { app, auth } = await setup({ config: OIDC });
    await verifiedAccount(app, auth, "first"); // the first account (made with a password)
    const pat = await verifiedAccount(app, auth, "pat"); // pat@example.com

    const linked = await signInWithSso(app, provider);
    const me = (await (await app.request("/api/v1/me", { headers: { Cookie: cookiesOf(linked) } })).json()) as { user: { id: string } };
    const patsOwn = (await (await app.request("/api/v1/me", { headers: { Cookie: pat.cookie } })).json()) as { user: { id: string } };
    expect(me.user.id).toBe(patsOwn.user.id);

    // An address the provider hasn't checked: never.
    provider.next = { sub: "u-3", email: "first@example.com", email_verified: false, name: "Not first" };
    const unverified = await signInWithSso(app, provider);
    expect(unverified.headers.get("location")).toMatch(/sso=failed|error/);

    // Sign-up closed: someone nobody invited gets no account.
    const closed = await setup({ config: { ...OIDC, ALLOW_SIGNUP: false } });
    await verifiedAccount(closed.app, closed.auth, "first");
    provider.next = { sub: "u-2", email: "stranger@example.com", email_verified: true, name: "Stranger" };
    const refused = await signInWithSso(closed.app, provider);
    expect(refused.headers.get("location")).toBe("/?sso=failed&error=invite_only");
    expect(refused.headers.getSetCookie().some((c) => c.startsWith("better-auth.session_token=") && !c.includes("Max-Age=0"))).toBe(false);
  });

  it("tries discovery again later when the provider was down at the start", async () => {
    const provider = await fakeProvider();
    provider.down = true;
    const { app } = await setup({ config: OIDC });
    // Ferret starts (and answers) without the provider.
    expect((await app.request("/api/v1/auth-options")).status).toBe(200);
    expect((await app.request("/api/auth/get-session")).status).toBe(200);
    provider.down = false;
    const back = await signInWithSso(app, provider);
    expect(back.status).toBe(302);
    expect(back.headers.get("location")).toBe("/#/items");
  });
});

describe("trusted headers from a sign-in proxy", () => {
  const HEADERS = { TRUSTED_HEADER_AUTH: true, TRUSTED_HEADER_PROXIES: "10.0.0.2" };
  const fromProxy = (who: Record<string, string>) => ({ method: "POST", headers: { [PROXY_MARK]: "1", Origin: "http://localhost:8787", ...who } });

  it("signs in whoever the proxy says, only through the proxy", async () => {
    const { app, auth } = await setup({ config: HEADERS });
    await verifiedAccount(app, auth, "first");
    expect(await (await app.request("/api/v1/auth-options")).json()).toMatchObject({ trustedHeader: true, sso: null });

    // Without the mark (not from the proxy), the headers mean nothing.
    const direct = await app.request("/api/auth/sign-in/trusted-header", { method: "POST", headers: { "Remote-User": "pat", "Remote-Email": "pat@example.com", Origin: "http://localhost:8787" } });
    expect(direct.status).toBe(401);

    const ok = await app.request("/api/auth/sign-in/trusted-header", fromProxy({ "Remote-User": "pat", "Remote-Email": "Pat@Example.com", "Remote-Name": "Pat" }));
    expect(ok.status).toBe(200);
    const me = (await (await app.request("/api/v1/me", { headers: { Cookie: cookiesOf(ok) } })).json()) as { user: { id: string; email: string; name: string } };
    expect(me.user).toMatchObject({ email: "pat@example.com", name: "Pat" });

    // Known by the user name after that: a new email in the proxy is still pat.
    const later = await app.request("/api/auth/sign-in/trusted-header", fromProxy({ "Remote-User": "pat", "Remote-Email": "pat@new.example" }));
    const me2 = (await (await app.request("/api/v1/me", { headers: { Cookie: cookiesOf(later) } })).json()) as { user: { id: string } };
    expect(me2.user.id).toBe(me.user.id);

    // No email: nothing.
    expect((await app.request("/api/auth/sign-in/trusted-header", fromProxy({ "Remote-User": "sam" }))).status).toBe(401);
  });

  it("follows the sign-up rules; is off unless switched on", async () => {
    const closed = await setup({ config: { ...HEADERS, ALLOW_SIGNUP: false } });
    await verifiedAccount(closed.app, closed.auth, "first");
    expect((await closed.app.request("/api/auth/sign-in/trusted-header", fromProxy({ "Remote-User": "x", "Remote-Email": "x@example.com" }))).status).toBe(403);

    const off = await setup();
    expect((await off.app.request("/api/auth/sign-in/trusted-header", fromProxy({ "Remote-User": "x", "Remote-Email": "x@example.com" }))).status).toBe(404);
  });

  it("the Node server marks only connections from the proxy, and takes off a mark a client sent", () => {
    const proxies = proxyList("10.0.0.2");
    const req = (headers: Record<string, string> = {}) => new Request("http://ferret/api/auth/sign-in/trusted-header", { method: "POST", headers });
    expect(markAuthProxy(req(), "10.0.0.2", proxies).headers.get(PROXY_MARK)).toBe("1");
    expect(markAuthProxy(req(), "::ffff:10.0.0.2", proxies).headers.get(PROXY_MARK)).toBe("1");
    expect(markAuthProxy(req({ [PROXY_MARK]: "1" }), "203.0.113.9", proxies).headers.has(PROXY_MARK)).toBe(false);
    expect(markAuthProxy(req({ [PROXY_MARK]: "1" }), "10.0.0.2", null).headers.has(PROXY_MARK)).toBe(false);
  });
});
