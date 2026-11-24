/** Apps signing in to Ferret with OAuth for /mcp (lib/oauth.ts): the whole flow, as claude.ai runs it. */
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { and, eq, isNull } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { appWebSession, job, member, oauthConsent, oauthResource } from "../src/db/schema";
import { APP_CONNECTED_JOB } from "../src/jobs/security-alert";
import { appWebCookieName } from "../src/lib/app-web-session";
import { purgeOAuth } from "../src/lib/oauth";
import { config, setup, verifiedAccount } from "./helpers";

type Setup = Awaited<ReturnType<typeof setup>>;
type User = Awaited<ReturnType<Setup["user"]>>;

const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const RESOURCE = `${new URL(config.PUBLIC_URL).origin}/mcp`;

function base64url(bytes: Uint8Array) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** An app registering itself (RFC 7591), like claude.ai does the first time. */
async function register(app: Setup["app"], name = "Claude", native?: string) {
  const res = await app.request("/api/auth/oauth2/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: name,
      redirect_uris: [native ?? REDIRECT],
      ...(native ? { application_type: "native" } : {}),
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: "ferret offline_access",
    }),
  });
  expect(res.status, await res.clone().text()).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

/** The part after `?` of a redirect into the web app (`/#/connect?…`). */
const queryOf = (location: string) => location.slice(location.indexOf("?") + 1);

async function startAuthorize(as: User["as"] | Setup["app"]["request"], clientId: string, redirect = REDIRECT) {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirect,
    scope: "ferret offline_access",
    state: "state-123",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: RESOURCE,
  });
  const res = await as(`/api/auth/oauth2/authorize?${params}`, { redirect: "manual" });
  expect(res.status, await res.clone().text()).toBe(302);
  return { location: res.headers.get("location")!, verifier };
}

/** Everything a person does on #/connect, then the app swapping its code for tokens. */
async function connect(s: Setup, u: User, clientId: string, pick: { householdId?: string; readOnly?: boolean; redirect?: string } = {}) {
  const redirect = pick.redirect ?? REDIRECT;
  const { location, verifier } = await startAuthorize(u.as, clientId, redirect);
  expect(location.startsWith("/#/connect?")).toBe(true);
  const chosen = await u.as("/api/v1/oauth/connect", {
    method: "POST",
    body: JSON.stringify({ clientId, householdId: pick.householdId ?? u.householdId, readOnly: pick.readOnly ?? false }),
  });
  expect(chosen.status).toBe(200);
  const cont = await u.as("/api/auth/oauth2/continue", { method: "POST", body: JSON.stringify({ postLogin: true, oauth_query: queryOf(location) }) });
  expect(cont.status, await cont.clone().text()).toBe(200);
  let { url } = (await cont.json()) as { url: string };
  if (url.startsWith("/#/connect/finish?")) {
    const consent = await u.as("/api/auth/oauth2/consent", { method: "POST", body: JSON.stringify({ accept: true, oauth_query: queryOf(url) }) });
    expect(consent.status, await consent.clone().text()).toBe(200);
    url = ((await consent.json()) as { url: string }).url;
  }
  const back = new URL(url);
  expect(`${back.protocol}${back.host ? `//${back.host}` : ""}${back.pathname}`).toBe(redirect);
  expect(back.searchParams.get("state")).toBe("state-123");
  const token = await s.app.request("/api/auth/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: back.searchParams.get("code")!,
      redirect_uri: redirect,
      client_id: clientId,
      code_verifier: verifier,
      resource: RESOURCE,
    }).toString(),
  });
  expect(token.status, await token.clone().text()).toBe(200);
  return (await token.json()) as { access_token: string; refresh_token: string; expires_in: number; scope: string };
}

async function refresh(app: Setup["app"], clientId: string, refreshToken: string) {
  return app.request("/api/auth/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId, resource: RESOURCE }).toString(),
  });
}

