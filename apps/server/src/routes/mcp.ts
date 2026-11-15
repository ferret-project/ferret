/**
 * /mcp — the MCP endpoint (Streamable HTTP). An API key, or an app's OAuth access token (lib/oauth.ts): either fixes
 * the user and household, and a read-only one (or a viewer) gets only read tools.
 */
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import { keyFromHeaders, verifyKey } from "../lib/api-keys";
import { ACCESS_TOKEN_PREFIX, verifyOAuthToken } from "../lib/oauth";
import { countEvent } from "../lib/analytics";
import { type AppEnv, membership } from "../lib/context";
import { mcpAuthInfo, mcpHandler } from "../mcp/server";
import { householdLocale } from "../lib/household-time";
import { requireFeature } from "../lib/plan";
import { HTTPException } from "hono/http-exception";

export const mcp = new Hono<AppEnv>();

/** Photos arrive as base64 (a third bigger than the file): room for one upload, plus the JSON-RPC around it. */
const sizeLimit = createMiddleware<AppEnv>((c, next) =>
  bodyLimit({
    maxSize: Math.ceil(c.var.config.MAX_UPLOAD_MB * 1024 * 1024 * 1.4) + 64 * 1024,
    onError: (c) => c.json({ jsonrpc: "2.0", error: { code: -32600, message: "Request too large" }, id: null }, 413),
  })(c, next),
);

/** Who's asking: an API key's holder, or the account and household an app was approved for. */
async function holderOf(c: Context<AppEnv>) {
  const bearer = c.req.header("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (bearer?.startsWith(ACCESS_TOKEN_PREFIX)) {
    const app = await verifyOAuthToken(c.var.db, bearer);
    return app && { userId: app.userId, householdId: app.householdId, role: app.role, readOnly: app.readOnly, name: app.clientName, id: `oauth:${app.clientId}` };
  }
  const key = keyFromHeaders(c.req.raw.headers);
  const holder = key ? await verifyKey(c.var.auth, c.var.db, key) : null;
  if (!holder) return null;
  const role = await membership(c.var.db, holder.key.householdId, holder.user.id);
  if (!role) return "left" as const;
  return { userId: holder.user.id, householdId: holder.key.householdId, role, readOnly: holder.key.readOnly, name: holder.key.name, id: holder.key.id };
}

mcp.all("/", sizeLimit, async (c) => {
  const holder = await holderOf(c);
  if (!holder) {
    // RFC 9728: where an app finds out how to sign in (the protected resource's metadata names the authorization server).
    const metadata = `${new URL(c.var.config.PUBLIC_URL).origin}/.well-known/oauth-protected-resource/mcp`;
    return c.json(
      { jsonrpc: "2.0", error: { code: -32001, message: "Ferret needs you to sign in, or an API key: Authorization: Bearer ferret_… (Settings → Claude & API)" }, id: null },
      401,
      { "WWW-Authenticate": `Bearer realm="ferret", resource_metadata="${metadata}"` },
    );
  }
  if (holder === "left") {
    return c.json({ jsonrpc: "2.0", error: { code: -32003, message: "This API key's owner is no longer in that household" }, id: null }, 403);
  }
  try {
    await requireFeature({ deps: c.var.deps, householdId: holder.householdId }, "apiKeys");
  } catch (e) {
    if (!(e instanceof HTTPException)) throw e;
    return c.json({ jsonrpc: "2.0", error: { code: -32004, message: e.message }, id: null }, 402);
  }
  countEvent(c.var.deps, "mcp.call");
  const caller = {
    deps: c.var.deps,
    db: c.var.db,
    householdId: holder.householdId,
    userId: holder.userId,
    ...(await householdLocale(c.var.db, holder.householdId)),
    via: "mcp" as const,
    keyName: holder.name,
    readOnly: holder.readOnly || holder.role === "viewer",
    files: c.var.files,
    maxUploadBytes: c.var.config.MAX_UPLOAD_MB * 1024 * 1024,
    demo: c.var.config.DEMO,
  };
  return mcpHandler.fetch(c.req.raw, { authInfo: mcpAuthInfo(caller, holder.id) });
});
