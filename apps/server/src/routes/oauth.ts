/**
 * /api/v1/oauth — the web app's side of apps signing in with OAuth (lib/oauth.ts). A real sign-in only: an API key
 * can't approve apps or see them.
 * - GET /connect?client_id= — what the "Connect an app" screen (#/connect) shows: the app and your households.
 * - POST /connect — what was picked there (a household, read-only or not), for the rest of the flow.
 * - GET /grants, DELETE /grants/:id — Settings → Claude & API → Connected apps, for this household.
 */
import { type OAuthConnectRequest, type OAuthGrantSummary, oauthConnectInput } from "@ferret/shared";
import { and, desc, eq, inArray, isNull, max } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { member, oauthAccessToken, oauthClient, oauthConsent, oauthRefreshToken, organization } from "../db/schema";
import { type AppEnv, body, membership, requireHousehold, requireSession, requireUser } from "../lib/context";
import { endAppWebSessions } from "../lib/app-web-session";
import { oauthReference, parseReference, saveChoice } from "../lib/oauth";

export const oauth = new Hono<AppEnv>();
oauth.use(requireUser, requireSession);

/** The host an app sends people back to: shown on the consent screen and in Settings, so a look-alike name stands out. */
function redirectHost(uris: unknown): string | null {
  const first = Array.isArray(uris) ? uris[0] : typeof uris === "string" ? (JSON.parse(uris) as unknown[])[0] : null;
  if (typeof first !== "string") return null;
  try {
    const url = new URL(first);
    return url.protocol === "http:" || url.protocol === "https:" ? url.host : url.protocol.replace(/:$/, "");
  } catch {
    return null;
  }
}

/** Only an http(s) address from the app's registration is shown as a link. */
const webAddress = (value: string | null) => (value && /^https?:\/\//i.test(value) ? value : null);

oauth.get("/connect", async (c) => {
  const clientId = c.req.query("client_id");
  if (!clientId) throw new HTTPException(400, { message: "client_id is required" });
  const [client] = await c.var.db.select().from(oauthClient).where(eq(oauthClient.clientId, clientId));
  if (!client || client.disabled) throw new HTTPException(404, { message: "That app isn't registered here — start again from the app" });
  const households = await c.var.db
    .select({ id: organization.id, name: organization.name, role: member.role })
    .from(member)
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .where(eq(member.userId, c.var.user.id))
    .orderBy(organization.name);
  const result: OAuthConnectRequest = {
    name: client.name?.trim() || "An app",
    redirectHost: redirectHost(client.redirectUris),
    uri: webAddress(client.uri),
    logoUri: webAddress(client.icon),
    households,
    activeHouseholdId: c.var.session?.activeOrganizationId ?? null,
  };
  return c.json(result);
});

oauth.post("/connect", async (c) => {
  const input = await body(c.req.raw, oauthConnectInput);
  const role = await membership(c.var.db, input.householdId, c.var.user.id);
  if (!role) throw new HTTPException(403, { message: "Not a member of this household" });
  await saveChoice(c.var.db, {
    sessionId: c.var.session!.id,
    userId: c.var.user.id,
    clientId: input.clientId,
    householdId: input.householdId,
    // A viewer's apps can only look.
    readOnly: input.readOnly || role === "viewer",
  });
  return c.json({ ok: true });
});

/** This person's approvals (consents) for this household — read-only and read-write ones. */
async function grantRows(c: { var: AppEnv["Variables"] }, id?: string) {
  const references = [oauthReference(c.var.householdId, true), oauthReference(c.var.householdId, false)];
  return c.var.db
    .select({
      id: oauthConsent.id,
      clientId: oauthConsent.clientId,
      referenceId: oauthConsent.referenceId,
      createdAt: oauthConsent.createdAt,
      name: oauthClient.name,
      redirectUris: oauthClient.redirectUris,
    })
    .from(oauthConsent)
    .innerJoin(oauthClient, eq(oauthClient.clientId, oauthConsent.clientId))
    .where(
      and(
        eq(oauthConsent.userId, c.var.user.id),
        inArray(oauthConsent.referenceId, references),
        ...(id ? [eq(oauthConsent.id, id)] : []),
      ),
    )
    .orderBy(desc(oauthConsent.createdAt));
}

oauth.get("/grants", requireHousehold, async (c) => {
  const rows = await grantRows(c);
  const used = rows.length
    ? await c.var.db
        .select({ clientId: oauthAccessToken.clientId, referenceId: oauthAccessToken.referenceId, at: max(oauthAccessToken.createdAt) })
        .from(oauthAccessToken)
        .where(and(eq(oauthAccessToken.userId, c.var.user.id), inArray(oauthAccessToken.referenceId, [oauthReference(c.var.householdId, true), oauthReference(c.var.householdId, false)])))
        .groupBy(oauthAccessToken.clientId, oauthAccessToken.referenceId)
    : [];
  const lastUsed = new Map(used.map((u) => [`${u.clientId} ${u.referenceId}`, u.at]));
  const data: OAuthGrantSummary[] = rows.map((r) => {
    const at = lastUsed.get(`${r.clientId} ${r.referenceId}`);
    return {
      id: r.id,
      name: r.name?.trim() || "An app",
      redirectHost: redirectHost(r.redirectUris),
      readOnly: parseReference(r.referenceId)?.readOnly ?? true,
      createdAt: r.createdAt.toISOString(),
      lastUsedAt: at ? new Date(at).toISOString() : null,
    };
  });
  return c.json({ data });
});

/** Disconnect an app: its approval goes, and every token it holds for this household stops working now. */
oauth.delete("/grants/:id", requireHousehold, async (c) => {
  const [grant] = await grantRows(c, c.req.param("id"));
  if (!grant) throw new HTTPException(404, { message: "Not found" });
  const now = new Date();
  const same = (t: typeof oauthAccessToken | typeof oauthRefreshToken) =>
    and(eq(t.clientId, grant.clientId), eq(t.userId, c.var.user.id), eq(t.referenceId, grant.referenceId!), isNull(t.revoked));
  await c.var.db.update(oauthRefreshToken).set({ revoked: now }).where(same(oauthRefreshToken));
  await c.var.db.update(oauthAccessToken).set({ revoked: now }).where(same(oauthAccessToken));
  await c.var.db.delete(oauthConsent).where(eq(oauthConsent.id, grant.id));
  // Its web screens in the phone app too (they'd be refused anyway: they need the approval just removed).
  await endAppWebSessions(c.var.db, { clientId: grant.clientId, userId: c.var.user.id, referenceId: grant.referenceId! });
  return c.body(null, 204);
});
