/**
 * /api/v1/import — importing things (lib/imports.ts): rows from a spreadsheet, or devices from Home Assistant.
 * Anyone who can edit can import (and undo an import). Reading Home Assistant makes the server connect to an address
 * someone typed, usually on the LAN, so that's for the household's owner and admins, signed in (not an API key).
 */
import { homeAssistantApply, homeAssistantConnect, importInput, importKnownInput } from "@ferret/shared";
import { importTriageInput } from "@ferret/shared";
import { startImportTriage } from "../lib/ai-runs";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { type AppEnv, body, callerOf, requireHousehold, requireSession, requireUser, requireWriter } from "../lib/context";
import { homeAssistantDevices } from "../lib/home-assistant";
import { applyHomeAssistant, importItems, knownImportKeys, listImports, undoImport } from "../lib/imports";
import { HomeAssistantError } from "../ports";
import { checkItemZip, importItemZip } from "../lib/item-import";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";

export const imports = new Hono<AppEnv>();
imports.use(requireUser, requireHousehold);

imports.get("/", async (c) => c.json({ data: await listImports(callerOf(c)) }));

imports.post("/", requireWriter, async (c) => c.json(await importItems(callerOf(c), await body(c.req.raw, importInput)), 201));

/**
 * A thing exported from Ferret (lib/item-import.ts), its ZIP as the body (application/zip): /check says what's in it
 * and whether it's signed by this household's key; then POST /import/item adds it — ?anyway=true when it isn't
 * (another key, not signed, or changed), after the person saw that; ?propertyId= where its place goes.
 */
const zipLimit = createMiddleware<AppEnv>((c, next) =>
  bodyLimit({
    maxSize: c.var.config.MAX_UPLOAD_MB * 10 * 1024 * 1024,
    onError: (c) => c.json({ error: { code: "http_413", message: `That ZIP is too big (up to ${c.var.config.MAX_UPLOAD_MB * 10} MB)` } }, 413),
  })(c, next),
);
const zipBody = async (req: Request) => new Uint8Array(await req.arrayBuffer());
imports.post("/item/check", requireWriter, zipLimit, async (c) => c.json(await checkItemZip(callerOf(c), await zipBody(c.req.raw))));
imports.post("/item", requireWriter, zipLimit, async (c) =>
  c.json(
    await importItemZip(callerOf(c), c.var.files, await zipBody(c.req.raw), {
      anyway: c.req.query("anyway") === "true",
      propertyId: c.req.query("propertyId") || null,
      filename: c.req.header("x-filename") ? decodeURIComponent(c.req.header("x-filename")!) : undefined,
    }),
    201,
  ),
);

/** Before importing a file: which of its lines are already here, so they start unticked. Only looks. */
imports.post("/known", async (c) => {
  const { keys } = await body(c.req.raw, importKnownInput);
  return c.json({ known: [...(await knownImportKeys(callerOf(c), keys))] });
});

/** Sort the lines with AI before importing (AI-1): which look worth keeping, and a category from the household's own. */
imports.post("/triage", requireWriter, async (c) => c.json(await startImportTriage(callerOf(c), await body(c.req.raw, importTriageInput)), 202));

imports.post("/:id/undo", requireWriter, async (c) => c.json(await undoImport(callerOf(c), c.req.param("id"))));

imports.post("/home-assistant/devices", requireSession, requireWriter, async (c) => {
  if (c.var.role !== "owner" && c.var.role !== "admin") {
    throw new HTTPException(403, { message: "Only the household's owner and admins can connect Home Assistant" });
  }
  if (!c.var.deps.homeAssistant) throw new HTTPException(501, { message: "Home Assistant import isn't available on this server" });
  const { url, token } = await body(c.req.raw, homeAssistantConnect);
  try {
    return c.json(await homeAssistantDevices(callerOf(c), url, token));
  } catch (e) {
    if (e instanceof HomeAssistantError) throw new HTTPException(502, { message: e.message });
    throw e;
  }
});

/** A re-import's changes (names, makers, rooms HA changed since); doesn't reach Home Assistant, so anyone who can edit. */
imports.post("/home-assistant/apply", requireWriter, async (c) => c.json(await applyHomeAssistant(callerOf(c), await body(c.req.raw, homeAssistantApply))));
