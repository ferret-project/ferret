/**
 * Share links (lib/shares.ts). `/api/v1/shares` manages them — the household's owner and admins, signed in (not an API
 * key). `/api/v1/shared/:token` is what a link opens, with no account: the view, its CSV, and (when shared) the shown
 * items' photos and documents. `/s/:token` is the short link itself, which opens the web app's page for it.
 */
import { shareInput } from "@ferret/shared";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { type AppEnv, body, callerOf, requireHousehold, requireSession, requireUser } from "../lib/context";
import { toCsv } from "../lib/export";
import { createShare, listShares, openShare, revokeShare, sharedFile, sharedRows, sharedView, shareViews } from "../lib/shares";
import { todayFor } from "../lib/household-time";

export const shares = new Hono<AppEnv>();
shares.use(requireUser, requireHousehold, requireSession, async (c, next) => {
  if (c.var.role !== "owner" && c.var.role !== "admin") throw new HTTPException(403, { message: "Only the household's owner and admins can share" });
  await next();
});
shares.get("/", async (c) => c.json({ data: await listShares(callerOf(c), c.var.files, c.var.config.PUBLIC_URL) }));
shares.post("/", async (c) => {
  const input = await body(c.req.raw, shareInput);
  return c.json(await createShare(callerOf(c), c.var.files, c.var.config.PUBLIC_URL, input), 201);
});
shares.post("/:id/revoke", async (c) => {
  await revokeShare(callerOf(c), c.req.param("id"));
  return c.body(null, 204);
});
shares.get("/:id/views", async (c) => c.json({ data: await shareViews(callerOf(c), c.req.param("id")) }));

/** No account: what a link opens. Never cached, never indexed, no referrer passed on. */
export const shared = new Hono<AppEnv>();
shared.use(async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
  c.header("X-Robots-Tag", "noindex, nofollow");
  c.header("Referrer-Policy", "no-referrer");
});
shared.get("/:token", async (c) => {
  const { link, v } = await openShare(c.var.deps, c.req.param("token"));
  const seen = { ipAddress: c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || null, userAgent: c.req.header("user-agent") ?? null };
  return c.json(await sharedView(v, link, seen));
});
shared.get("/:token/items.csv", async (c) => {
  const { link, v } = await openShare(c.var.deps, c.req.param("token"));
  const rows = (await sharedRows(v, link)).map((r) => ({ ...r, notes: null }));
  return c.body(toCsv(rows), 200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="shared-inventory-${todayFor(v)}.csv"`,
  });
});
for (const variant of ["original", "thumbnail"] as const) {
  shared.get(variant === "original" ? "/:token/files/:id" : "/:token/files/:id/thumbnail", async (c) => {
    const { link, v } = await openShare(c.var.deps, c.req.param("token"));
    const file = await sharedFile(v, link, c.req.param("id"));
    const thumb = variant === "thumbnail" && file.thumbnailKey;
    const bytes = await c.var.files.get(file.householdId, thumb ? file.thumbnailKey! : file.blobKey);
    if (!bytes) throw new HTTPException(404, { message: "That file is missing" });
    return c.body(bytes, 200, {
      "Content-Type": thumb ? "image/webp" : file.contentType,
      "Content-Length": String(bytes.length),
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
      "X-Content-Type-Options": "nosniff",
    });
  });
}

/** The short link: `/s/<token>` → the web app's page for it. */
export const shareShortLinks = new Hono<AppEnv>();
shareShortLinks.get("/:token{[\\w-]{20,100}}", (c) => c.redirect(`/#/s/${c.req.param("token")}`, 302));
