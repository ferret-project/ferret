// Bundles the server into dist/server.js (and the command-line tool into dist/cli.js) (everything inlined except the native
// bits — libSQL, sharp, the canvas PDFs are drawn on — and pdf.js, which loads its worker and fonts from its own package)
// and copies migrations next to it, so the Docker image needs almost no node_modules.
import { cpSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { build } from "esbuild";

rmSync("dist", { recursive: true, force: true });
await build({
  entryPoints: ["src/server.ts", "src/cli.ts"],
  outdir: "dist",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  external: ["@libsql/client", "libsql", "sharp", "pdfjs-dist", "@napi-rs/canvas"],
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
});
cpSync("migrations", "dist/migrations", { recursive: true });
// The server's translations (lib/language.ts), made by the web app's build just before (translations.mjs prepare).
if (existsSync("../web/src/locales/server.json")) cpSync("../web/src/locales/server.json", "dist/locales.json");
writeFileSync("dist/package.json", JSON.stringify({ type: "module" }));
console.log("built dist/server.js");
