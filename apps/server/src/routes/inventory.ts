/**
 * /api/v1 — the public REST API. Thin: the work happens in lib/inventory.ts,
 * which the MCP tools call too, so the app and Claude always agree.
 * Accepts a session cookie or an API key (see lib/context.ts).
 */
import { householdSummary } from "../lib/summary";
import { PHOTO_ORDER } from "../lib/photo-order";
import * as usage from "../lib/usage";
import { usageReadingInput, itemsBulk, reviewItemBody, repairInput, repairPatch,
  askInput,
  dismissPartInput,
  itemFindQuery,
  type AttachmentKind,
  attachmentKinds,
  itemInput,
  itemPatch,
  listQuery,
  locationInput,
  locationPatch,
  propertyInput,
  propertyPatch,
  warrantyInput,
  warrantyPatch,
} from "@ferret/shared";
import { and, eq, isNull } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { attachment, item, user, warranty } from "../db/schema";
import { dismissSuggestedPart, itemParts } from "../lib/parts";
import { countEvent } from "../lib/analytics";
import { type AppEnv, body, callerOf, requireHousehold, requireUser, requireWriter } from "../lib/context";
import * as svc from "../lib/inventory";
import { ownLabelsOf } from "../lib/own-labels";
import { roomScansAvailable } from "../lib/room-scans";
import { itemChanged, logActivity, withStatus } from "../lib/inventory";
import { categoryDescendants, findTag } from "../lib/catalog";
import { addAttachment, analyzeAgain, attachmentFields, setMainPhoto } from "../lib/attachments";
import { sniffContentType } from "../lib/sniff";
import { isServerAdmin } from "../lib/server-admin";
import { itemHistory } from "../lib/history";
import { markMissing, markSeen } from "../lib/sightings";
import { itemLifespan, replacementForecast } from "../lib/lifespans";
import * as repairs from "../lib/repairs";
import { checkInReview, finishRoomReview, getRoomReview, roomsToReview, startRoomReview } from "../lib/room-reviews";
import * as warranties from "../lib/warranties";

export const inventory = new Hono<AppEnv>();

inventory.get("/me", requireUser, async (c) =>
  c.json({
    user: c.var.user,
    activeHouseholdId: c.var.apiKey?.householdId ?? c.var.session?.activeOrganizationId ?? null,
    /** The server admin sees Settings → Server (backups). */
    serverAdmin: await isServerAdmin(c.var.db, c.var.user.id),
    /** What this server can do that depends on how it runs (the app hides what it can't). */
    features: { fromWeb: Boolean(c.var.deps.downloader), homeAssistant: Boolean(c.var.deps.homeAssistant), roomScan: roomScansAvailable(c.var.deps, c.var.config.DEMO),
      // The AI helpers that read words (sorting imports, filters from words, estimates, typical upkeep), and speech to text.
      textAi: Boolean(c.var.deps.chat ?? c.var.deps.ai),
      speech: Boolean(c.var.deps.speech),
    },
  }),
);

inventory.use("/properties/*", requireUser, requireHousehold);
inventory.use("/properties", requireUser, requireHousehold);
inventory.use("/locations/*", requireUser, requireHousehold);
inventory.use("/locations", requireUser, requireHousehold);
inventory.use("/items/*", requireUser, requireHousehold);
inventory.use("/items", requireUser, requireHousehold);
inventory.use("/attachments/*", requireUser, requireHousehold);
inventory.use("/usage/*", requireUser, requireHousehold);
inventory.use("/room-reviews/*", requireUser, requireHousehold);
inventory.use("/room-reviews", requireUser, requireHousehold);
inventory.use("/replacements", requireUser, requireHousehold);
inventory.use("/repairs/*", requireUser, requireHousehold);
inventory.use("/warranties/*", requireUser, requireHousehold);
inventory.use("/warranties", requireUser, requireHousehold);

// ── Properties ──────────────────────────────────────────────────────────────
inventory.get("/properties", async (c) => c.json({ data: await svc.listProperties(callerOf(c)) }));

inventory.post("/properties", requireWriter, async (c) => {
  const input = await body(c.req.raw, propertyInput);
  return c.json(await svc.createProperty(callerOf(c), input), 201);
});

inventory.patch("/properties/:id", requireWriter, async (c) => {
  const input = await body(c.req.raw, propertyPatch);
  return c.json(await svc.updateProperty(callerOf(c), c.req.param("id"), input));
});

