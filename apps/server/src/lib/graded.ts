/**
 * Graded coins and cards (deps.grading — PCGS for coins, PSA for cards): a thing's page takes the certificate number
 * on its slab and shows what the grading service says — the coin or card, its grade, how many it has graded the same
 * and higher, and (PCGS) its price guide value, offered as the thing's value. Each service needs the server admin's
 * key (Settings → Server), kept sealed (lib/server-keys.ts). A certificate's answer is kept for the whole server a week
 * (collectible_info, "graded:<by>:<cert>"): prices move, grades don't.
 */
import { convertCents, type GradedInfo, type GradingService, type GradingStatus, type ItemGradedInfo, gradingServices } from "@ferret/shared";
import { eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { collectibleInfo } from "../db/schema";
import { CatalogKeyError, CatalogLimitError, type Db, type Deps } from "../ports";
import { currentRates } from "./exchange";
import { type Caller, getItem } from "./inventory";
import { savedKeyHints, saveServerKey, serverKey } from "./server-keys";

const FRESH_MS = 7 * 24 * 60 * 60 * 1000;
// not translated (names of services)
export const GRADING_NAMES: Record<GradingService, string> = { pcgs: "PCGS", psa: "PSA" };
const keyName = (by: GradingService) => `graded.${by}.key`;

type GradingDeps = Pick<Deps, "db" | "grading">;

export async function gradingStatus(deps: GradingDeps): Promise<GradingStatus[]> {
  const hints = await savedKeyHints(deps.db, "graded.%.key");
  return gradingServices.map((by) => ({ by, available: Boolean(deps.grading?.[by]), hint: hints.get(keyName(by)) ?? null }));
}

/** The services people can use: this server has the adapter and a key is saved. */
export async function gradingOn(deps: GradingDeps): Promise<GradingService[]> {
  if (!deps.grading) return [];
  const hints = await savedKeyHints(deps.db, "graded.%.key");
  return gradingServices.filter((by) => deps.grading![by] && hints.has(keyName(by)));
}

export async function saveGradingKey(deps: GradingDeps, filesKey: string, by: GradingService, key: string | null) {
  const service = deps.grading?.[by];
  if (!service) throw new HTTPException(409, { message: `${GRADING_NAMES[by]} isn't available on this server` });
  if (key != null) {
    const ok = await service.check(key).catch((err: unknown) => {
      if (err instanceof CatalogLimitError) throw new HTTPException(429, { message: `${GRADING_NAMES[by]} says today's allowance is used up — try again tomorrow` });
      throw new HTTPException(502, { message: `Couldn't reach ${GRADING_NAMES[by]} to check the key — try again in a while` });
    });
    if (!ok) throw new HTTPException(422, { message: `${GRADING_NAMES[by]} didn't accept that key${by === "psa" ? " — PSA approves accounts for its API first" : ""}` });
  }
  await saveServerKey(deps.db, filesKey, keyName(by), key);
  return gradingStatus(deps);
}

const bookKey = (by: GradingService, cert: string) => `graded:${by}:${cert.replace(/\D/g, "")}`;

/** A certificate, kept or asked (inline: one request, a person waiting). Null: no such certificate. */
export async function lookupCert(deps: GradingDeps, filesKey: string, by: GradingService, cert: string): Promise<GradedInfo | null> {
  const service = deps.grading?.[by];
  const key = service ? await serverKey(deps.db, filesKey, keyName(by)) : null;
  if (!service || !key) throw new HTTPException(409, { message: `${GRADING_NAMES[by]} look-ups aren't switched on on this server` });
  const [kept] = await deps.db.select().from(collectibleInfo).where(eq(collectibleInfo.key, bookKey(by, cert)));
  if (kept && Date.now() - kept.fetchedAt.getTime() < FRESH_MS) return kept.info as GradedInfo | null;
  try {
    const info = await service.byCert(key, cert);
    if (info) await remember(deps.db, bookKey(by, cert), info);
    return info;
  } catch (err) {
    if (kept) return kept.info as GradedInfo; // last week's beats none
    if (err instanceof CatalogKeyError) throw new HTTPException(502, { message: `${GRADING_NAMES[by]} refused this server's key — the server admin can check it in Settings → Server` });
    if (err instanceof CatalogLimitError) throw new HTTPException(429, { message: `${GRADING_NAMES[by]}'s allowance for today is used up — try again tomorrow` });
    throw new HTTPException(502, { message: `${GRADING_NAMES[by]} didn't answer — try again in a while` });
  }
}

async function remember(db: Db, key: string, info: GradedInfo) {
  const now = new Date();
  await db.insert(collectibleInfo).values({ key, info, fetchedAt: now }).onConflictDoUpdate({ target: collectibleInfo.key, set: { info, fetchedAt: now } });
}

/** A graded thing's certificate and what its service says, with the price guide's value in the household's currency. */
export async function itemGraded(v: Caller, filesKey: string, itemId: string): Promise<ItemGradedInfo> {
  const it = await getItem(v, itemId);
  if (!it.graded) return { graded: null, info: null, price: null };
  const on = (await gradingOn(v.deps)).includes(it.graded.by);
  const info = on ? await lookupCert(v.deps, filesKey, it.graded.by, it.graded.cert).catch(() => null) : null;
  let price: ItemGradedInfo["price"] = null;
  if (info?.priceCents) {
    if (v.currency === "USD") price = { cents: info.priceCents, currency: "USD" };
    else {
      const cents = convertCents(info.priceCents, "USD", v.currency, await currentRates(v.deps));
      if (cents != null) price = { cents, currency: v.currency, original: { cents: info.priceCents, currency: "USD" } };
    }
  }
  return { graded: it.graded, info, price };
}
