/**
 * /api/v1/export — the insurance export (items as JSON for the printable report, or a CSV download), and
 * "Download everything": the household's data and files as a ZIP (lib/household-export.ts).
 */
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { type AppEnv, callerOf, requireHousehold, requireSession, requireUser } from "../lib/context";
import { donations, donationsCsv } from "../lib/donations";
import { exportRows, toCsv } from "../lib/export";
import { householdExport } from "../lib/household-export";
import { todayFor } from "../lib/household-time";

export const exporter = new Hono<AppEnv>();
exporter.use(requireUser, requireHousehold);

/** ?propertyId= narrows to one property. */
/** ?gone=lost: what was lost or stolen (for a claim), with what happened and when. */
const exportOpts = (c: { req: { query: (k: string) => string | undefined } }) => ({
  propertyId: c.req.query("propertyId") || undefined,
  gone: c.req.query("gone") === "lost" ? ("lost" as const) : undefined,
});

exporter.get("/items.json", async (c) => c.json({ data: await exportRows(callerOf(c), exportOpts(c)) }));

exporter.get("/items.csv", async (c) => {
  const opts = exportOpts(c);
  const rows = await exportRows(callerOf(c), opts);
  return c.body(toCsv(rows, { currency: c.var.currency, gone: Boolean(opts.gone) }), 200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="ferret-${opts.gone ? "lost-and-stolen" : "inventory"}-${todayFor(c.var)}.csv"`,
    "Cache-Control": "no-store",
  });
});

/** ?year=2026: that year's donations; without, only the years (with counts and totals). */
const donationYear = (c: { req: { query: (k: string) => string | undefined } }) => {
  const raw = c.req.query("year");
  if (raw == null || raw === "") return undefined;
  if (!/^\d{4}$/.test(raw)) throw new HTTPException(400, { message: "year must be like 2026" });
  return Number(raw);
};

exporter.get("/donations.json", async (c) => c.json(await donations(callerOf(c), donationYear(c))));

exporter.get("/donations.csv", async (c) => {
  const year = donationYear(c) ?? Number(todayFor(c.var).slice(0, 4));
  const { data } = await donations(callerOf(c), year);
  return c.body(donationsCsv(data, c.var.currency), 200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="ferret-donations-${year}.csv"`,
    "Cache-Control": "no-store",
  });
});

/**
 * Everything, files decrypted: so only the household's owner and admins, signed in (not with an API key). Streamed
 * as it's made; nothing is kept on the server.
 */
exporter.get("/everything.zip", requireSession, async (c) => {
  if (c.var.role !== "owner" && c.var.role !== "admin") throw new HTTPException(403, { message: "Only the household's owner and admins can download everything" });
  const { filename, stream } = await householdExport(callerOf(c), c.var.files);
  return c.body(stream, 200, {
    "Content-Type": "application/zip",
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Cache-Control": "no-store",
  });
});
