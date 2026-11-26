/**
 * /api/v1/inbox — photos, a receipt or something shared, read by the AI before anything is added (lib/inbox.ts).
 */
import { attachmentKinds, inboxCreate, inboxOnto, receiptLinesInput } from "@ferret/shared";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { addAttachment } from "../lib/attachments";
import { type AppEnv, body, callerOf, requireHousehold, requireUser, requireWriter } from "../lib/context";
import * as svc from "../lib/inbox";

export const inbox = new Hono<AppEnv>();
inbox.use("/*", requireUser, requireHousehold);
inbox.use("/", requireUser, requireHousehold);

const uploadLimit = createMiddleware<AppEnv>((c, next) =>
  bodyLimit({
    maxSize: c.var.config.MAX_UPLOAD_MB * 1024 * 1024,
    onError: (c) => c.json({ error: { code: "http_413", message: `Files can be up to ${c.var.config.MAX_UPLOAD_MB} MB` } }, 413),
  })(c, next),
);

/** What's waiting, newest first. */
inbox.get("/", async (c) => c.json({ data: await svc.listInbox(callerOf(c)) }));

/** How many are waiting. */
inbox.get("/count", async (c) => c.json({ count: await svc.inboxCount(callerOf(c)) }));

inbox.post("/", requireWriter, async (c) => c.json(await svc.createInboxEntry(callerOf(c), await body(c.req.raw, inboxCreate)), 201));

inbox.get("/:id", async (c) => c.json(await svc.getInboxEntry(callerOf(c), c.req.param("id"))));

/** multipart/form-data: `file`, `kind` = photo | document (default photo), and the browser's `thumbnail`/`preview`. */
inbox.post("/:id/files", requireWriter, uploadLimit, async (c) => {
  const form = await c.req.parseBody().catch(() => {
    throw new HTTPException(400, { message: "Body must be multipart/form-data" });
  });
  const file = form.file;
  if (!(file instanceof File)) throw new HTTPException(400, { message: 'Send the upload in a "file" field' });
  const kind = z.enum(attachmentKinds).default("photo").safeParse(form.kind ?? undefined);
  if (!kind.success) throw new HTTPException(422, { message: "kind must be photo or document" });
  const copy = async (part: unknown) => (part instanceof File ? new Uint8Array(await part.arrayBuffer()) : undefined);
  const row = await addAttachment(callerOf(c), c.var.files, { inboxId: c.req.param("id") }, {
    bytes: new Uint8Array(await file.arrayBuffer()),
    filename: file.name,
    kind: kind.data,
    made: { thumbnail: await copy(form.thumbnail), preview: await copy(form.preview) },
  });
  return c.json(row, 201);
});

/** Add it as a new thing (fields as for POST /items; left out: the entry's place, category, note and link). */
inbox.post("/:id/add", requireWriter, async (c) => {
  const raw = await c.req.json().catch(() => {
    throw new HTTPException(400, { message: "Body must be JSON" });
  });
  return c.json(await svc.addFromInbox(callerOf(c), c.req.param("id"), raw), 201);
});

/** Put its files on a thing already in Ferret. */
inbox.post("/:id/onto", requireWriter, async (c) => {
  const { itemId } = await body(c.req.raw, inboxOnto);
  return c.json(await svc.putInboxOnto(callerOf(c), c.req.param("id"), itemId));
});

/** Add the things on its receipt (as POST /attachments/{id}/lines): the first one ticked is made from the entry. */
inbox.post("/:id/lines", requireWriter, async (c) => c.json(await svc.addInboxLines(callerOf(c), c.var.files, c.req.param("id"), await body(c.req.raw, receiptLinesInput)), 201));

/** Discard it and its files. */
inbox.delete("/:id", requireWriter, async (c) => {
  await svc.discardInboxEntry(callerOf(c), c.var.files, c.req.param("id"));
  return c.body(null, 204);
});