/** Only an empty property can go (409 while items are kept in it). */
inventory.delete("/properties/:id", requireWriter, async (c) => {
  await svc.deleteProperty(callerOf(c), c.req.param("id"));
  return c.body(null, 204);
});

/** A map picture of the property's address (PNG); ?scheme=dark for dark mode. */
inventory.get("/properties/:id/map", async (c) => {
  const bytes = await svc.propertyMap(callerOf(c), c.req.param("id"), c.req.query("scheme") === "dark" ? "dark" : "light");
  return c.body(bytes, 200, { "Content-Type": "image/png", "Cache-Control": "private, max-age=86400" });
});

// ── Locations ───────────────────────────────────────────────────────────────
inventory.get("/locations", async (c) =>
  c.json({ data: await svc.listLocations(callerOf(c), c.req.query("propertyId") || undefined) }),
);

/** Every property with its locations nested, and item counts — the Places screen. */
inventory.get("/locations/tree", async (c) => c.json(await svc.locationTree(callerOf(c))));

inventory.post("/locations", requireWriter, async (c) => {
  const input = await body(c.req.raw, locationInput);
  return c.json(await svc.createLocation(callerOf(c), input), 201);
});

/** Rename or move a location. Items anywhere below it are re-indexed (their location path changed). */
inventory.patch("/locations/:id", requireWriter, async (c) => {
  const input = await body(c.req.raw, locationPatch);
  return c.json(await svc.updateLocation(callerOf(c), c.req.param("id"), input));
});

/** Only an empty location can go (409 while items are kept anywhere inside it). */
inventory.delete("/locations/:id", requireWriter, async (c) => {
  await svc.deleteLocation(callerOf(c), c.req.param("id"));
  return c.body(null, 204);
});

// ── Items ───────────────────────────────────────────────────────────────────
inventory.get("/items", async (c) => {
  const { q, locationId, barcode, missing, categoryId, tag, containerItemId, topLevel, boxes, gone, collectionId, wanted, judge, documents, origin, notScannedSince, notSeenSince, misplaced, minWorth, maxWorth, boughtFrom, boughtTo, fold, sort, dir, limit, offset } = listQuery.parse(c.req.query());
  const v = callerOf(c);
  // A location or category includes everything nested inside it ("what's in the garage?").
  const tagged = tag ? await findTag(v, tag) : undefined;
  if (tag && !tagged) return c.json({ data: [], total: 0, limit, offset });
  const filter = {
    locationIds: locationId ? await svc.descendants(v, locationId) : undefined,
    categoryIds: categoryId ? await categoryDescendants(v, categoryId) : undefined,
    tagId: tagged?.id,
    containerItemId,
    topLevel: topLevel === "true",
    boxes: boxes === "true",
    barcode,
    missing,
    gone,
    collectionId,
    wanted,
    origin,
    notScannedSince,
    notSeenSince,
    misplaced,
    minWorthCents: minWorth,
    maxWorthCents: maxWorth,
    boughtFrom,
    boughtTo,
  };
  // A search the app checks twice (judge=later, then judge=now) is counted once.
  if (q && judge !== "now") countEvent(v.deps, "search");
  const page = q ? await svc.searchItems(v, q, filter, limit, judge === "later" ? "hold" : "now", { documents }) : await svc.listItems(v, filter, { limit, offset, sort, dir, fold: fold ? { except: categoryId } : undefined });
  return c.json({ ...page, data: await svc.asListing(v, page.data) });
});

/** The Overview screen: value, warranties to act on, what's missing, recent changes. */
inventory.get("/overview", requireUser, requireHousehold, async (c) => c.json(await svc.overview(callerOf(c))));
/** For home dashboards (Heimdall, Homepage…): counts and the total only (lib/summary.ts). */
inventory.get("/summary", requireUser, requireHousehold, async (c) => c.json(await householdSummary(callerOf(c))));

/** Ask Ferret: a question answered from the household's own items and documents, with sources. */
inventory.post("/ask", requireUser, requireHousehold, async (c) => {
  const { question } = await body(c.req.raw, askInput);
  return c.json(await svc.ask(callerOf(c), question));
});

