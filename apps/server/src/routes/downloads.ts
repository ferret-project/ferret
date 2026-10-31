/** "Add from a web address" — /api/v1/items/:id/downloads (the server fetches it; public internet only). */
import { downloadInput } from "@ferret/shared";
import { Hono } from "hono";
import { type AppEnv, body, callerOf, requireHousehold, requireUser, requireWriter } from "../lib/context";
import { dismissDownload, listDownloads, requestDownload } from "../lib/downloads";

export const downloads = new Hono<AppEnv>();
// Mounted at /api/v1: only its own paths, so unknown API paths still 404.
downloads.use("/items/:id/downloads", requireUser, requireHousehold);
downloads.use("/downloads/*", requireUser, requireHousehold);

downloads.get("/items/:id/downloads", async (c) => c.json({ data: await listDownloads(callerOf(c), c.req.param("id")) }));

downloads.post("/items/:id/downloads", requireWriter, async (c) =>
  c.json(await requestDownload(callerOf(c), c.req.param("id"), await body(c.req.raw, downloadInput)), 202),
);

downloads.delete("/downloads/:id", requireWriter, async (c) => {
  await dismissDownload(callerOf(c), c.req.param("id"));
  return c.body(null, 204);
});
