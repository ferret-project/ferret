/** The help at /docs: served from its build, with its own CSP (its inline scripts by hash) — the app keeps the strict one. */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createLocalDb, runMigrations } from "../src/adapters/local/db";
import { FsBlobs } from "../src/adapters/local/blobs";
import { docsScriptHashes, mountDocs } from "../src/adapters/local/web";
import { createApp } from "../src/app";
import { config } from "./helpers";

const HASH = "sha256-S2giiGvqLfOPhaO37+NyDWnVA3p4+Jnqet9ao5q3WSU=";

async function withDocs() {
  const docs = mkdtempSync(path.join(tmpdir(), "ferret-docs-"));
  mkdirSync(path.join(docs, "guide"));
  writeFileSync(path.join(docs, "index.html"), "<!doctype html><title>Ferret help</title>");
  writeFileSync(path.join(docs, "guide/labels.html"), "<!doctype html><title>QR labels</title>");
  writeFileSync(path.join(docs, "404.html"), "<!doctype html><title>Not found</title>");
  writeFileSync(path.join(docs, "csp.json"), JSON.stringify({ scriptHashes: [HASH] }));
  const { db } = createLocalDb(":memory:");
  await runMigrations(db, path.resolve(__dirname, "../migrations"));
  const { app } = createApp({ db, blobs: new FsBlobs(mkdtempSync(path.join(tmpdir(), "ferret-blobs-"))) }, config, { docsScriptHashes: docsScriptHashes(docs) });
  mountDocs(app, docs);
  return app;
}

describe("help at /docs", () => {
  it("serves its pages, with its own CSP", async () => {
    const app = await withDocs();
    const redirect = await app.request("/docs");
    expect(redirect.status).toBe(301);
    expect(redirect.headers.get("location")).toBe("/docs/");

    for (const [url, title] of [["/docs/", "Ferret help"], ["/docs/guide/labels.html", "QR labels"]]) {
      const res = await app.request(url!);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain(title);
      const csp = res.headers.get("content-security-policy")!;
      expect(csp).toContain(`script-src 'self' '${HASH}'`);
      expect(csp).toContain("style-src 'self' 'unsafe-inline'");
      expect(csp).toContain("frame-src https://www.youtube-nocookie.com");
      expect(csp).not.toContain("wasm-unsafe-eval");
    }

    const missing = await app.request("/docs/guide/nope.html");
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain("Not found");
    expect((await app.request("/docs/../../etc/passwd")).status).toBe(404);
  });

  it("leaves the app's strict CSP alone", async () => {
    const app = await withDocs();
    const csp = (await app.request("/healthz")).headers.get("content-security-policy")!;
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain(HASH);
    expect(csp).not.toContain("youtube");
  });
});
