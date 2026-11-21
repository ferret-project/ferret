/** Outside checks on one thing: ENERGY STAR's certified energy use (lib/energy.ts), Bike Index's stolen reports (lib/bikes.ts). */
import { Hono } from "hono";
import { type AppEnv, callerOf, requireHousehold, requireUser } from "../lib/context";
import { itemEnergy } from "../lib/energy";
import { itemBikeIndex } from "../lib/bikes";

export const energy = new Hono<AppEnv>();
energy.use("/items/:id/energy", requireUser, requireHousehold);
energy.use("/items/:id/bike-index", requireUser, requireHousehold);

/** `pending`: being looked up — ask again in a few seconds. */
energy.get("/items/:id/energy", async (c) => c.json(await itemEnergy(callerOf(c), c.req.param("id"))));

/** Whether a bike with this one's serial is reported stolen on Bike Index; `pending` — ask again. */
energy.get("/items/:id/bike-index", async (c) => c.json(await itemBikeIndex(callerOf(c), c.req.param("id"))));
