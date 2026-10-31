/** /api/v1/push — this device's Web Push subscription for maintenance reminders (a real sign-in only). */
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { pushSubscription } from "../db/schema";
import { type AppEnv, body, requireHousehold, requireSession, requireUser } from "../lib/context";

export const push = new Hono<AppEnv>();
push.use(requireUser, requireSession, requireHousehold);

/**
 * The browsers' push services. A subscription's endpoint is where the server sends each reminder, so it must be one
 * of these — otherwise anyone signed in could make the server POST to any address.
 */
const PUSH_SERVICES = ["fcm.googleapis.com", "push.services.mozilla.com", "push.apple.com", "notify.windows.com"];
export const isPushService = (endpoint: string) => {
  const url = URL.parse(endpoint);
  return url?.protocol === "https:" && PUSH_SERVICES.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
};

const subscription = z.object({
  endpoint: z.url().max(2000).refine(isPushService, "Not a browser push service"),
  keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }),
});

/** Whether reminders are on for the server, its public key, and (with ?endpoint=) whether this device is subscribed. */
push.get("/", async (c) => {
  const service = c.var.deps.push;
  const endpoint = c.req.query("endpoint");
  const [mine] = endpoint
    ? await c.var.db
        .select({ id: pushSubscription.id })
        .from(pushSubscription)
        .where(and(eq(pushSubscription.endpoint, endpoint), eq(pushSubscription.userId, c.var.user.id)))
    : [];
  return c.json({ enabled: Boolean(service), publicKey: service?.publicKey ?? null, subscribed: Boolean(mine) });
});

push.post("/subscribe", async (c) => {
  if (!c.var.deps.push) throw new HTTPException(409, { message: "Push reminders aren't set up on this server (VAPID keys)" });
  const { endpoint, keys } = await body(c.req.raw, subscription);
  const values = { householdId: c.var.householdId, userId: c.var.user.id, endpoint, ...keys, lastNotifiedOn: null };
  // The same device again (e.g. after switching household) updates its row; another person's device is left alone.
  const saved = await c.var.db
    .insert(pushSubscription)
    .values(values)
    .onConflictDoUpdate({ target: pushSubscription.endpoint, set: values, setWhere: eq(pushSubscription.userId, c.var.user.id) })
    .returning({ id: pushSubscription.id });
  if (!saved.length) throw new HTTPException(409, { message: "This device gets someone else's reminders — they need to turn them off first" });
  return c.body(null, 204);
});

push.post("/unsubscribe", async (c) => {
  const { endpoint } = await body(c.req.raw, z.object({ endpoint: z.string().min(1) }));
  await c.var.db
    .delete(pushSubscription)
    .where(and(eq(pushSubscription.endpoint, endpoint), eq(pushSubscription.userId, c.var.user.id)));
  return c.body(null, 204);
});

/** Sends a test notification to this person's devices. */
push.post("/test", async (c) => {
  const service = c.var.deps.push;
  if (!service) throw new HTTPException(409, { message: "Push reminders aren't set up on this server (VAPID keys)" });
  const subs = await c.var.db
    .select()
    .from(pushSubscription)
    .where(and(eq(pushSubscription.userId, c.var.user.id), eq(pushSubscription.householdId, c.var.householdId)));
  let sent = 0;
  for (const sub of subs) {
    const result = await service.send(sub, {
      title: "Ferret reminders are on",
      body: "You'll hear from Ferret when maintenance is due or a warranty is about to end.",
      url: `${c.var.config.PUBLIC_URL}/#/maintenance`,
    });
    if (result === "gone") await c.var.db.delete(pushSubscription).where(eq(pushSubscription.id, sub.id));
    else sent++;
  }
  return c.json({ sent });
});
