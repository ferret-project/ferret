/** Collections (lib/collections.ts): things kept as a set, a template's fields as columns, and a want list. */
import type { CollectionSummary, ItemListing, ItemSearch, ItemTemplate, Overview } from "@ferret/shared";
import { describe, expect, it } from "vitest";
import { setup } from "./helpers";

type User = Awaited<ReturnType<Awaited<ReturnType<typeof setup>>["user"]>>;
const json = async <T>(res: Response | Promise<Response>) => (await (await res).json()) as T;
const send = (u: User, method: string, url: string, data?: object) => u.as(url, { method, ...(data ? { body: JSON.stringify(data) } : {}) });

describe("collections", () => {
  it("count what's owned, duplicates and the want list; wanted things stay out of what you own until you get them", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    const coin = await json<ItemTemplate>(send(ann, "POST", "/api/v1/templates", { name: "Coin", fields: [{ key: "year", label: "Year", type: "number" }] }));
    const morgans = await json<CollectionSummary>(send(ann, "POST", "/api/v1/collections", { name: "Morgan dollars", description: "1878–1921", templateId: coin.id }));
    expect(morgans).toMatchObject({ name: "Morgan dollars", owned: 0, wanted: 0 });

    const a = await ann.addItem({ name: "1881-S", collectionId: morgans.id, valueCents: 6000, purchasePriceCents: 4000, customFields: { year: 1881 } });
    await ann.addItem({ name: "1921", collectionId: morgans.id, quantity: 3, valueCents: 4000 });
    const key = await ann.addItem({ name: "1893-S", collectionId: morgans.id, wanted: true, valueCents: 500000 });
    // A thing added to the collection starts from its template.
    expect(await json<ItemListing>(ann.as(`/api/v1/items/${a.id}`))).toMatchObject({ collectionId: morgans.id, templateId: coin.id });

    const summary = await json<CollectionSummary>(ann.as(`/api/v1/collections/${morgans.id}`));
    expect(summary).toMatchObject({ owned: 2, pieces: 4, wanted: 1, valueCents: 6000 + 3 * 4000, costCents: 4000 });

    // The want list isn't owned: not in lists, totals or search — but the collection shows it when asked.
    const everything = await json<ItemSearch>(ann.as("/api/v1/items"));
    expect(everything.data.map((i) => i.name).sort()).toEqual(["1881-S", "1921"]);
    expect((await json<Overview>(ann.as("/api/v1/overview"))).total.items).toBe(2);
    expect((await ann.search("1893")).data).toEqual([]);
    const inIt = await json<ItemSearch>(ann.as(`/api/v1/items?collectionId=${morgans.id}&wanted=include`));
    expect(inIt.data.map((i) => i.name).sort()).toEqual(["1881-S", "1893-S", "1921"]);
    expect((await json<ItemSearch>(ann.as(`/api/v1/items?collectionId=${morgans.id}&wanted=only`))).data.map((i) => i.name)).toEqual(["1893-S"]);
    // Its own page still opens.
    expect((await ann.as(`/api/v1/items/${key.id}`)).status).toBe(200);

    // Got it.
    await send(ann, "PATCH", `/api/v1/items/${key.id}`, { wanted: false });
    expect(await json<CollectionSummary>(ann.as(`/api/v1/collections/${morgans.id}`))).toMatchObject({ owned: 3, wanted: 0 });
    const history = await json<{ data: { summary: string }[] }>(ann.as(`/api/v1/items/${key.id}/history`));
    expect(history.data.map((h) => h.summary).join(" ")).toContain("got it — off the want list");
    expect((await ann.search("Morgan")).data.map((i) => i.name)).toContain("1881-S"); // the collection's name is searchable
  });

  it("stay in their household; removing one keeps what you own and bins the want list", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    const bob = await user("bob");
    const dolls = await json<CollectionSummary>(send(ann, "POST", "/api/v1/collections", { name: "Barbies" }));
    expect((await send(bob, "POST", "/api/v1/items", { name: "x", collectionId: dolls.id })).status).toBe(404);
    expect((await bob.as(`/api/v1/collections/${dolls.id}`)).status).toBe(404);
    expect((await send(bob, "POST", "/api/v1/collections", { name: "Mine", templateId: "nope" })).status).toBe(404);

    const owned = await ann.addItem({ name: "Malibu Barbie", collectionId: dolls.id });
    const wanted = await ann.addItem({ name: "Totally Hair Barbie", collectionId: dolls.id, wanted: true });
    expect((await send(ann, "DELETE", `/api/v1/collections/${dolls.id}`)).status).toBe(204);
    expect(await json<ItemListing>(ann.as(`/api/v1/items/${owned.id}`))).toMatchObject({ collectionId: null });
    expect((await ann.as(`/api/v1/items/${wanted.id}`)).status).toBe(404);
    expect((await json<{ data: CollectionSummary[] }>(ann.as("/api/v1/collections"))).data).toEqual([]);
  });
});
