/**
 * "To confirm" (#/to-confirm): what the AI suggested and nobody has looked at yet, in one place — so tidying up after
 * adding things is one list, not a visit to every thing. The things whose photos and receipts have suggestions that
 * differ from what the thing says (the app shows each as on its page: Apply / Dismiss), replacement-cost estimates
 * not used yet, and how many wait in the lists with their own screens (filled in by AI, duplicates, suggested
 * maintenance, Paperless, room scans, the inbox). Nothing here changes anything.
 */
import type { Attachment, AttachmentSuggestions, ToConfirm } from "@ferret/shared";
import { and, desc, eq, gt, isNotNull, isNull, sql } from "drizzle-orm";
import { attachment, item, warranty } from "../db/schema";
import { aiFillEntries } from "./ai-fill";
import { attachmentFields } from "./attachments";
import { duplicateCount } from "./duplicates";
import { type Caller, asListing, itemScope, withTags } from "./inventory";
import { inboxCount as waitingInInbox } from "./inbox";
import { inboxCount } from "./paperless";
import { PHOTO_ORDER } from "./photo-order";
import { openRoomScans } from "./room-scans";
import { inList } from "./sql";
import { suggestedTaskCount } from "./suggested-tasks";

/** At most this many things in the list at once (newest suggestions first); the rest come as these are handled. */
const MAX_ITEMS = 30;
const MAX_ESTIMATES = 50;

const FIELDS = ["brand", "model", "serialNumber", "barcode", "purchaseDate", "purchasePriceCents", "returnBy", "categoryId"] as const;
const same = (a: unknown, b: unknown) => String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();

/** Whether a file says anything the thing doesn't (a close cousin of the app's pendingSuggestions, which decides exactly). */
function hasNews(all: AttachmentSuggestions, thing: typeof item.$inferSelect, hasWarranty: boolean) {
  // A receipt of several things: its own name, brand, model, price and category are nobody's (the app reads the
  // thing's own line instead); its lines, day and return window still count.
  const { name: _n, brand: _b, model: _m, purchasePriceCents: _p, categoryId: _c, ...rest } = all;
  const s: AttachmentSuggestions = all.lines?.length ? rest : all;
  // A name only for a thing nobody has named yet: the model's "Cordless drill" isn't news for "Dad's drill".
  if (s.name && thing.name === "New item") return true;
  if (FIELDS.some((f) => s[f] != null && !same(s[f], thing[f]))) return true;
  return Boolean((s.lines?.length && !s.linesHandled) || (s.warrantyMonths && !hasWarranty) || (s.returnDays && !thing.returnBy));
}

/** The things with suggestions waiting (newest first, at most `max`). */
async function thingsWithNews(v: Caller, max: number) {
  const files = await v.db
    .select({ ...attachmentFields, thing: item })
    .from(attachment)
    .innerJoin(item, eq(item.id, attachment.itemId))
    .where(
      and(
        eq(attachment.householdId, v.householdId),
        isNull(attachment.deletedAt),
        eq(attachment.analysisStatus, "done"),
        isNull(attachment.suggestionsDismissedAt),
        isNotNull(attachment.analysis),
        itemScope(v),
      ),
    )
    .orderBy(desc(attachment.analyzedAt))
    .limit(1000);
  const candidates = [...new Set(files.map((f) => f.thing.id))];
  const warrantied = new Set(
    candidates.length
      ? (await v.db.select({ itemId: warranty.itemId }).from(warranty).where(and(eq(warranty.householdId, v.householdId), isNull(warranty.deletedAt), inList(warranty.itemId, candidates)))).map((w) => w.itemId)
      : [],
  );
  const ids: string[] = [];
  for (const f of files) {
    if (ids.length >= max) break;
    if (!ids.includes(f.thing.id) && f.analysis && hasNews(f.analysis.suggestions, f.thing, warrantied.has(f.thing.id))) ids.push(f.thing.id);
  }
  return ids;
}

const estimatesWaiting = (v: Caller) => and(itemScope(v), isNull(item.replacementCents), isNotNull(item.replacementEstimate), gt(sql`json_extract(${item.replacementEstimate}, '$.cents')`, 0));

export async function toConfirm(v: Caller): Promise<ToConfirm> {
  const ids = await thingsWithNews(v, MAX_ITEMS);

  const things = ids.length ? await v.db.select().from(item).where(and(itemScope(v), inList(item.id, ids))) : [];
  const listings = new Map((await withTags(v, await asListing(v, things))).map((l) => [l.id, l]));
  const [allFiles, warranties] = ids.length
    ? await Promise.all([
        v.db.select(attachmentFields).from(attachment).where(and(eq(attachment.householdId, v.householdId), isNull(attachment.deletedAt), inList(attachment.itemId, ids))).orderBy(...PHOTO_ORDER),
        v.db.select({ itemId: warranty.itemId, endsOn: warranty.endsOn }).from(warranty).where(and(eq(warranty.householdId, v.householdId), isNull(warranty.deletedAt), inList(warranty.itemId, ids))),
      ])
    : [[], []];

  const estimates = await v.db
    .select()
    .from(item)
    .where(estimatesWaiting(v))
    .orderBy(desc(sql`json_extract(${item.replacementEstimate}, '$.at')`))
    .limit(MAX_ESTIMATES);
  const estimateListings = new Map((await asListing(v, estimates)).map((l) => [l.id, l]));

  const [aiFilled, duplicates, suggestedTasks, paperless, scans] = await Promise.all([
    aiFillEntries(v).then((e) => e.length),
    duplicateCount(v),
    suggestedTaskCount(v),
    inboxCount(v),
    openRoomScans(v),
  ]);
  return {
    items: ids.flatMap((id) => {
      const listing = listings.get(id);
      if (!listing) return [];
      return [
        {
          item: listing as unknown as ToConfirm["items"][number]["item"],
          attachments: allFiles.filter((a) => a.itemId === id) as unknown as Attachment[],
          warranties: warranties.filter((w) => w.itemId === id).map((w) => ({ endsOn: w.endsOn })),
        },
      ];
    }),
    estimates: estimates.map((e) => ({
      itemId: e.id,
      name: e.name,
      photoId: estimateListings.get(e.id)?.photoId ?? null,
      cents: e.replacementEstimate!.cents,
      reasoning: e.replacementEstimate!.reasoning,
      valueCents: e.valueCents,
      purchasePriceCents: e.purchasePriceCents,
    })),
    counts: { aiFilled, duplicates, suggestedTasks, paperless, roomScans: scans.filter((s) => s.status !== "pending").length, inbox: await waitingInInbox(v) },
  };
}

/** How many wait in "To confirm" itself (for the bell): things with suggestions, and estimates. */
export async function toConfirmCount(v: Caller) {
  const [ids, [estimates]] = await Promise.all([thingsWithNews(v, 100), v.db.select({ n: sql<number>`count(*)` }).from(item).where(estimatesWaiting(v))]);
  return ids.length + Number(estimates?.n ?? 0);
}
