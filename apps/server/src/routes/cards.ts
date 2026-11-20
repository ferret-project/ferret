/** Trading cards ("Scan cards"): read a photo of a card, search the games' catalogs, a card thing's price (lib/cards.ts). */
import { cardGames } from "@ferret/shared";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import * as svc from "../lib/cards";
import { type AppEnv, callerOf, requireHousehold, requireUser, requireWriter } from "../lib/context";

export const cards = new Hono<AppEnv>();
cards.use("/cards/*", requireUser, requireHousehold);
cards.use("/items/:id/card", requireUser, requireHousehold);
cards.use("/items/:id/card/*", requireUser, requireHousehold);

const game = z.enum(cardGames);

const photoLimit = createMiddleware<AppEnv>((c, next) =>
  bodyLimit({
    maxSize: c.var.config.MAX_UPLOAD_MB * 1024 * 1024 + 64 * 1024,
    onError: (c) => c.json({ error: { code: "http_413", message: `Photos can be up to ${c.var.config.MAX_UPLOAD_MB} MB` } }, 413),
  })(c, next),
);

/** Typed: the cards matching a name (and number) in one game's catalog. */
cards.get("/cards/search", async (c) => {
  const q = z.object({ game, q: z.string().trim().min(1).max(200) }).parse(c.req.query());
  return c.json({ data: await svc.searchCards(callerOf(c), q.game, q.q) });
});

/** multipart/form-data: `photo`, and optionally `game`. 202: being read — GET /cards/read/{id} until it's done. */
cards.post("/cards/read", requireWriter, photoLimit, async (c) => {
  const form = await c.req.parseBody().catch(() => {
    throw new HTTPException(400, { message: "Body must be multipart/form-data" });
  });
  if (!(form.photo instanceof File)) throw new HTTPException(422, { message: "Send the card's photo as `photo`" });
  const chosen = game.safeParse(form.game);
  const run = await svc.startCardRead(callerOf(c), c.var.files, new Uint8Array(await form.photo.arrayBuffer()), chosen.success ? chosen.data : null);
  return c.json(run, 202);
});

cards.get("/cards/read/:id", async (c) => c.json(await svc.getCardRead(callerOf(c), c.req.param("id"))));

/** "Update values": the household's cards (or one collection's) beside today's price. */
cards.get("/cards/values", async (c) => {
  const { collectionId } = z.object({ collectionId: z.string().min(1).optional() }).parse(c.req.query());
  return c.json(await svc.cardValues(callerOf(c), collectionId ?? null));
});

cards.get("/items/:id/card", async (c) => c.json(await svc.itemCard(callerOf(c), c.req.param("id"))));

/** Keep the card's own picture as the thing's photo. */
cards.post("/items/:id/card/photo", requireWriter, async (c) => c.json(await svc.useCardImage(callerOf(c), c.var.files, c.req.param("id")), 201));
