/**
 * Connecting Hardcover (a third book source, lib/books.ts) — Settings → Server → Book look-ups → Connect Hardcover:
 * Ferret asks Hardcover for a code (OAuth's device grant), the server admin enters it on hardcover.app and approves,
 * and Settings checks every few seconds until it's done. Hardcover's terms: never have people paste a personal token
 * into an app — hence the code.
 *
 * The tokens are kept sealed like the other services' keys (lib/server-keys.ts). The access token lasts a week; it's
 * renewed a day before it ends (or when Hardcover refuses it). Each refresh token works once — the newest is saved at
 * once, and renewals in this process wait for each other, since using one twice ends the connection. When Hardcover
 * no longer takes it (disconnected on hardcover.app, or reset while its API is in beta), the connection is forgotten
 * and the server admin's bell says to connect again.
 */
import type { HardcoverStatus } from "@ferret/shared";
import { and, eq, isNull } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { barcodeProduct, serverSetting } from "../db/schema";
import type { Db, Deps, Hardcover, HardcoverTokens } from "../ports";
import { saveServerKey, savedKeyHints, serverKey } from "./server-keys";

export const HARDCOVER_TOKENS = "books.hardcover.tokens";
const HARDCOVER_DEVICE = "books.hardcover.device";
const HARDCOVER_LOST = "books.hardcover.lost";
const RENEW_BEFORE_MS = 86_400_000;

type Kept = { access: string; refresh: string; expiresAt: number };
type Waiting = { deviceCode: string; userCode: string; verificationUri: string; verificationUriComplete: string | null; expiresAt: number; interval: number };

async function plain(db: Db, key: string) {
  const [row] = await db.select().from(serverSetting).where(eq(serverSetting.key, key));
  return row?.value ?? null;
}
async function setPlain(db: Db, key: string, value: string | null) {
  if (value == null) await db.delete(serverSetting).where(eq(serverSetting.key, key));
  else await db.insert(serverSetting).values({ key, value }).onConflictDoUpdate({ target: serverSetting.key, set: { value } });
}
const sealedJson = async <T>(db: Db, filesKey: string, name: string) => {
  const raw = await serverKey(db, filesKey, name);
  return raw ? (JSON.parse(raw) as T) : null;
};
const keep = (db: Db, filesKey: string, t: HardcoverTokens) =>
  saveServerKey(db, filesKey, HARDCOVER_TOKENS, JSON.stringify({ access: t.accessToken, refresh: t.refreshToken, expiresAt: Date.now() + t.expiresIn * 1000 } satisfies Kept));

/** Whether a Hardcover account is connected (nothing is opened). */
export async function hardcoverConnected(db: Db) {
  return (await savedKeyHints(db, HARDCOVER_TOKENS)).has(HARDCOVER_TOKENS);
}

/** For Settings → Server. */
export async function hardcoverStatus(deps: Pick<Deps, "db" | "hardcover">, filesKey: string, ended?: HardcoverStatus["ended"]): Promise<HardcoverStatus> {
  const waiting = await sealedJson<Waiting>(deps.db, filesKey, HARDCOVER_DEVICE).catch(() => null);
  const pending = waiting && waiting.expiresAt > Date.now() ? waiting : null;
  return {
    available: Boolean(deps.hardcover),
    connected: await hardcoverConnected(deps.db),
    lostAt: await plain(deps.db, HARDCOVER_LOST),
    pending: pending && {
      userCode: pending.userCode,
      verificationUri: pending.verificationUri,
      verificationUriComplete: pending.verificationUriComplete,
      expiresAt: new Date(pending.expiresAt).toISOString(),
      interval: pending.interval,
    },
    ...(ended ? { ended } : {}),
  };
}

const unavailable = () => new HTTPException(409, { message: "Hardcover isn't available on this server" });
const unreachable = () => new HTTPException(502, { message: "Couldn't reach Hardcover — try again in a while" });

/** Start connecting: a code for the server admin to enter on hardcover.app. */
export async function startHardcover(deps: Pick<Deps, "db" | "hardcover">, filesKey: string) {
  if (!deps.hardcover) throw unavailable();
  const d = await deps.hardcover.start().catch(() => {
    throw unreachable();
  });
  const waiting: Waiting = { deviceCode: d.deviceCode, userCode: d.userCode, verificationUri: d.verificationUri, verificationUriComplete: d.verificationUriComplete ?? null, expiresAt: Date.now() + d.expiresIn * 1000, interval: d.interval };
  await saveServerKey(deps.db, filesKey, HARDCOVER_DEVICE, JSON.stringify(waiting));
  return hardcoverStatus(deps, filesKey);
}

