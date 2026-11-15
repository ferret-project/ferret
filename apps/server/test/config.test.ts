import { describe, expect, it } from "vitest";
import { OpenAiModels } from "../src/adapters/local/ai";
import { apiUrl } from "../src/adapters/local/chat";
import { doclingOptions, loadConfig, vapidSubject, vapidSubjectProblem } from "../src/config";

const base = { NODE_ENV: "test", AUTH_SECRET: "test-secret-test-secret-test-secret-123", FILES_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(9))) };

describe("docling options", () => {
  it("are docling's own defaults unless a VLM endpoint or options are given", () => {
    expect(doclingOptions(loadConfig(base))).toEqual({});
  });

  it("use the VLM pipeline at DOCLING_VLM_URL", () => {
    const options = doclingOptions(loadConfig({ ...base, DOCLING_VLM_URL: "http://gpu.example:8001/v1/chat/completions" }));
    expect(options.pipeline).toBe("vlm");
    expect(JSON.parse(options.vlm_pipeline_model_api!)).toMatchObject({ url: "http://gpu.example:8001/v1/chat/completions", params: { model: "granite-docling" } });
  });

  it("take DOCLING_OPTIONS over both, object values as JSON", () => {
    const config = loadConfig({ ...base, DOCLING_VLM_URL: "http://gpu.example:8001/v1/chat/completions", DOCLING_OPTIONS: '{"pipeline":"standard","ocr":{"lang":"en"}}' });
    expect(doclingOptions(config)).toEqual({ pipeline: "standard", ocr: '{"lang":"en"}' });
  });

  it("refuse DOCLING_OPTIONS that isn't JSON", () => {
    expect(() => loadConfig({ ...base, DOCLING_OPTIONS: "pipeline=vlm" })).toThrow(/DOCLING_OPTIONS/);
  });
});

describe("Web Push's contact", () => {
  it("is admin@ the public host unless VAPID_SUBJECT says otherwise", () => {
    expect(vapidSubject(loadConfig({ ...base, PUBLIC_URL: "https://ferret.example.com" }))).toBe("mailto:admin@ferret.example.com");
    expect(vapidSubject(loadConfig({ ...base, VAPID_SUBJECT: "mailto:me@example.org" }))).toBe("mailto:me@example.org");
  });

  it("is checked for what Apple's push service refuses: no public domain", () => {
    for (const bad of ["https://ferret.lan", "mailto:admin@ferret.lan", "mailto:admin@localhost", "https://10.0.0.2", "https://nas", "https://ferret.home.arpa", "ferret.example.com", "http://ferret.example.org"]) {
      expect(vapidSubjectProblem(bad), bad).toBeTruthy();
    }
    for (const good of ["mailto:me@example.org", "https://ferret.example.org", "mailto:noreply@ferret.app"]) {
      expect(vapidSubjectProblem(good), good).toBeUndefined();
    }
  });
});

describe("empty settings", () => {
  it("count as unset, as Unraid's template and `KEY=` lines in .env pass them", () => {
    const config = loadConfig({ ...base, OLLAMA_URL: "", APPRISE_URL: " ", TRUSTED_PROXIES: "", OIDC_NAME: "", BACKUP_DIR: "" });
    expect(config.OLLAMA_URL).toBeUndefined();
    expect(config.APPRISE_URL).toBeUndefined();
    expect(config.BACKUP_DIR).toBeUndefined();
    expect(config.TRUSTED_PROXIES).toBe("127.0.0.1,::1");
    expect(config.OIDC_NAME).toBe("single sign-on");
  });

  it("except CHAT_REASONING, where empty leaves reasoning_effort out", () => {
    expect(loadConfig({ ...base, CHAT_REASONING: "" }).CHAT_REASONING).toBe("");
    expect(loadConfig(base).CHAT_REASONING).toBe("low");
  });

  it("still leave a required one missing", () => {
    expect(() => loadConfig({ ...base, AUTH_SECRET: "" })).toThrow(/AUTH_SECRET/);
  });
});

describe("model servers", () => {
  it("read OLLAMA_URL as VISION_URL, and use it for embeddings unless EMBED_URL is set", () => {
    const old = loadConfig({ ...base, OLLAMA_URL: "http://gpu.example:11434" });
    expect(old.VISION_URL).toBe("http://gpu.example:11434");
    expect(old.EMBED_URL).toBe("http://gpu.example:11434");
    const split = loadConfig({ ...base, VISION_URL: "http://gpu.example:8080", OLLAMA_URL: "http://old.example:11434", EMBED_URL: "http://gpu.example:8081" });
    expect(split.VISION_URL).toBe("http://gpu.example:8080");
    expect(split.EMBED_URL).toBe("http://gpu.example:8081");
    expect(loadConfig(base).VISION_URL).toBeUndefined();
  });

  it("refuse EMBED_URL without a vision server", () => {
    expect(() => loadConfig({ ...base, EMBED_URL: "http://gpu.example:8081" })).toThrow(/EMBED_URL needs VISION_URL/);
  });

  it("are called on /v1/… whether or not the address ends in /v1 or sits under a path", () => {
    expect(apiUrl("http://gpu.example:8080", "/v1/embeddings").href).toBe("http://gpu.example:8080/v1/embeddings");
    expect(apiUrl("http://gpu.example:8000/v1/", "/v1/chat/completions").href).toBe("http://gpu.example:8000/v1/chat/completions");
    expect(apiUrl("https://lab.example/llama", "/v1/rerank").href).toBe("https://lab.example/llama/v1/rerank");
  });

  it("send AI_API_KEY as a Bearer token", async () => {
    const seen: Request[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push(new Request(input, init));
      return Response.json({ data: [{ index: 0, embedding: [1, 0] }] });
    }) as typeof fetch;
    try {
      const ai = new OpenAiModels({ vision: "http://gpu.example:8080", embed: "http://emb.example:8081/v1", apiKey: "sk-test" }, { vision: "v", embed: "e" });
      await ai.embed(["drill"], "document");
    } finally {
      globalThis.fetch = original;
    }
    expect(seen[0]!.url).toBe("http://emb.example:8081/v1/embeddings");
    expect(seen[0]!.headers.get("authorization")).toBe("Bearer sk-test");
  });
});
