/**
 * Room reviews and keeping track: walk a place thing by thing — still here, moved, gone, can't find it — so the
 * inventory stays something you can trust. One review open per place at a time (anyone in the household carries it
 * on); each thing checked is a `room_review_entry`, changeable until the review is finished. Only the things kept right
 * there are checked one by one: a box confirmed is everything in it confirmed (lib/sightings.ts), and places inside
 * get reviews of their own.
 *
 * Also the dashboard's "Keeping track" card and the bell's gentle nudge (`trackingSummary`): things not seen in a
 * year, things nobody can find, the place reviewed longest ago.
 */
import type { ItemListing, LocationNode, ReviewOutcome, RoomReview, RoomToReview, TrackingSummary } from "@ferret/shared";
import { and, count, desc, eq, isNotNull, isNull, max, notExists, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { item, roomReview, roomReviewEntry, user } from "../db/schema";
import { asListing, type Caller, itemScope, locationTree, logActivity, notSeenSince, updateItem } from "./inventory";
import { markMissing, markSeen } from "./sightings";
import { inList } from "./sql";

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

/** Every place's node by id (with its path and how many things it holds). */
async function places(v: Caller) {
  const { properties } = await locationTree(v);
  const nodes = new Map<string, LocationNode>();
  const walk = (list: LocationNode[]) =>
    list.forEach((n) => {
      nodes.set(n.id, n);
      walk(n.children);
    });
  properties.forEach((p) => walk(p.locations));
  return nodes;
}

async function placeOf(v: Caller, locationId: string) {
  const node = (await places(v)).get(locationId);
  if (!node) throw new HTTPException(404, { message: "Place not found" });
  return node;
}

/** When each place was last reviewed (finished). */
async function lastReviewed(v: Caller) {
  const rows = await v.db
    .select({ locationId: roomReview.locationId, at: max(roomReview.finishedAt) })
    .from(roomReview)
    .where(and(eq(roomReview.householdId, v.householdId), isNotNull(roomReview.finishedAt)))
    .groupBy(roomReview.locationId);
  return new Map(rows.map((r) => [r.locationId, r.at ? new Date(r.at as unknown as number) : null]));
}

/** Reviews under way, by place: the review and how many things it has checked. */
async function openReviews(v: Caller) {
  const rows = await v.db
    .select({ id: roomReview.id, locationId: roomReview.locationId, startedAt: roomReview.startedAt, startedBy: user.name })
    .from(roomReview)
    .leftJoin(user, eq(user.id, roomReview.startedBy))
    .where(and(eq(roomReview.householdId, v.householdId), isNull(roomReview.finishedAt)));
  const done = rows.length
    ? await v.db
        .select({ reviewId: roomReviewEntry.reviewId, n: count() })
        .from(roomReviewEntry)
        .where(and(eq(roomReviewEntry.householdId, v.householdId), inList(roomReviewEntry.reviewId, rows.map((r) => r.id))))
        .groupBy(roomReviewEntry.reviewId)
    : [];
  const n = new Map(done.map((d) => [d.reviewId, d.n]));
  return new Map(rows.map((r) => [r.locationId, { ...r, done: n.get(r.id) ?? 0 }]));
}

/**
 * Places with things in them, the next to review first: reviews under way, then never reviewed (fullest first), then
 * the longest ago.
 */
export async function roomsToReview(v: Caller): Promise<RoomToReview[]> {
  const [nodes, reviewed, open] = await Promise.all([places(v), lastReviewed(v), openReviews(v)]);
  const rooms: RoomToReview[] = [];
  for (const n of nodes.values()) {
    if (!n.itemCount && !open.has(n.id)) continue;
    const o = open.get(n.id);
    rooms.push({
      locationId: n.id,
      path: n.path,
      items: n.itemCount,
      reviewedAt: reviewed.get(n.id)?.toISOString() ?? null,
      open: o ? { done: o.done, startedAt: o.startedAt.toISOString() } : null,
    });
  }
  const rank = (r: RoomToReview) => (r.open ? 0 : r.reviewedAt ? 2 : 1);
  return rooms.sort((a, b) => rank(a) - rank(b) || (a.reviewedAt ?? "").localeCompare(b.reviewedAt ?? "") || b.items - a.items || a.path.localeCompare(b.path));
}

/** The dashboard's "Keeping track" and the bell's nudge. */
export async function trackingSummary(v: Caller): Promise<TrackingSummary> {
  const yearAgo = new Date(Date.now() - YEAR_MS);
  const [[stale], [missing], rooms] = await Promise.all([
    v.db.select({ n: count() }).from(item).where(and(itemScope(v), notSeenSince(v, yearAgo))),
    v.db.select({ n: count() }).from(item).where(and(itemScope(v), isNotNull(item.missingSince))),
    roomsToReview(v),
  ]);
  return { notSeenYear: stale?.n ?? 0, misplaced: missing?.n ?? 0, nextRoom: rooms[0] ?? null };
}

async function currentReview(v: Caller, locationId: string) {
  const [r] = await v.db
    .select({ id: roomReview.id, startedAt: roomReview.startedAt, startedBy: user.name })
    .from(roomReview)
    .leftJoin(user, eq(user.id, roomReview.startedBy))
    .where(and(eq(roomReview.householdId, v.householdId), eq(roomReview.locationId, locationId), isNull(roomReview.finishedAt)))
    .orderBy(desc(roomReview.startedAt))
    .limit(1);
  return r ?? null;
}

/** A place's review: what's there still to check, what's been checked, and the places inside it. */
export async function getRoomReview(v: Caller, locationId: string): Promise<RoomReview> {
  const node = await placeOf(v, locationId);
  const [review, reviewed] = await Promise.all([currentReview(v, locationId), lastReviewed(v)]);
  const entries = review
    ? await v.db
        .select({ itemId: roomReviewEntry.itemId, outcome: roomReviewEntry.outcome, at: roomReviewEntry.at })
        .from(roomReviewEntry)
        .where(and(eq(roomReviewEntry.householdId, v.householdId), eq(roomReviewEntry.reviewId, review.id)))
        .orderBy(desc(roomReviewEntry.at))
    : [];
  const checkedIds = entries.map((e) => e.itemId);
  const [here, checkedRows] = await Promise.all([
    v.db
      .select()
      .from(item)
      .where(
        and(
          itemScope(v, { locationId, topLevel: true }),
          review
            ? notExists(
                v.db
                  .select({ one: sql`1` })
                  .from(roomReviewEntry)
                  .where(and(eq(roomReviewEntry.reviewId, review.id), eq(roomReviewEntry.itemId, item.id))),
              )
            : undefined,
        ),
      )
      // Boxes first (each confirms what's in it), then by name.
      .orderBy(desc(item.isContainer), sql`lower(${item.name})`),
    checkedIds.length ? v.db.select().from(item).where(and(itemScope(v, { gone: "include" }), inList(item.id, checkedIds))) : [],
  ]);
  const [toCheck, checkedListed] = await Promise.all([asListing(v, here), asListing(v, checkedRows)]);
  const byId = new Map<string, ItemListing>(checkedListed.map((r) => [r.id, r as unknown as ItemListing]));
  return {
    locationId,
    path: node.path,
    review: review ? { id: review.id, startedAt: review.startedAt.toISOString(), startedBy: review.startedBy ?? null } : null,
    reviewedAt: reviewed.get(locationId)?.toISOString() ?? null,
    toCheck: toCheck as unknown as ItemListing[],
    checked: entries.flatMap((e) => {
      const it = byId.get(e.itemId);
      return it ? [{ ...it, outcome: e.outcome, checkedAt: e.at.toISOString() }] : [];
    }),
    inside: node.children.filter((c) => c.totalCount > 0).map((c) => ({ locationId: c.id, name: c.name, items: c.totalCount })),
  };
}

/** Start a review of a place, or carry on the one under way. */
export async function startRoomReview(v: Caller, locationId: string) {
  await placeOf(v, locationId);
  if (!(await currentReview(v, locationId))) {
    await v.db.insert(roomReview).values({ householdId: v.householdId, locationId, startedBy: v.userId || null, startedAt: new Date() });
  }
  return getRoomReview(v, locationId);
}

/**
 * What the review found for one thing: still here (seen — a box with everything in it), moved (to `to`, and seen
 * there), gone (the GoneDialog has already said what happened), can't find it (missing). Checking it again changes it.
 */
export async function checkInReview(v: Caller, locationId: string, itemId: string, outcome: ReviewOutcome, to?: string) {
  const review = await currentReview(v, locationId);
  if (!review) throw new HTTPException(409, { message: "Start the review first" });
  const [it] = await v.db.select({ id: item.id, locationId: item.locationId, disposition: item.disposition }).from(item).where(and(eq(item.id, itemId), itemScope(v, { gone: "include" })));
  if (!it) throw new HTTPException(404, { message: "Item not found" });
  const [already] = await v.db
    .select({ outcome: roomReviewEntry.outcome })
    .from(roomReviewEntry)
    .where(and(eq(roomReviewEntry.reviewId, review.id), eq(roomReviewEntry.itemId, it.id)));
  // Only what's in this place (or was, when this review checked it).
  if (!already && it.locationId !== locationId) throw new HTTPException(422, { message: "That isn't kept here" });
  if (outcome === "here") {
    if (it.locationId !== locationId) await updateItem(v, it.id, { locationId });
    await markSeen(v, it.id, "reviewed");
  } else if (outcome === "moved") {
    if (!to || to === locationId) throw new HTTPException(422, { message: "Say where it is now" });
    await updateItem(v, it.id, { locationId: to }); // checks the place is the household's
    await markSeen(v, it.id, "reviewed");
  } else if (outcome === "missing") {
    await markMissing(v, it.id);
  } else if (!it.disposition) {
    throw new HTTPException(422, { message: "Say what happened to it first" });
  }
  await v.db
    .insert(roomReviewEntry)
    .values({ householdId: v.householdId, reviewId: review.id, itemId: it.id, outcome, at: new Date() })
    .onConflictDoUpdate({ target: [roomReviewEntry.reviewId, roomReviewEntry.itemId], set: { outcome, at: new Date() } });
  return getRoomReview(v, locationId);
}

const OUTCOME_WORDS: Record<ReviewOutcome, string> = { here: "still here", moved: "moved", gone: "gone", missing: "can't find" };

/** Done: the review is finished (the place's "last reviewed"), with a line in recent changes. */
export async function finishRoomReview(v: Caller, locationId: string) {
  const node = await placeOf(v, locationId);
  const review = await currentReview(v, locationId);
  if (!review) throw new HTTPException(409, { message: "No review under way" });
  const counts = await v.db
    .select({ outcome: roomReviewEntry.outcome, n: count() })
    .from(roomReviewEntry)
    .where(and(eq(roomReviewEntry.householdId, v.householdId), eq(roomReviewEntry.reviewId, review.id)))
    .groupBy(roomReviewEntry.outcome);
  await v.db.update(roomReview).set({ finishedAt: new Date() }).where(and(eq(roomReview.id, review.id), eq(roomReview.householdId, v.householdId)));
  const order = Object.keys(OUTCOME_WORDS);
  const words = counts
    .sort((a, b) => order.indexOf(a.outcome) - order.indexOf(b.outcome))
    .map((c) => `${c.n} ${OUTCOME_WORDS[c.outcome]}`)
    .join(", ");
  await logActivity(v, "location.review", locationId, words ? `Reviewed ${node.name}: ${words}` : `Reviewed ${node.name}`);
  return getRoomReview(v, locationId);
}
