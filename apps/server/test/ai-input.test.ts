import { describe, expect, it } from "vitest";
import { FakeAi, FakeDocuments, pdf, setup } from "./helpers";

type J = Record<string, unknown>;
const json = async <T = J>(r: Response | Promise<Response>) => (await (await r).json()) as T;
const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });

describe("a thing described in words", () => {
  it("reads its fields, with places, boxes, categories and tags only from the household's own", async () => {
    const chat = new FakeAi([
      {
        name: "Cordless drill",
        brand: "DeWalt",
        model: "DCD771",
        serialNumber: null,
        quantity: 1,
        place: "Garage › Top shelf",
        box: null,
        category: "power tools",
        tags: ["Dad's", "made up"],
        value: null,
        purchaseDate: "2026-03-01",
        purchasePrice: 129,
        description: "Yellow, with two batteries",
        isBox: false,
      },
    ]);
    const { user } = await setup({ chat });
    const pat = await user("pat");
    const tools = await json<{ id: string }>(pat.as("/api/v1/categories", post({ name: "Tools" })));
    const power = await json<{ id: string }>(pat.as("/api/v1/categories", post({ name: "Power tools", parentId: tools.id })));
    const home = await json<{ id: string }>(pat.as("/api/v1/properties", post({ name: "Home" })));
    const garage = await json<{ id: string }>(pat.as("/api/v1/locations", post({ name: "Garage", propertyId: home.id })));
    const shelf = await json<{ id: string }>(pat.as("/api/v1/locations", post({ name: "Top shelf", propertyId: home.id, parentId: garage.id })));
    await pat.addItem({ name: "Thing", tags: ["Dad's"] });

    const draft = await json(pat.as("/api/v1/items/from-text", post({ text: "dewalt drill DCD771 top shelf in the garage bought in march for 129 yellow two batteries dad's" })));
    expect(draft).toMatchObject({
      name: "Cordless drill",
      brand: "DeWalt",
      model: "DCD771",
      quantity: null,
      locationId: shelf.id,
      place: "Home › Garage › Top shelf",
      containerItemId: null,
      categoryId: power.id,
      category: "Tools › Power tools",
      tags: ["Dad's"],
      purchaseDate: "2026-03-01",
      purchasePriceCents: 12900,
      description: "Yellow, with two batteries",
      isContainer: false,
    });
    expect(chat.calls[0]!.prompt).toContain("- Home › Garage › Top shelf");
    // Nothing was added.
    expect((await json<{ data: unknown[] }>(pat.as("/api/v1/items"))).data).toHaveLength(1);
  });

  it("puts it in a box it names, and leaves out a place that isn't theirs", async () => {
    const chat = new FakeAi([{ name: "Lamp", place: "The attic", box: "Winter box", category: null, tags: [], isBox: false }]);
    const { user } = await setup({ chat });
    const pat = await user("pat");
    const box = await pat.addItem({ name: "Winter box", isContainer: true });
    const draft = await json(pat.as("/api/v1/items/from-text", post({ text: "a lamp in the winter box in the attic" })));
    expect(draft).toMatchObject({ name: "Lamp", locationId: null, place: null, containerItemId: box.id, box: "Winter box" });
  });

  it("needs a writer and a text model", async () => {
    const { user } = await setup();
    const pat = await user("pat");
    expect((await pat.as("/api/v1/items/from-text", post({ text: "a lamp" }))).status).toBe(503);
  });
});

const receipt = {
  description: "Costco receipt.",
  text: "",
  name: "Stand mixer",
  brand: "KitchenAid",
  purchaseDate: "2026-11-01",
  purchasePrice: 299.99,
  returnBy: "2099-01-30",
  category: "Kitchen",
  lines: [
    { name: "Stand mixer", brand: "KitchenAid", model: null, quantity: 1, price: 299.99 },
    { name: "Air fryer", brand: "Ninja", model: "AF101", quantity: 1, price: 89.99 },
    { name: "Bath towel", brand: null, model: null, quantity: 4, price: 12.5 },
  ],
  sure: [],
};

