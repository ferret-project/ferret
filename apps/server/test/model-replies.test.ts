/** Model replies that aren't JSON (adapters/local/chat.ts): said plainly when the model server's window filled up. */
import { describe, expect, it } from "vitest";
import { filledWindow, jsonReply, type ModelReply } from "../src/adapters/local/chat";
import { ServiceFailure } from "../src/ports";

const thinking = (prompt: number, reply: number): ModelReply => ({ text: "", finishReason: "length", usage: { prompt_tokens: prompt, completion_tokens: reply } });

describe("a model that runs out of room", () => {
  it("is told apart from one that hit Ferret's reply limit", () => {
    // A Discord report: qwen3-vl:8b (thinking) on Ollama's default 4,096-token window.
    expect(filledWindow([thinking(2660, 1436), thinking(2660, 1436)], 6000)).toBe(4096);
    expect(filledWindow([thinking(1000, 1046)], 6000)).toBe(2048);
    expect(filledWindow([thinking(2660, 6000)], 6000)).toBeNull(); // Ferret's own limit
    expect(filledWindow([thinking(2660, 900)], 6000)).toBeNull(); // not a window size
    expect(filledWindow([{ ...thinking(2660, 1436), finishReason: "stop" }], 6000)).toBeNull();
  });

  it("says so in the error, with what to change", async () => {
    const err = await jsonReply("qwen3-vl:8b", { prompt: "x", schema: {}, maxTokens: 6000 }, async () => thinking(2660, 1436)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceFailure);
    expect((err as Error).message).toContain("context window (4,096 tokens) filled up");
    expect((err as Error).message).toContain("OLLAMA_CONTEXT_LENGTH");
    expect((err as ServiceFailure).detail).toMatchObject({ contextWindow: 4096, promptTokens: "2660, 2660", replyTokens: "1436, 1436" });
  });
});