/** Everything that happened to it, newest first: ?limit= (≤100, 30) &offset=. */
/** Maintenance by use: an item's readings (odometer, hour meter), and logging one. */
inventory.get("/items/:id/usage", async (c) => c.json(await usage.usageSummary(callerOf(c), c.req.param("id"))));
inventory.post("/items/:id/usage", requireWriter, async (c) =>
  c.json(await usage.addReading(callerOf(c), c.req.param("id"), await body(c.req.raw, usageReadingInput)), 201),
);
inventory.delete("/usage/:id", requireWriter, async (c) => {
  await usage.deleteReading(callerOf(c), c.req.param("id"));
  return c.body(null, 204);
});

/** A thing's parts and supplies, and the ones its manuals list that it doesn't have yet. */
inventory.get("/items/:id/parts", async (c) => c.json(await itemParts(callerOf(c), c.req.param("id"))));

/** A part a manual suggested isn't wanted. */
inventory.post("/items/:id/parts/dismiss", requireWriter, async (c) => {
  await dismissSuggestedPart(callerOf(c), c.req.param("id"), await body(c.req.raw, dismissPartInput));
  return c.body(null, 204);
});

/** Search inside one item: the passages of its documents, photos' text, warranties and notes that have the words. */
inventory.get("/items/:id/find", async (c) => {
  const { q } = itemFindQuery.parse(c.req.query());
  return c.json(await svc.findInOneItem(callerOf(c), c.req.param("id"), q));
});

/** Ask about one item: answered from its own documents and details, with citations. */
inventory.post("/items/:id/ask", async (c) => {
  const { question } = await body(c.req.raw, askInput);
  return c.json(await svc.askItem(callerOf(c), c.req.param("id"), question));
});

// ── Keeping track: last seen, can't find, room reviews (lib/sightings.ts, lib/room-reviews.ts) ─────────────
/** "Still here" (or found it): seen now — a box with everything in it. */
inventory.post("/items/:id/seen", requireWriter, async (c) => {
  const v = callerOf(c);
  const confirmed = await markSeen(v, c.req.param("id"));
  return c.json({ confirmed });
});
/** "Can't find it": missing until it's seen again or given up as lost. */
inventory.post("/items/:id/missing", requireWriter, async (c) => {
  await markMissing(callerOf(c), c.req.param("id"));
  return c.body(null, 204);
});
// ── Repairs and cost of ownership (lib/repairs.ts) ──────────────────────────
inventory.get("/items/:id/repairs", async (c) => c.json({ data: await repairs.listRepairs(callerOf(c), c.req.param("id")) }));
inventory.post("/items/:id/repairs", requireWriter, async (c) => c.json(await repairs.createRepair(callerOf(c), c.req.param("id"), await body(c.req.raw, repairInput)), 201));
inventory.patch("/repairs/:id", requireWriter, async (c) => c.json(await repairs.updateRepair(callerOf(c), c.req.param("id"), await body(c.req.raw, repairPatch))));
inventory.delete("/repairs/:id", requireWriter, async (c) => {
  await repairs.deleteRepair(callerOf(c), c.req.param("id"));
  return c.body(null, 204);
});
inventory.get("/items/:id/cost", async (c) => c.json(await repairs.ownershipCost(callerOf(c), c.req.param("id"))));

/** The replacement forecast: things by the year they're likely due (estimates from lifespans — lib/lifespans.ts). */
inventory.get("/replacements", async (c) => {
  const { years } = z.object({ years: z.coerce.number().int().min(1).max(30).default(10) }).parse(c.req.query());
  return c.json(await replacementForecast(callerOf(c), { years }));
});
inventory.get("/room-reviews", async (c) => c.json({ data: await roomsToReview(callerOf(c)) }));
inventory.get("/room-reviews/:locationId", async (c) => c.json(await getRoomReview(callerOf(c), c.req.param("locationId"))));
inventory.post("/room-reviews/:locationId", requireWriter, async (c) => c.json(await startRoomReview(callerOf(c), c.req.param("locationId"))));
inventory.post("/room-reviews/:locationId/items/:itemId", requireWriter, async (c) => {
  const { outcome, locationId } = await body(c.req.raw, reviewItemBody);
  return c.json(await checkInReview(callerOf(c), c.req.param("locationId"), c.req.param("itemId"), outcome, locationId));
});
inventory.post("/room-reviews/:locationId/finish", requireWriter, async (c) => c.json(await finishRoomReview(callerOf(c), c.req.param("locationId"))));

