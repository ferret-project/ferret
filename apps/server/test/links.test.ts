/** Web links on items: http(s) only, replaced as a list, and found by search. */
import { describe, expect, it } from "vitest";
import { setup } from "./helpers";

describe("item links", () => {
  it("keeps web links on an item, refuses other schemes, and finds the item by the site", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    const drill = await ann.addItem({
      name: "Cordless drill",
      links: [{ url: "https://www.dewalt.com/product/dcd771c2", label: "Product page" }, { url: "http://192.168.1.50/" }],
    });
    const saved = (await (await ann.as(`/api/v1/items/${drill.id}`)).json()) as { links: unknown };
    expect(saved.links).toEqual([
      { url: "https://www.dewalt.com/product/dcd771c2", label: "Product page" },
      { url: "http://192.168.1.50/" },
    ]);

    for (const url of ["javascript:alert(1)", "data:text/html,hi", "ftp://example.com/x", "dewalt.com"]) {
      const res = await ann.as(`/api/v1/items/${drill.id}`, { method: "PATCH", body: JSON.stringify({ links: [{ url }] }) });
      expect(res.status, url).toBe(422);
    }

    // Found by the site's name.
    expect((await ann.search("dewalt.com")).data.map((i) => i.id)).toEqual([drill.id]);

    // A patch sets the whole list.
    const patched = await ann.as(`/api/v1/items/${drill.id}`, { method: "PATCH", body: JSON.stringify({ links: [{ url: "https://manuals.example/dcd771.pdf", label: "Manual" }] }) });
    expect(((await patched.json()) as { links: unknown }).links).toEqual([{ url: "https://manuals.example/dcd771.pdf", label: "Manual" }]);
    expect((await ann.search("dewalt.com")).data).toEqual([]);
  });
});
