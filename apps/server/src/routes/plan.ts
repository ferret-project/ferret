/**
 * Settings → Plan & usage (lib/plan.ts): the household's plan, if any, and this period's usage by person. Everyone
 * in the household can see it; a plan's billing is the service's own (its upgradeUrl / manageUrl).
 */
import { Hono } from "hono";
import { type AppEnv, requireHousehold, requireUser } from "../lib/context";
import { planReport } from "../lib/plan";

export const plan = new Hono<AppEnv>();

plan.use("/*", requireUser, requireHousehold);

plan.get("/", async (c) => c.json(await planReport({ db: c.var.db, deps: c.var.deps, householdId: c.var.householdId })));
