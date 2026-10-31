/**
 * The public demo (DEMO=true). Never on a real Ferret.
 *
 * - Two accounts made when missing, confirmed without email: the demo's server admin (DEMO_ADMIN_EMAIL, required)
 *   and the shared demo account (DEMO_EMAIL / DEMO_PASSWORD, shown on the sign-in screen).
 * - The sample household (demo/household.ts), planted again every night: everything visitors changed goes. Its photos
 *   come from the demo's own files (`demo-samples/…`, put there by whoever runs the demo — never in Ferret's image);
 *   its receipts are made as it's planted (demo/receipts.ts), so their dates fit.
 * - The shared account can't be taken over or spoil it for the next person: its password, email, two-step sign-in,
 *   passkeys, sessions, API keys, members and invitations are locked, and it sees no one's sign-ins.
 * - Visitors' own accounts (sign up is open) and their households are deleted after DEMO_VISITOR_DAYS.
 * - Email goes to accounts only (never borrowers or anyone typed in), and never to the demo account.
 * - A daily AI budget (DEMO_AI_PER_DAY calls, everyone together), and DEMO_PAUSED, the off switch.
 */
import { deleteHouseholds } from "./deletion";
import { addDays, itemInput, loanInput, locationInput, maintenanceInput, propertyInput, providerInput, today } from "@ferret/shared";
import { and, eq, like, lt, sql } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import type { Auth } from "../auth";
import type { Config } from "../config";
import { activity, apikey, attachment, category, member, organization, serverSetting, user, warranty } from "../db/schema";
import { DEMO_HOUSEHOLD, DEMO_ITEMS, DEMO_LOAN, DEMO_PLACES, DEMO_PROPERTY, DEMO_PROVIDERS, DEMO_TASKS, type DemoItem } from "../demo/household";
import { receiptFilename, receiptFor, receiptPdf, receiptSample } from "../demo/receipts";
import type { Deps, Jobs, Notifier } from "../ports";
import { addAttachment } from "./attachments";
import { addStarterCategories, setItemTags } from "./catalog";
import type { AppEnv } from "./context";
import type { FileStore } from "./files";
import { setHouseholdTimeZone } from "./household-time";
import { type Caller, createItem, createLocation, createProperty, itemChanged } from "./inventory";
import { createLoan } from "./loans";
import { createTask } from "./maintenance";
import { createProvider } from "./providers";
import { isServerAdmin, setServerAdmin } from "./server-admin";
import { type DemoPart, isOff, partsOff } from "./demo-switches";
import { inList } from "./sql";

const sameEmail = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
export const isDemoAccount = (config: Config, email: string | null | undefined) => config.DEMO && !!email && sameEmail(email, config.DEMO_EMAIL);

// ── Accounts ────────────────────────────────────────────────────────────────

/** The account with this email, made (confirmed, with this password) if there's none. */
async function ensureAccount(auth: Auth, email: string, name: string, password: string) {
  const ctx = await auth.$context;
  const found = await ctx.internalAdapter.findUserByEmail(email);
  if (found) return found.user.id;
  const created = await ctx.internalAdapter.createUser({ name, email, emailVerified: true }, { method: "admin" });
  await ctx.internalAdapter.linkAccount({ userId: created.id, providerId: "credential", accountId: created.id, password: await ctx.password.hash(password) });
  return created.id;
}

export interface DemoParts {
  deps: Deps;
  auth: Auth;
  config: Config;
  files: FileStore;
}

/** A household being planted has this slug until it's all there; one left over from a planting cut short goes. */
const PLANTING = `${DEMO_HOUSEHOLD.slug}-planting-`;
const PLANTING_GIVE_UP_MS = 10 * 60_000;

/**
 * The admin and demo accounts and the sample household, each made if it's missing. Cheap when they're all there.
 * Planting only from the scheduled work (`plant`), which runs one at a time — some runtimes start several instances at once,
 * and each planting its own house made two.
 */
