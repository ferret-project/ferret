import { describe, expect, it } from "vitest";
import { FakeAi, FakeDocuments, MemoryVectors, pdf, photo, setup } from "./helpers";

const blank = { description: "Warranty.", text: "", name: null, brand: null, model: null, serialNumber: null, barcode: null, purchaseDate: null, purchasePrice: null };
const warranty = "KitchenAid Limited Warranty\n\nLength of warranty: One year from the date of purchase.";

async function askSetup(answer: unknown) {
  // First reply: the document analysis; then the answer.
  const ai = new FakeAi([blank, answer]);
  const env = await setup({ ai, vectors: new MemoryVectors(), documents: new FakeDocuments([warranty]) });
  const pat = await env.user("pat");
  const mixer = await pat.addItem({ name: "Stand mixer", brand: "KitchenAid" });
  await pat.upload(mixer.id, pdf("warranty"), "mixer-warranty.pdf", "document");
  await env.jobs.drain();
  const ask = async (question: string) => {
    const res = await pat.as("/api/v1/ask", { method: "POST", body: JSON.stringify({ question }) });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  return { ...env, ai, pat, mixer, ask };
}

describe("Ask Ferret", () => {
  it("answers from the household's documents and cites them", async () => {
    const { ai, mixer, ask } = await askSetup({ answer: "One year from purchase.", found: true, sources: [2] });
    const { status, body } = await ask("how long is the kitchenaid warranty?");
    expect(status).toBe(200);
    expect(body).toEqual({
      answer: "One year from purchase.",
      found: true,
      citations: [{ itemId: mixer.id, itemName: "Stand mixer", attachmentId: expect.any(String), filename: "mixer-warranty.pdf" }],
    });
    // The model saw the item and the matching passage, fenced off as data.
    const prompt = ai.calls.at(-1)!.prompt;
    expect(prompt).toContain("Question: how long is the kitchenaid warranty?");
    expect(prompt).toMatch(/\[1\] Stand mixer\n/);
    expect(prompt).toContain("[2] Stand mixer — mixer-warranty.pdf\n");
    expect(prompt).toContain("One year from the date of purchase");
  });

  it("says so when the inventory doesn't know, without citations", async () => {
    const { ask } = await askSetup({ answer: "Your documents don't say.", found: false, sources: [1] });
    const { body } = await ask("what color is the kitchenaid?");
    expect(body).toEqual({ answer: "Your documents don't say.", found: false, citations: [] });
  });

  it("ignores made-up source numbers and doesn't cite twice", async () => {
    const { ask } = await askSetup({ answer: "One year.", found: true, sources: [2, 2, 9] });
    const { body } = await ask("how long is the kitchenaid warranty?");
    expect(body.citations).toHaveLength(1);
  });

  it("doesn't call the model when nothing matches", async () => {
    const { ai, ask } = await askSetup({ answer: "x", found: true, sources: [] });
    const before = ai.calls.length;
    const { body } = await ask("where is the zxqv?");
    expect(body.found).toBe(false);
    expect(ai.calls.length).toBe(before);
  });

  it("only ever uses the asker's own household", async () => {
    const { ai, user } = await askSetup({ answer: "Nothing.", found: false, sources: [] });
    const sam = await user("sam");
    await sam.addItem({ name: "Toaster" });
    const before = ai.calls.length;
    const res = await sam.as("/api/v1/ask", { method: "POST", body: JSON.stringify({ question: "kitchenaid warranty?" }) });
    expect(((await res.json()) as { found: boolean }).found).toBe(false);
    // Pat's mixer never reaches the model on Sam's behalf.
    for (const call of ai.calls.slice(before)) expect(call.prompt).not.toContain("[1] Stand mixer");
  });

  it("reports when it isn't set up or the model fails", async () => {
    const plain = await setup();
    const sam = await plain.user("sam");
    const res = await sam.as("/api/v1/ask", { method: "POST", body: JSON.stringify({ question: "where is my drill?" }) });
    expect(res.status).toBe(409);

    const { ask } = await askSetup(new Error("model overloaded"));
    expect((await ask("how long is the kitchenaid warranty?")).status).toBe(503);
  });

  it("uses the stronger text model when one is configured — photos stay on the vision model", async () => {
    const vision = new FakeAi([{ ...blank, description: "A red stand mixer." }]);
    const chat = new FakeAi([blank, { answer: "One year.", found: true, sources: [2] }]);
    const env = await setup({ ai: vision, chat, vectors: new MemoryVectors(), documents: new FakeDocuments([warranty]) });
    const pat = await env.user("pat");
    const mixer = await pat.addItem({ name: "Stand mixer", brand: "KitchenAid" });
    await pat.upload(mixer.id, pdf("warranty"), "mixer-warranty.pdf", "document");
    await pat.upload(mixer.id, await photo(), "mixer.jpg");
    await env.jobs.drain();

    expect(vision.calls.map((c) => c.image)).toEqual(["image/jpeg"]); // only the photo
    expect(chat.calls[0]!.prompt).toContain("<document>"); // the PDF's text

    const res = await pat.as("/api/v1/ask", { method: "POST", body: JSON.stringify({ question: "kitchenaid warranty?" }) });
    expect(((await res.json()) as { answer: string }).answer).toBe("One year.");
    expect(chat.calls).toHaveLength(2);
    expect(vision.calls).toHaveLength(1);
  });
});
