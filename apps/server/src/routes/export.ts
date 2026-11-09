import { t as translateText } from "./../lib/i18n";
/**
 * /api/v1/export — the insurance export (items as JSON for the printable report, or a CSV download), and
 * "Download everything": the household's data and files as a ZIP (lib/household-export.ts).
 */
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { type AppEnv, callerOf, requireHousehold, requireSession, requireUser } from "../lib/context";
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
    "Content-Disposition": translateText("attachment; filename=\"ferret-{v0}-{v1}.csv\"", { v0: opts.gone ? translateText("lost-and-stolen") : translateText("inventory"), v1: todayFor(c.var) }),
    "Cache-Control": "no-store",
  });
});

/**
 * Everything, files decrypted: so only the household's owner and admins, signed in (not with an API key). Streamed
 * as it's made; nothing is kept on the server.
 */
exporter.get("/everything.zip", requireSession, async (c) => {
  if (c.var.role !== "owner" && c.var.role !== "admin") throw new HTTPException(403, { message: translateText("Only the household's owner and admins can download everything") });
  const { filename, stream } = await householdExport(callerOf(c), c.var.files);
  return c.body(stream, 200, {
    "Content-Type": "application/zip",
    "Content-Disposition": translateText("attachment; filename=\"{v0}\"", { v0: filename }),
    "Cache-Control": "no-store",
  });
});
