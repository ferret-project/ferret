/** Collector catalogs: LEGO sets, coins and comics — search, read a photo, a coin's prices, a thing's entry (lib/collectibles.ts). */
import { collectibleKinds, collectibleSearch } from "@ferret/shared";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import * as svc from "../lib/collectibles";
import { type AppEnv, callerOf, requireHousehold, requireUser, requireWriter } from "../lib/context";

export const collectibles = new Hono<AppEnv>();
collectibles.use("/collectibles/*", requireUser, requireHousehold);
collectibles.use("/items/:id/collectible", requireUser, requireHousehold);
collectibles.use("/items/:id/collectible/*", requireUser, requireHousehold);

const kind = z.enum(collectibleKinds);

const photoLimit = createMiddleware<AppEnv>((c, next) =>
  bodyLimit({
    maxSize: c.var.config.MAX_UPLOAD_MB * 1024 * 1024 + 64 * 1024,
    onError: (c) => c.json({ error: { code: "http_413", message: `Photos can be up to ${c.var.config.MAX_UPLOAD_MB} MB` } }, 413),
  })(c, next),
);

/** Typed: sets, coins or comics matching the words (coins also by issuer and year). */
collectibles.get("/collectibles/search", async (c) => {
  const q = collectibleSearch.parse(c.req.query());
  return c.json({ data: await svc.searchCollectibles(callerOf(c), c.var.config.FILES_KEY, q) });
});

/** Coins: issuers (countries…) whose name has these words, to search coins by. */
collectibles.get("/collectibles/issuers", async (c) => {
  const { q } = z.object({ q: z.string().trim().min(1).max(80) }).parse(c.req.query());
  return c.json({ data: await svc.findIssuers(c.var.deps, c.var.config.FILES_KEY, q) });
});

/** multipart/form-data: `photo` and `kind`. 202: being read — GET /collectibles/read/{id} until it's done. */
collectibles.post("/collectibles/read", requireWriter, photoLimit, async (c) => {
  const form = await c.req.parseBody().catch(() => {
    throw new HTTPException(400, { message: "Body must be multipart/form-data" });
  });
  if (!(form.photo instanceof File)) throw new HTTPException(422, { message: "Send the photo as `photo`" });
  const chosen = kind.safeParse(form.kind);
  if (!chosen.success) throw new HTTPException(422, { message: "Say what it is as `kind`: lego, coin, comic, video, game, record or book" });
  const run = await svc.startCollectibleRead(callerOf(c), c.var.files, c.var.config.FILES_KEY, new Uint8Array(await form.photo.arrayBuffer()), chosen.data);
  return c.json(run, 202);
});

collectibles.get("/collectibles/read/:id", async (c) => c.json(await svc.getCollectibleRead(callerOf(c), c.req.param("id"))));

/** "Update values": the household's coins and records (or one collection's) beside today's price. */
collectibles.get("/collectibles/values", async (c) => {
  const { collectionId } = z.object({ collectionId: z.string().min(1).optional() }).parse(c.req.query());
  return c.json(await svc.collectibleValues(callerOf(c), collectionId ?? null));
});

/** One set, coin (with its issues) or comic. */
collectibles.get("/collectibles/:kind/:id", async (c) => {
  const k = kind.safeParse(c.req.param("kind"));
  if (!k.success) throw new HTTPException(404, { message: "Not found" });
  const info = await svc.collectibleFor(c.var.deps, c.var.config.FILES_KEY, k.data, c.req.param("id"));
  if (!info) throw new HTTPException(404, { message: "Not in the catalog" });
  return c.json(info);
});

/** Prices in the household's currency: a coin issue's by grade (`issue` needed), a record's by condition and the lowest for sale. */
collectibles.get("/collectibles/:kind/:id/prices", async (c) => {
  const k = kind.safeParse(c.req.param("kind"));
  if (!k.success) throw new HTTPException(404, { message: "Not found" });
  const { issue } = z.object({ issue: z.string().regex(/^\d+$/).optional() }).parse(c.req.query());
  const v = callerOf(c);
  return c.json({ data: await svc.catalogPrices(v.deps, c.var.config.FILES_KEY, k.data, c.req.param("id"), issue ?? null, v.currency) });
});

collectibles.get("/items/:id/collectible", async (c) => c.json(await svc.itemCollectible(callerOf(c), c.var.config.FILES_KEY, c.req.param("id"))));

/** Keep the catalog's picture as the thing's photo. */
collectibles.post("/items/:id/collectible/photo", requireWriter, async (c) =>
  c.json(await svc.useCollectibleImage(callerOf(c), c.var.files, c.var.config.FILES_KEY, c.req.param("id")), 201),
);
