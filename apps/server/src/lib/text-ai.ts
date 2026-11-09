import { t as translateText } from "./i18n";
/**
 * The AI helpers that read words (sorting imports, filters from plain words, replacement estimates, typical upkeep):
 * the text model they use (the chat model, else the vision model's own text) and the plan gate each call goes through
 * (lib/plan.ts — each counts as one AI action, like an Ask question).
 */
import { HTTPException } from "hono/http-exception";
import type { Deps, TextModel } from "../ports";
import { allow, recordUsage, requireAllowed, type Who } from "./plan";

export const textModelOf = (deps: Pick<Deps, "chat" | "ai">): TextModel | undefined => deps.chat ?? deps.ai;

/** For a person waiting (a request): the model, or a 503 when there's none; 402 when the plan's allowance is used up. */
export async function requireTextModel(w: Who & { deps: Deps }) {
  const model = textModelOf(w.deps);
  if (!model) throw new HTTPException(503, { message: translateText("This needs an AI model, and none is set up on this server") });
  const plan = await requireAllowed(w, "ai.ask");
  return { model, counted: () => recordUsage(w, "ai.ask", 1, plan) };
}

/** In a job: asks the model if the plan allows (null when it doesn't), and counts it. */
export async function askInJob<T>(w: Who & { deps: Deps }, ask: (model: TextModel) => Promise<T>): Promise<T | null> {
  const model = textModelOf(w.deps);
  if (!model) return null;
  const allowed = await allow(w, "ai.ask");
  if (!allowed.ok) return null;
  const answer = await ask(model);
  await recordUsage(w, "ai.ask", 1, allowed.plan);
  return answer;
}