inventory.get("/items/:id/history", async (c) => {
  const page = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30), offset: z.coerce.number().int().min(0).default(0) }).parse(c.req.query());
  return c.json(await itemHistory(callerOf(c), c.req.param("id"), page));
});

inventory.get("/items/:id", async (c) => {
  const v = callerOf(c);
  const found = await svc.getItem(v, c.req.param("id"));
  const [listed] = await svc.asListing(v, [found]);
  const [by] = found.createdBy ? await c.var.db.select({ name: user.name }).from(user).where(eq(user.id, found.createdBy)) : [];
  return c.json({ ...listed, addedBy: by?.name ?? null, ownLabels: await ownLabelsOf(v, found.id), lifespan: await itemLifespan(v, found), ...(await repairs.replacementsOf(v, found)) });
});

/** One change to many things: move, category, tag, untag, delete (≤200 at a time). */
inventory.post("/items/bulk", requireWriter, async (c) => c.json(await svc.bulkItems(callerOf(c), await body(c.req.raw, itemsBulk))));

inventory.post("/items", requireWriter, async (c) => {
  const input = await body(c.req.raw, itemInput);
  return c.json(await svc.createItem(callerOf(c), input), 201);
});

inventory.patch("/items/:id", requireWriter, async (c) => {
  const input = await body(c.req.raw, itemPatch);
  return c.json(await svc.updateItem(callerOf(c), c.req.param("id"), input));
});

inventory.delete("/items/:id", requireWriter, async (c) => {
  await svc.deleteItem(callerOf(c), c.req.param("id"));
  return c.body(null, 204);
});

// ── Warranties ──────────────────────────────────────────────────────────────
/** Every warranty in the household, soonest to end first. ?status=active|expiring|expired narrows it. */
inventory.get("/warranties", async (c) => {
  const status = z.enum(["active", "expiring", "expired"]).optional().parse(c.req.query("status") || undefined);
  return c.json({ data: await svc.listWarranties(callerOf(c), status) });
});

inventory.get("/items/:id/warranties", async (c) => c.json({ data: await warranties.itemWarranties(callerOf(c), c.req.param("id")) }));

inventory.post("/items/:id/warranties", requireWriter, async (c) =>
  c.json(await warranties.createWarranty(callerOf(c), c.req.param("id"), await body(c.req.raw, warrantyInput)), 201),
);

inventory.patch("/warranties/:id", requireWriter, async (c) =>
  c.json(await warranties.updateWarranty(callerOf(c), c.req.param("id"), await body(c.req.raw, warrantyPatch))),
);

inventory.delete("/warranties/:id", requireWriter, async (c) => {
  await warranties.deleteWarranty(callerOf(c), c.req.param("id"));
  return c.body(null, 204);
});

// ── Attachments (photos & documents, stored encrypted per household) ────────
const uploadLimit = createMiddleware<AppEnv>((c, next) =>
  bodyLimit({
    maxSize: c.var.config.MAX_UPLOAD_MB * 1024 * 1024,
    onError: (c) =>
      c.json({ error: { code: "http_413", message: `Files can be up to ${c.var.config.MAX_UPLOAD_MB} MB` } }, 413),
  })(c, next),
);

inventory.get("/items/:id/attachments", async (c) => {
  const rows = await c.var.db
    .select(attachmentFields)
    .from(attachment)
    .where(
      and(
        eq(attachment.itemId, c.req.param("id")),
        eq(attachment.householdId, c.var.householdId),
        isNull(attachment.deletedAt),
      ),
    )
    .orderBy(...PHOTO_ORDER);
  return c.json({ data: rows });
});

/**
 * multipart/form-data: `file` (required), `kind` = photo | document (default photo); optionally the browser's own
 * `thumbnail` and `preview` (the vision model's copy) of a photo, so the server needn't make them (lib/attachments.ts).
 */
