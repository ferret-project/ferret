/** Categories (nested, with extra fields) and tags (collections). */
import type { CategoryNode, ItemListing, ItemSearch, Overview, TagSummary } from "@ferret/shared";
import { describe, expect, it } from "vitest";
import { photo, setup } from "./helpers";

type User = Awaited<ReturnType<Awaited<ReturnType<typeof setup>>["user"]>>;
const json = async <T>(res: Response | Promise<Response>) => (await (await res).json()) as T;
const send = (u: User, method: string, url: string, data?: object) =>
  u.as(url, { method, ...(data ? { body: JSON.stringify(data) } : {}) });

describe("categories", () => {
  it("show a photo from inside them — their own things', else a subcategory's", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    const kitchen = await json<{ id: string }>(send(ann, "POST", "/api/v1/categories", { name: "Kitchen" }));
    const pans = await json<{ id: string }>(send(ann, "POST", "/api/v1/categories", { name: "Pans", parentId: kitchen.id }));
    const empty = await json<{ id: string }>(send(ann, "POST", "/api/v1/categories", { name: "Knives", parentId: kitchen.id }));
    const wok = await ann.addItem({ name: "Wok", categoryId: pans.id });
    const shot = await ann.upload(wok.id, await photo(), "wok.png");
    const tree = (await json<{ data: CategoryNode[] }>(ann.as("/api/v1/categories"))).data;
    const top = tree.find((c) => c.id === kitchen.id)!;
    expect(top.photoId).toBe(shot.id);
    expect(top.children.find((c) => c.id === pans.id)!.photoId).toBe(shot.id);
    expect(top.children.find((c) => c.id === empty.id)!.photoId).toBeNull();
  });

  it("nest, carry extra fields, filter lists (with subcategories) and add up in the report", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    const electronics = await json<{ id: string }>(
      send(ann, "POST", "/api/v1/categories", { name: "Electronics", fields: [{ key: "screen_size", label: "Screen size", type: "number", unit: "in" }] }),
    );
    const tvs = await json<{ id: string }>(send(ann, "POST", "/api/v1/categories", { name: "TVs", parentId: electronics.id }));
    const tv = await ann.addItem({ name: "Living room TV", categoryId: tvs.id, customFields: { screen_size: 65 }, valueCents: 90000 });
    await ann.addItem({ name: "Laptop", categoryId: electronics.id, valueCents: 120000 });
    await ann.addItem({ name: "Couch", valueCents: 50000 });

    const tree = await json<{ data: CategoryNode[] }>(ann.as("/api/v1/categories"));
    expect(tree.data[0]).toMatchObject({ name: "Electronics", itemCount: 1, children: [{ name: "TVs", path: "Electronics › TVs", itemCount: 1 }] });

    const inElectronics = await json<ItemSearch>(ann.as(`/api/v1/items?categoryId=${electronics.id}`));
    expect(inElectronics.data.map((i) => i.name).sort()).toEqual(["Laptop", "Living room TV"]);
    expect((await json<ItemListing>(ann.as(`/api/v1/items/${tv.id}`))).category).toBe("Electronics › TVs");

    // Search reads the category and the extra fields.
    expect((await ann.search("electronics")).data.map((i) => i.name).sort()).toEqual(["Laptop", "Living room TV"]);
    expect((await ann.search("screen size 65")).data.map((i) => i.name)).toEqual(["Living room TV"]);

    const o = await json<Overview>(ann.as("/api/v1/overview"));
    expect(o.byCategory.map((g) => [g.name, g.valueCents])).toEqual([
      ["Electronics", 210000],
      ["No category", 50000],
    ]);
    expect(o.missing.category).toBe(1);

    // Removing a category moves its items and subcategories up a level; it can't go inside itself.
    expect((await send(ann, "PATCH", `/api/v1/categories/${electronics.id}`, { parentId: tvs.id })).status).toBe(422);
    expect((await send(ann, "DELETE", `/api/v1/categories/${tvs.id}`)).status).toBe(204);
    expect((await json<ItemListing>(ann.as(`/api/v1/items/${tv.id}`))).category).toBe("Electronics");
  });

  it("offers a starter set once, and keeps households apart", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    const bob = await user("bob");
    const starter = await json<{ data: CategoryNode[] }>(send(ann, "POST", "/api/v1/categories/starter"));
    expect(starter.data.map((c) => c.name)).toContain("Appliances");
    expect((await send(ann, "POST", "/api/v1/categories/starter")).status).toBe(409);

    expect((await json<{ data: unknown[] }>(bob.as("/api/v1/categories"))).data).toEqual([]);
    const annsCategory = starter.data[0]!.id;
    expect((await send(bob, "POST", "/api/v1/items", { name: "x", categoryId: annsCategory })).status).toBe(404);
    expect((await send(bob, "DELETE", `/api/v1/categories/${annsCategory}`)).status).toBe(404);
  });
});

describe("tags", () => {
  it("are set by name, case-insensitively, and work as collections", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    const tent = await ann.addItem({ name: "Tent", tags: ["Camping", "summer"] });
    await ann.addItem({ name: "Stove", tags: ["camping"] });
    await ann.addItem({ name: "Lights", tags: ["Christmas"] });

    expect((await json<ItemListing>(ann.as(`/api/v1/items/${tent.id}`))).tags).toEqual(["Camping", "summer"]);
    const tags = await json<{ data: TagSummary[] }>(ann.as("/api/v1/tags"));
    expect(tags.data.map((t) => [t.name, t.items])).toEqual([
      ["Camping", 2],
      ["Christmas", 1],
      ["summer", 1],
    ]);

    // A tag is a collection: list it, any case. Search finds by tag too.
    const camping = await json<ItemSearch>(ann.as("/api/v1/items?tag=CAMPING"));
    expect(camping.data.map((i) => i.name).sort()).toEqual(["Stove", "Tent"]);
    expect((await json<ItemSearch>(ann.as("/api/v1/items?tag=nothing"))).total).toBe(0);
    expect((await ann.search("christmas")).data.map((i) => i.name)).toEqual(["Lights"]);

    // A patch replaces the set; other fields stay.
    const patched = await json<ItemListing>(send(ann, "PATCH", `/api/v1/items/${tent.id}`, { tags: ["camping"] }));
    expect(patched).toMatchObject({ name: "Tent", tags: ["Camping"] });

    // Renaming onto another tag merges them.
    const summer = tags.data.find((t) => t.name === "summer")!;
    await send(ann, "PATCH", `/api/v1/tags/${summer.id}`, { name: "Christmas" });
    const merged = await json<{ data: TagSummary[] }>(ann.as("/api/v1/tags"));
    expect(merged.data.map((t) => t.name)).toEqual(["Camping", "Christmas"]);

    const christmas = merged.data.find((t) => t.name === "Christmas")!;
    expect((await send(ann, "DELETE", `/api/v1/tags/${christmas.id}`)).status).toBe(204);
    expect((await json<ItemSearch>(ann.as("/api/v1/items?tag=christmas"))).total).toBe(0);
  });
});
