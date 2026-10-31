/**
 * Recalls (lib/recalls.ts), insurance coverage (lib/coverage.ts) and each person's weekly summary (lib/digest.ts).
 */
import { coverageInput, weeklyDigestInput } from "@ferret/shared";
import { Hono } from "hono";
import { z } from "zod";
import { type AppEnv, body, callerOf, requireHousehold, requireSession, requireUser, requireWriter } from "../lib/context";
import { addCoverage, coverageChecks, deleteCoverage, updateCoverage } from "../lib/coverage";
import { getWeekly, setWeekly } from "../lib/digest";
import { emailEnabled } from "../lib/email-verification";
import { listRecalls, recallsEnabled, resolveRecall } from "../lib/recalls";

export const payoff = new Hono<AppEnv>();
for (const path of ["/recalls", "/recalls/*", "/items/:id/recalls", "/coverage", "/coverage/*", "/me/weekly"]) payoff.use(path, requireUser, requireHousehold);

/** Open recalls on your things; `enabled`: the server admin has switched recall checks on. */
payoff.get("/recalls", async (c) =>
  c.json({ data: await listRecalls(callerOf(c)), enabled: Boolean(c.var.deps.recalls) && (await recallsEnabled(c.var.db)) }),
);
payoff.get("/items/:id/recalls", async (c) => c.json({ data: await listRecalls(callerOf(c), { itemId: c.req.param("id") }) }));
payoff.post("/recalls/:id", requireWriter, async (c) => {
  const { status } = await body(c.req.raw, z.object({ status: z.enum(["open", "dismissed", "done"]) }));
  await resolveRecall(callerOf(c), c.req.param("id"), status);
  return c.body(null, 204);
});

payoff.get("/coverage", async (c) => c.json({ data: await coverageChecks(callerOf(c)) }));
payoff.post("/coverage", requireWriter, async (c) => c.json(await addCoverage(callerOf(c), await body(c.req.raw, coverageInput)), 201));
payoff.put("/coverage/:id", requireWriter, async (c) => c.json(await updateCoverage(callerOf(c), c.req.param("id"), await body(c.req.raw, coverageInput))));
payoff.delete("/coverage/:id", requireWriter, async (c) => {
  await deleteCoverage(callerOf(c), c.req.param("id"));
  return c.body(null, 204);
});

/** Your weekly summary (a real sign-in: it's a person's setting, not a script's). */
payoff.get("/me/weekly", requireSession, async (c) => c.json(await getWeekly(callerOf(c), emailEnabled(c.var.deps, c.var.config))));
payoff.put("/me/weekly", requireSession, async (c) =>
  c.json(await setWeekly(callerOf(c), await body(c.req.raw, weeklyDigestInput), emailEnabled(c.var.deps, c.var.config))),
);
