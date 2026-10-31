/**
 * Lending (lib/loans.ts): `/api/v1/loans` and an item's `/items/:id/loans`, for the household; `/api/v1/borrowed/:token`
 * is the borrower's page from a reminder email (no account): what they have, "I've given it back", "stop reminding
 * me". `/b/:token` is the email's short link, which opens the web app's page for it.
 */
import { loanInput, loanPatch } from "@ferret/shared";
import { Hono } from "hono";
import { z } from "zod";
import { type AppEnv, body, callerOf, requireHousehold, requireUser, requireWriter } from "../lib/context";
import { borrowerReturned, borrowerStop, borrowerView, createLoan, deleteLoan, listLoans, returnLoan, updateLoan } from "../lib/loans";
import { emailEnabled } from "../lib/email-verification";

export const loans = new Hono<AppEnv>();
loans.use("/loans", requireUser, requireHousehold);
loans.use("/loans/*", requireUser, requireHousehold);
loans.use("/items/:id/loans", requireUser, requireHousehold);

/** ?all=true: with those back in the last 90 days. `canEmail`: Ferret can send the borrower reminders. */
loans.get("/loans", async (c) =>
  c.json({ data: await listLoans(callerOf(c), { all: c.req.query("all") === "true" }), canEmail: emailEnabled(c.var.deps, c.var.config) }),
);
loans.get("/items/:id/loans", async (c) =>
  c.json({ data: await listLoans(callerOf(c), { all: true, itemId: c.req.param("id") }), canEmail: emailEnabled(c.var.deps, c.var.config) }),
);
loans.post("/items/:id/loans", requireWriter, async (c) => c.json(await createLoan(callerOf(c), c.var.files, c.req.param("id"), await body(c.req.raw, loanInput)), 201));
loans.patch("/loans/:id", requireWriter, async (c) => c.json(await updateLoan(callerOf(c), c.var.files, c.req.param("id"), await body(c.req.raw, loanPatch))));
loans.post("/loans/:id/returned", requireWriter, async (c) => {
  const { on } = await body(c.req.raw, z.object({ on: z.iso.date().optional().nullable() }));
  return c.json(await returnLoan(callerOf(c), c.req.param("id"), on));
});
loans.delete("/loans/:id", requireWriter, async (c) => {
  await deleteLoan(callerOf(c), c.req.param("id"));
  return c.body(null, 204);
});

/** The borrower's page: no account, only the link from the email. */
export const borrowed = new Hono<AppEnv>();
borrowed.use(async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
  c.header("X-Robots-Tag", "noindex, nofollow");
  c.header("Referrer-Policy", "no-referrer");
});
borrowed.get("/:token", async (c) => c.json(await borrowerView(c.var.db, c.req.param("token"))));
borrowed.post("/:token/returned", async (c) => c.json(await borrowerReturned(c.var.db, c.req.param("token"))));
borrowed.post("/:token/stop", async (c) => c.json(await borrowerStop(c.var.db, c.req.param("token"))));

export const borrowerShortLinks = new Hono<AppEnv>();
borrowerShortLinks.get("/:token{[\\w-]{20,100}}", (c) => c.redirect(`/#/b/${c.req.param("token")}`, 302));