async function mcpClient(app: Setup["app"], token: string) {
  const transport = new StreamableHTTPClientTransport(new URL("http://ferret.test/mcp"), {
    fetch: async (url, init) => app.request(String(url), init),
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    return { isError: Boolean(result.isError), text: result.content[0]!.text };
  };
  return { client, call };
}

const mcpStatus = (app: Setup["app"], token: string) =>
  app.request("/mcp", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });

describe("apps signing in with OAuth", () => {
  it("say where to sign in: /mcp's 401 and the discovery documents", async () => {
    const { app } = await setup();
    const res = await app.request("/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(`resource_metadata="${new URL(config.PUBLIC_URL).origin}/.well-known/oauth-protected-resource/mcp"`);

    const resource = (await (await app.request("/.well-known/oauth-protected-resource/mcp")).json()) as Record<string, unknown>;
    expect(resource).toMatchObject({ resource: RESOURCE, authorization_servers: [`${new URL(config.PUBLIC_URL).origin}/api/auth`] });

    for (const path of ["/.well-known/oauth-authorization-server", "/.well-known/oauth-authorization-server/api/auth"]) {
      const meta = (await (await app.request(path)).json()) as Record<string, unknown>;
      expect(meta.issuer).toBe(`${new URL(config.PUBLIC_URL).origin}/api/auth`);
      expect(meta.registration_endpoint).toBe(`${new URL(config.PUBLIC_URL).origin}/api/auth/oauth2/register`);
      expect(meta.code_challenge_methods_supported).toEqual(["S256"]);
    }
    // A browser-based MCP client may read them from another origin.
    const cors = await app.request("/.well-known/oauth-protected-resource/mcp", { headers: { Origin: "http://localhost:6274" } });
    expect(cors.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("connect an app to one household: register, sign in, pick, swap the code, use /mcp, refresh", async () => {
    const s = await setup();
    const ann = await s.user("ann");
    await ann.addItem({ name: "Cordless drill" });
    const clientId = await register(s.app);

    const shown = (await (await ann.as(`/api/v1/oauth/connect?client_id=${clientId}`)).json()) as { name: string; redirectHost: string; households: { id: string }[] };
    expect(shown).toMatchObject({ name: "Claude", redirectHost: "claude.ai", households: [expect.objectContaining({ id: ann.householdId, role: "owner" })] });

    const tokens = await connect(s, ann, clientId);
    expect(tokens.access_token).toMatch(/^ferret_at_/);
    expect(tokens.refresh_token).toMatch(/^ferret_rt_/);

    const { call } = await mcpClient(s.app, tokens.access_token);
    expect((await call("search_inventory", { query: "drill" })).text).toContain("Cordless drill");
    const added = await call("create_item", { name: "Ladder" });
    expect(added.isError).toBe(false);
    // Things it adds say where they came from, like a key's.
    const items = (await (await ann.as("/api/v1/items?q=ladder")).json()) as { data: { origin: string; originDetail: string }[] };
    expect(items.data[0]).toMatchObject({ origin: "claude", originDetail: "Claude" });

    // The owner hears about it.
    const notices = await s.db.select().from(job).where(eq(job.type, APP_CONNECTED_JOB));
    expect(notices).toHaveLength(1);

    // Listed in Settings, then refreshed into a new pair (the old refresh token is used up).
    const grants = (await (await ann.as("/api/v1/oauth/grants")).json()) as { data: { name: string; readOnly: boolean }[] };
    expect(grants.data).toEqual([expect.objectContaining({ name: "Claude", readOnly: false, redirectHost: "claude.ai" })]);
    const renewed = await refresh(s.app, clientId, tokens.refresh_token);
    expect(renewed.status).toBe(200);
    const next = (await renewed.json()) as { access_token: string; refresh_token: string };
    expect(next.refresh_token).not.toBe(tokens.refresh_token);
    expect((await mcpStatus(s.app, next.access_token)).status).toBe(200);
  });

  it("keep working after the browser that approved them signs out (a refresh, as after any 401)", async () => {
    const s = await setup();
    const ann = await s.user("ann");
    const clientId = await register(s.app);
    const tokens = await connect(s, ann, clientId);
    await ann.as("/api/auth/sign-out", { method: "POST", body: "{}" });
    // Better Auth revokes the access token that browser session approved; the refresh token (offline_access) lives on.
    const renewed = await refresh(s.app, clientId, tokens.refresh_token);
    expect(renewed.status).toBe(200);
    const next = (await renewed.json()) as { access_token: string };
    expect((await mcpStatus(s.app, next.access_token)).status).toBe(200);
  });

  it("can be read-only, and never reuse an earlier read-write approval", async () => {
    const s = await setup();
    const ann = await s.user("ann");
    const clientId = await register(s.app);
    await connect(s, ann, clientId);

    // Asking again always shows #/connect; read-only this time means a new approval, not the old one.
    const { location } = await startAuthorize(ann.as, clientId);
    expect(location.startsWith("/#/connect?")).toBe(true);
    const readOnly = await connect(s, ann, clientId, { readOnly: true });
    const { client, call } = await mcpClient(s.app, readOnly.access_token);
    expect((await call("search_inventory", { query: "anything" })).isError).toBe(false);
    // Like a read-only key: the tools that change things aren't offered at all.
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toContain("search_inventory");
    expect(tools).not.toContain("create_item");
    const grants = (await (await ann.as("/api/v1/oauth/grants")).json()) as { data: { readOnly: boolean }[] };
    expect(grants.data.map((g) => g.readOnly).sort()).toEqual([false, true]);
  });

  it("stop at once when disconnected in Settings, or when the person leaves the household", async () => {
    const s = await setup();
    const ann = await s.user("ann");
    const clientId = await register(s.app);
    const tokens = await connect(s, ann, clientId);
    const [grant] = ((await (await ann.as("/api/v1/oauth/grants")).json()) as { data: { id: string }[] }).data;
    expect((await ann.as(`/api/v1/oauth/grants/${grant!.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await mcpStatus(s.app, tokens.access_token)).status).toBe(401);
    expect((await refresh(s.app, clientId, tokens.refresh_token)).status).not.toBe(200);
    expect(((await (await ann.as("/api/v1/oauth/grants")).json()) as { data: unknown[] }).data).toEqual([]);

    const again = await connect(s, ann, clientId);
    expect((await mcpStatus(s.app, again.access_token)).status).toBe(200);
    await s.db.delete(member).where(and(eq(member.organizationId, ann.householdId)));
    expect((await mcpStatus(s.app, again.access_token)).status).toBe(401);
  });

  it("let a phone app sign in with its own address scheme and use the REST API like a key", async () => {
    const s = await setup();
    const ann = await s.user("ann");
    await ann.addItem({ name: "Cordless drill" });
    const redirect = "com.example.ferret:/oauth";
    const clientId = await register(s.app, "Ferret for iPhone", redirect);
    const tokens = await connect(s, ann, clientId, { redirect });
    const api = (path: string, token = tokens.access_token, init: RequestInit = {}) =>
      s.app.request(`/api/v1${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...init.headers } });

    const me = (await (await api("/me")).json()) as { user: { id: string }; activeHouseholdId: string };
    const mine = (await (await ann.as("/api/v1/me")).json()) as { user: { id: string } };
    expect(me).toMatchObject({ user: { id: mine.user.id }, activeHouseholdId: ann.householdId });
    const found = (await (await api("/items?q=drill")).json()) as { data: { name: string }[] };
    expect(found.data.map((i) => i.name)).toContain("Cordless drill");
    const added = await api("/items", tokens.access_token, { method: "POST", body: JSON.stringify({ name: "Ladder" }) });
    expect(added.status).toBe(201);
    expect(await added.json()).toMatchObject({ origin: "api", originDetail: "Ferret for iPhone" });
    // Never a real sign-in: what needs one refuses it, as it refuses keys.
    expect((await api("/api-keys")).status).toBe(403);

    // Read-only means read-only here too.
    const readOnly = await connect(s, ann, clientId, { redirect, readOnly: true });
    expect((await api("/items?q=drill", readOnly.access_token)).status).toBe(200);
    expect((await api("/items", readOnly.access_token, { method: "POST", body: JSON.stringify({ name: "Rake" }) })).status).toBe(403);

    // Disconnected in Settings: refused at once, with a 401 the app can act on.
    const grants = ((await (await ann.as("/api/v1/oauth/grants")).json()) as { data: { id: string; readOnly: boolean }[] }).data;
    for (const g of grants) await ann.as(`/api/v1/oauth/grants/${g.id}`, { method: "DELETE" });
    expect((await api("/me")).status).toBe(401);
    expect((await api("/me", "ferret_at_madeup")).status).toBe(401);
  });

  describe("the phone app's web screens", () => {
    /** A phone app signed in, and a helper for its REST calls with the access token. */
    async function phone(readOnly = false) {
      const s = await setup();
      const ann = await s.user("ann");
      await ann.addItem({ name: "Cordless drill" });
      const redirect = "com.example.ferret:/oauth";
      const clientId = await register(s.app, "Ferret for iPhone", redirect);
      const tokens = await connect(s, ann, clientId, { redirect, readOnly });
      const api = (path: string, init: RequestInit = {}, token = tokens.access_token) =>
        s.app.request(`/api/v1${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...init.headers } });
      /** The app asking for a link, then its web view opening it: the cookie Ferret set, and where it went. */
      const handoff = async (to?: string, site: string | undefined = "none") => {
        const started = await api("/app/web-session", { method: "POST", body: JSON.stringify(to ? { to } : {}) });
        expect(started.status).toBe(201);
        const { url } = (await started.json()) as { url: string; expiresAt: string };
        const opened = await s.app.request(url, { headers: site ? { "Sec-Fetch-Site": site } : {} });
        const set = opened.headers.get("set-cookie") ?? "";
        return { url, opened, set, cookie: set.split(";")[0]! };
      };
      const web = (path: string, cookie: string, init: RequestInit = {}) =>
        s.app.request(`/api/v1${path}`, { ...init, headers: { Cookie: cookie, "Content-Type": "application/json", ...init.headers } });
      return { s, ann, clientId, tokens, api, handoff, web };
    }

    it("sign in through a one-time link, with the app's limits and the same-origin check", async () => {
      const { ann, handoff, web } = await phone();
      const { opened, set, cookie } = await handoff("#/settings/household");
      expect(opened.status).toBe(303);
      expect(opened.headers.get("location")).toBe("/#/settings/household");
      expect(opened.headers.get("cache-control")).toBe("no-store");
      expect(set).toMatch(/^ferret_app=[\w-]{43};/);
      expect(set).toMatch(/HttpOnly/);
      expect(set).toMatch(/SameSite=Strict/);
      expect(set).toMatch(/Path=\//);
      // Not the access token: a new secret only for these screens.
      expect(cookie).not.toContain("ferret_at_");

      const me = (await (await web("/me", cookie)).json()) as { household: { id: string; name: string; role: string; readOnly: boolean } };
      expect(me.household).toMatchObject({ id: ann.householdId, role: "owner", readOnly: false });
      expect(me.household.name).not.toBe("");
      expect((await web("/items?q=drill", cookie)).status).toBe(200);
      // Ferret's own page: allowed. Another site: refused.
      expect((await web("/items", cookie, { method: "POST", body: JSON.stringify({ name: "Ladder" }), headers: { "Sec-Fetch-Site": "same-origin" } })).status).toBe(201);
      expect((await web("/items", cookie, { method: "POST", body: JSON.stringify({ name: "Rake" }), headers: { "Sec-Fetch-Site": "cross-site", Origin: "https://evil.example" } })).status).toBe(403);
      // Never a real sign-in.
      expect((await web("/api-keys", cookie)).status).toBe(403);
      expect((await web("/oauth/grants", cookie)).status).toBe(403);
      // The cookie isn't a bearer token, and can't ask for more links.
      const asBearer = { headers: { Authorization: `Bearer ${cookie.split("=")[1]}` } };
      expect((await web("/me", "", asBearer)).status).toBe(401);
      expect((await web("/app/web-session", cookie, { method: "POST", body: "{}", headers: { "Sec-Fetch-Site": "same-origin" } })).status).toBe(401);
    });

    it("use each link once, within a minute, and only when the app opens it", async () => {
      const { s, handoff, api } = await phone();
      const first = await handoff();
      expect(first.cookie).toMatch(/^ferret_app=/);
      expect(first.opened.headers.get("location")).toBe("/#/");
      // Again: no cookie, just Ferret.
      const again = await s.app.request(first.url, { headers: { "Sec-Fetch-Site": "none" } });
      expect(again.headers.get("set-cookie")).toBeNull();
      expect(again.headers.get("location")).toBe("/#/");
      // A link from another site (someone planting their own sign-in): no cookie.
      const planted = await handoff(undefined, "cross-site");
      expect(planted.set).toBe("");
      // A browser that doesn't say: allowed (as for the same-origin check).
      expect((await handoff(undefined, undefined)).cookie).toMatch(/^ferret_app=/);
      // Made up, or a screen that isn't a hash route: no cookie, and never sent elsewhere.
      const madeUp = await s.app.request("/app/enter?code=nope&to=%2F%2Fevil.example", { headers: { "Sec-Fetch-Site": "none" } });
      expect(madeUp.headers.get("set-cookie")).toBeNull();
      expect(madeUp.headers.get("location")).toBe("/#/");
      expect((await api("/app/web-session", { method: "POST", body: JSON.stringify({ to: "https://evil.example" }) })).status).toBe(422);
      // Past its minute.
      const started = (await (await api("/app/web-session", { method: "POST", body: "{}" })).json()) as { url: string };
      await s.db.update(appWebSession).set({ expiresAt: new Date(Date.now() - 1) }).where(isNull(appWebSession.tokenHash));
      expect((await s.app.request(started.url, { headers: { "Sec-Fetch-Site": "none" } })).headers.get("set-cookie")).toBeNull();
    });

    it("only for an app's own token: not a key, a session, or nothing", async () => {
      const { s, ann } = await phone();
      expect((await s.app.request("/api/v1/app/web-session", { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } })).status).toBe(401);
      expect((await ann.as("/api/v1/app/web-session", { method: "POST", body: "{}" })).status).toBe(401);
      const key = (await (await ann.as("/api/v1/api-keys", { method: "POST", body: JSON.stringify({ name: "script" }) })).json()) as { key: string };
      const withKey = await s.app.request("/api/v1/app/web-session", { method: "POST", body: "{}", headers: { Authorization: `Bearer ${key.key}`, "Content-Type": "application/json" } });
      expect(withKey.status).toBe(401);
    });

    it("never take the place of a real sign-in in the same browser", async () => {
      const { s, ann, handoff } = await phone();
      const { cookie: annApp } = await handoff();
      const { cookie: bobSession } = await verifiedAccount(s.app, s.auth, "bob");
      const both = (await (await s.app.request("/api/v1/me", { headers: { Cookie: `${bobSession}; ${annApp}` } })).json()) as { user: { name: string }; household: { id: string } | null };
      expect(both.user.name).toBe("bob");
      expect(both.household?.id).not.toBe(ann.householdId);
      // A bad one beside a real sign-in changes nothing.
      expect((await s.app.request("/api/v1/me", { headers: { Cookie: `${bobSession}; ferret_app=madeup` } })).status).toBe(200);
      expect((await s.app.request("/api/v1/me", { headers: { Cookie: "ferret_app=madeup" } })).status).toBe(401);
      expect((await s.app.request("/api/v1/me", { headers: { Cookie: "ferret_app=%E0%A4%A" } })).status).toBe(401);
    });

    it("show read-only in /me, and refuse changes", async () => {
      const { handoff, web } = await phone(true);
      const { cookie } = await handoff();
      const me = (await (await web("/me", cookie)).json()) as { household: { readOnly: boolean } };
      expect(me.household.readOnly).toBe(true);
      expect((await web("/items", cookie, { method: "POST", body: JSON.stringify({ name: "Rake" }), headers: { "Sec-Fetch-Site": "same-origin" } })).status).toBe(403);
    });

    it("end when the app signs out or is disconnected", async () => {
      const { s, ann, api, handoff, web } = await phone();
      // Signing out of the app.
      const out = await handoff();
      expect((await api("/app/web-session", { method: "DELETE" })).status).toBe(204);
      expect((await web("/me", out.cookie)).status).toBe(401);
      // Disconnected in Settings.
      const disconnected = await handoff();
      expect((await web("/me", disconnected.cookie)).status).toBe(200);
      const grants = ((await (await ann.as("/api/v1/oauth/grants")).json()) as { data: { id: string }[] }).data;
      for (const g of grants) await ann.as(`/api/v1/oauth/grants/${g.id}`, { method: "DELETE" });
      expect((await web("/me", disconnected.cookie)).status).toBe(401);
      expect(await s.db.select().from(appWebSession)).toEqual([]);
    });

    it("stop for someone no longer in the household, and get purged once ended", async () => {
      const { s, ann, handoff, web } = await phone();
      const { cookie } = await handoff();
      await s.db.update(appWebSession).set({ expiresAt: new Date(Date.now() - 1) });
      expect((await web("/me", cookie)).status).toBe(401);
      expect(await purgeOAuth(s.db)).toBeGreaterThan(0);
      expect(await s.db.select().from(appWebSession)).toEqual([]);
      const fresh = await handoff();
      await s.db.delete(member).where(eq(member.organizationId, ann.householdId));
      expect((await web("/me", fresh.cookie)).status).toBe(401);
    });

    it("use a __Host- cookie on HTTPS", () => {
      expect(appWebCookieName({ PUBLIC_URL: "https://ferret.example.com" })).toBe("__Host-ferret_app");
      expect(appWebCookieName({ PUBLIC_URL: "http://10.0.0.2:8787" })).toBe("ferret_app");
    });
  });

  it("only offer households the person is in, and only from a real sign-in", async () => {
    const s = await setup();
    const ann = await s.user("ann");
    const bob = await s.user("bob");
    const clientId = await register(s.app);
    await startAuthorize(ann.as, clientId);
    const theirs = await ann.as("/api/v1/oauth/connect", { method: "POST", body: JSON.stringify({ clientId, householdId: bob.householdId }) });
    expect(theirs.status).toBe(403);

    const key = (await (await ann.as("/api/v1/api-keys", { method: "POST", body: JSON.stringify({ name: "Script" }) })).json()) as { key: string };
    const withKey = await s.app.request("/api/v1/oauth/connect", {
      method: "POST",
      headers: { Authorization: `Bearer ${key.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ clientId, householdId: ann.householdId }),
    });
    expect(withKey.status).toBe(403);
  });

  it("send someone who isn't signed in to sign in first", async () => {
    const s = await setup();
    const clientId = await register(s.app);
    const { location } = await startAuthorize(s.app.request.bind(s.app), clientId);
    expect(location.startsWith("/#/connect/sign-in?")).toBe(true);
    expect(new URLSearchParams(queryOf(location)).get("client_id")).toBe(clientId);
  });

  it("never let a choice made for one app approve another, or approve anything without Allow", async () => {
    const s = await setup();
    const ann = await s.user("ann");
    const good = await register(s.app, "Claude");
    const evil = await register(s.app, "Claude (really)");
    // Ann connects the real app; the other one's signed request is to hand within the ten minutes.
    await connect(s, ann, good);
    const { location } = await startAuthorize(ann.as, evil);
    const query = queryOf(location);
    for (const [path, body] of [
      ["/api/auth/oauth2/continue", { postLogin: true, oauth_query: query }],
      ["/api/auth/oauth2/consent", { accept: true, oauth_query: query }],
    ] as const) {
      const res = await ann.as(path, { method: "POST", body: JSON.stringify(body) });
      expect(res.status, path).toBe(403);
    }
    const grants = (await (await ann.as("/api/v1/oauth/grants")).json()) as { data: { name: string }[] };
    expect(grants.data.map((g) => g.name)).toEqual(["Claude"]);
  });

  it("refuse tokens from a code issued just before the app was disconnected", async () => {
    const s = await setup();
    const ann = await s.user("ann");
    const clientId = await register(s.app);
    const tokens = await connect(s, ann, clientId);
    const [grant] = ((await (await ann.as("/api/v1/oauth/grants")).json()) as { data: { id: string }[] }).data;
    // The approval goes; a token that somehow still exists for it (here: one not yet revoked) is refused anyway.
    await s.db.delete(oauthConsent).where(eq(oauthConsent.id, grant!.id));
    expect((await mcpStatus(s.app, tokens.access_token)).status).toBe(401);
  });

  it("are only for this server's /mcp, and never make Better Auth seed resources (it hung hosted's sign-ins, 2026.11.18)", async () => {
    const s = await setup();
    const ann = await s.user("ann");
    const clientId = await register(s.app);
    const other = await ann.as(`/api/auth/oauth2/authorize?${new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, scope: "ferret", code_challenge: "x".repeat(43), code_challenge_method: "S256", resource: "https://elsewhere.example/api" })}`, { redirect: "manual" });
    expect(other.status).toBe(400);
    await connect(s, ann, clientId);
    expect(await s.db.select().from(oauthResource)).toEqual([]);
  });

  it("let apps on a computer register with a localhost address (Claude Code, Cursor, MCP Inspector)", async () => {
    const { app } = await setup();
    const res = await app.request("/api/auth/oauth2/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_name: "Claude Code", redirect_uris: ["http://localhost:53682/callback"], token_endpoint_auth_method: "none" }),
    });
    expect(res.status, await res.clone().text()).toBe(201);
    // Not a web address that isn't loopback, though.
    const plain = await app.request("/api/auth/oauth2/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_name: "Sneaky", redirect_uris: ["http://example.com/callback"], token_endpoint_auth_method: "none" }),
    });
    expect(plain.status).toBe(400);
  });

  it("send the app back with access_denied on Cancel", async () => {
    const s = await setup();
    const ann = await s.user("ann");
    const clientId = await register(s.app);
    const { location } = await startAuthorize(ann.as, clientId);
    const res = await ann.as("/api/auth/oauth2/consent", { method: "POST", body: JSON.stringify({ accept: false, oauth_query: queryOf(location) }) });
    expect(res.status).toBe(200);
    const back = new URL(((await res.json()) as { url: string }).url);
    expect(back.origin + back.pathname).toBe(REDIRECT);
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("state")).toBe("state-123");
  });

  it("clear out apps nobody approved", async () => {
    const s = await setup();
    const ann = await s.user("ann");
    await register(s.app, "Nobody");
    const kept = await register(s.app, "Claude");
    await connect(s, ann, kept);
    expect(await purgeOAuth(s.db, Date.now() + 8 * 24 * 60 * 60 * 1000)).toBeGreaterThan(0);
    expect((await ann.as(`/api/v1/oauth/connect?client_id=${kept}`)).status).toBe(200);
  });
});
