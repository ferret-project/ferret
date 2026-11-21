/** Graded coins and cards: a certificate's details (PCGS, PSA), and a graded thing's (lib/graded.ts). */
import { gradingServices } from "@ferret/shared";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { type AppEnv, callerOf, requireHousehold, requireUser } from "../lib/context";
import { itemGraded, lookupCert } from "../lib/graded";

export const graded = new Hono<AppEnv>();
graded.use("/graded/*", requireUser, requireHousehold);
graded.use("/items/:id/graded", requireUser, requireHousehold);

/** What PCGS or PSA says about a certificate number (before it's saved on a thing). */
graded.get("/graded/:by/:cert", async (c) => {
  const by = z.enum(gradingServices).safeParse(c.req.param("by"));
  const cert = z.string().regex(/^[0-9A-Za-z-]{4,30}$/).safeParse(c.req.param("cert"));
  if (!by.success || !cert.success) throw new HTTPException(404, { message: "Not found" });
  const info = await lookupCert(c.var.deps, c.var.config.FILES_KEY, by.data, cert.data);
  if (!info) throw new HTTPException(404, { message: "No such certificate" });
  return c.json(info);
});

graded.get("/items/:id/graded", async (c) => c.json(await itemGraded(callerOf(c), c.var.config.FILES_KEY, c.req.param("id"))));
