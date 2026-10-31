/**
 * Room scans: photograph a room (or a box) once — up to five photos for a big room — and the vision model lists what
 * it sees: a name, the household's category for it, how many, and where in the photo (when the model says). Someone
 * reviews the list (untick junk, fix names, add what it missed) and the ticked ones become items there. Like every
 * model output, nothing is added on its own.
 *
 * One AI action per photo (lib/plan.ts, counted as a photo), never per thing found. The photos are kept (encrypted,
 * the vision-sized copy only) so the review can show them and each item found can link back to its room photo.
 */
import { itemInput, type RoomScan, type RoomScanCandidate, type RoomScanCommit } from "@ferret/shared";
import { and, desc, eq, inArray, isNull, lt, isNotNull } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { category, item, location, roomScan, user } from "../db/schema";
import { VISION_PX } from "../jobs/analyze";
import type { Db, Deps, JobHandler } from "../ports";
import type { FileStore } from "./files";
import { type Caller, createItem, locationIn, locationPaths, logActivity, notFound } from "./inventory";
import { recordUsage, requireAllowed, requireRoom } from "./plan";
import { sniffContentType } from "./sniff";
import { inList } from "./sql";

export const ROOM_SCAN_JOB = "room.scan";
export const MAX_ROOM_PHOTOS = 5;
/** At most this many things from one photo (the most valuable first). */
const MAX_PER_PHOTO = 25;
/** Each reply, thinking included: qwen3-vl thinks a few thousand tokens over a photo before it answers. */
const MAX_TOKENS = 7000;
const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"];

/** Where a scan's photo is kept (encrypted with the household's key). */
export const roomPhotoKey = (householdId: string, scanId: string, n: number) => `${householdId}/roomscan-${scanId}-${n}`;

/**
 * Room scans need the vision model, the job runner and a way to make the vision-sized copy — and aren't part of the
 * public demo (each one is minutes of the model, on the demo's shared budget).
 */
export const roomScansAvailable = (deps: Pick<Deps, "ai" | "jobs" | "images">, demo: boolean) => !demo && Boolean(deps.ai && deps.jobs && deps.images);

/** Start a scan: keep the photos, and look at them in the background (ROOM_SCAN_JOB). */
export async function createRoomScan(
  v: Caller,
  files: FileStore,
  input: { locationId?: string | null; containerItemId?: string | null; photos: Uint8Array[] },
  where: { demo: boolean },
): Promise<RoomScan> {
  if (where.demo) throw new HTTPException(403, { message: "Room scans aren't part of the demo" });
  if (!roomScansAvailable(v.deps, false)) throw new HTTPException(501, { message: "Room scans need the vision model, which isn't set up on this server" });
  if (Boolean(input.locationId) === Boolean(input.containerItemId)) throw new HTTPException(422, { message: "Say which room (locationId) or box (containerItemId)" });
  if (!input.photos.length || input.photos.length > MAX_ROOM_PHOTOS) {
    throw new HTTPException(422, { message: `Send 1 to ${MAX_ROOM_PHOTOS} photos` });
  }
  await placeOf(v, input);
  await requireAllowed(v, "ai.photo"); // a plan with AI and some left (counted per photo by the job)

  // The vision-sized copy only, upright and without GPS: it's what the model and the review look at.
  const copies: Uint8Array[] = [];
  for (const bytes of input.photos) {
    if (!PHOTO_TYPES.includes(sniffContentType(bytes) ?? "")) throw new HTTPException(415, { message: "Room scans take photos (JPEG, PNG, WebP, HEIC)" });
    const copy = await v.deps.images!.resize(bytes, VISION_PX, "jpeg");
    if (!copy) throw new HTTPException(415, { message: "Couldn't read one of the photos" });
    copies.push(copy);
  }
  const [row] = await v.db
    .insert(roomScan)
    .values({
      householdId: v.householdId,
      locationId: input.locationId ?? null,
      containerItemId: input.containerItemId ?? null,
      photoCount: copies.length,
      createdBy: v.userId,
    })
    .returning();
  for (const [n, copy] of copies.entries()) await files.put(v.householdId, roomPhotoKey(v.householdId, row!.id, n), copy);
  await v.deps.jobs!.enqueue(ROOM_SCAN_JOB, { scanId: row!.id });
  return describe(v, row!);
}

