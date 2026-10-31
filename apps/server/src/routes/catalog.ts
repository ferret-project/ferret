/** /api/v1/categories, /api/v1/tags and /api/v1/templates — thin; see lib/catalog.ts and lib/templates.ts. */
import { categoryInput, categoryPatch, collectionInput, collectionPatch, templateInput, templatePatch } from "@ferret/shared";
import { Hono } from "hono";
import { z } from "zod";
import * as svc from "../lib/catalog";
import * as templates from "../lib/templates";
import * as collections from "../lib/collections";
import { type AppEnv, body, callerOf, requireHousehold, requireUser, requireWriter } from "../lib/context";

export const catalog = new Hono<AppEnv>();
catalog.use("/categories/*", requireUser, requireHousehold);
catalog.use("/categories", requireUser, requireHousehold);
catalog.use("/tags/*", requireUser, requireHousehold);
catalog.use("/tags", requireUser, requireHousehold);
catalog.use("/templates/*", requireUser, requireHousehold);
catalog.use("/templates", requireUser, requireHousehold);
catalog.use("/collections/*", requireUser, requireHousehold);
catalog.use("/collections", requireUser, requireHousehold);

/** Every category as a tree, with paths, extra fields and item counts. */
catalog.get("/categories", async (c) => c.json({ data: await svc.categoryTree(callerOf(c)) }));

catalog.post("/categories", requireWriter, async (c) =>
  c.json(await svc.createCategory(callerOf(c), await body(c.req.raw, categoryInput)), 201),
);

/** A starting set (Appliances, Electronics, Tools…) for a household with no categories yet. */
catalog.post("/categories/starter", requireWriter, async (c) => c.json({ data: await svc.addStarterCategories(callerOf(c)) }, 201));

catalog.patch("/categories/:id", requireWriter, async (c) =>
  c.json(await svc.updateCategory(callerOf(c), c.req.param("id"), await body(c.req.raw, categoryPatch))),
);

/** Its subcategories and items move up to its parent. */
catalog.delete("/categories/:id", requireWriter, async (c) => {
  await svc.deleteCategory(callerOf(c), c.req.param("id"));
  return c.body(null, 204);
});

/** Every tag, with how many items carry it. */
catalog.get("/tags", async (c) => c.json({ data: await svc.listTags(callerOf(c)) }));

/** Rename (onto an existing tag = merge). */
catalog.patch("/tags/:id", requireWriter, async (c) => {
  const { name } = await body(c.req.raw, z.object({ name: z.string().trim().min(1).max(40) }));
  return c.json(await svc.renameTag(callerOf(c), c.req.param("id"), name));
});

catalog.delete("/tags/:id", requireWriter, async (c) => {
  await svc.deleteTag(callerOf(c), c.req.param("id"));
  return c.body(null, 204);
});

// ── Item templates ─────────────────────────────────────────────────────────
catalog.get("/templates", async (c) => c.json({ data: await templates.listTemplates(callerOf(c)) }));
catalog.post("/templates", requireWriter, async (c) => c.json(await templates.createTemplate(callerOf(c), await body(c.req.raw, templateInput)), 201));
/** Coin, trading card, doll, toy, comic, stamp, record, LEGO — the ones the household doesn't have yet. */
catalog.post("/templates/starter", requireWriter, async (c) => c.json({ data: await templates.addStarterTemplates(callerOf(c)) }, 201));
catalog.get("/templates/:id", async (c) => c.json(await templates.getTemplate(callerOf(c), c.req.param("id"))));
catalog.patch("/templates/:id", requireWriter, async (c) =>
  c.json(await templates.updateTemplate(callerOf(c), c.req.param("id"), await body(c.req.raw, templatePatch))),
);
catalog.delete("/templates/:id", requireWriter, async (c) => {
  await templates.deleteTemplate(callerOf(c), c.req.param("id"));
  return c.body(null, 204);
});

// ── Collections (the things in one: GET /items?collectionId=…&wanted=include) ─────────────────────────────
catalog.get("/collections", async (c) => c.json({ data: await collections.listCollections(callerOf(c)) }));
catalog.post("/collections", requireWriter, async (c) => c.json(await collections.createCollection(callerOf(c), await body(c.req.raw, collectionInput)), 201));
catalog.get("/collections/:id", async (c) => c.json(await collections.getCollection(callerOf(c), c.req.param("id"))));
catalog.patch("/collections/:id", requireWriter, async (c) =>
  c.json(await collections.updateCollection(callerOf(c), c.req.param("id"), await body(c.req.raw, collectionPatch))),
);
/** Its owned things stay (out of it); its want list goes to Recently deleted. */
catalog.delete("/collections/:id", requireWriter, async (c) => {
  await collections.deleteCollection(callerOf(c), c.req.param("id"));
  return c.body(null, 204);
});
