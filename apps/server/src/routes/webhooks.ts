/**
 * /api/v1/webhooks — the household's webhooks (lib/webhooks.ts): its owner and admins, signed in (not an API key: a
 * webhook sends the household's events elsewhere).
 */
import { webhookInput, webhookPatch } from "@ferret/shared";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { type AppEnv, body, callerOf, requireHousehold, requireSession, requireUser } from "../lib/context";
import {
  createWebhook,
  listDeliveries,
  listWebhooks,
  removeWebhook,
  retryDelivery,
  rotateSecret,
  testWebhook,
  updateWebhook,
  webhookSecret,
} from "../lib/webhooks";
import { WEBHOOK_EVENTS } from "@ferret/shared";
import { isServerAdmin } from "../lib/server-admin";

export const webhooks = new Hono<AppEnv>();
webhooks.use(requireUser, requireHousehold, requireSession, async (c, next) => {
  if (c.var.role !== "owner" && c.var.role !== "admin") throw new HTTPException(403, { message: "Only the household's owner and admins can manage webhooks" });
  await next();
});

const manager = (c: Parameters<typeof callerOf>[0]) => ({ ...callerOf(c), files: c.var.files });
const notHere = () => new HTTPException(409, { message: "Webhooks aren't available on this server" });

/** Whether this server sends webhooks (and to its own network, for this person), the events, and the household's webhooks. */
webhooks.get("/", async (c) =>
  c.json({
    enabled: Boolean(c.var.deps.webhooks),
    local: await isServerAdmin(c.var.db, c.var.user.id),
    events: WEBHOOK_EVENTS,
    data: await listWebhooks(callerOf(c)),
  }),
);
webhooks.post("/", async (c) => {
  if (!c.var.deps.webhooks) throw notHere();
  return c.json(await createWebhook(manager(c), await body(c.req.raw, webhookInput)), 201);
});
webhooks.patch("/:id", async (c) => c.json(await updateWebhook(manager(c), c.req.param("id"), await body(c.req.raw, webhookPatch))));
webhooks.delete("/:id", async (c) => {
  await removeWebhook(callerOf(c), c.req.param("id"));
  return c.body(null, 204);
});
webhooks.post("/:id/test", async (c) => c.json(await testWebhook(manager(c), c.req.param("id"), c.var.config.PUBLIC_URL)));
webhooks.post("/:id/secret", async (c) => c.json(await webhookSecret(manager(c), c.req.param("id"))));
webhooks.post("/:id/rotate", async (c) => c.json(await rotateSecret(manager(c), c.req.param("id"))));
webhooks.get("/:id/deliveries", async (c) => c.json({ data: await listDeliveries(callerOf(c), c.req.param("id")) }));
webhooks.post("/:id/deliveries/:deliveryId/retry", async (c) => c.json(await retryDelivery(callerOf(c), c.req.param("id"), c.req.param("deliveryId"))));