/** The room or box, checked to be the household's (a box must be one). Its name, for people. */
async function placeOf(v: Caller, at: { locationId?: string | null; containerItemId?: string | null }) {
  if (at.containerItemId) {
    const [box] = await v.db
      .select({ name: item.name, isContainer: item.isContainer })
      .from(item)
      .where(and(eq(item.id, at.containerItemId), eq(item.householdId, v.householdId), isNull(item.deletedAt)));
    if (!box) throw notFound("Box");
    if (!box.isContainer) throw new HTTPException(422, { message: `${box.name} isn't a box — mark it as one first` });
    return box.name;
  }
  if (at.locationId) {
    const [place] = await v.db.select({ id: location.id }).from(location).where(locationIn(v, at.locationId));
    if (!place) throw notFound("Location");
    return (await locationPaths(v)).get(at.locationId) ?? null;
  }
  return null;
}

async function describe(v: Caller, row: typeof roomScan.$inferSelect): Promise<RoomScan> {
  const [by] = row.createdBy ? await v.db.select({ name: user.name }).from(user).where(eq(user.id, row.createdBy)) : [];
  const made =
    row.status === "done"
      ? await v.db
          .select({ id: item.id, name: item.name })
          .from(item)
          .where(and(eq(item.householdId, v.householdId), eq(item.roomScanId, row.id), isNull(item.deletedAt)))
      : [];
  let placeName: string | null = null;
  try {
    placeName = await placeOf(v, row);
  } catch {
    placeName = null; // the room or box has gone since
  }
  return {
    id: row.id,
    status: row.status,
    locationId: row.locationId,
    containerItemId: row.containerItemId,
    placeName,
    photos: row.photoCount,
    candidates: row.candidates ?? [],
    error: row.error,
    by: by?.name ?? null,
    createdAt: row.createdAt.toISOString(),
    items: made,
  };
}

const scanIn = (v: Caller, id: string) => and(eq(roomScan.id, id), eq(roomScan.householdId, v.householdId), isNull(roomScan.deletedAt));

export async function getRoomScan(v: Caller, id: string) {
  const [row] = await v.db.select().from(roomScan).where(scanIn(v, id));
  if (!row) throw notFound("Room scan");
  return describe(v, row);
}

/** Scans still to finish: being looked at, or waiting to be reviewed (newest first). */
export async function openRoomScans(v: Caller) {
  const rows = await v.db
    .select()
    .from(roomScan)
    .where(and(eq(roomScan.householdId, v.householdId), isNull(roomScan.deletedAt), inArray(roomScan.status, ["pending", "ready", "failed"])))
    .orderBy(desc(roomScan.createdAt));
  return Promise.all(rows.map((r) => describe(v, r)));
}

/** One of a scan's photos (JPEG). */
export async function roomScanPhoto(v: Caller, files: FileStore, id: string, n: number) {
  const [row] = await v.db.select().from(roomScan).where(and(eq(roomScan.id, id), eq(roomScan.householdId, v.householdId)));
  if (!row || !Number.isInteger(n) || n < 0 || n >= row.photoCount) throw notFound("Photo");
  const bytes = await files.get(v.householdId, roomPhotoKey(v.householdId, id, n));
  if (!bytes) throw notFound("Photo");
  return bytes;
}

/**
 * Makes items of what was ticked, in the scanned room or box: origin "roomscan", linked to the scan, "Added … from a
 * room scan" in each one's history. Returns them in the order given (the app then adds each one's cropped photo).
 */
export async function commitRoomScan(v: Caller, id: string, input: RoomScanCommit) {
  const [row] = await v.db.select().from(roomScan).where(scanIn(v, id));
  if (!row) throw notFound("Room scan");
  if (row.status === "pending") throw new HTTPException(409, { message: "Still looking at the photos — try again in a moment" });
  if (row.status === "done") throw new HTTPException(409, { message: "Those things were added already" });
  if (!row.locationId && !row.containerItemId) throw new HTTPException(409, { message: "The room or box it was taken in has gone" });
  await requireRoom(v, { items: input.items.length });
  // Categories must be the household's: anything else is left without one.
  const categoryIds = [...new Set(input.items.map((i) => i.categoryId).filter((c): c is string => Boolean(c)))];
  const known = categoryIds.length
    ? new Set(
        (
          await v.db
            .select({ id: category.id })
            .from(category)
            .where(and(eq(category.householdId, v.householdId), isNull(category.deletedAt), inList(category.id, categoryIds)))
        ).map((c) => c.id),
      )
    : new Set<string>();
  const made: { id: string; name: string }[] = [];
  for (const it of input.items) {
    const fields = itemInput.parse({
      name: it.name,
      quantity: it.quantity ?? 1,
      categoryId: it.categoryId && known.has(it.categoryId) ? it.categoryId : null,
      ...(row.containerItemId ? { containerItemId: row.containerItemId } : { locationId: row.locationId }),
    });
    const created = await createItem(v, fields, { roomScanId: row.id });
    made.push({ id: created.id, name: created.name });
  }
  await v.db.update(roomScan).set({ status: "done", updatedAt: new Date() }).where(eq(roomScan.id, row.id));
  return { items: made };
}

