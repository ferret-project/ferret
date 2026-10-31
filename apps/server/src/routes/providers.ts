/** /api/v1/providers — service providers and their history (lib/providers.ts). */
import { providerInput, providerPatch } from "@ferret/shared";
import { Hono } from "hono";
import { type AppEnv, body, callerOf, requireHousehold, requireUser, requireWriter } from "../lib/context";
import * as svc from "../lib/providers";

export const providers = new Hono<AppEnv>();
providers.use(requireUser, requireHousehold);

providers.get("/", async (c) => c.json({ data: await svc.listProviders(callerOf(c)) }));
providers.post("/", requireWriter, async (c) => c.json(await svc.createProvider(callerOf(c), await body(c.req.raw, providerInput)), 201));
providers.get("/:id", async (c) => c.json(await svc.getProvider(callerOf(c), c.req.param("id"))));
/** The jobs they did, newest first. */
providers.get("/:id/visits", async (c) => c.json({ data: await svc.providerVisits(callerOf(c), c.req.param("id")) }));
providers.patch("/:id", requireWriter, async (c) =>
  c.json(await svc.updateProvider(callerOf(c), c.req.param("id"), await body(c.req.raw, providerPatch))),
);
providers.delete("/:id", requireWriter, async (c) => {
  await svc.deleteProvider(callerOf(c), c.req.param("id"));
  return c.body(null, 204);
});
