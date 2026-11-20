/** Settings → Server → AI prompts: each built-in prompt (with placeholders) beside the admin's extra instructions (lib/ai-prompts.ts). */
import type { PromptKind, PromptSetting } from "@ferret/shared";
import { promptKinds } from "@ferret/shared";
import { like } from "drizzle-orm";
import { serverSetting } from "../db/schema";
import type { Db } from "../ports";
import { imagePrompt } from "../jobs/analyze";
import { PREFIX } from "./ai-prompts";
import { askPrompt } from "./ask";
import { describePrompt } from "./item-from-text";
import { roomScanPrompt } from "./room-scans";

const CATEGORIES = ["{each of the household's categories}"];
const CURRENCY = "{the household's currency}";

/** Each built-in prompt as the model gets it, with placeholders for a household's own details. */
function builtIn(kind: PromptKind): string {
  switch (kind) {
    case "photo":
      return imagePrompt("photo", CURRENCY, CATEGORIES);
    case "document":
      return imagePrompt("document", CURRENCY, CATEGORIES);
    case "roomScan":
      return roomScanPrompt(CATEGORIES);
    case "describe":
      return describePrompt({
        today: "{today}",
        currency: CURRENCY,
        places: "- {each of their places}",
        boxes: "- {each of their boxes}",
        categories: "- {each of their categories}",
        tags: "- {each of their tags}",
        words: "{what they said}",
      });
    case "ask":
      return askPrompt("{the question}", "[1] {each source: a thing, a document's section…}", "{today}");
  }
}

export async function promptSettings(db: Db): Promise<PromptSetting[]> {
  const rows = await db.select({ key: serverSetting.key, value: serverSetting.value }).from(serverSetting).where(like(serverSetting.key, `${PREFIX}%`));
  const extras = new Map(rows.map((r) => [r.key.slice(PREFIX.length), r.value?.trim() || null]));
  return promptKinds.map((kind) => ({ kind, extra: extras.get(kind) ?? null, builtIn: builtIn(kind) }));
}
