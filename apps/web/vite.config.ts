import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { lingui } from "@lingui/vite-plugin";
import { type Plugin, defineConfig } from "vite";
import { createRequire } from "node:module";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * pdf.js's data files (the document viewer, DocumentViewer.tsx): built-in fonts, character maps and its wasm image
 * decoders, served at /pdfjs/… — copied into the build, and from node_modules in dev. Only fetched when a PDF needs one.
 */
function pdfjsFiles(): Plugin {
  const root = path.dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
  const dirs = ["cmaps", "standard_fonts", "wasm"];
  return {
    name: "ferret-pdfjs-files",
    configureServer(server) {
      server.middlewares.use("/pdfjs", (req, res, next) => {
        const rel = path.normalize(decodeURIComponent((req.url ?? "").split("?")[0] ?? "")).replace(/^([/\\])+/, "");
        const file = path.join(root, rel);
        if (!dirs.includes(rel.split(/[/\\]/)[0] ?? "") || !file.startsWith(root + path.sep) || !statSync(file, { throwIfNoEntry: false })?.isFile()) return next();
        res.setHeader("Content-Type", file.endsWith(".wasm") ? "application/wasm" : "application/octet-stream");
        res.end(readFileSync(file));
      });
    },
    generateBundle() {
      for (const dir of dirs)
        for (const name of readdirSync(path.join(root, dir)))
          this.emitFile({ type: "asset", fileName: `pdfjs/${dir}/${name}`, source: readFileSync(path.join(root, dir, name)) });
    },
  };
}

/**
 * Writes precache.json: every file the built app is made of (and the public ones it needs), so the service worker
 * (public/sw.js) can keep them and the app opens with no signal (offline capture). `version` changes when they do.
 */
function precacheList(): Plugin {
  const always = ["/", "/appearance.js", "/manifest.webmanifest", "/favicon.svg", "/apple-touch-icon.png", "/icon-192.png", "/icon-512.png", "/icon-maskable-512.png"];
  return {
    name: "ferret-precache",
    apply: "build",
    enforce: "post",
    generateBundle(_, bundle) {
      const files = Object.keys(bundle)
        // pdf.js (the document viewer) isn't kept offline: the files it shows come from the server anyway.
        .filter((f) => !f.endsWith(".map") && f !== "index.html" && !f.startsWith("pdfjs/") && !/^assets\/pdf(\.worker\.min)?-/.test(f))
        .map((f) => `/${f}`)
        .sort();
      const version = files.join("|").length.toString(36) + "-" + [...files.join("|")].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7).toString(36);
      this.emitFile({ type: "asset", fileName: "precache.json", source: JSON.stringify({ version, files: [...always, ...files] }) });
    },
  };
}

/**
 * Fails the build if zod reaches the app: it's ~360 kB of the server's schemas. The web app takes types from
 * `@ferret/shared` and values only from `@ferret/shared/utils` (zod-free).
 */
function noZod(): Plugin {
  return {
    name: "ferret-no-zod",
    apply: "build",
    generateBundle(_, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== "chunk") continue;
        const zod = chunk.moduleIds.find((id) => /[\\/]node_modules[\\/].*[\\/]zod[\\/]/.test(id));
        if (zod) this.error(`zod is in ${chunk.fileName} — import values from "@ferret/shared/utils", only types from "@ferret/shared"`);
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), lingui({ macroTransform: true, failOnCompileError: true }), tailwindcss(), pdfjsFiles(), precacheList(), noZod()],
  server: {
    port: 5173,
    // In dev, the API runs separately on :8787; in production one server serves both.
    proxy: {
      "/api": "http://localhost:8787",
      "/healthz": "http://localhost:8787",
      "/mcp": "http://localhost:8787",
      "/calendar": "http://localhost:8787",
      // The help, as the server serves it once built (pnpm --filter @ferret/docs build; or pnpm docs:dev on :5174 to write it).
      "/docs": "http://localhost:8787",
      // QR label links (/l/K7QM); only that exact shape, so Vite's own /@… and /src/… paths stay local.
      "^/l/[0-9A-Za-z]+$": "http://localhost:8787",
      // Share links (/s/<token>) and a borrower's link from a reminder email (/b/<token>).
      "^/[sb]/[\\w-]{20,}$": "http://localhost:8787",
    },
  },
});
