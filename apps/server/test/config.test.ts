import { describe, expect, it } from "vitest";
import { doclingOptions, loadConfig, vapidSubject } from "../src/config";

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
});
