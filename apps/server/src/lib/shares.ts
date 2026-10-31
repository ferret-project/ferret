/**
 * Share links: a read-only view of the insurance report (the whole household or one property), or of a tag's or a
 * category's things, for someone without an account — an insurer, an executor. Made by owners and admins (a real
 * sign-in), for 7, 30 or 90 days, and can be turned off; every opening is logged (`share_view`).
 *
 * The token is 32 random bytes: found by its SHA-256 (`token_hash`), and sealed with the household key so the link can
 * be copied again from Settings. What a link shows is worked out when it's opened (the report as it is now), only for
 * things you still have; with `includeFiles`, each shown item's photos and documents open too — and nothing else.
 */
import { PHOTO_ORDER } from "./photo-order";
import type { ShareInput, ShareLinkSummary, SharedView, ShareViewEntry } from "@ferret/shared";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { attachment, category, organization, property, shareLink, shareView, user } from "../db/schema";
import { categoryDescendants, categoryInfo, findTag } from "./catalog";
import { exportRows } from "./export";
import type { FileStore } from "./files";
import { type Caller, type ItemFilter, listProperties, logActivity, notFound } from "./inventory";
import { householdTimeZone } from "./household-time";
import { featureOn, requireFeature } from "./plan";
import { inList } from "./sql";

const DAY_MS = 86_400_000;
const sealLabel = (id: string) => `share:${id}`;

