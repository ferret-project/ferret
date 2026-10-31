// After `vitepress build`: every help page as plain text, split at its ## headings, in dist/help.json — for anything that
// answers questions from the help (a help bot, a search index). Each section carries its page's path and the
// heading's anchor (VitePress's own slugs), so an answer can link to the exact place.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = import.meta.dirname;
const dist = path.join(root, ".vitepress/dist");

/** VitePress's heading anchors (@mdit-vue/shared slugify). */
function slugify(text) {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[\u0000-\u001f]/g, "")
    .replace(/[\s~`!@#$%^&*()\-_+=[\]{}|\\;:"'“”‘’<>,.?/]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^(\d)/, "_$1")
    .toLowerCase();
}

/** Markdown → plain text that still reads well: no images, attributes, containers or HTML; links keep their words. */
function plain(md) {
  return md
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^!\[.*$/gm, "")
    .replace(/\{[.#][^}]*\}/g, "")
    .replace(/^:::\s*\w+\s*(.*)$/gm, (_, title) => (title ? `${title}:` : ""))
    .replace(/^:::\s*$/gm, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const headingText = (h) => plain(h.replace(/\*\*|`/g, ""));

const pages = [];
for (const file of readdirSync(root, { recursive: true }).sort()) {
  if (!file.endsWith(".md") || file.includes("node_modules") || file.startsWith(".vitepress") || path.basename(file) === "CLAUDE.md") continue;
  let md = readFileSync(path.join(root, file), "utf8");
  const front = md.match(/^---\n([\s\S]*?)\n---\n/);
  if (front) md = md.slice(front[0].length);
  if (/^layout:\s*home/m.test(front?.[1] ?? "")) md = md.replace(/^## Take the tour[\s\S]*?(?=^## )/m, "");
  const title = headingText(md.match(/^# (.+)$/m)?.[1] ?? front?.[1].match(/^title:\s*(.+)$/m)?.[1] ?? file);
  const sections = [];
  let current = { heading: null, anchor: null, lines: [] };
  for (const line of md.split("\n")) {
    if (/^# /.test(line)) continue;
    const h2 = line.match(/^## (.+?)\s*(\{#([\w-]+)\})?\s*$/);
    if (h2) {
      sections.push(current);
      const heading = headingText(h2[1]);
      current = { heading, anchor: h2[3] ?? slugify(heading), lines: [] };
    } else current.lines.push(line);
  }
  sections.push(current);
  pages.push({
    // Pages added with FERRET_HELP_PAGES (.vitepress/config.ts) are copied to extra/ and served under guide/.
    path: file.replace(/\.md$/, "").replace(/(^|\/)index$/, "$1").replace(/^extra\//, "guide/"),
    title,
    sections: sections
      .map(({ heading, anchor, lines }) => ({ heading, anchor, text: plain(lines.join("\n")) }))
      .filter((s) => s.text),
  });
}
writeFileSync(path.join(dist, "help.json"), JSON.stringify({ format: "ferret-help", version: 1, pages }));
console.log(`help.json: ${pages.length} pages, ${pages.reduce((n, p) => n + p.sections.length, 0)} sections`);
