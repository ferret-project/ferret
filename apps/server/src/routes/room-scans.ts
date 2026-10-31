/**
 * /api/v1/room-scans — photograph a room, review what the vision model found, add what's ticked (lib/room-scans.ts).
 */
import { roomScanCommit } from "@ferret/shared";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { type AppEnv, body, callerOf, requireHousehold, requireUser, requireWriter } from "../lib/context";
import * as svc from "../lib/room-scans";

export const roomScans = new Hono<AppEnv>();
roomScans.use("/*", requireUser, requireHousehold);
roomScans.use("/", requireUser, requireHousehold);

/** Up to five photos, each as big as an upload may be. */
const photosLimit = createMiddleware<AppEnv>((c, next) =>
  bodyLimit({
    maxSize: svc.MAX_ROOM_PHOTOS * c.var.config.MAX_UPLOAD_MB * 1024 * 1024,
    onError: (c) => c.json({ error: { code: "http_413", message: `Photos can be up to ${c.var.config.MAX_UPLOAD_MB} MB each` } }, 413),
  })(c, next),
);

/** Scans still to finish (being looked at, ready to review, or failed). */
roomScans.get("/", async (c) => c.json({ data: await svc.openRoomScans(callerOf(c)) }));

/** multipart/form-data: `photo` (1–5 of them), and `locationId` or `containerItemId`. 202: being looked at. */
roomScans.post("/", requireWriter, photosLimit, async (c) => {
  const form = await c.req.parseBody({ all: true }).catch(() => {
    throw new HTTPException(400, { message: "Body must be multipart/form-data" });
  });
  const parts = ([] as unknown[]).concat(form.photo ?? []);
  const photos = await Promise.all(parts.filter((p): p is File => p instanceof File).map(async (f) => new Uint8Array(await f.arrayBuffer())));
  const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const scan = await svc.createRoomScan(callerOf(c), c.var.files, {
    locationId: text(form.locationId),
    containerItemId: text(form.containerItemId),
    photos,
  }, { demo: c.var.config.DEMO });
  return c.json(scan, 202);
});

roomScans.get("/:id", async (c) => c.json(await svc.getRoomScan(callerOf(c), c.req.param("id"))));

roomScans.get("/:id/photos/:n", async (c) => {
  const bytes = await svc.roomScanPhoto(callerOf(c), c.var.files, c.req.param("id"), Number(c.req.param("n")));
  return c.body(bytes, 200, { "Content-Type": "image/jpeg", "Content-Length": String(bytes.length), "Cache-Control": "private, max-age=86400" });
});

/** Add what was ticked: `items` in order; the answer lists the new items in the same order. */
roomScans.post("/:id/add", requireWriter, async (c) => c.json(await svc.commitRoomScan(callerOf(c), c.req.param("id"), await body(c.req.raw, roomScanCommit)), 201));

roomScans.delete("/:id", requireWriter, async (c) => {
  await svc.dismissRoomScan(callerOf(c), c.req.param("id"));
  return c.body(null, 204);
});