export async function ensureDemo(p: DemoParts, { plant = true }: { plant?: boolean } = {}) {
  const { config, auth, deps } = p;
  if (!config.DEMO) return null;
  // loadConfig makes sure the demo has its own admin.
  const adminId = await ensureAccount(auth, config.DEMO_ADMIN_EMAIL!, "Demo admin", config.DEMO_ADMIN_PASSWORD!);
  const [chosen] = await deps.db.select({ value: serverSetting.value }).from(serverSetting).where(eq(serverSetting.key, "admin"));
  if (chosen?.value !== adminId) await setServerAdmin(deps.db, config.DEMO_ADMIN_EMAIL!);
  const demoId = await ensureAccount(auth, config.DEMO_EMAIL, "Demo visitor", config.DEMO_PASSWORD);
  if (!plant) return { demoId, adminId, householdId: null };
  const stale = await deps.db
    .select({ id: organization.id })
    .from(organization)
    .where(and(like(organization.slug, `${PLANTING}%`), lt(organization.createdAt, new Date(Date.now() - PLANTING_GIVE_UP_MS))));
  await deleteHouseholds(p, stale.map((o) => o.id));
  await ensureAdminHousehold(p, adminId);
  const [house] = await deps.db.select({ id: organization.id }).from(organization).where(eq(organization.slug, DEMO_HOUSEHOLD.slug));
  const householdId = house?.id ?? (await plantHousehold(p, demoId));
  // The admin is no part of the shared house (a house planted before this had them as its owner): the demo account owns it.
  if (house) {
    await deps.db.delete(member).where(and(eq(member.organizationId, house.id), eq(member.userId, adminId)));
    await deps.db.update(member).set({ role: "owner" }).where(and(eq(member.organizationId, house.id), eq(member.userId, demoId)));
  }
  return { demoId, adminId, householdId };
}

/** The demo's admin has a household of their own, so their name never shows in the shared one. Kept by every reset. */
export const ADMIN_HOUSEHOLD = { name: "Demo admin", slug: "demo-admin" };

async function ensureAdminHousehold(p: DemoParts, adminId: string) {
  const { db } = p.deps;
  const id = crypto.randomUUID();
  const now = new Date();
  // The slug is unique: a second planting at the same moment makes nothing.
  const made = await db
    .insert(organization)
    .values({ id, name: ADMIN_HOUSEHOLD.name, slug: ADMIN_HOUSEHOLD.slug, createdAt: now })
    .onConflictDoNothing({ target: organization.slug })
    .returning({ id: organization.id });
  if (made.length) await db.insert(member).values({ id: crypto.randomUUID(), organizationId: id, userId: adminId, role: "owner", createdAt: now });
}


// ── The sample household ────────────────────────────────────────────────────