describe("a receipt with several things on it", () => {
  it("adds the ones a person ticks, each with a copy of the receipt, then doesn't offer them again", async () => {
    const chat = new FakeAi([receipt]);
    const { user, jobs } = await setup({ chat, documents: new FakeDocuments(["COSTCO\nKITCHENAID MIXER 299.99\nNINJA AF101 89.99\nTOWEL 4 @ 12.50"]) });
    const pat = await user("pat");
    const kitchen = await json<{ id: string }>(pat.as("/api/v1/categories", post({ name: "Kitchen" })));
    const home = await json<{ id: string }>(pat.as("/api/v1/properties", post({ name: "Home" })));
    const room = await json<{ id: string }>(pat.as("/api/v1/locations", post({ name: "Kitchen", propertyId: home.id })));
    const mixer = await pat.addItem({ name: "Mixer", locationId: room.id });
    await pat.upload(mixer.id, pdf(), "costco.pdf", "document");
    await jobs.drain();
    const [file] = await pat.attachments(mixer.id);
    const suggestions = (file!.analysis as { suggestions: { lines: unknown[]; categoryId: string } }).suggestions;
    expect(suggestions.lines).toHaveLength(3);
    expect(suggestions.categoryId).toBe(kitchen.id);

    const added = await pat.as(
      `/api/v1/attachments/${file!.id}/lines`,
      post({ lines: [{ name: "Air fryer", brand: "Ninja", model: "AF101", quantity: 1, priceCents: 8999, categoryId: kitchen.id }, { name: "Bath towel", quantity: 4, priceCents: 1250 }] }),
    );
    expect(added.status).toBe(201);
    const { items } = (await added.json()) as { items: { id: string; name: string }[] };
    expect(items.map((i) => i.name)).toEqual(["Air fryer", "Bath towel"]);
    const fryer = await json(pat.as(`/api/v1/items/${items[0]!.id}`));
    expect(fryer).toMatchObject({ brand: "Ninja", model: "AF101", purchaseDate: "2026-11-01", purchasePriceCents: 8999, returnBy: "2099-01-30", categoryId: kitchen.id, locationId: room.id, origin: "receipt" });
    expect((await json(pat.as(`/api/v1/items/${items[1]!.id}`))).quantity).toBe(4);
    // Each has the receipt, already read (found by its words), and isn't read by the model again.
    const copies = await pat.attachments(items[0]!.id);
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatchObject({ filename: "costco.pdf", analysisStatus: "done" });
    await jobs.drain();
    expect(chat.calls).toHaveLength(1);
    expect((await pat.search("NINJA")).data.map((i) => i.name)).toContain("Air fryer");

    // Offered once.
    const [after] = await pat.attachments(mixer.id);
    expect((after!.analysis as { suggestions: { linesHandled?: boolean } }).suggestions.linesHandled).toBe(true);
    expect((await pat.as(`/api/v1/attachments/${file!.id}/lines`, post({ lines: [{ name: "Again" }] }))).status).toBe(409);
  });

  it("makes the receipt's own New item the first line, when it was photographed on its own", async () => {
    const chat = new FakeAi([{ ...receipt, name: null, brand: null, purchasePrice: null }]);
    const { user, jobs } = await setup({ chat, documents: new FakeDocuments(["COSTCO"]) });
    const pat = await user("pat");
    const thing = await pat.addItem({ name: "New item" });
    await pat.upload(thing.id, pdf(), "costco.pdf", "document");
    await jobs.drain();
    const [file] = await pat.attachments(thing.id);
    const { items } = await json<{ items: { id: string; name: string }[] }>(
      pat.as(`/api/v1/attachments/${file!.id}/lines`, post({ intoItem: true, lines: [{ name: "Stand mixer", brand: "KitchenAid", priceCents: 29999 }, { name: "Air fryer", priceCents: 8999 }] })),
    );
    expect(items.map((i) => i.name)).toEqual(["Stand mixer", "Air fryer"]);
    expect(items[0]!.id).toBe(thing.id);
    expect(await json(pat.as(`/api/v1/items/${thing.id}`))).toMatchObject({ name: "Stand mixer", brand: "KitchenAid", purchasePriceCents: 29999, purchaseDate: "2026-11-01" });
    expect(await pat.attachments(thing.id)).toHaveLength(1); // it has the receipt already
    expect(await pat.attachments(items[1]!.id)).toHaveLength(1);
  });

  it("can be told not these", async () => {
    const chat = new FakeAi([receipt]);
    const { user, jobs } = await setup({ chat, documents: new FakeDocuments(["COSTCO"]) });
    const pat = await user("pat");
    const mixer = await pat.addItem({ name: "Mixer" });
    await pat.upload(mixer.id, pdf(), "costco.pdf", "document");
    await jobs.drain();
    const [file] = await pat.attachments(mixer.id);
    expect((await pat.as(`/api/v1/attachments/${file!.id}/lines`, { method: "DELETE" })).status).toBe(204);
    const [after] = await pat.attachments(mixer.id);
    expect((after!.analysis as { suggestions: { lines?: unknown; brand?: string } }).suggestions).toMatchObject({ brand: "KitchenAid" });
    expect((after!.analysis as { suggestions: { linesHandled?: boolean } }).suggestions.linesHandled).toBe(true);
  });
});