/** Never mind this scan: it leaves the bell; its photos go with the next purge (lib/trash.ts). */
export async function dismissRoomScan(v: Caller, id: string) {
  const [row] = await v.db.update(roomScan).set({ deletedAt: new Date() }).where(scanIn(v, id)).returning({ id: roomScan.id });
  if (!row) throw notFound("Room scan");
  await logActivity(v, "roomscan.dismiss", row.id, "Dismissed a room scan");
}

/** Deleted scans older than `cutoff`: their photos and rows, for good (unless something found in them links back). */
export async function purgeRoomScans(p: { db: Db; files: FileStore }, cutoff: Date) {
  const old = await p.db
    .select({ id: roomScan.id, householdId: roomScan.householdId, photoCount: roomScan.photoCount })
    .from(roomScan)
    .where(and(isNotNull(roomScan.deletedAt), lt(roomScan.deletedAt, cutoff)));
  for (const s of old) {
    for (let n = 0; n < s.photoCount; n++) await p.files.delete(roomPhotoKey(s.householdId, s.id, n)).catch(() => {});
    await p.db.delete(roomScan).where(eq(roomScan.id, s.id));
  }
  return old.length;
}

/** Every stored room photo of these households (or all), for backups and deleting households. */
export async function roomPhotoKeys(db: Db, householdIds?: string[]) {
  const rows = await db
    .select({ id: roomScan.id, householdId: roomScan.householdId, photoCount: roomScan.photoCount })
    .from(roomScan)
    .where(householdIds ? inList(roomScan.householdId, householdIds) : undefined);
  return rows.flatMap((r) => Array.from({ length: r.photoCount }, (_, n) => ({ householdId: r.householdId, key: roomPhotoKey(r.householdId, r.id, n) })));
}

// ── Looking at the photos (the job) ─────────────────────────────────────────

/**
 * Two looks per photo. First the list — names, categories, counts — which must work. Then, best-effort, where each one
 * is (boxes): asked together, qwen3-vl deliberates over coordinates until it runs out of room, so apart they're quick
 * (~85 s + ~55 s on a home GPU). If the boxes don't come, the review shows the list without them.
 */
export const roomScanSchema = {
  type: "object",
  properties: {
    items: {
      type: "array",
      maxItems: MAX_PER_PHOTO,
      items: {
        type: "object",
        properties: { name: { type: "string" }, category: { type: ["string", "null"] }, count: { type: "integer" } },
        required: ["name", "category", "count"],
      },
    },
  },
  required: ["items"],
};

export function roomScanPrompt(categories: string[]) {
  // Short on purpose: qwen3-vl thinks before it answers, and every extra rule is more to deliberate over.
  return `This is a photo of a room — or a shelf, cupboard or open box — in someone's home. List the distinct things in it worth keeping in a home inventory: furniture, appliances, electronics, tools, lamps, decor, collectibles. Skip walls, floors, windows, curtains, built-in fixtures, plants and small clutter.
Reply with JSON only: items, at most ${MAX_PER_PHOTO}, the most valuable first, each with:
- name: short and generic ("Floor lamp", "Office chair"); the brand only if clearly readable.
- category: ${categories.length ? "one of the categories below, exactly as written, or null" : "null"}.
- count: how many you see.${categories.length ? `\n\nCategories:\n${categories.map((c) => `- ${c}`).join("\n")}` : ""}`;
}

export const boxesSchema = {
  type: "object",
  properties: { boxes: { type: "array", items: { type: ["array", "null"], items: { type: "number" } } } },
  required: ["boxes"],
};

export function boxesPrompt(names: string[]) {
  return `Find each of these things in the photo and give its bounding box as [x1, y1, x2, y2] on a 0–1000 grid from the top-left corner (null if you can't see it):
${names.map((n, i) => `${i + 1}. ${n}`).join("\n")}
Reply with JSON only: boxes, one per thing, in the same order.`;
}

const found = z.object({
  name: z.string().trim().min(1).max(200),
  category: z.string().trim().nullish().catch(null),
  count: z.number().int().min(1).max(1000).catch(1),
});

/** [x1, y1, x2, y2] on 0–1000 → [left, top, width, height] as fractions; null unless it's a real box in the picture. */
export function toBox(raw: unknown): RoomScanCandidate["box"] {
  const ok = z.array(z.number()).length(4).safeParse(raw);
  if (!ok.success) return null;
  const [x1, y1, x2, y2] = ok.data.map((n) => Math.min(1000, Math.max(0, n))) as [number, number, number, number];
  if (x2 - x1 < 5 || y2 - y1 < 5) return null;
  const f = (n: number) => Math.round(n) / 1000;
  return [f(x1), f(y1), f(x2 - x1), f(y2 - y1)];
}

