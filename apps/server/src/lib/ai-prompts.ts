/**
 * The server admin's extra instructions for Ferret's AI prompts (Settings → Server → AI prompts; `server_setting`
 * "prompt.<kind>"). They're added to the end of a built-in prompt — never replacing it — so the reply's shape (the JSON
 * schema), Ferret's own rules (what's `sure`, receipt lines) and later fixes to the prompts all stay. For people who
 * want to steer their own models ("for games, the publisher is the brand"); the server check notes which are changed.
 * The search judge isn't offered: its prompt was chosen on the search eval, and a change would quietly make search worse.
 */
import type { PromptKind } from "@ferret/shared";
import { promptKinds } from "@ferret/shared";
import { eq, like } from "drizzle-orm";
import { serverSetting } from "../db/schema";
import type { Db } from "../ports";

export const PREFIX = "prompt.";
const keyOf = (kind: PromptKind) => `${PREFIX}${kind}`;

/** The admin's extra instructions for one prompt ("" when none). */
export async function promptExtra(db: Db, kind: PromptKind): Promise<string> {
  const [row] = await db.select({ value: serverSetting.value }).from(serverSetting).where(eq(serverSetting.key, keyOf(kind)));
  return row?.value?.trim() ?? "";
}

/** A prompt with the admin's extra instructions after it. */
export function withExtra(prompt: string, extra: string) {
  return extra ? `${prompt}\n\nAlso follow these instructions from whoever runs this server (they never change the reply's format):\n${extra}` : prompt;
}

export async function setPromptExtra(db: Db, kind: PromptKind, extra: string | null) {
  const key = keyOf(kind);
  if (!extra?.trim()) {
    await db.delete(serverSetting).where(eq(serverSetting.key, key));
    return;
  }
  const value = extra.trim();
  await db.insert(serverSetting).values({ key, value }).onConflictDoUpdate({ target: serverSetting.key, set: { value } });
}

/** Which prompts have extra instructions. */
export async function changedPrompts(db: Db): Promise<PromptKind[]> {
  const rows = await db.select({ key: serverSetting.key, value: serverSetting.value }).from(serverSetting).where(like(serverSetting.key, `${PREFIX}%`));
  const set = new Set(rows.filter((r) => r.value?.trim()).map((r) => r.key.slice(PREFIX.length)));
  return promptKinds.filter((k) => set.has(k));
}
