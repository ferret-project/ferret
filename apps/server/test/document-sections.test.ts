/** The part of a document that answers a question, whole (lib/document-sections.ts), and Ask reading it. */
import type { AskAnswer, AskSettings } from "@ferret/shared";
import { describe, expect, it } from "vitest";
import { stepLines } from "../src/lib/ask";
import { bestSections, isProcedureQuestion } from "../src/lib/document-sections";
import { FakeAi, FakeDocuments, pdf, setup } from "./helpers";

const filler = (topic: string) => Array.from({ length: 12 }, (_, i) => `The ${topic} paragraph ${i + 1} of the Brava espresso machine describes ordinary use in some detail.`).join("\n\n");

/** Docling writes every heading at the same level; the numbering says what's inside what. A notice is a heading too. */
const manual = [
  "## Brava espresso machine — instructions",
  "## Contents",
  "1 Safety ........ 2\n2 Brewing ........ 4\n11 Descaling ........ 30\n12 Cleaning ........ 34",
  "## 1 Safety",
  filler("safety"),
  "## 2 Brewing",
  filler("brewing"),
  "## 2.1 Brewing a long coffee",
  "1. Fill the tank.\n2. Press the long coffee button.",
  "## 11 Descaling",
  "Descale the machine when the descale light comes on. Scale shortens its life.",
  "## WARNING",
  "The descaler is an irritant: keep it away from eyes and skin. Never drink it.",
  "## 11.1 Preparing to descale",
  "1. Empty the drip tray.\n2. Pour the descaler into the tank and fill it with water to the A line.\n3. Put a container of at least 1.5 litres under the spout.",
  "## 11.2 Running the descale cycle",
  filler("cycle"),
  "4. Press and hold the descale button for 5 seconds.\n5. Turn the steam knob to open.\n6. Wait until the tank is empty (about 25 minutes).\n7. Turn the steam knob to closed.\n8. Rinse the tank and fill it with clean water to MAX.\n9. Empty the container and put it back under the spout.\n10. Turn the steam knob to open again for the rinse.\n11. When the rinse is done, turn the knob to closed.\n12. Empty the drip tray and the container.",
  "## 12 Cleaning",
  "Clean the drip tray weekly with warm water. Descale light: see chapter 11.",
  filler("cleaning"),
].join("\n\n");

