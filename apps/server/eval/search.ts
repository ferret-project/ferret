/**
 * Search evaluation on the real models from .env (eval/run.ts does the work): Ollama for embeddings, and optionally
 * the reranker and the chat model as the search judge. Vectors go to the `ferret-eval` Qdrant collection.
 *
 *   pnpm --filter @ferret/server eval:search            # summary + misses
 *   pnpm --filter @ferret/server eval:search --verbose  # every query
 *   pnpm --filter @ferret/server eval:search --no-judge # without the chat model deciding unsure matches
 */
import { OllamaAi } from "../src/adapters/local/ai";
import { OpenAiChat } from "../src/adapters/local/chat";
import { VllmReranker } from "../src/adapters/local/reranker";
import { loadConfig } from "../src/config";
import { SEARCH_PROFILES } from "../src/lib/search";
import { runSearchEval } from "./run";

const noJudge = process.argv.includes("--no-judge");
const config = loadConfig({ ...process.env, NODE_ENV: "test" });
if (!config.QDRANT_URL || !config.OLLAMA_URL) {
  console.error("Needs OLLAMA_URL and QDRANT_URL (and optionally RERANK_URL, CHAT_URL) in .env");
  process.exit(1);
}
await runSearchEval({
  config,
  collection: "ferret-eval",
  ai: new OllamaAi(config.OLLAMA_URL, { vision: config.VISION_MODEL, embed: config.EMBED_MODEL }),
  reranker: config.RERANK_URL ? new VllmReranker(config.RERANK_URL, config.RERANK_MODEL) : undefined,
  chat: !noJudge && config.CHAT_URL ? new OpenAiChat(config.CHAT_URL, config.CHAT_MODEL, { reasoningEffort: config.CHAT_REASONING || undefined }) : undefined,
  searchProfile: SEARCH_PROFILES.home,
  profileName: "home",
  models: { embed: config.EMBED_MODEL, rerank: config.RERANK_URL ? config.RERANK_MODEL : undefined, chat: !noJudge && config.CHAT_URL ? config.CHAT_MODEL : undefined },
  verbose: process.argv.includes("--verbose"),
});
process.exit(0);
