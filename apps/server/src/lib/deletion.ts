/**
 * Deleting for good, when someone asks (Settings → Household → Delete household; Settings → Security → Delete
 * account) — and for the demo's nightly reset. Nothing is left
 * behind: rows (most by cascade from the household or the user), encrypted files, search entries (full-text and
 * vectors), API keys. Database backups still hold it until they age out — the help and the privacy policy say so.
 */
import type { AccountDeletionInfo } from "@ferret/shared";
import { and, count, eq, inArray, isNotNull } from "drizzle-orm";
import { sql } from "drizzle-orm";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { account, attachment, apikey, member, organization, session, user } from "../db/schema";
import { previewKey } from "../jobs/analyze";
import type { Db, Deps } from "../ports";
import type { AppEnv } from "./context";
import type { FileStore } from "./files";
import { roomPhotoKeys } from "./room-scans";
import { isServerAdmin } from "./server-admin";
import { inList } from "./sql";

/** API keys bound to these households (the household is in the key's metadata). */
async function keysOf(db: Db, householdIds: Set<string>) {
  const rows = await db.select({ id: apikey.id, metadata: apikey.metadata }).from(apikey);
  return rows
    .filter((r) => {
      try {
        const m = typeof r.metadata === "string" ? JSON.parse(r.metadata) : r.metadata;
        const parsed = typeof m === "string" ? JSON.parse(m) : m;
        return householdIds.has(parsed?.householdId);
      } catch {
        return false;
      }
    })
    .map((r) => r.id);
}

/** Deletes households for good: their encrypted files, search entries, API keys and rows (by cascade). */
export async function deleteHouseholds(p: { deps: Pick<Deps, "db" | "vectors">; files: FileStore }, ids: string[]) {
  if (!ids.length) return;
  const { db, vectors } = p.deps;
  for (const photo of await roomPhotoKeys(db, ids)) await p.files.delete(photo.key).catch(() => {}); // room scans' photos
  const stored = await db.select({ blobKey: attachment.blobKey, thumbnailKey: attachment.thumbnailKey }).from(attachment).where(inList(attachment.householdId, ids));
  for (const f of stored) {
    await p.files.delete(f.blobKey).catch(() => {}); // an original already removed to free space
    if (f.thumbnailKey) await p.files.delete(f.thumbnailKey);
    await p.files.delete(previewKey(f.blobKey)).catch(() => {});
  }
  for (const id of ids) {
    await vectors?.deleteWhere({ householdId: id });
    await db.run(sql`DELETE FROM item_search WHERE household_id = ${id}`);
    await db.run(sql`DELETE FROM item_search_trigram WHERE household_id = ${id}`);
  }
  const keys = await keysOf(db, new Set(ids));
  if (keys.length) await db.delete(apikey).where(inList(apikey.id, keys));
  // Sessions that had one of them active: none active now (the app then picks another, or offers to make one).
  await db.update(session).set({ activeOrganizationId: null }).where(inList(session.activeOrganizationId, ids));
  await db.delete(organization).where(inList(organization.id, ids));
}

export interface AccountDeletion {
  /** Households it owns with other people in them: hand them over (or delete them) first. */
  blockers: { id: string; name: string }[];
  /** Households only it is in: deleted with the account. */
  households: { id: string; name: string }[];
}

/** What deleting this account would take with it, or what stops it. */
export async function accountDeletion(db: Db, userId: string): Promise<AccountDeletion> {
  const owned = await db
    .select({ id: organization.id, name: organization.name })
    .from(member)
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .where(and(eq(member.userId, userId), eq(member.role, "owner")));
  const ids = owned.map((o) => o.id);
  const others = ids.length
    ? await db
        .select({ householdId: member.organizationId })
        .from(member)
        .where(and(inArray(member.organizationId, ids), sql`${member.userId} <> ${userId}`))
    : [];
  const shared = new Set(others.map((o) => o.householdId));
  return { blockers: owned.filter((o) => shared.has(o.id)), households: owned.filter((o) => !shared.has(o.id)) };
}

/**
 * Deletes an account for good, with the households only it is in. The caller has checked who's asking and that
 * nothing blocks it. Its sessions, passkeys, memberships and sign-in log go by cascade; its API keys explicitly.
 */
export async function deleteAccount(p: { deps: Pick<Deps, "db" | "vectors">; files: FileStore }, userId: string) {
  const { households } = await accountDeletion(p.deps.db, userId);
  await deleteHouseholds(p, households.map((h) => h.id));
  await p.deps.db.delete(apikey).where(eq(apikey.referenceId, userId));
  await p.deps.db.delete(user).where(eq(user.id, userId));
}

// ── The checks before deleting (routes/household.ts, routes/security.ts) ─────────────────────────────────────────

/** A sign-in this recent stands in for the password, for accounts without one (passkeys, emailed links). */
const RECENT_SIGN_IN_MS = 15 * 60_000;

/** What deleting the signed-in account would take with it, or what stops it. */
export async function accountDeletionInfo(c: { var: AppEnv["Variables"] }): Promise<AccountDeletionInfo> {
  const db = c.var.db;
  const userId = c.var.user.id;
  const [password] = await db
    .select({ id: account.id })
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, "credential"), isNotNull(account.password)));
  const [users] = await db.select({ n: count() }).from(user);
  return {
    ...(await accountDeletion(db, userId)),
    needsPassword: Boolean(password),
    serverAdmin: (await isServerAdmin(db, userId)) && Number(users?.n ?? 0) > 1,
  };
}

/** That it's really them: the password if the account has one, else a sign-in in the last 15 minutes. Throws if not. */
export async function confirmIdentity(c: Context<AppEnv>, needsPassword: boolean, password: string | undefined) {
  if (needsPassword) {
    if (!password) throw new HTTPException(403, { message: "Enter your password to delete your account" });
    const ok = await c.var.auth.api.verifyPassword({ body: { password }, headers: c.req.raw.headers }).then(
      () => true,
      () => false,
    );
    if (!ok) {
      await new Promise((r) => setTimeout(r, 1000)); // no quick guessing through here
      throw new HTTPException(403, { message: "That password isn't right" });
    }
  } else if (Date.now() - new Date(c.var.session!.createdAt).getTime() > RECENT_SIGN_IN_MS) {
    throw new HTTPException(403, { message: "For safety, sign out and in again, then delete your account within 15 minutes" });
  }
}
