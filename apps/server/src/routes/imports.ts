/**
 * /api/v1/import — importing things (lib/imports.ts): rows from a spreadsheet, or devices from Home Assistant.
 * Anyone who can edit can import (and undo an import). Reading Home Assistant makes the server connect to an address
 * someone typed, usually on the LAN, so that's for the household's owner and admins, signed in (not an API key).
 */
import { homeAssistantApply, homeAssistantConnect, importInput } from "@ferret/shared";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { type AppEnv, body, callerOf, requireHousehold, requireSession, requireUser, requireWriter } from "../lib/context";
import { homeAssistantDevices } from "../lib/home-assistant";
import { applyHomeAssistant, importItems, listImports, undoImport } from "../lib/imports";
import { HomeAssistantError } from "../ports";

export const imports = new Hono<AppEnv>();
imports.use(requireUser, requireHousehold);

imports.get("/", async (c) => c.json({ data: await listImports(callerOf(c)) }));

imports.post("/", requireWriter, async (c) => c.json(await importItems(callerOf(c), await body(c.req.raw, importInput)), 201));

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