/** The model's list for one photo, as candidates (anything malformed dropped; no boxes yet). */
export function toCandidates(raw: unknown, photo: number, categoryByPath: Map<string, string>): RoomScanCandidate[] {
  const list = z.object({ items: z.array(z.unknown()).catch([]) }).catch({ items: [] }).parse(raw).items;
  return list
    .flatMap((entry) => {
      const ok = found.safeParse(entry);
      return ok.success ? [ok.data] : [];
    })
    .slice(0, MAX_PER_PHOTO)
    .map((f) => ({
      name: f.name,
      categoryId: (f.category && categoryByPath.get(f.category.toLowerCase())) ?? null,
      quantity: f.count,
      photo,
      box: null,
    }));
}

/** The boxes reply, one per candidate in order; anything missing or malformed leaves that one without. */
export function withBoxes(candidates: RoomScanCandidate[], raw: unknown): RoomScanCandidate[] {
  const boxes = z.object({ boxes: z.array(z.unknown()).catch([]) }).catch({ boxes: [] }).parse(raw).boxes;
  return candidates.map((c, i) => ({ ...c, box: toBox(boxes[i]) }));
}

/** The household's categories by path ("Electronics › TV") and by bare name, lower-cased → id. */
async function categoryPaths(db: Db, householdId: string) {
  const rows = await db
    .select({ id: category.id, name: category.name, parentId: category.parentId })
    .from(category)
    .where(and(eq(category.householdId, householdId), isNull(category.deletedAt)));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const pathOf = (id: string) => {
    const parts: string[] = [];
    for (let at = byId.get(id), hops = 0; at && hops < 20; at = at.parentId ? byId.get(at.parentId) : undefined, hops++) parts.unshift(at.name);
    return parts.join(" › ");
  };
  const paths = rows.map((r) => ({ id: r.id, path: pathOf(r.id), name: r.name }));
  const lookup = new Map<string, string>();
  for (const p of paths) lookup.set(p.name.toLowerCase(), p.id);
  for (const p of paths) lookup.set(p.path.toLowerCase(), p.id); // a full path wins over a repeated name
  return { list: paths.map((p) => p.path).sort().slice(0, 150), lookup };
}

export function analyzeRoomScan(deps: { db: Db; files: FileStore; ai?: Deps["ai"]; entitlements?: Deps["entitlements"] }): JobHandler {
  return async (payload, { lastAttempt }) => {
    const { scanId } = z.object({ scanId: z.string() }).parse(payload);
    const [row] = await deps.db.select().from(roomScan).where(and(eq(roomScan.id, scanId), isNull(roomScan.deletedAt)));
    if (!row || row.status !== "pending") return; // dismissed, or done already
    const fail = (error: string) => deps.db.update(roomScan).set({ status: "failed", error, updatedAt: new Date() }).where(eq(roomScan.id, row.id));
    if (!deps.ai) return void (await fail("The vision model isn't set up on this server"));
    try {
      const categories = await categoryPaths(deps.db, row.householdId);
      const candidates: RoomScanCandidate[] = [];
      for (let n = 0; n < row.photoCount; n++) {
        const image = await deps.files.get(row.householdId, roomPhotoKey(row.householdId, row.id, n));
        if (!image) continue;
        const photo = { data: image, contentType: "image/jpeg" };
        const reply = await deps.ai.json({ prompt: roomScanPrompt(categories.list), schema: roomScanSchema, image: photo, maxTokens: MAX_TOKENS });
        let found = toCandidates(reply, n, categories.lookup);
        if (found.length) {
          try {
            const boxes = await deps.ai.json({ prompt: boxesPrompt(found.map((c) => c.name)), schema: boxesSchema, image: photo, maxTokens: MAX_TOKENS });
            found = withBoxes(found, boxes);
          } catch {
            // no boxes: the review shows the list on its own
          }
        }
        candidates.push(...found);
        // One AI action per photo, for whoever took it (lib/plan.ts) — counted as the model answers.
        await recordUsage({ db: deps.db, deps, householdId: row.householdId, userId: row.createdBy }, "ai.photo");
      }
      await deps.db.update(roomScan).set({ status: "ready", candidates, error: null, updatedAt: new Date() }).where(eq(roomScan.id, row.id));
    } catch (err) {
      if (lastAttempt) await fail("Couldn't look at the photos — try again later");
      throw err; // the runner retries with backoff
    }
  };
}
