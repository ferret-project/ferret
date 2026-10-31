/** Warranty claims: /api/v1/warranties/:id/claims to file one, /api/v1/claims to list and change them (lib/claims.ts). */
import { claimInput, claimPatch } from "@ferret/shared";
import { Hono } from "hono";
import { type AppEnv, body, callerOf, requireHousehold, requireUser, requireWriter } from "../lib/context";
import * as svc from "../lib/claims";

export const claims = new Hono<AppEnv>();
claims.use("/claims/*", requireUser, requireHousehold);
claims.use("/claims", requireUser, requireHousehold);
claims.use("/warranties/:id/claims", requireUser, requireHousehold);

/** Newest first; ?itemId=, ?open=true (still waiting on the provider). */
claims.get("/claims", async (c) =>
  c.json({ data: await svc.listClaims(callerOf(c), { itemId: c.req.query("itemId") || undefined, open: c.req.query("open") === "true" }) }),
);
claims.get("/warranties/:id/claims", async (c) => c.json({ data: await svc.listClaims(callerOf(c), { warrantyId: c.req.param("id") }) }));
claims.post("/warranties/:id/claims", requireWriter, async (c) =>
  c.json(await svc.fileClaim(callerOf(c), c.req.param("id"), await body(c.req.raw, claimInput)), 201),
);
claims.patch("/claims/:id", requireWriter, async (c) =>
  c.json(await svc.updateClaim(callerOf(c), c.req.param("id"), await body(c.req.raw, claimPatch))),
);
claims.delete("/claims/:id", requireWriter, async (c) => {
  await svc.deleteClaim(callerOf(c), c.req.param("id"));
  return c.body(null, 204);
});