/** Makes the sample household, owned by the shared demo account (its locks keep it from being given away or deleted). */
async function plantHousehold(p: DemoParts, demoId: string) {
  const { db } = p.deps;
  const householdId = crypto.randomUUID();
  const now = new Date();
  await db.insert(organization).values({ id: householdId, name: DEMO_HOUSEHOLD.name, slug: `${PLANTING}${householdId}`, createdAt: now });
  await db.insert(member).values({ id: crypto.randomUUID(), organizationId: householdId, userId: demoId, role: "owner", createdAt: now });
  await setHouseholdTimeZone(db, householdId, DEMO_HOUSEHOLD.timeZone);
  const jobs = onceEach(p.deps.jobs);
  const v: Caller = { deps: { ...p.deps, jobs: jobs.queue }, db, householdId, userId: demoId, timeZone: DEMO_HOUSEHOLD.timeZone, via: "web" };
  const on = today(now, v.timeZone);

  const home = await createProperty(v, propertyInput.parse(DEMO_PROPERTY));
  const places = new Map<string, string>();
  for (const path of DEMO_PLACES) {
    const [parent, name] = path.includes("/") ? path.split("/") : [undefined, path];
    const row = await createLocation(v, locationInput.parse({ propertyId: home.id, parentId: parent ? places.get(parent) : null, name }));
    places.set(path, row.id);
  }

  await addStarterCategories(v);
  const categories = await db.select({ id: category.id, name: category.name, parentId: category.parentId }).from(category).where(eq(category.householdId, householdId));
  const categoryId = (path: string) => {
    const [top, sub] = path.split("/");
    const parent = categories.find((c) => !c.parentId && c.name === top);
    return sub ? categories.find((c) => c.parentId === parent?.id && c.name === sub)?.id : parent?.id;
  };

  const items = new Map<string, string>();
  // Boxes first, so their contents can go in them.
  for (const d of [...DEMO_ITEMS].sort((a, b) => Number(!!b.isContainer) - Number(!!a.isContainer))) {
    const row = await createItem(
      v,
      itemInput.parse({
        name: d.name,
        description: d.description,
        brand: d.brand,
        model: d.model,
        serialNumber: d.serialNumber,
        barcode: d.barcode,
        quantity: d.quantity,
        minQuantity: d.minQuantity,
        condition: d.condition,
        purchaseDate: d.boughtDaysAgo === undefined ? undefined : addDays(on, -d.boughtDaysAgo),
        purchasePriceCents: d.priceCents,
        valueCents: d.valueCents,
        isContainer: d.isContainer,
        locationId: d.inBox ? undefined : places.get(d.place),
        containerItemId: d.inBox ? items.get(d.inBox) : undefined,
        categoryId: d.category ? categoryId(d.category) : undefined,
      }),
    );
    items.set(d.name, row.id);
    if (d.tags?.length) await setItemTags(v, row.id, d.tags);
    if (d.warrantyEndsIn !== undefined) {
      await db.insert(warranty).values({
        householdId,
        itemId: row.id,
        provider: d.warrantyProvider,
        startsOn: d.boughtDaysAgo === undefined ? null : addDays(on, -d.boughtDaysAgo),
        endsOn: addDays(on, d.warrantyEndsIn),
      });
      await itemChanged(v, row.id);
    }
    await addSamples(v, p, d, row.id, on);
  }

  const providers = new Map<string, string>();
  for (const d of DEMO_PROVIDERS) providers.set(d.name, (await createProvider(v, providerInput.parse(d))).id);
  for (const t of DEMO_TASKS) {
    await createTask(
      v,
      maintenanceInput.parse({
        title: t.title,
        itemId: t.item ? items.get(t.item) : null,
        locationId: t.place ? places.get(t.place) : null,
        intervalCount: t.every?.count,
        intervalUnit: t.every?.unit,
        dueOn: addDays(on, t.dueIn),
        providerId: t.provider ? providers.get(t.provider) : null,
        partItemId: t.part ? items.get(t.part) : null,
        partQuantity: t.part ? 1 : undefined,
      }),
    );
  }
  await createLoan(
    v,
    p.files,
    items.get(DEMO_LOAN.item)!,
    loanInput.parse({ direction: "lent", person: DEMO_LOAN.person, since: addDays(on, -DEMO_LOAN.sinceDaysAgo), dueOn: addDays(on, DEMO_LOAN.dueIn) }),
  );
  await spreadOverTime(db, householdId, items, now);
  await jobs.send();
  // All there: now it's the demo's. (If another planting finished first, the slug is taken and this one is left over.)
  await db.update(organization).set({ slug: DEMO_HOUSEHOLD.slug }).where(eq(organization.id, householdId));
  return householdId;
}

const DAY = 86_400_000;

/**
 * Planted in a moment, the house would look it ("Recent changes": all "2 min ago"). Spread back over a couple of weeks
 * instead: the rooms, categories and maintenance first, then the things (the first in DEMO_ITEMS most recently), then
 * the loan, a few hours ago. Things and their history both, so lists and "Recent changes" agree.
 */
async function spreadOverTime(db: Deps["db"], householdId: string, items: Map<string, string>, now: Date) {
  const rows = await db
    .select({ id: activity.id, action: activity.action, itemId: activity.itemId })
    .from(activity)
    .where(eq(activity.householdId, householdId))
    .orderBy(sql`rowid`);
  const order = DEMO_ITEMS.map((d) => items.get(d.name)!).reverse(); // the last in the list furthest back
  const itemAt = new Map(order.map((id, i) => [id, now.getTime() - (13 - (12 * i) / Math.max(1, order.length - 1)) * DAY + 9 * 3_600_000]));
  const setUp = now.getTime() - 16 * DAY;
  const moments = rows.map((r, i) => {
    const base = r.action.startsWith("loan.") ? now.getTime() - 3 * 3_600_000 : r.itemId && itemAt.has(r.itemId) && !r.action.startsWith("maintenance.") ? itemAt.get(r.itemId)! : setUp;
    return { id: r.id, at: base + i * 47_000 }; // a little apart, in the order they happened
  });
  await db.run(sql`update activity set created_at = j.value ->> 'at' from json_each(${JSON.stringify(moments)}) j where activity.id = j.value ->> 'id'`);
  const things = [...itemAt].map(([id, at]) => ({ id, at }));
  await db.run(sql`update item set created_at = j.value ->> 'at', updated_at = j.value ->> 'at' from json_each(${JSON.stringify(things)}) j where item.id = j.value ->> 'id'`);
}

