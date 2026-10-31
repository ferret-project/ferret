/**
 * /mcp — the MCP endpoint (Streamable HTTP). API keys only: a key fixes the
 * user and household, and a read-only key (or a viewer) gets only read tools.
 */
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import { keyFromHeaders, verifyKey } from "../lib/api-keys";
import { countEvent } from "../lib/analytics";
import { type AppEnv, membership } from "../lib/context";
import { mcpAuthInfo, mcpHandler } from "../mcp/server";
import { householdTimeZone } from "../lib/household-time";
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

mcp.all("/", sizeLimit, async (c) => {
  const key = keyFromHeaders(c.req.raw.headers);
  const holder = key ? await verifyKey(c.var.auth, c.var.db, key) : null;
  if (!holder) {
    return c.json(
      { jsonrpc: "2.0", error: { code: -32001, message: "Ferret needs an API key: Authorization: Bearer ferret_… (Settings → API keys)" }, id: null },
      401,
      { "WWW-Authenticate": 'Bearer realm="ferret"' },
    );
  }
  const role = await membership(c.var.db, holder.key.householdId, holder.user.id);
  if (!role) {
    return c.json({ jsonrpc: "2.0", error: { code: -32003, message: "This API key's owner is no longer in that household" }, id: null }, 403);
  }
  try {
    await requireFeature({ deps: c.var.deps, householdId: holder.key.householdId }, "apiKeys");
  } catch (e) {
    if (!(e instanceof HTTPException)) throw e;
    return c.json({ jsonrpc: "2.0", error: { code: -32004, message: e.message }, id: null }, 402);
  }
  countEvent(c.var.deps, "mcp.call");
  const caller = {
    deps: c.var.deps,
    db: c.var.db,
    householdId: holder.key.householdId,
    userId: holder.user.id,
    timeZone: await householdTimeZone(c.var.db, holder.key.householdId),
    via: "mcp" as const,
    keyName: holder.key.name,
    readOnly: holder.key.readOnly || role === "viewer",
    files: c.var.files,
    maxUploadBytes: c.var.config.MAX_UPLOAD_MB * 1024 * 1024,
    demo: c.var.config.DEMO,
  };
  return mcpHandler.fetch(c.req.raw, { authInfo: mcpAuthInfo(caller, holder.key.id) });
});
