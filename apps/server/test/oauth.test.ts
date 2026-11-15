/** Apps signing in to Ferret with OAuth for /mcp (lib/oauth.ts): the whole flow, as claude.ai runs it. */
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { job, member } from "../src/db/schema";
import { APP_CONNECTED_JOB } from "../src/jobs/security-alert";
import { purgeOAuth } from "../src/lib/oauth";
import { config, setup } from "./helpers";

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
async function register(app: Setup["app"], name = "Claude") {
  const res = await app.request("/api/auth/oauth2/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: name,
      redirect_uris: [REDIRECT],
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

async function startAuthorize(as: User["as"] | Setup["app"]["request"], clientId: string) {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
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
async function connect(s: Setup, u: User, clientId: string, pick: { householdId?: string; readOnly?: boolean } = {}) {
  const { location, verifier } = await startAuthorize(u.as, clientId);
  expect(location.startsWith("/#/connect?")).toBe(true);
  const chosen = await u.as("/api/v1/oauth/connect", {
    method: "POST",
    body: JSON.stringify({ householdId: pick.householdId ?? u.householdId, readOnly: pick.readOnly ?? false }),
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
  expect(back.origin + back.pathname).toBe(REDIRECT);
  expect(back.searchParams.get("state")).toBe("state-123");
  const token = await s.app.request("/api/auth/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: back.searchParams.get("code")!,
      redirect_uri: REDIRECT,
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

  it("only offer households the person is in, and only from a real sign-in", async () => {
    const s = await setup();
    const ann = await s.user("ann");
    const bob = await s.user("bob");
    const clientId = await register(s.app);
    await startAuthorize(ann.as, clientId);
    const theirs = await ann.as("/api/v1/oauth/connect", { method: "POST", body: JSON.stringify({ householdId: bob.householdId }) });
    expect(theirs.status).toBe(403);

    const key = (await (await ann.as("/api/v1/api-keys", { method: "POST", body: JSON.stringify({ name: "Script" }) })).json()) as { key: string };
    const withKey = await s.app.request("/api/v1/oauth/connect", {
      method: "POST",
      headers: { Authorization: `Bearer ${key.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ householdId: ann.householdId }),
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
