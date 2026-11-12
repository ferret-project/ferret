import { describe, expect, it } from "vitest";
import type { Speech } from "../src/ports";
import { member } from "../src/db/schema";
import { FakeAi, setup } from "./helpers";

type J = Record<string, unknown>;
const json = async <T = J>(r: Response | Promise<Response>) => (await (await r).json()) as T;

describe("sorting an import with AI", () => {
  it("says which lines to keep and picks categories only from the household's own", async () => {
    const chat = new FakeAi([{ lines: [{ n: 1, keep: true, category: "tools › power tools" }, { n: 2, keep: false, category: "Groceries" }, { n: 3, keep: true, category: null }] }]);
    const { user, jobs } = await setup({ chat });
    const pat = await user("pat");
    const tools = await json<{ id: string }>(pat.as("/api/v1/categories", { method: "POST", body: JSON.stringify({ name: "Tools" }) }));
    await pat.as("/api/v1/categories", { method: "POST", body: JSON.stringify({ name: "Power tools", parentId: tools.id }) });

    const start = await pat.as("/api/v1/import/triage", { method: "POST", body: JSON.stringify({ rows: [{ name: "DeWalt drill" }, { name: "Bananas" }, { name: "Lamp" }] }) });
    expect(start.status).toBe(202);
    const { id } = (await start.json()) as { id: string };
    expect(await json(pat.as(`/api/v1/ai-runs/${id}`))).toMatchObject({ status: "pending", done: 0, total: 3 });
    await jobs.drain();
    const run = await json<{ status: string; result: unknown[] }>(pat.as(`/api/v1/ai-runs/${id}`));
    expect(run.status).toBe("done");
    expect(run.result).toEqual([
      { keep: true, category: "Tools › Power tools" },
      { keep: false, category: null }, // not one of theirs: dropped
      { keep: true, category: null },
    ]);
    expect(chat.calls[0]!.prompt).toContain("- Tools › Power tools");

    // Only who asked can see it.
    const sam = await user("sam");
    expect((await sam.as(`/api/v1/ai-runs/${id}`)).status).toBe(404);
  });

  it("is refused without a model", async () => {
    const { user } = await setup();
    const pat = await user("pat");
    expect((await pat.as("/api/v1/import/triage", { method: "POST", body: JSON.stringify({ rows: [{ name: "x" }] }) })).status).toBe(503);
  });
});

describe("filters from plain words", () => {
  it("turns words into Everything's filters, from the household's own lists", async () => {
    const chat = new FakeAi([
      { category: "Tools", place: "Home › Garage", tag: "made up", missing: "document", origin: null, minWorth: 100, maxWorth: null, boughtFrom: "2025-01-01", boughtTo: "2025-12-31", notScannedMonths: 9, words: "dewalt" },
    ]);
    const { user } = await setup({ chat });
    const pat = await user("pat");
    const tools = await json<{ id: string }>(pat.as("/api/v1/categories", { method: "POST", body: JSON.stringify({ name: "Tools" }) }));
    const home = await json<{ id: string }>(pat.as("/api/v1/properties", { method: "POST", body: JSON.stringify({ name: "Home" }) }));
    const garage = await json<{ id: string }>(pat.as("/api/v1/locations", { method: "POST", body: JSON.stringify({ name: "Garage", propertyId: home.id }) }));

    const res = await json<{ filters: Record<string, string>; chips: { key: string }[]; query: string }>(
      pat.as("/api/v1/items/filters-from-text", { method: "POST", body: JSON.stringify({ text: "dewalt tools in the garage bought last year over $100 without a receipt" }) }),
    );
    expect(res.filters).toEqual({ categoryId: tools.id, locationId: garage.id, missing: "document", minWorth: "10000", boughtFrom: "2025-01-01", boughtTo: "2025-12-31", unscanned: "12" });
    expect(res.query).toBe("dewalt");
    expect(res.chips.map((c) => c.key)).not.toContain("tag");

    // The new filters work on the list.
    await pat.addItem({ name: "Drill", categoryId: tools.id, purchasePriceCents: 15000, purchaseDate: "2025-06-01" });
    await pat.addItem({ name: "Screwdriver", categoryId: tools.id, purchasePriceCents: 900, purchaseDate: "2025-06-01" });
    const list = await json<{ data: { name: string }[] }>(pat.as("/api/v1/items?minWorth=10000&boughtFrom=2025-01-01&boughtTo=2025-12-31"));
    expect(list.data.map((i) => i.name)).toEqual(["Drill"]);
  });
});

describe("replacement cost estimates", () => {
  it("leaves an estimate on the item, applied only by a person", async () => {
    const chat = new FakeAi([{ amount: 1449, reasoning: "A current 65-inch OLED is about $1,449 — an estimate." }]);
    const { user, jobs } = await setup({ chat });
    const pat = await user("pat");
    const tv = await pat.addItem({ name: "TV", brand: "LG", model: "OLED65C1" });
    expect((await pat.as(`/api/v1/items/${tv.id}/replacement-estimate`, { method: "POST" })).status).toBe(202);
    await jobs.drain();
    const item = await json(pat.as(`/api/v1/items/${tv.id}`));
    expect(item).toMatchObject({ replacementCents: null, replacementEstimate: { cents: 144900, reasoning: expect.stringContaining("estimate") } });
    await pat.as(`/api/v1/items/${tv.id}`, { method: "PATCH", body: JSON.stringify({ replacementCents: 144900 }) });
    const history = await json<{ data: { summary: string }[] }>(pat.as(`/api/v1/items/${tv.id}/history`));
    expect(history.data[0]!.summary).toBe("TV: replacement cost set to $1,449.00");
  });
});

