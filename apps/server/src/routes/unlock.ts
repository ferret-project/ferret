/**
 * /api/v1/sign-in — "email me a link to sign in again" (works signed out). The
 * request always answers the same, so it never says whether an account exists.
 */
import { getIP } from "better-auth/api";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { UNLOCK_JOB } from "../jobs/unlock";
import { type AppEnv, body } from "../lib/context";
import { useUnlock } from "../lib/sign-in-guard";

export const unlock = new Hono<AppEnv>();

unlock.post("/unlock-request", async (c) => {
  const { email } = await body(c.req.raw, z.object({ email: z.email().max(320) }));
  const jobs = c.var.deps.jobs;
  if (jobs) {
    const ipAddress = getIP(c.req.raw, c.var.auth.options) ?? null;
    await jobs.enqueue(UNLOCK_JOB, { email: email.trim().toLowerCase(), ipAddress });
  }
  return c.body(null, 204);
});

unlock.post("/unlock", async (c) => {
  const { token } = await body(c.req.raw, z.object({ token: z.string().min(20).max(100) }));
  if (!(await useUnlock(c.var.db, token))) throw new HTTPException(410, { message: "This link was used already or has expired" });
  return c.body(null, 204);
});
