import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { userLanguage } from "../db/schema";
import { body, requireUser, requireSession, type AppEnv } from "../lib/context";
import { preferredLanguage } from "../lib/i18n";

export const language = new Hono<AppEnv>();
language.use("/*", requireUser, requireSession);
language.get("/", async (c) => {
  const [preference] = await c.var.db.select().from(userLanguage).where(eq(userLanguage.userId, c.var.user.id));
  return c.json({ language: await preferredLanguage(c.var.db, c.var.user.id, c.var.session?.activeOrganizationId), personal: Boolean(preference) });
});
language.put("/", async (c) => {
  const input = await body(c.req.raw, z.object({ language: z.enum(["en", "hu"]) }));
  await c.var.db.insert(userLanguage).values({ userId: c.var.user.id, language: input.language })
    .onConflictDoUpdate({ target: userLanguage.userId, set: { language: input.language } });
  return c.json({ language: await preferredLanguage(c.var.db, c.var.user.id) });
});
