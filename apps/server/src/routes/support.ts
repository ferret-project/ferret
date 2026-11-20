/** A thing's software support (endoflife.date): tracked, a model to confirm, or nothing (lib/support.ts). */
import { Hono } from "hono";
import { z } from "zod";
import { type AppEnv, body, callerOf, requireHousehold, requireUser, requireWriter } from "../lib/context";
import * as svc from "../lib/support";

export const support = new Hono<AppEnv>();
support.use("/items/:id/support", requireUser, requireHousehold);
support.use("/items/:id/support/*", requireUser, requireHousehold);

support.get("/items/:id/support", async (c) => c.json(await svc.itemSupport(callerOf(c), c.req.param("id"))));

/** "Yes, that's it": track this model's end of support on the thing. */
support.put("/items/:id/support", requireWriter, async (c) => {
  const pick = await body(c.req.raw, z.object({ product: z.string().min(1).max(80), release: z.string().min(1).max(80) }));
  return c.json(await svc.trackSupport(callerOf(c), c.req.param("id"), pick));
});

/** Stop tracking, or "it isn't that" for a suggestion: that model isn't offered for it again. */
support.delete("/items/:id/support", requireWriter, async (c) => c.json(await svc.untrackSupport(callerOf(c), c.req.param("id"))));
