/** /api/v1/notifications — this person's reminders to other apps through Apprise (a real sign-in only). */
import { notificationChannelInput } from "@ferret/shared";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { type AppEnv, body, requireHousehold, requireSession, requireUser } from "../lib/context";
import { addChannel, listChannels, removeChannel, testChannel } from "../lib/notifications";

export const notifications = new Hono<AppEnv>();
notifications.use(requireUser, requireSession, requireHousehold);

const owner = (c: { var: AppEnv["Variables"] }) => ({
  db: c.var.db,
  files: c.var.files,
  householdId: c.var.householdId,
  userId: c.var.user.id,
});

const notSetUp = () => new HTTPException(409, { message: "Notifications to other apps aren't set up on this server (APPRISE_URL)" });

/** Whether Apprise is set up on the server, and this person's channels. */
notifications.get("/", async (c) => c.json({ enabled: Boolean(c.var.deps.notifier), data: await listChannels(owner(c)) }));

notifications.post("/", async (c) => {
  if (!c.var.deps.notifier) throw notSetUp();
  return c.json(await addChannel(owner(c), await body(c.req.raw, notificationChannelInput)), 201);
});

notifications.delete("/:id", async (c) => {
  await removeChannel(owner(c), c.req.param("id"));
  return c.body(null, 204);
});

notifications.post("/:id/test", async (c) => {
  const notifier = c.var.deps.notifier;
  if (!notifier) throw notSetUp();
  await testChannel(owner(c), notifier, c.req.param("id"), c.var.config.PUBLIC_URL);
  return c.json({ sent: true });
});
