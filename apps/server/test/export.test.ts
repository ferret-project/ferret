/** The insurance export: rows for the report, and the CSV download. */
import type { ExportRow } from "@ferret/shared";
import { describe, expect, it } from "vitest";
import { pdf, photo, setup } from "./helpers";

type User = Awaited<ReturnType<Awaited<ReturnType<typeof setup>>["user"]>>;
const json = async <T>(res: Response | Promise<Response>) => (await (await res).json()) as T;
const send = (u: User, method: string, url: string, data?: object) =>
  u.as(url, { method, ...(data ? { body: JSON.stringify(data) } : {}) });

describe("insurance export", () => {
  it("lists every item with what an adjuster asks for, sorted by where it is", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    const home = await json<{ id: string }>(send(ann, "POST", "/api/v1/properties", { name: "Home" }));
    const cabin = await json<{ id: string }>(send(ann, "POST", "/api/v1/properties", { name: "Cabin" }));
    const den = await json<{ id: string }>(send(ann, "POST", "/api/v1/locations", { propertyId: home.id, name: "Den" }));
    const shed = await json<{ id: string }>(send(ann, "POST", "/api/v1/locations", { propertyId: cabin.id, name: "Shed" }));

    const tv = await ann.addItem({
      name: "TV",
      brand: "LG",
      model: "OLED65",
      serialNumber: "SN-1",
      locationId: den.id,
      valueCents: 150000,
      quantity: 1,
      tags: ["electronics"],
      notes: 'Mounted, "wall" bracket',
    });
    await ann.upload(tv.id, await photo(), "tv.png");
    await ann.upload(tv.id, pdf(), "receipt.pdf", "document");
    await send(ann, "POST", `/api/v1/items/${tv.id}/warranties`, { endsOn: "2028-05-01" });
    await ann.addItem({ name: "Chairs", locationId: den.id, purchasePriceCents: 5000, quantity: 4 });
    await ann.addItem({ name: "Kayak", locationId: shed.id, valueCents: 80000 });
    await ann.addItem({ name: "Moving box", isContainer: true, locationId: shed.id }); // packaging: left out
    await ann.addItem({ name: "=HYPERLINK(\"x\")" }); // no place: last

    const all = await json<{ data: ExportRow[] }>(ann.as("/api/v1/export/items.json"));
    expect(all.data.map((r) => r.name)).toEqual(["Kayak", "Chairs", "TV", '=HYPERLINK("x")']);
    expect(all.data.find((r) => r.name === "TV")).toMatchObject({
      place: "Home › Den",
      serialNumber: "SN-1",
      totalValueCents: 150000,
      photos: 1,
      documents: 1,
      warrantyEnds: "2028-05-01",
      tags: ["electronics"],
    });
    expect(all.data.find((r) => r.name === "Chairs")?.totalValueCents).toBe(20000);

    const homeOnly = await json<{ data: ExportRow[] }>(ann.as(`/api/v1/export/items.json?propertyId=${home.id}`));
    expect(homeOnly.data.map((r) => r.name)).toEqual(["Chairs", "TV"]);

    const csv = await ann.as("/api/v1/export/items.csv");
    expect(csv.headers.get("Content-Type")).toContain("text/csv");
    expect(csv.headers.get("Content-Disposition")).toMatch(/attachment; filename="ferret-inventory-\d{4}-\d{2}-\d{2}\.csv"/);
    const bytes = new Uint8Array(await csv.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // UTF-8 BOM, for Excel (text() would strip it)
    const text = new TextDecoder().decode(bytes);
    expect(text.startsWith("Item,Where,In box,Category")).toBe(true);
    const lines = text.trim().split("\r\n");
    expect(lines).toHaveLength(5);
    expect(lines.find((l) => l.startsWith("TV,"))).toContain('"Mounted, ""wall"" bracket"');
    expect(lines.find((l) => l.startsWith("TV,"))).toContain(",1500.00,1500.00,1,1,2028-05-01,electronics,");
    // A formula-looking name is defused for spreadsheets.
    expect(lines.at(-1)).toMatch(/^"'=HYPERLINK\(""x""\)"/);
  });

  it("only exports the caller's household", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    await ann.addItem({ name: "Ann's thing" });
    const bob = await user("bob");
    expect((await json<{ data: unknown[] }>(bob.as("/api/v1/export/items.json"))).data).toEqual([]);
    expect((await (await bob.as("/api/v1/export/items.csv")).text()).trim().split("\r\n")).toHaveLength(1);
  });
});
