/** Barcodes: what a scanned code is (the barcode book, then the online database), and an item's product suggestions. */
import { Hono } from "hono";
import { z } from "zod";
import { type AppEnv, body, callerOf, requireHousehold, requireUser, requireWriter } from "../lib/context";
import * as svc from "../lib/products";
import { itemsWithCode } from "../lib/stock";

export const barcodes = new Hono<AppEnv>();
barcodes.use("/barcodes/*", requireUser, requireHousehold);
barcodes.use("/items/:id/product", requireUser, requireHousehold);
barcodes.use("/items/:id/product/*", requireUser, requireHousehold);

/**
 * `match` is null when nobody knows the code; `online` says whether the online database is switched on; `have` is
 * what the household already has with it (so a client can offer "add 1 to it" before making another).
 */
barcodes.get("/barcodes/:code", async (c) => {
  const v = callerOf(c);
  const code = c.req.param("code");
  const [match, have] = await Promise.all([svc.lookupBarcode(v, code), itemsWithCode(v, code)]);
  return c.json({ match, online: Boolean(c.var.deps.products), have });
});

barcodes.get("/items/:id/product", async (c) => c.json(await svc.itemProduct(callerOf(c), c.req.param("id"))));

/** Attach one of the product's photos (by its index in `product.images`). */
barcodes.post("/items/:id/product/photo", requireWriter, async (c) => {
  const { index } = await body(c.req.raw, z.object({ index: z.number().int().min(0).max(7) }));
  return c.json(await svc.useProductPhoto(callerOf(c), c.var.files, c.req.param("id"), index), 201);
});

barcodes.post("/items/:id/product/dismiss", requireWriter, async (c) => {
  await svc.dismissProduct(callerOf(c), c.req.param("id"));
  return c.body(null, 204);
});
