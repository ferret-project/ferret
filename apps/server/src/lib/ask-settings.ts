/**
 * How much Ask Ferret gives the answering model to read — the server admin sets the model's context size (Settings →
 * Server → Ask Ferret; `server_setting` "ask.contextTokens"), and Ask fits its sources and room for the reply inside it.
 * Too large for the model and long prompts get cut off by the model server (an answer from half a manual) or refused;
 * too small and long manuals are read in shorter pieces. Tokens are estimated from characters (about 3 a token for
 * English, erring on the safe side) — no tokenizer.
 */
import type { AskSettings } from "@ferret/shared";
import { eq } from "drizzle-orm";
import { serverSetting } from "../db/schema";
import type { Db } from "../ports";

const KEY = "ask.contextTokens";
/** Fits nearly every model server's default; ferret.lan-style servers with big models can raise it. */
export const ASK_CONTEXT_DEFAULT = 8192;
const CHARS_PER_TOKEN = 3;
/** The prompt's own words (instructions, the question), in tokens. */
const PROMPT_TOKENS = 700;
/** More than this is slow to read and rarely helps: even with a huge window, sources stop here. */
const MAX_SOURCE_CHARS = 120_000;
const MIN_SOURCE_CHARS = 2500;

export async function askContextTokens(db: Db) {
  const [row] = await db.select().from(serverSetting).where(eq(serverSetting.key, KEY));
  const n = Number(row?.value);
  return Number.isInteger(n) && n > 0 ? n : ASK_CONTEXT_DEFAULT;
}

export async function setAskContextTokens(db: Db, tokens: number | null) {
  if (tokens == null) {
    await db.delete(serverSetting).where(eq(serverSetting.key, KEY));
    return;
  }
  await db.insert(serverSetting).values({ key: KEY, value: String(tokens) }).onConflictDoUpdate({ target: serverSetting.key, set: { value: String(tokens) } });
}

/** Room kept for the reply: a list of steps needs more than a sentence or two. */
export function replyTokens(contextTokens: number, procedure: boolean) {
  return procedure ? Math.min(4096, Math.max(1024, Math.round(contextTokens / 4))) : Math.min(1024, Math.max(512, Math.round(contextTokens / 8)));
}

/** How many characters of sources fit, after the prompt and the reply's room. */
export function sourceChars(contextTokens: number, procedure: boolean) {
  const tokens = contextTokens - replyTokens(contextTokens, procedure) - PROMPT_TOKENS;
  return Math.min(MAX_SOURCE_CHARS, Math.max(MIN_SOURCE_CHARS, tokens * CHARS_PER_TOKEN));
}

export async function askSettings(db: Db): Promise<AskSettings> {
  const [row] = await db.select().from(serverSetting).where(eq(serverSetting.key, KEY));
  const contextTokens = await askContextTokens(db);
  return {
    contextTokens,
    isDefault: !row,
    default: ASK_CONTEXT_DEFAULT,
    readChars: sourceChars(contextTokens, false),
    readCharsHowTo: sourceChars(contextTokens, true),
  };
}
