/**
 * /api/v1/attention — what needs doing now (the app's bell): lib/attention.ts. In the person's language when they're
 * signed in; English for API keys, so a script's text doesn't change under it.
 */
import { Hono } from "hono";
import { needsAttention } from "../lib/attention";
import { type AppEnv, callerOf, requireHousehold, requireUser } from "../lib/context";
import { translator, trFor } from "../lib/language";

export const attention = new Hono<AppEnv>();
attention.get("/", requireUser, requireHousehold, async (c) => {
  const tr = c.var.apiKey ? translator(undefined, null) : await trFor(c.var.deps, c.var.user.id);
  return c.json({ data: await needsAttention(callerOf(c), tr) });
});
