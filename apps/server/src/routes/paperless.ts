/**
 * /api/v1/paperless — the household's Paperless-ngx (lib/paperless.ts). Connecting it (the address and token) is for
 * its owner and admins with a real sign-in; the inbox is for everyone in the household, sorting it for writers.
 */
import { paperlessAddInput, paperlessAttachInput, paperlessInput } from "@ferret/shared";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { type AppEnv, body, callerOf, requireHousehold, requireSession, requireUser, requireWriter } from "../lib/context";
import {
  addFromPaperless,
  attachPaperless,
  connectPaperless,
  disconnectPaperless,
  dismissPaperless,
  getConnection,
  listPaperlessDocuments,
  paperlessThumbnail,
  searchPaperless,
  syncPaperless,
} from "../lib/paperless";
import { isServerAdmin } from "../lib/server-admin";

export const paperless = new Hono<AppEnv>();
paperless.use(requireUser, requireHousehold);

const manager = (c: Parameters<typeof callerOf>[0]) => ({ ...callerOf(c), files: c.var.files });
const docId = (raw: string) => {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new HTTPException(404, { message: "Document not found" });
  return n;
};
const maxBytes = (c: Parameters<typeof callerOf>[0]) => c.var.config.MAX_UPLOAD_MB * 1024 * 1024;
const managers = async (c: Parameters<typeof callerOf>[0], next: () => Promise<void>) => {
  if (c.var.role !== "owner" && c.var.role !== "admin") throw new HTTPException(403, { message: "Only the household's owner and admins can connect Paperless" });
  await next();
};

/** Whether this server can connect to Paperless (and to its own network, for this person), and the household's connection. */
paperless.get("/", async (c) =>
  c.json({
    available: Boolean(c.var.deps.paperless),
    local: await isServerAdmin(c.var.db, c.var.user.id),
    connection: await getConnection(callerOf(c)),
  }),
);
paperless.put("/", requireSession, managers, async (c) => c.json(await connectPaperless(manager(c), await body(c.req.raw, paperlessInput))));
paperless.delete("/", requireSession, managers, async (c) => {
  await disconnectPaperless(callerOf(c));
  return c.body(null, 204);
});
paperless.post("/sync", requireWriter, async (c) => {
  if (!(await getConnection(callerOf(c)))) throw new HTTPException(409, { message: "Connect Paperless first (Settings → Household)" });
  const result = await syncPaperless(c.var.deps, c.var.files, c.var.householdId);
  return c.json({ ...result, connection: await getConnection(callerOf(c)) });
});
paperless.get("/documents", async (c) => {
  const status = c.req.query("status");
  return c.json(await listPaperlessDocuments(callerOf(c), status === "done" ? "done" : "new"));
});
paperless.get("/search", async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  if (!q) return c.json({ data: [] });
  return c.json({ data: await searchPaperless(manager(c), q.slice(0, 200)) });
});
paperless.get("/documents/:id/thumbnail", async (c) => {
  const thumb = await paperlessThumbnail(manager(c), docId(c.req.param("id")));
  const type = thumb.contentType.startsWith("image/") && thumb.contentType !== "image/svg+xml" ? thumb.contentType : "application/octet-stream";
  return c.body(thumb.bytes as Uint8Array<ArrayBuffer>, 200, { "Content-Type": type, "Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff" });
});
paperless.post("/documents/:id/add", requireWriter, async (c) =>
  c.json(await addFromPaperless(manager(c), docId(c.req.param("id")), await body(c.req.raw, paperlessAddInput), maxBytes(c)), 201),
);
paperless.post("/documents/:id/attach", requireWriter, async (c) =>
  c.json(await attachPaperless(manager(c), docId(c.req.param("id")), (await body(c.req.raw, paperlessAttachInput)).itemId, maxBytes(c))),
);
paperless.post("/documents/:id/dismiss", requireWriter, async (c) => {
  await dismissPaperless(callerOf(c), docId(c.req.param("id")));
  return c.body(null, 204);
});
paperless.post("/documents/:id/restore", requireWriter, async (c) => {
  await dismissPaperless(callerOf(c), docId(c.req.param("id")), true);
  return c.body(null, 204);
});