/**
 * Planting changes each thing several times (made, its warranty, its photo, its receipt), and each change queues its
 * re-index — each an AI call against the demo's daily budget. Held back and sent once each, at the end.
 */
function onceEach(jobs: Jobs | undefined) {
  const held = new Map<string, [string, unknown]>();
  return {
    queue: jobs && ({ enqueue: async (type, payload) => void held.set(`${type} ${JSON.stringify(payload)}`, [type, payload]) } satisfies Jobs),
    send: async () => {
      for (const [type, payload] of held.values()) await jobs!.enqueue(type, payload);
    },
  };
}

/** A sample file put in the demo's own files, or null when it isn't there. */
async function sample(p: DemoParts, name: string) {
  const found = await p.deps.blobs.get(`demo-samples/${name}`);
  return found ? new Uint8Array(await new Response(found.body).arrayBuffer()) : null;
}

/**
 * A thing's photo and receipt, as if someone had added them (no analysis: that's for visitors' own photos, and the
 * budget). Each is a nice-to-have: one that can't be added (not uploaded yet, or uploads switched off) is left out.
 */
async function addSamples(v: Caller, p: DemoParts, d: DemoItem, itemId: string, on: string) {
  try {
    const bytes = d.photo && (await sample(p, `photos/${d.photo}.webp`));
    if (bytes) {
      const thumbnail = (await sample(p, `photos/${d.photo}.thumb.webp`)) ?? undefined;
      await addAttachment(v, p.files, itemId, { bytes, filename: `${d.name}.webp`, kind: "photo", made: { thumbnail }, analyze: false });
    }
    const receipt = d.boughtDaysAgo === undefined ? null : receiptFor(d, addDays(on, -d.boughtDaysAgo));
    if (receipt) {
      const thumbnail = (await sample(p, receiptSample(d))) ?? undefined;
      await addAttachment(v, p.files, itemId, { bytes: receiptPdf(receipt), filename: receiptFilename(receipt), kind: "document", made: { thumbnail }, analyze: false });
    }
  } catch (err) {
    console.warn(`demo: ${d.name}'s photo or receipt left out:`, err instanceof Error ? err.message : err);
  }
}

/** The nightly reset: the sample household planted afresh, and visitors past DEMO_VISITOR_DAYS deleted. */
export async function resetDemo(p: DemoParts, now = new Date()) {
  const { config, deps } = p;
  if (!config.DEMO) return;
  const [house] = await deps.db.select({ id: organization.id }).from(organization).where(eq(organization.slug, DEMO_HOUSEHOLD.slug));
  if (house) await deleteHouseholds(p, [house.id]);
  await purgeVisitors(p, now);
  await ensureDemo(p);
  // Yesterday's AI counts.
  await deps.db.delete(serverSetting).where(and(like(serverSetting.key, `${AI_COUNT}%`), sql`${serverSetting.key} <> ${aiKey(now)}`));
}

/** Visitors' accounts older than DEMO_VISITOR_DAYS, and the households they made. */
export async function purgeVisitors(p: DemoParts, now = new Date()) {
  const { config, deps } = p;
  const keep = [config.DEMO_EMAIL, config.DEMO_ADMIN_EMAIL].filter((e): e is string => !!e).map((e) => e.toLowerCase());
  const before = new Date(now.getTime() - config.DEMO_VISITOR_DAYS * 86_400_000);
  const old = await deps.db
    .select({ id: user.id })
    .from(user)
    .where(and(lt(user.createdAt, before), sql`lower(${user.email}) not in (select value from json_each(${JSON.stringify(keep)}))`));
  if (!old.length) return 0;
  const ids = old.map((u) => u.id);
  const owned = await deps.db
    .select({ id: member.organizationId })
    .from(member)
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .where(and(inList(member.userId, ids), eq(member.role, "owner"), sql`${organization.slug} <> ${DEMO_HOUSEHOLD.slug}`));
  await deleteHouseholds(p, [...new Set(owned.map((o) => o.id))]);
  await deps.db.delete(apikey).where(inList(apikey.referenceId, ids));
  await deps.db.delete(user).where(inList(user.id, ids));
  return ids.length;
}

