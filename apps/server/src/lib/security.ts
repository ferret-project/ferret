/**
 * Settings → Security: a person's signed-in sessions (sign one out, or every
 * other one) and their recent sign-ins. Two-step sign-in itself is Better
 * Auth's two-factor plugin (/api/auth/two-factor/*); see auth.ts.
 */
import type { SessionSummary, SignInEntry } from "@ferret/shared";
import { and, desc, eq, gt, ne, notInArray } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { session, signIn, signInFailure } from "../db/schema";
import type { Db } from "../ports";

/** How many sign-ins to keep per person (Settings shows the latest dozen). */
const KEEP_SIGN_INS = 50;

export type SignInMethod = "password" | "password+code" | "password+backup-code" | "sign-up" | "email-link" | "passkey" | "sso" | "trusted-header";

export async function recordSignIn(
  db: Db,
  entry: { userId: string; ipAddress: string | null | undefined; userAgent: string | null | undefined; method: SignInMethod },
) {
  await db.insert(signIn).values({ ...entry, ipAddress: entry.ipAddress ?? null, userAgent: entry.userAgent ?? null });
  const keep = db
    .select({ id: signIn.id })
    .from(signIn)
    .where(eq(signIn.userId, entry.userId))
    .orderBy(desc(signIn.createdAt))
    .limit(KEEP_SIGN_INS);
  await db.delete(signIn).where(and(eq(signIn.userId, entry.userId), notInArray(signIn.id, keep)));
}

/** The latest sign-ins and wrong passwords, newest first. */
export async function listSignIns(db: Db, userId: string, limit = 12): Promise<SignInEntry[]> {
  const [ok, failed] = await Promise.all([
    db.select().from(signIn).where(eq(signIn.userId, userId)).orderBy(desc(signIn.createdAt)).limit(limit),
    db.select().from(signInFailure).where(eq(signInFailure.userId, userId)).orderBy(desc(signInFailure.createdAt)).limit(limit),
  ]);
  return [
    ...ok.map((r) => ({ at: r.createdAt, ipAddress: r.ipAddress, userAgent: r.userAgent, method: r.method as SignInMethod })),
    ...failed.map((r) => ({ at: r.createdAt, ipAddress: r.ipAddress, userAgent: r.userAgent, method: "failed" as const })),
  ]
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .slice(0, limit)
    .map((e) => ({ ...e, at: e.at.toISOString() }));
}

const live = (userId: string) => and(eq(session.userId, userId), gt(session.expiresAt, new Date()));

/** This person's sessions that haven't expired, the one making the request first, then most recently active. */
export async function listSessions(db: Db, userId: string, currentId: string): Promise<SessionSummary[]> {
  const rows = await db.select().from(session).where(live(userId)).orderBy(desc(session.updatedAt));
  return rows
    .map((r) => ({
      id: r.id,
      current: r.id === currentId,
      ipAddress: r.ipAddress,
      userAgent: r.userAgent,
      signedInAt: r.createdAt.toISOString(),
      lastActiveAt: r.updatedAt.toISOString(),
      expiresAt: r.expiresAt.toISOString(),
    }))
    .sort((a, b) => Number(b.current) - Number(a.current));
}

/** Signs out one of this person's other sessions (this one signs out the usual way). */
export async function revokeSession(db: Db, userId: string, currentId: string, id: string) {
  if (id === currentId) throw new HTTPException(400, { message: "That's this session — use Sign out instead" });
  const gone = await db
    .delete(session)
    .where(and(eq(session.userId, userId), eq(session.id, id)))
    .returning({ id: session.id });
  if (!gone.length) throw new HTTPException(404, { message: "No such session" });
}

/** Signs out everywhere but here. Returns how many sessions ended. */
export async function revokeOtherSessions(db: Db, userId: string, currentId: string) {
  const gone = await db
    .delete(session)
    .where(and(eq(session.userId, userId), ne(session.id, currentId)))
    .returning({ id: session.id });
  return gone.length;
}

/** The network an address is on, roughly: an IPv4 /24, an IPv6 /48. Null when there's no address. */
export function networkOf(ip: string | null | undefined) {
  if (!ip) return null;
  const v4 = ip.replace(/^::ffff:/, "");
  if (/^127\./.test(v4) || ip === "::1") return null; // this machine: not a place
  if (/^\d+\.\d+\.\d+\.\d+$/.test(v4)) return v4.split(".").slice(0, 3).join(".");
  if (ip.includes(":")) return ip.toLowerCase().split(":").slice(0, 3).join(":");
  return ip;
}

/**
 * A sign-in from somewhere this account hasn't signed in from before (another network). Not the very first sign-in,
 * and never when the address is unknown. Asked before the new sign-in is recorded.
 */
export async function isNewPlace(db: Db, userId: string, ip: string | null | undefined) {
  const net = networkOf(ip);
  if (!net) return false;
  const before = await db.select({ ip: signIn.ipAddress, method: signIn.method }).from(signIn).where(eq(signIn.userId, userId));
  // Only sign-ins whose network is known count: the first one from a known address isn't "new".
  const nets = before.filter((b) => b.method !== "failed").map((b) => networkOf(b.ip)).filter(Boolean);
  if (!nets.length) return false;
  return !nets.includes(net);
}

/** "Safari on iPhone", "Chrome on Mac" — enough to recognise a device. */
export function describeDevice(ua: string | null | undefined) {
  if (!ua) return "an unknown device";
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "a browser";
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : null;
  return os ? `${browser} on ${os}` : browser;
}
