// After `vitepress build`: the sha256 of every inline <script> VitePress wrote (dark mode, the page hash map…), so the
// server's CSP for /docs can allow exactly those and nothing else (apps/server/src/app.ts). Written to dist/csp.json.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const dist = path.resolve(import.meta.dirname, ".vitepress/dist");
const hashes = new Set();
for (const file of readdirSync(dist, { recursive: true })) {
  if (!file.endsWith(".html")) continue;
  const html = readFileSync(path.join(dist, file), "utf8");
  for (const [, attrs, body] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    if (/\bsrc=/.test(attrs)) continue;
    hashes.add(`sha256-${createHash("sha256").update(body, "utf8").digest("base64")}`);
  }
}
writeFileSync(path.join(dist, "csp.json"), JSON.stringify({ scriptHashes: [...hashes].sort() }, null, 1));
console.log(`csp.json: ${hashes.size} inline script hashes`);
