/**
 * /api/v1/labels — QR labels for boxes, items and places (lib/labels.ts), and
 * /l/:code, the address printed in each QR code: it opens the app on that label.
 */
import { attachLabelInput, labelTarget } from "@ferret/shared";
import { Hono } from "hono";
import { z } from "zod";
import { type AppEnv, body, callerOf, requireHousehold, requireUser, requireWriter } from "../lib/context";
import * as svc from "../lib/labels";
import { attachLabel, removeOwnLabel } from "../lib/own-labels";

export const labels = new Hono<AppEnv>();

/** A scanned code: what it opens (in any of your households). */
labels.get("/:code{[0-9A-Za-z-]{4,12}}", requireUser, async (c) =>
  c.json(await svc.resolveLabel({ deps: c.var.deps, db: c.var.db, userId: c.var.user.id, via: c.var.apiKey ? "api" : "web" }, c.req.param("code"))),
);

labels.use("/*", requireUser, requireHousehold);
labels.use("/", requireUser, requireHousehold);

/** This household's labels; ?blank=true for ones not stuck on anything yet. */
labels.get("/", async (c) => c.json({ data: await svc.listLabels(callerOf(c), { blank: c.req.query("blank") === "true" }) }));

/** Blank labels to print ahead. */
labels.post("/blank", requireWriter, async (c) => {
  const { count } = await body(c.req.raw, z.object({ count: z.number().int().min(1).max(300) }));
  return c.json({ codes: await svc.createBlankLabels(callerOf(c), count) }, 201);
});

/** The label for a box, item or place (its existing one, or a new one). */
labels.post("/for", requireWriter, async (c) => c.json(await svc.labelFor(callerOf(c), await body(c.req.raw, labelTarget))));

/** Put a label you already have on something: a blank Ferret label, or (items) any other code — an asset tag. */
labels.post("/attach", requireWriter, async (c) => {
  const { code, ...target } = await body(c.req.raw, attachLabelInput);
  return c.json(await attachLabel(callerOf(c), code, target));
});

/** Take a label someone brought off its item. */
labels.delete("/own/:id", requireWriter, async (c) => {
  await removeOwnLabel(callerOf(c), c.req.param("id"));
  return c.body(null, 204);
});

/** Put a blank label on something. */
labels.put("/:code", requireWriter, async (c) =>
  c.json(await svc.assignLabel(callerOf(c), c.req.param("code"), await body(c.req.raw, labelTarget))),
);

/** Take a label off (blank again). */
labels.delete("/:code", requireWriter, async (c) => {
  await svc.clearLabel(callerOf(c), c.req.param("code"));
  return c.body(null, 204);
});

/** The QR code's address: hand over to the app, which looks the code up once signed in. */
export const shortLinks = new Hono<AppEnv>();
shortLinks.get("/:code{[0-9A-Za-z]{4,12}}", (c) => c.redirect(`/#/l/${encodeURIComponent(c.req.param("code").toUpperCase())}`, 302));
