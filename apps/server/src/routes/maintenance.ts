/** /api/v1/maintenance — maintenance tasks, marking them done, and their history. Thin: see lib/maintenance.ts. */
import { maintenanceDone, maintenanceInput, maintenancePatch } from "@ferret/shared";
import { Hono } from "hono";
import { z } from "zod";
import { type AppEnv, body, callerOf, requireHousehold, requireUser, requireWriter } from "../lib/context";
import * as svc from "../lib/maintenance";

export const maintenance = new Hono<AppEnv>();
maintenance.use(requireUser, requireHousehold);

const listQuery = z.object({
  itemId: z.string().min(1).optional(),
  providerId: z.string().min(1).optional(),
  status: z.enum(["open", "all", "overdue", "due", "upcoming", "done"]).optional(),
});

/** Open tasks soonest first; ?status=all|overdue|due|upcoming|done, ?itemId= for one item's. */
maintenance.get("/", async (c) => c.json({ data: await svc.listMaintenance(callerOf(c), listQuery.parse(c.req.query())) }));

maintenance.post("/", requireWriter, async (c) => c.json(await svc.createTask(callerOf(c), await body(c.req.raw, maintenanceInput)), 201));

maintenance.get("/:id", async (c) => c.json(await svc.getTask(callerOf(c), c.req.param("id"))));

maintenance.patch("/:id", requireWriter, async (c) =>
  c.json(await svc.updateTask(callerOf(c), c.req.param("id"), await body(c.req.raw, maintenancePatch))),
);

maintenance.delete("/:id", requireWriter, async (c) => {
  await svc.deleteTask(callerOf(c), c.req.param("id"));
  return c.body(null, 204);
});

/** Done: logs it and moves the next due date on (from the day it was done). */
maintenance.post("/:id/done", requireWriter, async (c) =>
  c.json(await svc.markDone(callerOf(c), c.req.param("id"), await body(c.req.raw, maintenanceDone))),
);

maintenance.get("/:id/history", async (c) => c.json({ data: await svc.taskHistory(callerOf(c), c.req.param("id")) }));
