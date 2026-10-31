#!/usr/bin/env node
/**
 * Writes a brotli (.br) and a gzip (.gz) copy beside every text file and the scanner's wasm in a built folder, so the
 * server sends them compressed with no work per request (serveStatic `precompressed`, adapters/local/web.ts).
 * Run after a build: `node scripts/precompress.mjs <dist folder>`. Copies that don't save at least 10% aren't kept.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: precompress.mjs <dist folder>");
  process.exit(1);
}
const COMPRESSIBLE = /\.(?:html|js|mjs|css|json|webmanifest|svg|txt|xml|wasm)$/;

let before = 0;
let after = 0;
const walk = (d) => {
  for (const name of readdirSync(d)) {
    const file = path.join(d, name);
    if (statSync(file).isDirectory()) walk(file);
    else if (COMPRESSIBLE.test(name)) {
      const data = readFileSync(file);
      if (data.length < 1024) continue;
      const br = brotliCompressSync(data, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: data.length } });
      const gz = gzipSync(data, { level: 9 });
      if (br.length < data.length * 0.9) writeFileSync(`${file}.br`, br);
      if (gz.length < data.length * 0.9) writeFileSync(`${file}.gz`, gz);
      before += data.length;
      after += Math.min(br.length, data.length);
    }
  }
};
walk(dir);
console.log(`precompressed ${dir}: ${Math.round(before / 1024)} kB → ${Math.round(after / 1024)} kB (brotli)`);