/** One check of the waiting sign-in (Settings asks every `interval` seconds): connected, still waiting, or ended. */
export async function checkHardcover(deps: Pick<Deps, "db" | "hardcover">, filesKey: string) {
  if (!deps.hardcover) throw unavailable();
  const waiting = await sealedJson<Waiting>(deps.db, filesKey, HARDCOVER_DEVICE);
  if (!waiting) return hardcoverStatus(deps, filesKey);
  const end = async (how: "denied" | "expired") => {
    await saveServerKey(deps.db, filesKey, HARDCOVER_DEVICE, null);
    return hardcoverStatus(deps, filesKey, how);
  };
  if (waiting.expiresAt <= Date.now()) return end("expired");
  const got = await deps.hardcover.poll(waiting.deviceCode).catch(() => {
    throw unreachable();
  });
  if (got === "pending") return hardcoverStatus(deps, filesKey);
  if (got === "slow_down") {
    await saveServerKey(deps.db, filesKey, HARDCOVER_DEVICE, JSON.stringify({ ...waiting, interval: waiting.interval + 5 }));
    return hardcoverStatus(deps, filesKey);
  }
  if (got === "denied" || got === "expired") return end(got);
  await keep(deps.db, filesKey, got);
  await saveServerKey(deps.db, filesKey, HARDCOVER_DEVICE, null);
  await setPlain(deps.db, HARDCOVER_LOST, null);
  // Books nobody knew are asked again — of Hardcover too, now.
  await deps.db.delete(barcodeProduct).where(and(eq(barcodeProduct.source, "openlibrary"), isNull(barcodeProduct.external)));
  return hardcoverStatus(deps, filesKey);
}

/** Disconnect: Hardcover is told to forget the sign-in, and Ferret forgets it too. */
export async function disconnectHardcover(deps: Pick<Deps, "db" | "hardcover">, filesKey: string) {
  const kept = await sealedJson<Kept>(deps.db, filesKey, HARDCOVER_TOKENS).catch(() => null);
  if (kept && deps.hardcover) await deps.hardcover.revoke(kept.refresh).catch(() => {});
  await saveServerKey(deps.db, filesKey, HARDCOVER_TOKENS, null);
  await saveServerKey(deps.db, filesKey, HARDCOVER_DEVICE, null);
  await setPlain(deps.db, HARDCOVER_LOST, null);
  return hardcoverStatus(deps, filesKey);
}

/** Renewals in progress, so two lookups at once don't spend the same refresh token. */
let renewing: Promise<string | null> | null = null;

/**
 * The access token for a lookup: the kept one, renewed when it's within a day of ending (or `renew`: Hardcover just
 * refused it). Null when not connected — or when Hardcover no longer takes the connection, which is then forgotten
 * (the server admin's bell says so).
 */
export async function hardcoverToken(db: Db, filesKey: string, api: Pick<Hardcover, "refresh">, opts: { renew?: boolean } = {}): Promise<string | null> {
  const kept = await sealedJson<Kept>(db, filesKey, HARDCOVER_TOKENS);
  if (!kept) return null;
  if (!opts.renew && kept.expiresAt - Date.now() > RENEW_BEFORE_MS) return kept.access;
  renewing ??= (async () => {
    try {
      // Another lookup may have renewed it while this one waited.
      const now = await sealedJson<Kept>(db, filesKey, HARDCOVER_TOKENS);
      if (!now) return null;
      if (now.refresh !== kept.refresh) return now.access;
      const got = await api.refresh(now.refresh);
      if (got === "revoked") {
        await saveServerKey(db, filesKey, HARDCOVER_TOKENS, null);
        await setPlain(db, HARDCOVER_LOST, new Date().toISOString().slice(0, 10));
        return null;
      }
      await keep(db, filesKey, got);
      return got.accessToken;
    } finally {
      renewing = null;
    }
  })();
  return renewing;
}

/** For the server admin's bell: the day Hardcover stopped taking the connection, if it did. */
export const hardcoverLostOn = (db: Db) => plain(db, HARDCOVER_LOST);
