/**
 * Photo reading on the real vision model from .env (VISION_URL): made-up covers and boxes, drawn here, go through the
 * same prompt and reply schema as a photo added to a thing (jobs/analyze.ts), and the name, brand and model that come
 * back are checked. Run it before and after changing the photo prompt.
 *
 *   pnpm --filter @ferret/server eval:vision             # each case once
 *   pnpm --filter @ferret/server eval:vision --runs 3    # each case 3 times (the model isn't deterministic)
 *   pnpm --filter @ferret/server eval:vision --verbose   # every reply in full
 */
import sharp from "sharp";
import { OpenAiModels } from "../src/adapters/local/ai";
import { loadConfig } from "../src/config";
import { imagePrompt, replySchema } from "../src/jobs/analyze";

type Field = "name" | "brand" | "model";
interface Case {
  title: string;
  svg: string;
  /** Each field must match (case-insensitive); `null` means the model must leave it empty. */
  expect: Partial<Record<Field, RegExp | null>>;
  /** Patterns a field must not match, like the brand in a generic name. */
  never?: Partial<Record<Field, RegExp>>;
}

const font = `font-family="Helvetica, Arial, sans-serif"`;

/** A game case's front: the platform's banner on top, the title, the publisher's logo at the bottom. */
const gameCase = (o: { banner: string; bannerColor: string; title: string[]; publisher: string; art: string }) => `
<svg xmlns="http://www.w3.org/2000/svg" width="760" height="680" viewBox="0 0 760 680">
  <rect width="760" height="680" fill="#d9d4cc"/>
  <rect x="110" y="20" width="540" height="640" rx="14" fill="${o.art}"/>
  <rect x="110" y="20" width="540" height="78" rx="14" fill="${o.bannerColor}"/>
  <text x="380" y="72" ${font} font-size="38" font-weight="bold" fill="#fff" text-anchor="middle" letter-spacing="2">${o.banner}</text>
  <circle cx="380" cy="330" r="120" fill="#ffffff" opacity="0.25"/>
  <circle cx="330" cy="300" r="40" fill="#ffd34d"/>
  ${o.title.map((line, i) => `<text x="380" y="${470 + i * 58}" ${font} font-size="52" font-weight="bold" fill="#fff" stroke="#222" stroke-width="2" text-anchor="middle">${line}</text>`).join("")}
  <rect x="140" y="580" width="56" height="64" fill="#fff"/><text x="168" y="628" ${font} font-size="40" font-weight="bold" text-anchor="middle">E</text>
  <rect x="470" y="596" width="160" height="40" rx="20" fill="#fff"/>
  <text x="550" y="624" ${font} font-size="24" font-weight="bold" fill="${o.bannerColor}" text-anchor="middle">${o.publisher}</text>
</svg>`;

