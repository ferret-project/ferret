/**
 * API keys, for Claude (MCP) and scripts. A key belongs to a user and is bound
 * to one household when it's made; it can be read-only. Sent as
 * `Authorization: Bearer ferret_…` or `x-api-key: ferret_…`.
 *
 * Membership is checked again on every request (lib/context.ts), so taking
 * someone out of a household also shuts off their keys for it.
 */
import { eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Auth } from "../auth";
import { user } from "../db/schema";
import type { Db } from "../ports";

export const KEY_PREFIX = "ferret_";

/** What we store in the key's metadata. */
const keyMetadata = z.object({ householdId: z.string().min(1), readOnly: z.boolean().default(false) });
export type KeyMetadata = z.infer<typeof keyMetadata>;

export interface KeyHolder {
  user: typeof user.$inferSelect;
  key: { id: string; name: string | null; householdId: string; readOnly: boolean };
}

/** The key in the request headers, if any (a Bearer token only counts if it looks like one of ours). */
export function keyFromHeaders(headers: Headers) {
  const bearer = headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (bearer?.startsWith(KEY_PREFIX)) return bearer;
  return headers.get("x-api-key") ?? undefined;
}

/** The user and household a key stands for, or null if it's unknown, disabled or expired. Throws 429 when rate-limited. */
export async function verifyKey(auth: Auth, db: Db, key: string): Promise<KeyHolder | null> {
  const result = await auth.api.verifyApiKey({ body: { key } }).catch((err: unknown) => ({
    valid: false as const,
    key: null,
    error: { code: (err as { body?: { code?: string } }).body?.code },
  }));
  if (result.error?.code === "RATE_LIMITED") throw new HTTPException(429, { message: "Too many requests with this key — slow down" });
  if (!result.valid || !result.key) return null;
  const metadata = keyMetadata.safeParse(parseMetadata(result.key.metadata));
  if (!metadata.success) return null;
  const [owner] = await db.select().from(user).where(eq(user.id, result.key.referenceId));
  if (!owner) return null;
  return { user: owner, key: { id: result.key.id, name: result.key.name ?? null, ...metadata.data } };
}

/** Better Auth hands metadata back as an object, but older rows may hold the JSON string. */
function parseMetadata(value: unknown) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
