/** /api/v1/maintenance — maintenance tasks, marking them done, and their history. Thin: see lib/maintenance.ts. */
import { maintenanceDone, maintenanceInput, maintenancePatch, taskVideoInput } from "@ferret/shared";
import { Hono } from "hono";
import { z } from "zod";
import { type AppEnv, body, callerOf, requireHousehold, requireUser, requireWriter } from "../lib/context";
import * as svc from "../lib/maintenance";
import { dismissSuggestedTask, listSuggestedTasks } from "../lib/suggested-tasks";
import { askTypicalUpkeep } from "../lib/typical-upkeep";
import { addTaskVideo, removeTaskVideo, searchVideos } from "../lib/videos";

export const maintenance = new Hono<AppEnv>();
maintenance.use(requireUser, requireHousehold);

const listQuery = z.object({
  itemId: z.string().min(1).optional(),
  providerId: z.string().min(1).optional(),
  status: z.enum(["open", "all", "overdue", "due", "upcoming", "done"]).optional(),
});

/** Open tasks soonest first; ?status=all|overdue|due|upcoming|done, ?itemId= for one item's. */
maintenance.get("/", async (c) => c.json({ data: await svc.listMaintenance(callerOf(c), listQuery.parse(c.req.query())) }));

/** YouTube's search for how-to videos (`q`), on a server with a YouTube key: `available: false` without one. Writers only (it uses the server's daily allowance). */
maintenance.get("/videos/search", requireWriter, async (c) => c.json(await searchVideos(callerOf(c), z.string().max(200).parse(c.req.query("q") ?? ""))));

/** Suggested maintenance: schedules found in manuals, and typical upkeep — waiting to be added or dismissed. */
maintenance.get("/suggestions", async (c) =>
  c.json({ data: await listSuggestedTasks(callerOf(c), z.string().min(1).optional().parse(c.req.query("itemId"))) }),
);
/** Typical upkeep for one thing (`itemId`), or for the household's things not asked about yet: into Suggested maintenance. */
maintenance.post("/typical", requireWriter, async (c) => {
  const { itemId } = await body(c.req.raw, z.object({ itemId: z.string().min(1).optional() }));
  return c.json(await askTypicalUpkeep(callerOf(c), itemId), 202);
});
maintenance.post("/suggestions/:id/dismiss", requireWriter, async (c) => c.json(await dismissSuggestedTask(callerOf(c), c.req.param("id"))));

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

/** A how-to video on a task, from a YouTube link. */
maintenance.post("/:id/videos", requireWriter, async (c) =>
  c.json(await addTaskVideo(callerOf(c), c.req.param("id"), (await body(c.req.raw, taskVideoInput)).url), 201),
);
maintenance.delete("/:id/videos/:videoId", requireWriter, async (c) => c.json(await removeTaskVideo(callerOf(c), c.req.param("id"), c.req.param("videoId"))));
