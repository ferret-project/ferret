/**
 * The AI's helpers (thin; see each lib): what it filled in by itself (lib/ai-fill.ts) — the "Filled in by AI" list,
 * confirming and undoing each; possible duplicates and merging (lib/duplicates.ts).
 */
import { Hono } from "hono";
import { type AppEnv, callerOf, requireHousehold, requireUser, requireWriter } from "../lib/context";
import { aiFillEntries, confirmAiFill, undoAiFill } from "../lib/ai-fill";
import { listDuplicates, mergeItems, notDuplicate } from "../lib/duplicates";
import { mergeInput } from "@ferret/shared";
import { z } from "zod";
import { body } from "../lib/context";
import { getAiRun } from "../lib/ai-runs";
import { askReplacementEstimate, askReplacementEstimates, dismissReplacementEstimate } from "../lib/replacement";
import { itemFromText } from "../lib/item-from-text";
import { toConfirm } from "../lib/to-confirm";
import { addReceiptLines, dismissReceiptLines, receiptLinesKnown } from "../lib/receipt-lines";
import { filtersFromText } from "../lib/plain-filters";
import { draftListing } from "../lib/listing";
import { filtersFromTextInput, itemFromTextInput, receiptLinesInput, replacementEstimatesInput } from "@ferret/shared";
import { HTTPException } from "hono/http-exception";
import { bodyLimit } from "hono/body-limit";
import { recordUsage, requireAllowed } from "../lib/plan";

export const ai = new Hono<AppEnv>();
for (const path of ["/ai-fills", "/items/:id/ai-fills/*", "/duplicates", "/duplicates/*", "/items/:id/merge", "/ai-runs/*", "/items/:id/replacement-estimate", "/items/filters-from-text", "/items/:id/listing", "/transcribe", "/items/from-text", "/replacement-estimates", "/to-confirm", "/attachments/:id/lines"]) ai.use(path, requireUser, requireHousehold);

/** "Filled in by AI": every field the AI filled in that nobody has looked at yet. */
ai.get("/ai-fills", async (c) => c.json({ data: await aiFillEntries(callerOf(c)) }));
ai.post("/items/:id/ai-fills/:field/confirm", requireWriter, async (c) => c.json(await confirmAiFill(callerOf(c), c.req.param("id"), c.req.param("field"))));
ai.post("/items/:id/ai-fills/:field/undo", requireWriter, async (c) => c.json(await undoAiFill(callerOf(c), c.req.param("id"), c.req.param("field"))));

/** Possible duplicates: pairs that may be the same thing. */
ai.get("/duplicates", async (c) => c.json({ data: await listDuplicates(callerOf(c)) }));
ai.post("/duplicates/not", requireWriter, async (c) => {
  const { a, b } = await body(c.req.raw, z.object({ a: z.string().min(1), b: z.string().min(1) }));
  return c.json(await notDuplicate(callerOf(c), a, b));
});
/** Merge `from` into this one: what it has fills the gaps here, everything pointing at it comes here; it goes to Recently deleted. */
ai.post("/items/:id/merge", requireWriter, async (c) => c.json(await mergeItems(callerOf(c), c.req.param("id"), await body(c.req.raw, mergeInput))));

/** AI work being done for the person who asked (sorting an import): its state, and its result once done. */
ai.get("/ai-runs/:id", async (c) => c.json(await getAiRun(callerOf(c), c.req.param("id"))));

/** Estimate what replacing it would cost today (a suggestion on the item, applied only by a tap). */
ai.post("/items/:id/replacement-estimate", requireWriter, async (c) => c.json(await askReplacementEstimate(callerOf(c), c.req.param("id")), 202));

/** Estimates for several things at once (things with no value yet, or a chosen few). */
ai.post("/replacement-estimates", requireWriter, async (c) => c.json(await askReplacementEstimates(callerOf(c), await body(c.req.raw, replacementEstimatesInput)), 202));
ai.delete("/items/:id/replacement-estimate", requireWriter, async (c) => {
  await dismissReplacementEstimate(callerOf(c), c.req.param("id"));
  return c.body(null, 204);
});

/** A sentence about a thing → its fields, for the person to check before adding (nothing saved). */
ai.post("/items/from-text", requireWriter, async (c) => {
  const { text } = await body(c.req.raw, itemFromTextInput);
  return c.json(await itemFromText(callerOf(c), text));
});

/** Everything the AI suggested that's waiting for someone to look. */
ai.get("/to-confirm", async (c) => c.json(await toConfirm(callerOf(c))));

/** A receipt's other things: add the ones ticked (each with a copy of the receipt), or not these. */
ai.get("/attachments/:id/lines", async (c) => c.json(await receiptLinesKnown(callerOf(c), c.req.param("id"))));
ai.post("/attachments/:id/lines", requireWriter, async (c) => c.json(await addReceiptLines(callerOf(c), c.var.files, c.req.param("id"), await body(c.req.raw, receiptLinesInput)), 201));
ai.delete("/attachments/:id/lines", requireWriter, async (c) => {
  await dismissReceiptLines(callerOf(c), c.req.param("id"));
  return c.body(null, 204);
});

/** Plain words → Everything's filters (shown for the person to change; never an answer by itself). */
ai.post("/items/filters-from-text", async (c) => {
  const { text } = await body(c.req.raw, filtersFromTextInput);
  return c.json(await filtersFromText(callerOf(c), text));
});

/** Listing text for selling: a draft ad (title, description, suggested price) to copy; nothing is saved. Viewers can't. */
ai.post("/items/:id/listing", requireWriter, async (c) => c.json(await draftListing(callerOf(c), c.req.param("id"))));

/** A recording's longest: a few seconds of naming something is far under this. */
const MAX_AUDIO = 4 * 1024 * 1024;
const AUDIO_TYPES = /^audio\/(webm|ogg|mp4|mpeg|wav|x-wav|x-m4a|aac)(;.*)?$/;

/** Speech to text (naming things aloud on a walkthrough): the words said; nothing is kept. */
ai.post(
  "/transcribe",
  requireWriter,
  bodyLimit({ maxSize: MAX_AUDIO + 64 * 1024, onError: (c) => c.json({ error: { code: "http_413", message: "That recording is too long" } }, 413) }),
  async (c) => {
    const v = callerOf(c);
    if (!v.deps.speech) throw new HTTPException(503, { message: "Speech to text isn't set up on this server" });
    const form = await c.req.formData().catch(() => null);
    const audio = form?.get("audio");
    if (!(audio instanceof File) || audio.size === 0) throw new HTTPException(422, { message: "Send the recording as `audio`" });
    if (audio.size > MAX_AUDIO) throw new HTTPException(413, { message: "That recording is too long" });
    const type = audio.type || "audio/webm";
    if (!AUDIO_TYPES.test(type)) throw new HTTPException(415, { message: "That isn't a recording Ferret can read" });
    const plan = await requireAllowed(v, "ai.ask");
    const text = await v.deps.speech.transcribe(new Uint8Array(await audio.arrayBuffer()), type).catch(() => {
      throw new HTTPException(502, { message: "Couldn't turn that into words — try again" });
    });
    await recordUsage(v, "ai.ask", 1, plan);
    return c.json({ text: text.trim().slice(0, 500) });
  },
);