export async function hashToken(token: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const shareUrl = (appUrl: string, token: string) => `${appUrl}/s/${token}`;

type Row = typeof shareLink.$inferSelect;

/** "Insurance report — Highland House", "Tag: Jewelry", "Category: Electronics › TV". */
async function titleOf(v: Caller, r: Pick<Row, "kind" | "propertyId" | "tag" | "categoryId">) {
  if (r.kind === "tag") return `Things tagged ${r.tag}`;
  if (r.kind === "category") return `${r.categoryId ? ((await categoryInfo(v)).get(r.categoryId)?.path ?? "A category") : "A category"}`;
  if (!r.propertyId) return "Insurance report";
  const [p] = await v.db.select({ name: property.name }).from(property).where(eq(property.id, r.propertyId));
  return `Insurance report — ${p?.name ?? "a property"}`;
}

const isActive = (r: Row, now = Date.now()) => !r.revokedAt && r.expiresAt.getTime() > now;

async function summary(v: Caller, files: FileStore, appUrl: string, r: Row & { by?: string | null }): Promise<ShareLinkSummary> {
  return {
    id: r.id,
    kind: r.kind,
    title: await titleOf(v, r),
    label: r.label,
    includeFiles: r.includeFiles,
    url: shareUrl(appUrl, await files.open(v.householdId, sealLabel(r.id), r.tokenSealed)),
    createdAt: r.createdAt.toISOString(),
    createdBy: r.by ?? null,
    expiresAt: r.expiresAt.toISOString(),
    revokedAt: r.revokedAt?.toISOString() ?? null,
    active: isActive(r),
    views: r.views,
    lastViewedAt: r.lastViewedAt?.toISOString() ?? null,
  };
}

export async function createShare(v: Caller, files: FileStore, appUrl: string, input: ShareInput & { days: 7 | 30 | 90 }) {
  await requireFeature(v, "shareLinks");
  if (input.kind === "report" && input.propertyId) {
    const [p] = await v.db
      .select({ id: property.id })
      .from(property)
      .where(and(eq(property.id, input.propertyId), eq(property.householdId, v.householdId), isNull(property.deletedAt)));
    if (!p) throw notFound("Property");
  }
  if (input.kind === "tag" && !(await findTag(v, input.tag!))) throw notFound("Tag");
  if (input.kind === "category") {
    const [c] = await v.db
      .select({ id: category.id })
      .from(category)
      .where(and(eq(category.id, input.categoryId!), eq(category.householdId, v.householdId), isNull(category.deletedAt)));
    if (!c) throw notFound("Category");
  }
  const id = crypto.randomUUID();
  const token = newToken();
  const [row] = await v.db
    .insert(shareLink)
    .values({
      id,
      householdId: v.householdId,
      kind: input.kind,
      propertyId: input.kind === "report" ? (input.propertyId ?? null) : null,
      tag: input.kind === "tag" ? input.tag! : null,
      categoryId: input.kind === "category" ? input.categoryId! : null,
      label: input.label ?? null,
      includeFiles: input.includeFiles ?? true,
      tokenHash: await hashToken(token),
      tokenSealed: await files.seal(v.householdId, sealLabel(id), token),
      expiresAt: new Date(Date.now() + input.days * DAY_MS),
      createdBy: v.userId,
    })
    .returning();
  const made = await summary(v, files, appUrl, row!);
  await logActivity(v, "share.create", id, `Shared ${made.title}${made.label ? ` (${made.label})` : ""} for ${input.days} days`);
  return made;
}

export async function listShares(v: Caller, files: FileStore, appUrl: string) {
  const rows = await v.db
    .select({ s: shareLink, by: user.name })
    .from(shareLink)
    .leftJoin(user, eq(user.id, shareLink.createdBy))
    .where(eq(shareLink.householdId, v.householdId))
    .orderBy(desc(shareLink.createdAt))
    .limit(100);
  return Promise.all(rows.map(({ s, by }) => summary(v, files, appUrl, { ...s, by })));
}

export async function revokeShare(v: Caller, id: string) {
  const [row] = await v.db
    .update(shareLink)
    .set({ revokedAt: new Date() })
    .where(and(eq(shareLink.id, id), eq(shareLink.householdId, v.householdId), isNull(shareLink.revokedAt)))
    .returning();
  if (!row) throw notFound("Share link");
  await logActivity(v, "share.revoke", id, `Turned off a share link (${await titleOf(v, row)})`);
}

export async function shareViews(v: Caller, id: string): Promise<ShareViewEntry[]> {
  const [row] = await v.db.select({ id: shareLink.id }).from(shareLink).where(and(eq(shareLink.id, id), eq(shareLink.householdId, v.householdId)));
  if (!row) throw notFound("Share link");
  const rows = await v.db.select().from(shareView).where(eq(shareView.linkId, id)).orderBy(desc(shareView.at)).limit(200);
  return rows.map((r) => ({ at: r.at.toISOString(), ipAddress: r.ipAddress, userAgent: r.userAgent }));
}

// ── Opening a link (no account) ─────────────────────────────────────────────

/** The link for a token, acting as its maker in its household — or why it doesn't open. */
export async function openShare(deps: Caller["deps"], token: string) {
  if (!/^[\w-]{20,100}$/.test(token)) throw new HTTPException(404, { message: "This link doesn't work" });
  const [row] = await deps.db.select().from(shareLink).where(eq(shareLink.tokenHash, await hashToken(token)));
  if (!row) throw new HTTPException(404, { message: "This link doesn't work" });
  if (row.revokedAt) throw new HTTPException(410, { message: "This link was turned off by whoever shared it" });
  if (row.expiresAt.getTime() <= Date.now()) throw new HTTPException(410, { message: "This link has expired — ask for a new one" });
  // Its household's plan no longer has share links: paused, not gone (it works again if the plan does). The person
  // opening it has no account here, so it doesn't say why.
  if (!(await featureOn({ deps, householdId: row.householdId }, "shareLinks"))) {
    throw new HTTPException(403, { message: "This link is paused — ask whoever shared it" });
  }
  const v: Caller = { deps, db: deps.db, householdId: row.householdId, userId: row.createdBy ?? "", timeZone: await householdTimeZone(deps.db, row.householdId), via: "web" };
  return { link: row, v };
}

async function filterOf(v: Caller, r: Row): Promise<ItemFilter | null> {
  if (r.kind === "tag") {
    const t = await findTag(v, r.tag!);
    return t ? { tagId: t.id } : null; // the tag was removed: nothing to show
  }
  if (r.kind === "category") return r.categoryId ? { categoryIds: await categoryDescendants(v, r.categoryId) } : null;
  return {};
}

export async function sharedRows(v: Caller, r: Row) {
  const filter = await filterOf(v, r);
  return filter ? exportRows(v, { propertyId: r.propertyId ?? undefined, filter }) : [];
}

/** What the link shows now; logs the opening. */
export async function sharedView(v: Caller, r: Row, seen: { ipAddress: string | null; userAgent: string | null }): Promise<SharedView> {
  const rows = await sharedRows(v, r);
  const files: SharedView["files"] = {};
  if (r.includeFiles && rows.length) {
    const found = await v.db
      .select({ id: attachment.id, itemId: attachment.itemId, kind: attachment.kind, filename: attachment.filename, contentType: attachment.contentType })
      .from(attachment)
      .where(and(eq(attachment.householdId, v.householdId), inList(attachment.itemId, rows.map((x) => x.id)), isNull(attachment.deletedAt)))
      .orderBy(...PHOTO_ORDER);
    for (const f of found) (files[f.itemId] ??= []).push({ id: f.id, kind: f.kind as "photo" | "document", filename: f.filename, contentType: f.contentType });
  }
  const [[household], [by], properties] = await Promise.all([
    v.db.select({ name: organization.name }).from(organization).where(eq(organization.id, v.householdId)),
    r.createdBy ? v.db.select({ name: user.name }).from(user).where(eq(user.id, r.createdBy)) : [undefined],
    r.kind === "report" ? listProperties(v) : [],
  ]);
  await v.db.insert(shareView).values({ householdId: v.householdId, linkId: r.id, ipAddress: seen.ipAddress, userAgent: seen.userAgent?.slice(0, 300) ?? null });
  await v.db.update(shareLink).set({ views: sql`${shareLink.views} + 1`, lastViewedAt: new Date() }).where(eq(shareLink.id, r.id));
  return {
    household: household?.name ?? "A household",
    title: await titleOf(v, r),
    label: r.label,
    sharedBy: by?.name ?? null,
    expiresAt: r.expiresAt.toISOString(),
    generatedAt: new Date().toISOString(),
    includeFiles: r.includeFiles,
    properties: properties
      .filter((p) => !r.propertyId || p.id === r.propertyId)
      .map((p) => ({
        name: p.name,
        type: p.type as SharedView["properties"][number]["type"],
        details: { street: p.street, city: p.city, region: p.region, postalCode: p.postalCode, country: p.country, yearBuilt: p.yearBuilt, valueCents: p.valueCents, notes: null },
      })),
    // Notes are the household's own ("spare key in the drawer"): not for an insurer.
    rows: rows.map((row) => ({ ...row, notes: null })),
    files,
  };
}

/** A file the link may show: one of a shown item's photos or documents, and only when files are shared. */
export async function sharedFile(v: Caller, r: Row, attachmentId: string) {
  if (!r.includeFiles) throw new HTTPException(404, { message: "Not shared" });
  const [file] = await v.db
    .select()
    .from(attachment)
    .where(and(eq(attachment.id, attachmentId), eq(attachment.householdId, v.householdId), isNull(attachment.deletedAt)));
  if (!file) throw new HTTPException(404, { message: "Not shared" });
  if (!(await sharedItemIds(v, r)).has(file.itemId)) throw new HTTPException(404, { message: "Not shared" });
  return file;
}

/** The items a link shows, kept a minute: a page of thumbnails shouldn't work the report out once per photo. */
const shownCache = new Map<string, { at: number; ids: Set<string> }>();
async function sharedItemIds(v: Caller, r: Row) {
  const hit = shownCache.get(r.id);
  if (hit && Date.now() - hit.at < 60_000) return hit.ids;
  const ids = new Set((await sharedRows(v, r)).map((x) => x.id));
  if (shownCache.size > 500) shownCache.clear();
  shownCache.set(r.id, { at: Date.now(), ids });
  return ids;
}
