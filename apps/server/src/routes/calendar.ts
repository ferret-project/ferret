/**
 * Calendar feeds of due maintenance: settings under /api/v1/calendar (a real
 * sign-in only), and the feed itself at /calendar/:token.ics, which calendar
 * apps fetch without cookies — the token is the credential.
 */
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { calendarFeed, organization } from "../db/schema";
import { createFeed, feedToken, findFeed, toICalendar } from "../lib/calendar";
import { type AppEnv, membership, requireHousehold, requireSession, requireUser } from "../lib/context";
import { listMaintenance } from "../lib/maintenance";
import { householdTimeZone } from "../lib/household-time";
import { featureOn, requireFeature } from "../lib/plan";

export const calendarSettings = new Hono<AppEnv>();
calendarSettings.use(requireUser, requireSession, requireHousehold);

const mine = (c: { var: AppEnv["Variables"] }) =>
  and(eq(calendarFeed.householdId, c.var.householdId), eq(calendarFeed.userId, c.var.user.id));

const links = (publicUrl: string, token: string) => {
  const url = `${publicUrl}/calendar/${token}.ics`;
  return { url, webcal: url.replace(/^https?:/, "webcal:") };
};

/** This person's feed for this household: whether it's on, and its link (null for feeds made before links were kept). */
calendarSettings.get("/", async (c) => {
  const feed = await feedToken(c.var.db, c.var.files, c.var.householdId, c.var.user.id);
  return c.json({
    active: Boolean(feed),
    createdAt: feed?.createdAt ?? null,
    ...(feed?.token ? links(c.var.config.PUBLIC_URL, feed.token) : { url: null, webcal: null }),
  });
});

/** Turn it on, or reset the link (the old one stops working — e.g. if it leaked). */
calendarSettings.post("/", async (c) => {
  await requireFeature({ deps: c.var.deps, householdId: c.var.householdId }, "calendarFeeds");
  const token = await createFeed(c.var.db, c.var.files, c.var.householdId, c.var.user.id);
  return c.json(links(c.var.config.PUBLIC_URL, token), 201);
});

calendarSettings.delete("/", async (c) => {
  await c.var.db.delete(calendarFeed).where(mine(c));
  return c.body(null, 204);
});

export const calendar = new Hono<AppEnv>();

calendar.get("/:file", async (c) => {
  const token = /^([\w-]{20,100})\.ics$/.exec(c.req.param("file"))?.[1];
  const feed = token ? await findFeed(c.var.db, token) : undefined;
  if (!feed) throw new HTTPException(404, { message: "Unknown calendar" });
  // Someone who left the household stops getting its calendar.
  if (!(await membership(c.var.db, feed.householdId, feed.userId))) throw new HTTPException(404, { message: "Unknown calendar" });
  // Its household's plan no longer has calendar feeds: paused (the link works again if the plan does).
  if (!(await featureOn({ deps: c.var.deps, householdId: feed.householdId }, "calendarFeeds"))) {
    throw new HTTPException(403, { message: "This calendar is paused" });
  }

  const [household] = await c.var.db.select({ name: organization.name }).from(organization).where(eq(organization.id, feed.householdId));
  const caller = { deps: c.var.deps, db: c.var.db, householdId: feed.householdId, userId: feed.userId, timeZone: await householdTimeZone(c.var.db, feed.householdId), via: "web" as const };
  const tasks = await listMaintenance(caller, { status: "open" });
  const ics = toICalendar(tasks, { name: `${household?.name ?? "Ferret"} maintenance`, appUrl: c.var.config.PUBLIC_URL, timeZone: caller.timeZone });
  return c.body(ics, 200, {
    "Content-Type": "text/calendar; charset=utf-8",
    "Cache-Control": "private, max-age=300",
  });
});
