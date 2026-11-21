/** ENERGY STAR: a thing's certified energy use (lib/energy.ts). */
import { Hono } from "hono";
import { type AppEnv, callerOf, requireHousehold, requireUser } from "../lib/context";
import { itemEnergy } from "../lib/energy";

export const energy = new Hono<AppEnv>();
energy.use("/items/:id/energy", requireUser, requireHousehold);

/** `pending`: being looked up — ask again in a few seconds. */
energy.get("/items/:id/energy", async (c) => c.json(await itemEnergy(callerOf(c), c.req.param("id"))));
