/** Scan to count (lib/stock.ts): what a scan does, an item's count and its history, what its codes do, the shopping list. */
import { scanInput, stockAdjust, stockRuleInput } from "@ferret/shared";
import { Hono } from "hono";
import { type AppEnv, body, callerOf, requireHousehold, requireUser, requireWriter } from "../lib/context";
import * as svc from "../lib/stock";

export const stock = new Hono<AppEnv>();
stock.use("/scan", requireUser, requireHousehold);
stock.use("/items/:id/stock", requireUser, requireHousehold);
stock.use("/items/:id/stock/*", requireUser, requireHousehold);
stock.use("/items/:id/stock-rules", requireUser, requireHousehold);
stock.use("/items/:id/stock-rules/*", requireUser, requireHousehold);
stock.use("/stock/*", requireUser, requireHousehold);
stock.use("/shopping", requireUser, requireHousehold);

/** Anyone can scan; only writers' scans change a count (a viewer's always just looks it up). */
stock.post("/scan", async (c) => {
  const canWrite = c.var.role !== "viewer" && !c.var.apiKey?.readOnly;
  return c.json(await svc.scan(callerOf(c), await body(c.req.raw, scanInput), canWrite, c.var.files));
});

stock.get("/items/:id/stock", async (c) => c.json(await svc.stockSummary(callerOf(c), c.req.param("id"))));

stock.post("/items/:id/stock", requireWriter, async (c) =>
  c.json(await svc.adjustByHand(callerOf(c), c.req.param("id"), await body(c.req.raw, stockAdjust))),
);

stock.put("/items/:id/stock-rules", requireWriter, async (c) =>
  c.json(await svc.setStockRule(callerOf(c), c.req.param("id"), await body(c.req.raw, stockRuleInput))),
);

stock.delete("/items/:id/stock-rules/:ruleId", requireWriter, async (c) => {
  await svc.deleteStockRule(callerOf(c), c.req.param("id"), c.req.param("ruleId"));
  return c.body(null, 204);
});

stock.post("/stock/movements/:id/undo", requireWriter, async (c) => c.json(await svc.undoMovement(callerOf(c), c.req.param("id"))));

/** What to buy: run out, or at or below "keep at least" — and the list as text, to copy or share. */
stock.get("/shopping", async (c) => c.json(await svc.shoppingList(callerOf(c))));