// ── What the demo account may not do ────────────────────────────────────────

/** Better Auth's endpoints that would let one visitor take the shared account over, or lock others out of it. */
const LOCKED_AUTH =
  /^\/api\/auth\/(change-password|change-email|update-user|delete-user|set-password|two-factor\/|passkey\/(?!generate-authenticate-options|verify-authentication)|revoke-session|revoke-sessions|revoke-other-sessions|organization\/(create|update|delete|leave|invite-member|cancel-invitation|accept-invitation|reject-invitation|remove-member|update-member-role|add-member))/;
/** Ferret's own: keys, sessions, notification channels and push (others' phones would get the shared reminders). */
const LOCKED_API: [RegExp, string[]][] = [
  [/^\/api\/v1\/api-keys/, ["POST", "PATCH", "DELETE"]],
  [/^\/api\/v1\/security\/sessions/, ["POST", "DELETE"]],
  [/^\/api\/v1\/notifications/, ["POST", "PUT", "PATCH", "DELETE"]],
  [/^\/api\/v1\/push\/(subscribe|test)/, ["POST"]],
  // Deleting the shared account or the sample house.
  [/^\/api\/v1\/security\/account$/, ["DELETE"]],
  [/^\/api\/v1\/household\/?$/, ["DELETE"]],
];
/** Lists that would show one visitor the others (where they signed in from). */
const HIDDEN = /^\/api\/(v1\/security\/(sessions|sign-ins)$|auth\/list-sessions$)/;
/** Nobody, in the demo. */
const OFF_FOR_ALL = /^\/api\/v1\/export\/everything\.zip$/;

/** What still answers while the demo rests: the sign-in screen, so its admin can sign in. */
const RESTING_OPEN = /^\/api\/(v1\/auth-options$|auth\/(sign-in\/email|get-session|sign-out|two-factor\/verify-totp)$)/;

const locked = (message: string) => new HTTPException(403, { message });

export const demoGuard = createMiddleware<AppEnv>(async (c, next) => {
  const { config } = c.var;
  if (!config.DEMO) return next();
  const path = c.req.path;
  const off = await partsOff(c.var.db);
  // Resting (DEMO_PAUSED, or "everything" switched off): only the sign-in screen works — and the server admin, signed
  // in, can use all of it (to look around, and to switch the demo back on without a redeploy).
  const resting = config.DEMO_PAUSED || off.has("everything");
  if (resting && path.startsWith("/api/") && !RESTING_OPEN.test(path)) {
    const session = await c.var.auth.api.getSession({ headers: c.req.raw.headers });
    if (!session || !(await isServerAdmin(c.var.db, session.user.id))) {
      return c.json({ error: { code: "demo_paused", message: "The demo is resting for now — please come back later." } }, 503);
    }
  }
  if (off.has("signups") && c.req.method === "POST" && path === "/api/auth/sign-up/email") {
    return c.json({ code: "SIGNUPS_PAUSED", message: "New accounts are paused in the demo for now — try the shared demo account." }, 403);
  }
  if (OFF_FOR_ALL.test(path)) throw locked("Not in the demo — on your own Ferret, this downloads everything as a ZIP.");
  const method = c.req.method;
  const guarded = LOCKED_AUTH.test(path) || HIDDEN.test(path) || LOCKED_API.some(([re, methods]) => re.test(path) && methods.includes(method));
  if (!guarded) return next();
  const session = await c.var.auth.api.getSession({ headers: c.req.raw.headers });
  if (!isDemoAccount(config, session?.user.email)) return next();
  if (HIDDEN.test(path) && method === "GET") return c.json(path.startsWith("/api/auth/") ? [] : { data: [] });
  throw locked("The demo account is shared, so this is locked — make your own account to try it.");
});

/**
 * Email in the demo goes only to accounts (confirmations, resets, sign-in links, weekly summaries) — never to the demo
 * account, nor to addresses someone typed in (a borrower's) — so the demo can't be used to send mail to strangers.
 */