describe("typical upkeep", () => {
  it("suggests typical schedules into Suggested maintenance, once per thing", async () => {
    const chat = new FakeAi([{ items: [{ n: 1, tasks: [{ task: "Replace the filter", every: 3, unit: "month" }] }, { n: 2, tasks: [] }] }]);
    const { user, jobs } = await setup({ chat });
    const pat = await user("pat");
    await pat.addItem({ name: "Furnace" });
    await pat.addItem({ name: "Mug" });
    await pat.addItem({ name: "Paper towels", minQuantity: 2 }); // a consumable: not asked about
    expect(await json(pat.as("/api/v1/maintenance/typical", { method: "POST", body: "{}" }))).toEqual({ queued: 2 });
    await jobs.drain();
    const suggested = await json<{ data: { title: string; itemName: string; source: string }[] }>(pat.as("/api/v1/maintenance/suggestions"));
    expect(suggested.data).toMatchObject([{ title: "Replace the filter", itemName: "Furnace", source: "typical" }]);
    // Asked once: nothing left to ask about.
    expect(await json(pat.as("/api/v1/maintenance/typical", { method: "POST", body: "{}" }))).toEqual({ queued: 0 });
  });
});

describe("speech to text", () => {
  class FakeSpeech implements Speech {
    calls: string[] = [];
    async transcribe(_audio: Uint8Array, contentType: string) {
      this.calls.push(contentType);
      return " Cordless drill ";
    }
  }
  const recording = (type = "audio/webm") => {
    const form = new FormData();
    form.set("audio", new File([new Uint8Array([1, 2, 3, 4])], "speech", { type }));
    return form;
  };

  it("turns a short recording into words", async () => {
    const speech = new FakeSpeech();
    const { user } = await setup({ speech });
    const pat = await user("pat");
    expect((await json<{ features: J }>(pat.as("/api/v1/me"))).features).toMatchObject({ speech: true });
    const res = await pat.as("/api/v1/transcribe", { method: "POST", body: recording("audio/mp4") });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "Cordless drill" });
    expect(speech.calls).toEqual(["audio/mp4"]);
    expect((await pat.as("/api/v1/transcribe", { method: "POST", body: recording("text/html") })).status).toBe(415);
  });

  it("is off without a speech server", async () => {
    const { user } = await setup();
    const pat = await user("pat");
    expect((await pat.as("/api/v1/transcribe", { method: "POST", body: recording() })).status).toBe(503);
  });
});

describe("listing text for selling", () => {
  it("drafts a title, description and price from the item, never its notes or serial — and saves nothing", async () => {
    const chat = new FakeAi([{ title: "DeWalt 20V drill DCD771", description: "Cordless drill in good condition.", price: 45.5, priceReasoning: "About half what it cost — a suggestion." }]);
    const { user, db } = await setup({ chat });
    const pat = await user("pat");
    const val = await user("val");
    const drill = await pat.addItem({ name: "Drill", brand: "DeWalt", model: "DCD771", condition: "good", purchasePriceCents: 9900, notes: "SECRETNOTE spare key under the mat", serialNumber: "SN-SECRET-1" });
    const before = await json<{ updatedAt: string }>(pat.as(`/api/v1/items/${drill.id}`));

    const draft = await json(pat.as(`/api/v1/items/${drill.id}/listing`, { method: "POST" }));
    expect(draft).toEqual({ title: "DeWalt 20V drill DCD771", description: "Cordless drill in good condition.", priceCents: 4550, priceReasoning: "About half what it cost — a suggestion." });
    const prompt = chat.calls[0]!.prompt;
    expect(prompt).toContain("Brand: DeWalt");
    expect(prompt).toContain("Paid new: 99.00 USD");
    expect(prompt).not.toContain("SECRETNOTE");
    expect(prompt).not.toContain("SN-SECRET-1");
    expect(await json<{ updatedAt: string }>(pat.as(`/api/v1/items/${drill.id}`))).toMatchObject({ updatedAt: before.updatedAt });

    // Viewers can't ask.
    const valId = (await db.query.user.findFirst({ where: (u, { eq }) => eq(u.name, "val") }))!.id;
    await db.insert(member).values({ id: crypto.randomUUID(), organizationId: pat.householdId, userId: valId, role: "viewer", createdAt: new Date() });
    expect((await val.as(`/api/v1/items/${drill.id}/listing`, { method: "POST", headers: { "X-Household-Id": pat.householdId } })).status).toBe(403);
  });

  it("answers 503 when the server has no text model", async () => {
    const { user } = await setup();
    const pat = await user("pat");
    const lamp = await pat.addItem({ name: "Lamp" });
    expect((await pat.as(`/api/v1/items/${lamp.id}/listing`, { method: "POST" })).status).toBe(503);
  });
});
