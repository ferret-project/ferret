import { readFileSync } from "node:fs";
import path from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import type { Context, Hono } from "hono";
import type { AppEnv } from "../../lib/context";

/**
 * How long a browser may keep a file: the build's hashed files (`assets/…`, named by their content) for a year without
 * asking again; everything else (pages, sw.js, precache.json, the manifest) is checked each time, so a new version is
 * seen at once. Set before the file is served (serveStatic's onFound comes after the response is made).
 */
const IMMUTABLE = "public, max-age=31536000, immutable";
const cacheFor = (assets: string) => (c: Context, next: () => Promise<void>) => {
  c.header("Cache-Control", c.req.path.startsWith(assets) ? IMMUTABLE : "no-cache");
  return next();
};

/**
 * Serves the built web app (SPA) from disk: static files, falling back to
 * index.html for client-side routes. /api/* is never answered with the page,
 * so an unknown API path gets the JSON 404 rather than a 200 of HTML.
 * Compressed copies (.br/.gz, written by scripts/precompress.mjs after the build) are sent when the browser takes them.
 */
export function mountWebApp(app: Hono<AppEnv>, webRoot: string) {
  const rel = path.relative(process.cwd(), webRoot) || ".";
  const page = serveStatic({ root: rel, path: "index.html", precompressed: true });
  app.use("/*", cacheFor("/assets/"), serveStatic({ root: rel, precompressed: true }));
  app.get("*", (c, next) => {
    if (c.req.path.startsWith("/api/")) return next();
    c.header("Cache-Control", "no-cache"); // the page, under a client-side route's address
    return page(c, next);
  });
}

/**
 * Serves the built help (VitePress) at /docs: its pages and assets, /docs → /docs/, and its own 404 page for anything
 * else under /docs (rather than the app). Mount before mountWebApp.
 */
export function mountDocs(app: Hono<AppEnv>, docsRoot: string) {
  const rel = path.relative(process.cwd(), docsRoot) || ".";
  const notFound = readFileSync(path.join(docsRoot, "404.html"), "utf8");
  app.get("/docs", (c) => c.redirect("/docs/", 301));
  app.use("/docs/*", cacheFor("/docs/assets/"), serveStatic({ root: rel, precompressed: true, rewriteRequestPath: (p) => p.replace(/^\/docs/, "") }));
  app.get("/docs/*", (c) => c.html(notFound, 404));
}

/** The sha256 hashes of the help's inline scripts (its build writes csp.json), for its CSP. */
export function docsScriptHashes(docsRoot: string): string[] {
  return (JSON.parse(readFileSync(path.join(docsRoot, "csp.json"), "utf8")) as { scriptHashes: string[] }).scriptHashes;
}
