/**
 * Outside checks on one thing: ENERGY STAR's certified energy use (lib/energy.ts), Bike Index's stolen reports
 * (lib/bikes.ts), a vehicle's fuel economy (lib/fuel-economy.ts).
 */
import { Hono } from "hono";
import { z } from "zod";
import { type AppEnv, body, callerOf, requireHousehold, requireUser, requireWriter } from "../lib/context";
import { chooseFuelEconomy, clearFuelEconomy, itemFuelEconomy } from "../lib/fuel-economy";
import { itemEnergy } from "../lib/energy";
import { itemBikeIndex } from "../lib/bikes";

export const energy = new Hono<AppEnv>();
energy.use("/items/:id/energy", requireUser, requireHousehold);
energy.use("/items/:id/bike-index", requireUser, requireHousehold);
energy.use("/items/:id/fuel-economy", requireUser, requireHousehold);

/** `pending`: being looked up — ask again in a few seconds. */
energy.get("/items/:id/energy", async (c) => c.json(await itemEnergy(callerOf(c), c.req.param("id"))));

/** Whether a bike with this one's serial is reported stolen on Bike Index; `pending` — ask again. */
energy.get("/items/:id/bike-index", async (c) => c.json(await itemBikeIndex(callerOf(c), c.req.param("id"))));

/** A vehicle's EPA fuel economy: confirmed (with a year's fuel cost), entries to choose from, or `pending` — ask again. */
energy.get("/items/:id/fuel-economy", async (c) => c.json(await itemFuelEconomy(callerOf(c), c.req.param("id"))));

/** "It's this one" ({ id } of an offered entry), or "none of these" ({ id: null }). */
energy.put("/items/:id/fuel-economy", requireWriter, async (c) => {
  const { id } = await body(c.req.raw, z.object({ id: z.string().regex(/^\d{1,8}$/).nullable() }));
  return c.json(await chooseFuelEconomy(callerOf(c), c.req.param("id"), id));
});

/** "Not this one": forget the choice, and offer the entries again. */
energy.delete("/items/:id/fuel-economy", requireWriter, async (c) => c.json(await clearFuelEconomy(callerOf(c), c.req.param("id"))));
