import { cpSync, existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { type DefaultTheme, defineConfig } from "vitepress";

/**
 * Pages added to the help at build time: `FERRET_HELP_PAGES` = a
 * folder of `*.md` pages (not README.md), served as /guide/<name>, and an optional `sidebar.json` — `[{ "group": "Getting started",
 * "text": "…", "link": "/guide/<name>" }]`. Copied into `extra/` (gitignored) and rewritten into guide/, so their
 * relative links work like the guide's own; help-json.mjs indexes them under guide/ too. Without it, `extra/` is emptied.
 */
const extraDir = path.join(import.meta.dirname, "../extra");
rmSync(extraDir, { recursive: true, force: true });
const extraFrom = process.env.FERRET_HELP_PAGES;
const extraPages = extraFrom ? readdirSync(extraFrom).filter((f) => f.endsWith(".md") && f !== "README.md") : [];
for (const page of extraPages) {
  if (existsSync(path.join(import.meta.dirname, "../guide", page))) throw new Error(`FERRET_HELP_PAGES: guide/${page} is already a page`);
  cpSync(path.join(extraFrom!, page), path.join(extraDir, page));
}
const extraSidebar: { group: string; text: string; link: string }[] =
  extraFrom && existsSync(path.join(extraFrom, "sidebar.json")) ? JSON.parse(readFileSync(path.join(extraFrom, "sidebar.json"), "utf8")) : [];

/** The guide's sidebar with the extra pages' entries at the end of their groups. */
function withExtra(groups: DefaultTheme.SidebarItem[]) {
  for (const entry of extraSidebar) {
    const group = groups.find((g) => g.text === entry.group);
    if (!group) throw new Error(`FERRET_HELP_PAGES: no sidebar group "${entry.group}"`);
    group.items!.push({ text: entry.text, link: entry.link });
  }
  return groups;
}

// Served by Ferret itself at /docs (adapters/local/web.ts), with its own CSP: the inline scripts VitePress writes are
// allowed by hash (csp-hashes.mjs, run after the build). No outside requests: local search, no fonts or analytics.
export default defineConfig({
  rewrites: Object.fromEntries(extraPages.map((page) => [`extra/${page}`, `guide/${page}`])),
  base: "/docs/",
  lang: "en-US",
  title: "Ferret",
  titleTemplate: ":title · Ferret help",
  description: "Find anything you own: how to use Ferret, and how to run it.",
  head: [["link", { rel: "icon", type: "image/svg+xml", href: "/docs/favicon.svg" }]],
  lastUpdated: false,
  // Links out of the help, into the app (/../#/api): they open with target="_self", so VitePress's router leaves them be.
  ignoreDeadLinks: [/^\/\.\.\//],
  themeConfig: {
    logo: { src: "/favicon.svg", alt: "" },
    siteTitle: "Ferret help",
    nav: [
      { text: "Using Ferret", link: "/guide/getting-started", activeMatch: "/guide/" },
      { text: "Running Ferret", link: "/hosting/install", activeMatch: "/hosting/" },
      { text: "API", link: "/../#/api", target: "_self" },
      { text: "Back to Ferret", link: "/../", target: "_self" },
    ],
    // The Ferret community: questions, ideas and news (icons in the top bar).
    socialLinks: [
      { icon: "github", link: "https://github.com/ferret-project/ferret", ariaLabel: "Ferret on GitHub" },
      { icon: "discord", link: "https://discord.gg/XSkKyP2pdg", ariaLabel: "Ferret on Discord" },
      { icon: "youtube", link: "https://www.youtube.com/@FerretProject", ariaLabel: "Ferret on YouTube" },
    ],
    sidebar: {
      "/guide/": withExtra([
        {
          text: "Getting started",
          items: [
            { text: "Signing in and households", link: "/guide/getting-started" },
            { text: "On your phone", link: "/guide/phone" },
          ],
        },
        {
          text: "Your things",
          items: [
            { text: "Adding things", link: "/guide/adding-things" },
            { text: "Scanning a room", link: "/guide/room-scan" },
            { text: "Walking through a room", link: "/guide/walkthrough" },
            { text: "Importing", link: "/guide/importing" },
            { text: "Places and boxes", link: "/guide/places-and-boxes" },
            { text: "QR labels", link: "/guide/labels" },
            { text: "Categories and tags", link: "/guide/categories-and-tags" },
            { text: "Collections", link: "/guide/collections" },
            { text: "Stock: scan to count", link: "/guide/stock" },
            { text: "HomeKit and Matter codes", link: "/guide/pairing-codes" },
            { text: "Finding things", link: "/guide/finding-things" },
            { text: "Lending and borrowing", link: "/guide/lending" },
            { text: "Past things", link: "/guide/past-things" },
            { text: "Recently deleted", link: "/guide/recently-deleted" },
          ],
        },
        {
          text: "Looking after them",
          items: [
            { text: "Warranties and claims", link: "/guide/warranties" },
            { text: "Maintenance", link: "/guide/maintenance" },
            { text: "Reminders", link: "/guide/reminders" },
            { text: "Needs attention", link: "/guide/attention" },
            { text: "Recalls", link: "/guide/recalls" },
          ],
        },
        {
          text: "Your records",
          items: [
            { text: "Insurance report", link: "/guide/insurance-report" },
            { text: "Insurance coverage", link: "/guide/coverage" },
            { text: "Share links", link: "/guide/sharing" },
            { text: "Download everything", link: "/guide/download-everything" },
          ],
        },
        {
          text: "More",
          items: [
            { text: "Claude and the API", link: "/guide/claude" },
            { text: "Plan and usage", link: "/guide/plan-and-usage" },
            { text: "Account security", link: "/guide/security" },
          ],
        },
      ]),
      "/hosting/": [
        {
          text: "Running Ferret",
          items: [
            { text: "Install", link: "/hosting/install" },
            { text: "Settings (.env)", link: "/hosting/configuration" },
            { text: "AI features", link: "/hosting/ai" },
            { text: "Email and notifications", link: "/hosting/email" },
            { text: "Single sign-on", link: "/hosting/single-sign-on" },
            { text: "Backups and restoring", link: "/hosting/backups" },
            { text: "The server admin", link: "/hosting/server-admin" },
            { text: "Away from home", link: "/hosting/away-from-home" },
            { text: "Upgrading", link: "/hosting/upgrading" },
          ],
        },
      ],
    },
    search: { provider: "local" },
    outline: { level: [2, 3], label: "On this page" },
    docFooter: { prev: "Previous", next: "Next" },
    footer: { message: "Ferret — find anything you own." },
  },
});