const CASES: Case[] = [
  {
    // GitHub issue #8: a 3DS game whose publisher also makes the platform came back with no brand or model.
    title: "3DS game published by the platform's maker",
    svg: gameCase({ banner: "NINTENDO 3DS", bannerColor: "#d6001c", title: ["STAR HOPPER", "GALAXY RUN"], publisher: "Nintendo", art: "#3a7bd5" }),
    expect: { name: /star hopper/i, brand: /nintendo/i, model: /3ds/i },
  },
  {
    title: "Switch game from another publisher",
    svg: gameCase({ banner: "NINTENDO SWITCH", bannerColor: "#e60012", title: ["HARBOR", "LIGHTS"], publisher: "LUMEN GAMES", art: "#2e8b57" }),
    expect: { name: /harbor lights/i, brand: /lumen/i, model: /switch/i },
    never: { brand: /nintendo/i },
  },
  {
    title: "A book: title as the name, publisher as the brand",
    svg: `
<svg xmlns="http://www.w3.org/2000/svg" width="600" height="760" viewBox="0 0 600 760">
  <rect width="600" height="760" fill="#cfc8bb"/>
  <rect x="90" y="30" width="420" height="700" fill="#5b3a29"/>
  <text x="300" y="200" font-family="Georgia, serif" font-size="56" fill="#f3e6c8" text-anchor="middle">The Quiet</text>
  <text x="300" y="270" font-family="Georgia, serif" font-size="56" fill="#f3e6c8" text-anchor="middle">Orchard</text>
  <line x1="180" y1="310" x2="420" y2="310" stroke="#f3e6c8" stroke-width="2"/>
  <text x="300" y="370" font-family="Georgia, serif" font-size="30" fill="#f3e6c8" text-anchor="middle">A Novel</text>
  <text x="300" y="560" font-family="Georgia, serif" font-size="34" fill="#f3e6c8" text-anchor="middle">MARGARET ELLWOOD</text>
  <text x="300" y="690" font-family="Georgia, serif" font-size="24" fill="#f3e6c8" text-anchor="middle">HALCYON PRESS</text>
</svg>`,
    expect: { name: /quiet orchard/i, brand: /halcyon/i },
  },
  {
    // The other way round: an ordinary product keeps a short, generic name without the brand.
    title: "A drill's box keeps a generic name",
    svg: `
<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600">
  <rect width="800" height="600" fill="#bfc4c9"/>
  <rect x="60" y="60" width="680" height="480" fill="#f2b705"/>
  <rect x="60" y="60" width="680" height="110" fill="#1b1b1b"/>
  <text x="100" y="138" ${font} font-size="64" font-weight="bold" fill="#f2b705">VOLTRA</text>
  <text x="700" y="132" ${font} font-size="40" font-weight="bold" fill="#fff" text-anchor="end">20V MAX</text>
  <text x="100" y="250" ${font} font-size="46" font-weight="bold" fill="#1b1b1b">CORDLESS DRILL/DRIVER</text>
  <text x="100" y="310" ${font} font-size="36" fill="#1b1b1b">1/2 in. (13 mm) · 2-Speed</text>
  <rect x="100" y="420" width="250" height="70" fill="#1b1b1b"/>
  <text x="225" y="468" ${font} font-size="40" font-weight="bold" fill="#fff" text-anchor="middle">VD-771</text>
  <path d="M470 380 h170 v50 h-60 l-20 90 h-40 l10 -90 h-60 z" fill="#1b1b1b"/>
</svg>`,
    expect: { name: /drill/i, brand: /voltra/i, model: /771/ },
    never: { name: /voltra/i },
  },
];

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
};
const runs = Math.max(1, Number(arg("--runs") ?? 1));
const verbose = process.argv.includes("--verbose");

const config = loadConfig({ ...process.env, NODE_ENV: "test" });
if (!config.VISION_URL) {
  console.error("Needs VISION_URL (and VISION_MODEL) in .env");
  process.exit(1);
}
const ai = new OpenAiModels(
  { vision: config.VISION_URL, embed: config.EMBED_URL ?? config.VISION_URL, apiKey: config.AI_API_KEY },
  { vision: config.VISION_MODEL, embed: config.EMBED_MODEL },
);
console.log(`Vision model: ${config.VISION_MODEL} at ${config.VISION_URL} — ${CASES.length} cases × ${runs}\n`);

const show = (v: unknown) => (v == null ? "—" : JSON.stringify(v));
let failed = 0;
for (const c of CASES) {
  const image = new Uint8Array(await sharp(Buffer.from(c.svg)).jpeg({ quality: 88 }).toBuffer());
  for (let run = 1; run <= runs; run++) {
    const started = Date.now();
    const reply = (await ai.json({ prompt: imagePrompt("photo", "USD"), schema: replySchema, image: { data: image, contentType: "image/jpeg" }, maxTokens: 6000 })) as Record<string, unknown>;
    const problems: string[] = [];
    for (const [field, want] of Object.entries(c.expect) as [Field, RegExp | null][]) {
      const got = reply[field];
      if (want === null ? got != null : typeof got !== "string" || !want.test(got)) problems.push(`${field} ${show(got)}, wanted ${want ?? "empty"}`);
    }
    for (const [field, bad] of Object.entries(c.never ?? {}) as [Field, RegExp][]) {
      const got = reply[field];
      if (typeof got === "string" && bad.test(got)) problems.push(`${field} ${show(got)} shouldn't match ${bad}`);
    }
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    const line = `name ${show(reply.name)}, brand ${show(reply.brand)}, model ${show(reply.model)}, sure ${show(reply.sure)}`;
    if (problems.length) failed++;
    console.log(`${problems.length ? "✗" : "✓"} ${c.title}${runs > 1 ? ` (run ${run})` : ""} — ${seconds} s\n    ${line}${problems.map((p) => `\n    ✗ ${p}`).join("")}`);
    if (verbose) console.log(JSON.stringify(reply, null, 2));
  }
}
const total = CASES.length * runs;
console.log(`\n${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
