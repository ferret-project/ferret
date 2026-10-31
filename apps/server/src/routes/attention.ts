/** /api/v1/attention — what needs doing now (the app's bell): lib/attention.ts. */
import { Hono } from "hono";
import { needsAttention } from "../lib/attention";
import { type AppEnv, callerOf, requireHousehold, requireUser } from "../lib/context";

export const attention = new Hono<AppEnv>();
attention.get("/", requireUser, requireHousehold, async (c) => c.json({ data: await needsAttention(callerOf(c)) }));
