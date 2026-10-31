/** /api/v1/trash — "Recently deleted": deleted items for 30 days, to restore or delete for good. */
import { Hono } from "hono";
import { type AppEnv, callerOf, requireHousehold, requireUser, requireWriter } from "../lib/context";
import { deleteItemForGood, listDeleted, restoreItem } from "../lib/trash";

export const trash = new Hono<AppEnv>();
trash.use(requireUser, requireHousehold);

trash.get("/items", async (c) => c.json({ data: await listDeleted(callerOf(c)) }));

trash.post("/items/:id/restore", requireWriter, async (c) => c.json(await restoreItem(callerOf(c), c.req.param("id"))));

trash.delete("/items/:id", requireWriter, async (c) => {
  await deleteItemForGood(callerOf(c), c.var.files, c.req.param("id"));
  return c.body(null, 204);
});