export function demoNotifier(db: Deps["db"], config: Config, notifier: Notifier | undefined): Notifier | undefined {
  if (!config.DEMO || !notifier) return notifier;
  return {
    async send(url, message) {
      if (await isOff(db, "email")) return;
      const to = new URL(url).searchParams.get("to");
      if (!to || isDemoAccount(config, to)) return;
      const [account] = await db.select({ id: user.id }).from(user).where(eq(sql`lower(${user.email})`, to.trim().toLowerCase()));
      if (account) await notifier.send(url, message);
    },
  };
}

// ── The daily AI budget ─────────────────────────────────────────────────────

const AI_COUNT = "demo.ai.";
/** One count a day (UTC), kept in server_setting. */
const aiKey = (d: Date) => `${AI_COUNT}${d.toISOString().slice(0, 10)}`;

export class AiBudgetSpent extends Error {
  constructor() {
    super("The demo's AI budget for today is used up — it comes back tomorrow (UTC).");
  }
}

/** Counts one AI call; false once today's DEMO_AI_PER_DAY are used. */
export async function spendAi(db: Deps["db"], config: Config, now = new Date()) {
  const key = aiKey(now);
  const [row] = await db
    .insert(serverSetting)
    .values({ key, value: "1" })
    .onConflictDoUpdate({ target: serverSetting.key, set: { value: sql`cast(${serverSetting.value} as integer) + 1` } })
    .returning({ value: serverSetting.value });
  return Number(row?.value ?? 0) <= config.DEMO_AI_PER_DAY;
}

/** AI calls made today, for Settings → Server. */
export async function aiSpentToday(db: Deps["db"], now = new Date()) {
  const [row] = await db.select({ value: serverSetting.value }).from(serverSetting).where(eq(serverSetting.key, aiKey(now)));
  return Number(row?.value ?? 0);
}

export class AiPartOff extends Error {
  constructor(part: DemoPart) {
    super(`This part of the demo (${part}) is switched off for now.`);
  }
}

/**
 * A model port that counts each call against the budget, and refuses once it's spent (search falls back to words) —
 * or when its part is switched off (lib/demo-switches.ts): `part` names it, or picks it by the method called.
 */
export function budgeted<T extends object>(db: Deps["db"], config: Config, port: T | undefined, part?: DemoPart | ((method: string) => DemoPart)): T | undefined {
  if (!config.DEMO || !port) return port;
  return new Proxy(port, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        const which = typeof part === "function" ? part(String(prop)) : part;
        if (which && (await isOff(db, which))) throw new AiPartOff(which);
        if (!(await spendAi(db, config))) throw new AiBudgetSpent();
        return value.apply(target, args);
      };
    },
  });
}

// ── Settings → Server → Demo ────────────────────────────────────────────────

/** How the demo is used: visitors' accounts now, today's AI calls, and the counts (lib/analytics.ts) of `days` days. */
export async function demoReport(deps: Deps, config: Config, days: number) {
  const staff = [config.DEMO_EMAIL, config.DEMO_ADMIN_EMAIL].filter((e): e is string => !!e).map((e) => e.toLowerCase());
  const [visitors] = await deps.db
    .select({ n: sql<number>`count(*)` })
    .from(user)
    .where(sql`lower(${user.email}) not in (select value from json_each(${JSON.stringify(staff)}))`);
  const [households] = await deps.db
    .select({ n: sql<number>`count(*)` })
    .from(organization)
    .where(sql`${organization.slug} not in (${DEMO_HOUSEHOLD.slug}, ${ADMIN_HOUSEHOLD.slug}) and ${organization.slug} not like ${`${PLANTING}%`}`);
  let counts: Awaited<ReturnType<NonNullable<NonNullable<Deps["analytics"]>["report"]>>> = null;
  let countsError: string | null = null;
  try {
    counts = (await deps.analytics?.report?.(days)) ?? null;
  } catch (err) {
    countsError = err instanceof Error ? err.message : String(err);
  }
  return {
    days,
    visitorAccounts: Number(visitors?.n ?? 0),
    visitorHouseholds: Number(households?.n ?? 0),
    visitorDays: config.DEMO_VISITOR_DAYS,
    ai: { today: await aiSpentToday(deps.db), perDay: config.DEMO_AI_PER_DAY },
    paused: config.DEMO_PAUSED,
    partsOff: [...(await partsOff(deps.db))],
    counts,
    countsError,
  };
}
