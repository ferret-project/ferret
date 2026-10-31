import { type FailureDetail, ServiceFailure, type TextModel } from "../../ports";

/** One answer from a chat model, as an OpenAI-style API gives it. */
export interface ModelReply {
  text: string;
  /** "stop", or "length" when it ran out of tokens. */
  finishReason?: string | null;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
}

type JsonRequest = { prompt: string; schema: object; image?: { data: Uint8Array; contentType: string }; maxTokens?: number };

/**
 * A model's JSON answer: asked once, and once more (a little less strictly) if the reply doesn't parse — now and then
 * gpt-oss opens the JSON and then only writes blank space until it runs out ("{" + newlines). Twice not JSON: a
 * ServiceFailure saying how both replies ended (shared by every chat adapter: vLLM, Ollama…).
 */
export async function jsonReply(model: string, request: JsonRequest, ask: (temperature: number) => Promise<ModelReply>, extra: FailureDetail = {}) {
  const started = Date.now();
  const replies: ModelReply[] = [];
  for (const temperature of [0, 0.3]) {
    const reply = await ask(temperature);
    replies.push(reply);
    try {
      // Some models wrap their reasoning in <think> tags before the JSON.
      return JSON.parse(reply.text.replace(/<think>[\s\S]*?<\/think>/g, "").trim()) as unknown;
    } catch {
      // asked again, or given up below
    }
  }
  const each = (f: (r: ModelReply) => unknown) => replies.map((r) => f(r) ?? "?").join(", ");
  const last = replies.at(-1)!.text;
  throw new ServiceFailure(`${model} reply wasn't JSON, twice (finished: ${each((r) => r.finishReason)})`, {
    model,
    attempts: replies.length,
    finishReason: each((r) => r.finishReason),
    promptTokens: each((r) => r.usage?.prompt_tokens),
    replyTokens: each((r) => r.usage?.completion_tokens),
    maxTokens: request.maxTokens ?? "model's default",
    promptChars: request.prompt.length,
    imageBytes: request.image?.data.length,
    seconds: Math.round((Date.now() - started) / 100) / 10,
    ...replyShape(last),
    ...extra,
  });
}

/** A reply described without keeping it: its length, how much is blank space, and its first and last words (folded). */
export function replyShape(text: string): FailureDetail {
  const folded = text.replace(/\s+/g, " ").trim();
  return {
    replyChars: text.length,
    replyBlank: text.length ? `${Math.round((100 * (text.length - text.replace(/\s/g, "").length)) / text.length)}%` : null,
    replyStart: folded.slice(0, 120),
    replyEnd: folded.length > 120 ? folded.slice(-80) : undefined,
  };
}

/**
 * Any OpenAI-compatible chat API (vLLM, Ollama…) asked for JSON that follows a
 * schema — e.g. gpt-oss-120b for questions and documents, or qwen3-vl
 * (with an image) for photos.
 */
export class OpenAiChat implements TextModel {
  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly opts: {
      /** For reasoning models (gpt-oss): "low" keeps answers quick. */
      reasoningEffort?: string;
      timeoutMs?: number;
    } = {},
  ) {}

  async json(request: JsonRequest) {
    const { prompt, schema, image, maxTokens } = request;
    const content: unknown[] = [{ type: "text", text: prompt }];
    if (image) {
      content.push({ type: "image_url", image_url: { url: `data:${image.contentType};base64,${toBase64(image.data)}` } });
    }
    const ask = async (temperature: number): Promise<ModelReply> => {
      const res = await fetch(new URL("/v1/chat/completions", this.baseUrl), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // A cold model load plus a busy GPU can take minutes.
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 300_000),
        body: JSON.stringify({
          model: this.model,
          temperature,
          messages: [{ role: "user", content: image ? content : prompt }],
          response_format: { type: "json_schema", json_schema: { name: "reply", schema } },
          ...(this.opts.reasoningEffort ? { reasoning_effort: this.opts.reasoningEffort } : {}),
          ...(maxTokens ? { max_tokens: maxTokens } : {}),
        }),
      });
      if (!res.ok) {
        throw new ServiceFailure(`${this.model} returned ${res.status}: ${(await res.text()).slice(0, 200)}`, {
          model: this.model,
          status: res.status,
          promptChars: prompt.length,
          imageBytes: image?.data.length,
          maxTokens,
        });
      }
      const body = (await res.json()) as { choices?: { message?: { content?: string | null }; finish_reason?: string | null }[]; usage?: ModelReply["usage"] };
      return { text: body.choices?.[0]?.message?.content ?? "", finishReason: body.choices?.[0]?.finish_reason, usage: body.usage };
    };
    return jsonReply(this.model, request, ask, { reasoningEffort: this.opts.reasoningEffort });
  }
}

export function toBase64(bytes: Uint8Array) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
