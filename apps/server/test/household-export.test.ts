/** "Download everything": a household's data and files as a ZIP — complete, decrypted, its own household only. */
import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { member } from "../src/db/schema";
import { pdf, setup } from "./helpers";

const PHOTO = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new TextEncoder().encode("drill photo")]);
const RECEIPT = pdf("DeWalt receipt $129.00");
const json = async <T>(res: Response | Promise<Response>) => (await (await res).json()) as T;
type Export = {
  format: string;
  version: number;
  household: { name: string };
  places: { name: string; path: string; label: string | null }[];
  categories: { path: string }[];
  tags: string[];
  providers: { name: string }[];
  items: {
    name: string;
    place: string | null;
    category: string | null;
    inBoxId: string | null;
    isBox: boolean;
    tags: string[];
    files: { filename: string; file: string; kind: string }[];
    warranties: { endsOn: string; claims: { problem: string; status: string }[] }[];
  }[];
  maintenance: { title: string; repeats: { every: number; unit: string } | null; history: { doneOn: string; by: string; provider: string | null; costCents: number }[] }[];
};

async function household() {
  const t = await setup();
  const ann = await t.user("ann");
  const bob = await t.user("bob");
  const send = <T = { id: string }>(method: string, url: string, body?: object) =>
    json<T>(ann.as(url, { method, ...(body ? { body: JSON.stringify(body) } : {}) }));
  const house = await send("POST", "/api/v1/properties", { name: "Highland House" });
  const garage = await send("POST", "/api/v1/locations", { propertyId: house.id, name: "Garage" });
  const shelf = await send("POST", "/api/v1/locations", { propertyId: house.id, parentId: garage.id, name: "Shelf 2" });
  const tools = await send("POST", "/api/v1/categories", { name: "Tools" });
  const box = await ann.addItem({ name: "Red toolbox", isContainer: true, locationId: shelf.id });
  const drill = await ann.addItem({ name: "Cordless drill", brand: "DeWalt", containerItemId: box.id, categoryId: tools.id, tags: ["Power tools"] });
  await ann.addItem({ name: "Cordless drill", brand: "Ryobi" }); // same name: its own folder
  await ann.upload(drill.id, PHOTO, "drill.png");
  await ann.upload(drill.id, PHOTO, "drill.png"); // same file name twice
  await ann.upload(drill.id, RECEIPT, "receipt: DeWalt/2024.pdf", "document");
  const w = await send("POST", `/api/v1/items/${drill.id}/warranties`, { endsOn: "2029-05-01", provider: "DeWalt" });
  await send("POST", `/api/v1/warranties/${w.id}/claims`, { problem: "Chuck slips" });
  const plumber = await send("POST", "/api/v1/providers", { name: "Ace Repairs" });
  const task = await send("POST", "/api/v1/maintenance", { title: "Oil the chuck", itemId: drill.id, dueOn: "2026-01-15", intervalCount: 6, intervalUnit: "month" });
  await send("POST", `/api/v1/maintenance/${task.id}/done`, { doneOn: "2026-01-20", providerId: plumber.id, costCents: 2500 });
  const gone = await ann.addItem({ name: "Broken kettle" });
  await ann.as(`/api/v1/items/${gone.id}`, { method: "DELETE" });
  await bob.addItem({ name: "Bob's secret safe" });
  return { ...t, ann, bob, drill };
}

const download = async (as: (url: string) => Response | Promise<Response>) => {
  const res = await as("/api/v1/export/everything.zip");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("application/zip");
  return { res, zip: unzipSync(new Uint8Array(await res.arrayBuffer())) };
};