describe("the section that answers", () => {
  it("takes the whole chapter, with its sub-sections and its warning, for a how-to question", () => {
    const [s] = bestSections(manual, "How do I descale my Brava?", { maxChars: 20_000 });
    expect(s!.title).toBe("11 Descaling");
    expect(s!.cut).toBe(false);
    // Every step, the preparation and the rinse; the warning that docling made a heading is inside, not a section.
    for (let n = 1; n <= 12; n++) expect(s!.text).toMatch(new RegExp(`^${n}\\. `, "m"));
    expect(s!.text).toContain("keep it away from eyes and skin");
    expect(s!.text).not.toContain("Clean the drip tray weekly"); // chapter 12 isn't part of it
    expect(s!.near).toMatch(/^Descale the machine when/);
  });

  it("matches other forms of the word ('descaling', 'scale') and leaves the table of contents out", () => {
    const [s] = bestSections(manual, "steps for descaling", { maxChars: 20_000 });
    expect(s!.title).toBe("11 Descaling");
  });

  it("says so when the section is longer than allowed, cut at a line", () => {
    const [s] = bestSections(manual, "How do I descale it?", { maxChars: 1200 });
    expect(s!.cut).toBe(true);
    expect(s!.text.length).toBeLessThanOrEqual(1200);
    expect(s!.text).toMatch(/the section goes on in the document; the rest wasn't read\]$/);
  });

  it("names a part with its chapter when the part's heading has no number", () => {
    const doc = "# Washer\n\n## Care\n\nKeep it dry.\n\n### Cleaning the filter\n\n1. Open the flap.\n2. Unscrew the filter.\n3. Rinse it.\n\n## Programs\n\nCotton, wool.";
    const [s] = bestSections(doc, "how do I clean the filter", { maxChars: 5000 });
    expect(s!.title).toBe("Care › Cleaning the filter");
    expect(s!.text).toContain("3. Rinse it.");
  });

  it("keeps a run of numbered steps together in a scan without headings", () => {
    const scan = [
      "Thank you for buying the Model 7 humidifier.",
      ...Array.from({ length: 30 }, (_, i) => `General information line ${i + 1}.`),
      "To clean the tank:",
      "1. Unplug the unit.",
      "2. Lift off the tank.",
      "3. Wash it with warm water and a mild soap.",
      "Do not use bleach.",
      "4. Dry it before putting it back.",
      "Warranty: one year.",
      "Keep this booklet.",
      "Made in Taiwan.",
    ].join("\n");
    const [s] = bestSections(scan, "How do I clean the tank?", { maxChars: 5000 });
    expect(s!.title).toBeUndefined();
    expect(s!.text).toContain("To clean the tank:");
    expect(s!.text).toContain("4. Dry it before putting it back.");
    expect(s!.text).toContain("Do not use bleach.");
    expect(s!.text).not.toContain("Made in Taiwan");
  });

  it("finds nothing when no part has the question's words", () => {
    expect(bestSections(manual, "what's the warranty period?", { maxChars: 5000 })).toEqual([]);
  });

  it("puts each step of an answer on its own line when the model ran them together", () => {
    expect(stepLines("1. Unplug it. 2. Lift the tank (about 2.5 kg). 3. Rinse it.\n\nWARNING: no bleach.")).toBe("1. Unplug it.\n2. Lift the tank (about 2.5 kg).\n3. Rinse it.\n\nWARNING: no bleach.");
    expect(stepLines("1. Unplug it.\n2. Rinse it.")).toBe("1. Unplug it.\n2. Rinse it.");
    expect(stepLines("It holds 2. litres")).toBe("It holds 2. litres");
  });

  it("knows a how-to question", () => {
    expect(isProcedureQuestion("How do I descale it?")).toBe(true);
    expect(isProcedureQuestion("steps to reset the router")).toBe(true);
    expect(isProcedureQuestion("where did I buy the drill?")).toBe(false);
  });
});

const docReply = { description: "Espresso machine manual.", text: "", name: null, brand: null, model: null, serialNumber: null, barcode: null, purchaseDate: null, purchasePrice: null, sure: [] };

async function withManual(replies: unknown[]) {
  const chat = new FakeAi([docReply, ...replies]);
  const ctx = await setup({ chat, documents: new FakeDocuments([manual]) });
  const ann = await ctx.user("ann");
  const { id } = await ann.addItem({ name: "Espresso machine", brand: "Brava" });
  const { id: attachmentId } = await ann.upload(id, pdf(), "brava-manual.pdf", "document");
  await ctx.jobs.drain();
  const askItem = async (question: string) => (await (await ann.as(`/api/v1/items/${id}/ask`, { method: "POST", body: JSON.stringify({ question }) })).json()) as AskAnswer;
  const ask = async (question: string) => (await (await ann.as("/api/v1/ask", { method: "POST", body: JSON.stringify({ question }) })).json()) as AskAnswer;
  return { ...ctx, chat, ann, id, attachmentId, askItem, ask };
}

describe("Ask reading whole sections", () => {
  it("gives the model the whole procedure and cites its section, with where it starts", async () => {
    const steps = "1. Empty the drip tray.\n2. Pour in the descaler.\n…\n12. Empty the drip tray and the container.";
    const { chat, askItem, id, attachmentId } = await withManual([{ answer: steps, found: true, sources: [2] }]);
    const answer = await askItem("How do I descale it?");
    const prompt = chat.calls.at(-1)!.prompt;
    expect(prompt).toContain('brava-manual.pdf, section "11 Descaling"');
    expect(prompt).toContain("12. Empty the drip tray and the container.");
    expect(prompt).toContain("keep it away from eyes and skin");
    expect(prompt).toContain("numbered list with one step per line");
    // Newlines kept: the web shows them.
    expect(answer.answer).toBe(steps);
    expect(answer.citations).toEqual([
      { itemId: id, itemName: "Espresso machine", attachmentId, filename: "brava-manual.pdf", section: "11 Descaling", near: expect.stringMatching(/^Descale the machine when/), find: "descale" },
    ]);
  });

  it("reads the section in a question about the whole inventory too", async () => {
    const { chat, ask } = await withManual([{ answer: "1. Empty the drip tray.", found: true, sources: [2] }]);
    const answer = await ask("how do I descale the brava espresso machine?");
    expect(chat.calls.at(-1)!.prompt).toContain("12. Empty the drip tray and the container.");
    expect(answer.citations[0]).toMatchObject({ section: "11 Descaling" });
  });

  it("reads less with a smaller context size, which only the server admin sets", async () => {
    const { chat, ann, user, askItem } = await withManual([
      { answer: "a", found: true, sources: [1] },
      { answer: "b", found: true, sources: [1] },
    ]);
    const settings = (await (await ann.as("/api/v1/server/ask")).json()) as AskSettings;
    expect(settings).toMatchObject({ contextTokens: 8192, isDefault: true, default: 8192 });
    await askItem("How do I descale it?");
    const big = chat.calls.at(-1)!.prompt.length;

    const put = await ann.as("/api/v1/server/ask", { method: "PUT", body: JSON.stringify({ contextTokens: 2048 }) });
    expect(await put.json()).toMatchObject({ contextTokens: 2048, isDefault: false });
    await askItem("How do I descale it?");
    const small = chat.calls.at(-1)!.prompt;
    expect(small.length).toBeLessThan(big);
    expect(small).toContain("the section goes on in the document"); // cut, and the model is told

    expect((await ann.as("/api/v1/server/ask", { method: "PUT", body: JSON.stringify({ contextTokens: 100 }) })).status).toBe(422);
    expect(await (await ann.as("/api/v1/server/ask", { method: "PUT", body: JSON.stringify({ contextTokens: null }) })).json()).toMatchObject({ contextTokens: 8192, isDefault: true });
    const bob = await user("bob");
    expect((await bob.as("/api/v1/server/ask")).status).toBe(403);
  });
});