describe("estimates for many things at once, and To confirm", () => {
  it("asks for the things with no value, lists the answers to confirm, and forgets one that's dismissed", async () => {
    const chat = new FakeAi([{ amount: 250, reasoning: "About $250 new — an estimate." }]);
    const { user, jobs } = await setup({ chat });
    const pat = await user("pat");
    const lamp = await pat.addItem({ name: "Lamp" });
    const chair = await pat.addItem({ name: "Chair" });
    await pat.addItem({ name: "Drill", purchasePriceCents: 12900 }); // has a price: not asked
    await pat.addItem({ name: "Box", isContainer: true }); // a box: not asked

    const asked = await pat.as("/api/v1/replacement-estimates", post({ missing: "value" }));
    expect(asked.status).toBe(202);
    expect(await asked.json()).toEqual({ queued: 2, skipped: 0 });
    await jobs.drain();
    expect(chat.calls).toHaveLength(2);

    const waiting = await json<{ estimates: { itemId: string; cents: number }[]; counts: Record<string, number> }>(pat.as("/api/v1/to-confirm"));
    expect(waiting.estimates.map((e) => e.itemId).sort()).toEqual([lamp.id, chair.id].sort());
    expect(waiting.estimates[0]!.cents).toBe(25000);
    const bell = await json<{ data: { id: string; title: string; href?: string }[] }>(pat.as("/api/v1/attention"));
    expect(bell.data.find((b) => b.id === "ai-filled")).toMatchObject({ title: "2 AI suggestions to confirm", href: "#/to-confirm" });

    // Used (a person sets the replacement cost) or dismissed: off the list. Asking again skips what's answered.
    await pat.as(`/api/v1/items/${lamp.id}`, { method: "PATCH", body: JSON.stringify({ replacementCents: 25000 }) });
    expect((await pat.as(`/api/v1/items/${chair.id}/replacement-estimate`, { method: "DELETE" })).status).toBe(204);
    expect((await json<{ estimates: unknown[] }>(pat.as("/api/v1/to-confirm"))).estimates).toEqual([]);
    expect(await json(pat.as("/api/v1/replacement-estimates", post({ itemIds: [lamp.id] })))).toEqual({ queued: 1, skipped: 0 });
  });

  it("lists things whose photos say something they don't, until applied or dismissed", async () => {
    const ai = new FakeAi([{ description: "A drill.", text: "DEWALT DCD771", name: "Cordless drill", brand: "DeWalt", model: "DCD771", sure: [] }]);
    const { user, jobs } = await setup({ ai });
    const pat = await user("pat");
    const named = await pat.addItem({ name: "Dad's drill" });
    const { photo } = await import("./helpers");
    await pat.upload(named.id, await photo(), "drill.jpg");
    await jobs.drain();
    const list = await json<{ items: { item: { id: string }; attachments: { id: string }[] }[] }>(pat.as("/api/v1/to-confirm"));
    expect(list.items.map((i) => i.item.id)).toEqual([named.id]);
    expect(list.items[0]!.attachments).toHaveLength(1);

    // Applying what it read: nothing new left (its name for it isn't news for a thing someone named).
    await pat.as(`/api/v1/items/${named.id}`, { method: "PATCH", body: JSON.stringify({ brand: "DeWalt", model: "DCD771" }) });
    expect((await json<{ items: unknown[] }>(pat.as("/api/v1/to-confirm"))).items).toEqual([]);
  });
});