inventory.post("/items/:id/attachments", requireWriter, uploadLimit, async (c) => {
  const form = await c.req.parseBody().catch(() => {
    throw new HTTPException(400, { message: "Body must be multipart/form-data" });
  });
  const file = form.file;
  if (!(file instanceof File)) throw new HTTPException(400, { message: 'Send the upload in a "file" field' });
  const kind = z.enum(attachmentKinds).default("photo").safeParse(form.kind ?? undefined);
  if (!kind.success) throw new HTTPException(422, { message: "kind must be photo or document" });
  const bytes = new Uint8Array(await file.arrayBuffer());
  const copy = async (part: unknown) => (part instanceof File ? new Uint8Array(await part.arrayBuffer()) : undefined);
  const made = { thumbnail: await copy(form.thumbnail), preview: await copy(form.preview) };
  // repairId: a repair's before/after photo or invoice (the repair must be this item's) — not read for suggestions.
  const repairId = typeof form.repairId === "string" && form.repairId ? await repairs.repairOfItem(callerOf(c), c.req.param("id"), form.repairId) : null;
  // analyze=false: nothing to read in it (a room scan's crop of something already named) — no AI action spent.
  const analyze = form.analyze !== "false" && !repairId;
  const row = await addAttachment(callerOf(c), c.var.files, c.req.param("id"), { bytes, filename: file.name, kind: kind.data, made, analyze, repairId });
  // main=true: it's the item's picture from now on (a crop of one of its photos).
  if (form.main === "true" && kind.data === "photo") await setMainPhoto(callerOf(c), row.id);
  return c.json(row, 201);
});

/** Makes a photo its item's main photo: its picture in lists, first on its page. */
inventory.post("/attachments/:id/main", requireWriter, async (c) => c.json(await setMainPhoto(callerOf(c), c.req.param("id"))));

inventory.get("/attachments/:id/content", (c) => serveAttachment(c, "original"));
/** The small WebP for grids; falls back to the original when no thumbnail could be made. */
inventory.get("/attachments/:id/thumbnail", (c) => serveAttachment(c, "thumbnail"));

async function serveAttachment(c: Context<AppEnv>, variant: "original" | "thumbnail") {
  const [row] = await c.var.db
    .select()
    .from(attachment)
    .where(
      and(eq(attachment.id, c.req.param("id")!), eq(attachment.householdId, c.var.householdId), isNull(attachment.deletedAt)),
    );
  if (!row) throw new HTTPException(404, { message: "Attachment not found" });
  // An original removed to free space is answered with its small copy.
  const thumbnail = (variant === "thumbnail" || row.originalRemovedAt) && row.thumbnailKey;
  const bytes = await c.var.files.get(row.householdId, thumbnail ? row.thumbnailKey! : row.blobKey);
  if (!bytes) throw new HTTPException(404, { message: "Attachment file is missing" });
  return c.body(bytes, 200, {
    // A thumbnail is WebP when the server made it; one a browser made may be JPEG (Safari can't write WebP).
    "Content-Type": thumbnail ? (sniffContentType(bytes) ?? "image/webp") : row.contentType,
    ...(row.originalRemovedAt && variant === "original" && { "X-Ferret-Small-Copy": "1" }),
    "Content-Length": String(bytes.length),
    "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
    // Attachments never change once uploaded, so browsers can keep them a while.
    "Cache-Control": "private, max-age=86400",
  });
}

/** Analyses an attachment again (after a failure, or to have it read afresh). */
inventory.post("/attachments/:id/analyze", requireWriter, async (c) => c.json(await analyzeAgain(callerOf(c), c.req.param("id")), 202));

inventory.post("/attachments/:id/dismiss-suggestions", requireWriter, async (c) => {
  const [row] = await c.var.db
    .update(attachment)
    .set({ suggestionsDismissedAt: new Date() })
    .where(
      and(eq(attachment.id, c.req.param("id")), eq(attachment.householdId, c.var.householdId), isNull(attachment.deletedAt)),
    )
    .returning({ id: attachment.id });
  if (!row) throw new HTTPException(404, { message: "Attachment not found" });
  return c.body(null, 204);
});

inventory.delete("/attachments/:id", requireWriter, async (c) => {
  // Soft delete like everything else; the encrypted blob stays until a later purge.
  const [row] = await c.var.db
    .update(attachment)
    .set({ deletedAt: new Date() })
    .where(
      and(eq(attachment.id, c.req.param("id")), eq(attachment.householdId, c.var.householdId), isNull(attachment.deletedAt)),
    )
    .returning({ id: attachment.id, kind: attachment.kind, itemId: attachment.itemId });
  if (!row) throw new HTTPException(404, { message: "Attachment not found" });
  await logActivity(callerOf(c), "attachment.delete", row.id, `Removed a ${row.kind}`, row.itemId);
  await itemChanged(c.var, row.itemId);
  return c.body(null, 204);
});
