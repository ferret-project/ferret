/** Item templates (lib/templates.ts): kinds of thing with their own fields — coins, trading cards, dolls. */
import type { ItemListing, ItemTemplate } from "@ferret/shared";
import { describe, expect, it } from "vitest";
import { setup } from "./helpers";

type User = Awaited<ReturnType<Awaited<ReturnType<typeof setup>>["user"]>>;
const json = async <T>(res: Response | Promise<Response>) => (await (await res).json()) as T;
const send = (u: User, method: string, url: string, data?: object) => u.as(url, { method, ...(data ? { body: JSON.stringify(data) } : {}) });

describe("item templates", () => {
  it("have their own fields; things made from one start in its category with its tags, and are found by their values", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    const coins = await json<{ id: string }>(send(ann, "POST", "/api/v1/categories", { name: "Coins" }));
    const coin = await json<ItemTemplate>(
      send(ann, "POST", "/api/v1/templates", {
        name: "Coin",
        categoryId: coins.id,
        tags: ["Coin collection"],
        fields: [
          { key: "year", label: "Year", type: "number" },
          { key: "mint_mark", label: "Mint mark", type: "text" },
          { key: "grade", label: "Grade", type: "choice", options: ["MS-63", "MS-65"] },
        ],
      }),
    );
    expect(coin).toMatchObject({ name: "Coin", categoryId: coins.id, tags: ["Coin collection"], itemCount: 0 });

    const dollar = await ann.addItem({ name: "1881-S Morgan dollar", templateId: coin.id, customFields: { year: 1881, mint_mark: "S", grade: "MS-65" } });
    const got = await json<ItemListing>(ann.as(`/api/v1/items/${dollar.id}`));
    expect(got).toMatchObject({ templateId: coin.id, categoryId: coins.id, tags: ["Coin collection"] });
    expect((await ann.search("mint mark S")).data.map((i) => i.name)).toContain("1881-S Morgan dollar");

    // A category or tags given win over the template's.
    const other = await ann.addItem({ name: "Odd coin", templateId: coin.id, categoryId: null, tags: ["Loose change"] });
    expect(await json<ItemListing>(ann.as(`/api/v1/items/${other.id}`))).toMatchObject({ categoryId: null, tags: ["Loose change"] });

    const list = await json<{ data: ItemTemplate[] }>(ann.as("/api/v1/templates"));
    expect(list.data).toEqual([expect.objectContaining({ id: coin.id, itemCount: 2 })]);

    // Removed: its things keep their values.
    expect((await send(ann, "DELETE", `/api/v1/templates/${coin.id}`)).status).toBe(204);
    expect(await json<ItemListing>(ann.as(`/api/v1/items/${dollar.id}`))).toMatchObject({ templateId: null, customFields: { year: 1881, mint_mark: "S" } });
  });

  it("stay in their household, check their fields, and come as a starter set", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    const bob = await user("bob");
    const mine = await json<ItemTemplate>(send(ann, "POST", "/api/v1/templates", { name: "Stamp", fields: [] }));
    expect((await send(bob, "POST", "/api/v1/items", { name: "x", templateId: mine.id })).status).toBe(404);
    expect((await bob.as(`/api/v1/templates/${mine.id}`)).status).toBe(404);
    const twice = await send(ann, "POST", "/api/v1/templates", { name: "Bad", fields: [{ key: "a", label: "A", type: "text" }, { key: "a", label: "B", type: "text" }] });
    expect(twice.status).toBe(422);
    expect((await send(ann, "POST", "/api/v1/templates", { name: "Bad", fields: [{ key: "g", label: "Grade", type: "choice" }] })).status).toBe(422);

    await send(ann, "POST", "/api/v1/categories/starter");
    const starter = await json<{ data: ItemTemplate[] }>(send(ann, "POST", "/api/v1/templates/starter"));
    const names = starter.data.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["Coin", "Trading card", "Doll", "Toy or action figure", "Comic book", "Vinyl record", "LEGO set", "Stamp"]));
    expect(names.filter((n) => n === "Stamp")).toHaveLength(1); // the one already there stays, once
    expect(starter.data.find((t) => t.name === "Coin")!.categoryId).not.toBeNull(); // in Art & collectibles
  });
});