describe("download everything", () => {
  it("has the household's data, its files decrypted, and nothing else", async () => {
    const { ann } = await household();
    const { res, zip } = await download(ann.as);
    const root = `ferret-export-ann-home-`;
    expect(res.headers.get("content-disposition")).toMatch(new RegExp(`attachment; filename="${root}\\d{4}-\\d{2}-\\d{2}\\.zip"`));
    const names = Object.keys(zip).map((n) => n.replace(/^ferret-export-ann-home-[\d-]+\//, "")).sort();
    expect(names).toEqual([
      "README.txt",
      "ferret.json",
      "files/Cordless drill/drill (2).png",
      "files/Cordless drill/drill.png",
      "files/Cordless drill/receipt_ DeWalt_2024.pdf",
      "items.csv",
    ].sort());
    const file = (suffix: string) => zip[Object.keys(zip).find((n) => n.endsWith(suffix))!]!;
    expect(file("drill.png")).toEqual(PHOTO);
    expect(file("2024.pdf")).toEqual(RECEIPT);

    const data = JSON.parse(new TextDecoder().decode(file("ferret.json"))) as Export;
    expect(data).toMatchObject({ format: "ferret-export", version: 1, household: { name: "ann home" }, tags: ["Power tools"], providers: [{ name: "Ace Repairs" }] });
    expect(data.places.map((p) => p.path)).toEqual(["Highland House › Garage", "Highland House › Garage › Shelf 2"]);
    expect(data.items.map((i) => i.name)).toEqual(["Cordless drill", "Cordless drill", "Red toolbox"]); // not the deleted kettle, not Bob's
    const drill = data.items.find((i) => i.files.length)!;
    const box = data.items.find((i) => i.isBox)!;
    expect(drill).toMatchObject({ place: "Highland House › Garage › Shelf 2", category: "Tools", tags: ["Power tools"], inBoxId: expect.any(String) });
    expect(drill.files.map((f) => [f.filename, f.kind, f.file])).toEqual([
      ["drill.png", "photo", "files/Cordless drill/drill.png"],
      ["drill.png", "photo", "files/Cordless drill/drill (2).png"],
      ["receipt: DeWalt_2024.pdf", "document", "files/Cordless drill/receipt_ DeWalt_2024.pdf"],
    ]);
    expect(Object.keys(zip).some((n) => n.endsWith(drill.files[0]!.file))).toBe(true);
    expect(box.isBox).toBe(true);
    expect(drill.warranties).toEqual([expect.objectContaining({ endsOn: "2029-05-01", claims: [expect.objectContaining({ problem: "Chuck slips", status: "filed" })] })]);
    expect(data.maintenance).toEqual([
      expect.objectContaining({ title: "Oil the chuck", repeats: { every: 6, unit: "month" }, history: [{ doneOn: "2026-01-20", by: "ann", provider: "Ace Repairs", note: null, costCents: 2500 }] }),
    ]);

    const csv = new TextDecoder().decode(file("items.csv"));
    expect(csv).toContain("Cordless drill");
    expect(csv).not.toContain("Bob's secret safe");
    expect(JSON.stringify(data)).not.toContain("Bob's secret safe");
  });

  it("is for the household's owner and admins, signed in — not members or API keys", async () => {
    const { db, ann, bob } = await household();
    const bobId = (await db.query.user.findFirst({ where: (u, { eq }) => eq(u.name, "bob") }))!.id;
    await db.insert(member).values({ id: crypto.randomUUID(), organizationId: ann.householdId, userId: bobId, role: "member", createdAt: new Date() });
    expect((await bob.as("/api/v1/export/everything.zip", { headers: { "X-Household-Id": ann.householdId } })).status).toBe(403);

    const key = await json<{ key: string }>(ann.as("/api/v1/api-keys", { method: "POST", body: JSON.stringify({ name: "script" }) }));
    expect((await ann.as("/api/v1/export/everything.zip", { headers: { Cookie: "", Authorization: `Bearer ${key.key}` } })).status).toBe(403);

    // Bob's own household: his, and only his.
    const { zip } = await download(bob.as);
    const data = JSON.parse(new TextDecoder().decode(zip[Object.keys(zip).find((n) => n.endsWith("ferret.json"))!]!)) as Export;
    expect(data.items.map((i) => i.name)).toEqual(["Bob's secret safe"]);
  });
});
