/**
 * Smart-home pairing codes on items (lib/pairing.ts). Listing them is for everyone in the household; showing a code
 * needs a real sign-in (not an API key — the codes stay out of scripts and Claude) and a role that can edit.
 */
import { pairingInput } from "@ferret/shared";
import { Hono } from "hono";
import { type AppEnv, body, callerOf, requireHousehold, requireSession, requireUser, requireWriter } from "../lib/context";
import * as svc from "../lib/pairing";

export const pairing = new Hono<AppEnv>();
pairing.use("/items/:id/pairing", requireUser, requireHousehold);
pairing.use("/items/:id/pairing/*", requireUser, requireHousehold);

pairing.get("/items/:id/pairing", async (c) => c.json({ data: await svc.listPairing(callerOf(c), c.req.param("id")) }));

pairing.post("/items/:id/pairing", requireWriter, async (c) =>
  c.json(await svc.addPairing(callerOf(c), c.var.files, c.req.param("id"), await body(c.req.raw, pairingInput)), 201),
);

pairing.post("/items/:id/pairing/:pairingId/reveal", requireSession, requireWriter, async (c) =>
  c.json(await svc.revealPairing(callerOf(c), c.var.files, c.req.param("id"), c.req.param("pairingId"))),
);

pairing.delete("/items/:id/pairing/:pairingId", requireWriter, async (c) => {
  await svc.deletePairing(callerOf(c), c.req.param("id"), c.req.param("pairingId"));
  return c.body(null, 204);
});
