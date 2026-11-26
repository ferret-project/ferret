import { type FailureDetail, ServiceFailure, type TextModel } from "../../ports";

/** One answer from a chat model, as an OpenAI-style API gives it. */
export interface ModelReply {
  text: string;
  /** "stop", or "length" when it ran out of tokens. */
  finishReason?: string | null;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
}

/**
 * An OpenAI-style endpoint on a model server's base address: http://gpu.lan:8080, …/v1 and a path in front
 * (a reverse proxy's /llama) all work — `new URL("/v1/…", base)` would drop that path.
 */
export function apiUrl(base: string, path: `/v1/${string}`) {
  return new URL(base.replace(/\/+$/, "").replace(/\/v1$/, "") + path);
}

/** Headers for a model server: JSON, plus the API key when it was started with one (AI_API_KEY). */
export function modelHeaders(apiKey: string | undefined, json = true): Record<string, string> {
  return { ...(json ? { "Content-Type": "application/json" } : {}), ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) };
}

type JsonRequest = { prompt: string; schema: object; image?: { data: Uint8Array; contentType: string }; maxTokens?: number; timeoutMs?: number; effort?: "medium" | "high" };

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
  const window = filledWindow(replies, request.maxTokens);
  if (window) {
    throw new ServiceFailure(
      `${model} ran out of room: the model server's context window (${window.toLocaleString("en-US")} tokens) filled up before it answered — ` +
        "give the model server a bigger window (Ollama: OLLAMA_CONTEXT_LENGTH), or use a model that doesn't think first (e.g. an -instruct one)",
      {
        model,
        contextWindow: window,
        promptTokens: each((r) => r.usage?.prompt_tokens),
        replyTokens: each((r) => r.usage?.completion_tokens),
        maxTokens: request.maxTokens ?? "model's default",
        promptChars: request.prompt.length,
        imageBytes: request.image?.data.length,
        seconds: Math.round((Date.now() - started) / 100) / 10,
        ...replyShape(last),
        ...extra,
      },
    );
  }
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

/**
 * JSON Schema keywords the grammar engines behind structured output often refuse — vLLM's xgrammar answers
 * `Grammar error: Unimplemented keys: ["uniqueItems"]` and reads nothing — so they're left out of what's sent.
 * They only tighten a reply Ferret checks again anyway (each job parses it with zod).
 */
const UNPORTABLE = new Set(["uniqueItems", "contains", "minContains", "maxContains", "propertyNames", "dependentRequired", "dependentSchemas", "if", "then", "else", "not", "$comment"]);

/** The schema without UNPORTABLE keywords, at any depth (a property *named* like one is kept). */
export function portableSchema(schema: unknown, isProperties = false): unknown {
  if (Array.isArray(schema)) return schema.map((s) => portableSchema(s));
  if (!schema || typeof schema !== "object") return schema;
  return Object.fromEntries(
    Object.entries(schema as Record<string, unknown>)
      .filter(([key]) => isProperties || !UNPORTABLE.has(key))
      .map(([key, value]) => [key, portableSchema(value, !isProperties && (key === "properties" || key === "$defs" || key === "definitions"))]),
  );
}

/** Context windows model servers come with (Ollama's default is 4,096; llama.cpp's and others' are powers of two too). */
const WINDOWS = [2048, 4096, 8192, 16384, 32768];

/**
 * The model server's context window, when that's what every reply ran into: each stopped at "length" before the
 * reply's own limit, with prompt + reply adding up to a usual window size (Ollama counts a few tokens either way).
 * Null otherwise — then it's the reply limit, or something else.
 */
export function filledWindow(replies: ModelReply[], maxTokens?: number) {
  let window: number | null = null;
  for (const r of replies) {
    const prompt = r.usage?.prompt_tokens;
    const reply = r.usage?.completion_tokens;
    if (r.finishReason !== "length" || prompt == null || reply == null) return null;
    if (maxTokens != null && reply >= maxTokens) return null;
    const total = prompt + reply;
    const near = WINDOWS.find((w) => total >= w - 8 && total <= w);
    if (!near || (window !== null && near !== window)) return null;
    window = near;
  }
  return window;
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
 * Any OpenAI-compatible chat API (vLLM, Ollama, llama.cpp, LM Studio…) asked for JSON that follows a
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
      apiKey?: string;
    } = {},
  ) {}

  async json(request: JsonRequest) {
    const { prompt, schema, image, maxTokens } = request;
    const content: unknown[] = [{ type: "text", text: prompt }];
    if (image) {
      content.push({ type: "image_url", image_url: { url: `data:${image.contentType};base64,${toBase64(image.data)}` } });
    }
    const ask = async (temperature: number): Promise<ModelReply> => {
      const res = await fetch(apiUrl(this.baseUrl, "/v1/chat/completions"), {
        method: "POST",
        headers: modelHeaders(this.opts.apiKey),
        // A cold model load plus a busy GPU can take minutes.
        signal: AbortSignal.timeout(request.timeoutMs ?? this.opts.timeoutMs ?? 300_000),
        body: JSON.stringify({
          model: this.model,
          temperature,
          messages: [{ role: "user", content: image ? content : prompt }],
          response_format: { type: "json_schema", json_schema: { name: "reply", schema: portableSchema(schema) } },
          // Only to a model that takes it (configured with one): more when the request asks.
          ...(this.opts.reasoningEffort ? { reasoning_effort: request.effort ?? this.opts.reasoningEffort } : {}),
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
