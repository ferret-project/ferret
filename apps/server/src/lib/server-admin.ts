/**
 * The server admin: the one person who looks after what belongs to the whole server rather than one household —
 * backups (Settings → Server). It's the first account made on the server until handed over (Settings → Server, or
 * `cli.js admin <email>` on the server itself); if that account is ever deleted, it falls back to the oldest one.
 */
import { asc, eq, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { serverSetting, user } from "../db/schema";
import type { Db } from "../ports";

const ADMIN = "admin";

/** The server admin's account, or null on a server with no accounts yet. */
export async function serverAdmin(db: Db) {
  const [chosen] = await db
    .select({ id: user.id, name: user.name, email: user.email })
    .from(serverSetting)
    .innerJoin(user, eq(user.id, serverSetting.value))
    .where(eq(serverSetting.key, ADMIN));
  if (chosen) return chosen;
  const [first] = await db.select({ id: user.id, name: user.name, email: user.email }).from(user).orderBy(asc(user.createdAt), asc(user.id)).limit(1);
  return first ?? null;
}

export async function isServerAdmin(db: Db, userId: string) {
  return (await serverAdmin(db))?.id === userId;
}

/** Makes the account with this email the server admin. It must have confirmed its email (so it's really theirs). */
export async function setServerAdmin(db: Db, email: string) {
  const [to] = await db
    .select({ id: user.id, name: user.name, email: user.email, emailVerified: user.emailVerified })
    .from(user)
    .where(eq(sql`lower(${user.email})`, email.trim().toLowerCase()));
  if (!to) throw new HTTPException(404, { message: `No account with the email ${email.trim()}` });
  if (!to.emailVerified) throw new HTTPException(409, { message: `${to.email} hasn't confirmed its email yet` });
  await db
    .insert(serverSetting)
    .values({ key: ADMIN, value: to.id })
    .onConflictDoUpdate({ target: serverSetting.key, set: { value: to.id, updatedAt: new Date() } });
  return { id: to.id, name: to.name, email: to.email };
}
