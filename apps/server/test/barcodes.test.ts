/** Ferret's barcode books (each household's own, learned from its saved items) and the optional online product database. */
import type { AttentionItem, BarcodeLookupStatus, BarcodeMatch, ItemListing, ItemProduct } from "@ferret/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UpcItemDb } from "../src/adapters/local/upcitemdb";
import { FakeDownloader, FakeProducts, photo, setup } from "./helpers";

type User = Awaited<ReturnType<Awaited<ReturnType<typeof setup>>["user"]>>;
const json = async <T>(res: Response | Promise<Response>) => (await (await res).json()) as T;
const send = (u: User, method: string, url: string, data?: object) =>
  u.as(url, { method, ...(data ? { body: JSON.stringify(data) } : {}) });
const scan = (u: User, code: string) => json<{ match: BarcodeMatch | null; online: boolean }>(u.as(`/api/v1/barcodes/${code}`));

const MIXER = {
  title: "KitchenAid Artisan 5 Qt Stand Mixer",
  brand: "KitchenAid",
  model: "KSM150PSER",
  images: ["https://images.example/mixer.jpg"],
  typicalPriceCents: 37999,
};

afterEach(() => vi.restoreAllMocks());

describe("the barcode book", () => {
  it("learns from items a household saves, keeps it to that household, and outlives the items", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    const bob = await user("bob");

    const drill = await ann.addItem({ name: "Cordless drill", brand: "DeWalt", model: "DCD771C2", barcode: "0 12345 67890 1 2" });
    expect((await scan(ann, "0123456789012")).match).toMatchObject({ name: "Cordless drill", brand: "DeWalt", model: "DCD771C2", source: "ferret" });
    // What one household called its things never reaches another — and another can't rename it for them.
    expect(await scan(bob, "0123456789012")).toEqual({ match: null, online: false, have: [] });
    await bob.addItem({ name: "Something else", barcode: "0123456789012" });
    expect((await scan(ann, "0123456789012")).match?.name).toBe("Cordless drill");

    // Not a placeholder name; and a renamed item teaches the new name.
    await ann.addItem({ name: "New item", barcode: "9999999999994" });
    expect((await scan(ann, "9999999999994")).match).toBeNull();
    await send(ann, "PATCH", `/api/v1/items/${drill.id}`, { name: "Drill/driver" });
    await send(ann, "DELETE", `/api/v1/items/${drill.id}`);
    expect((await scan(ann, "0123456789012")).match?.name).toBe("Drill/driver");
  });

  it("asks the online database about codes nobody has named, once, and a saved name wins", async () => {
    const products = new FakeProducts({ "0050000000017": MIXER });
    const { user } = await setup({ products });
    const ann = await user("ann");

    const first = await scan(ann, "050000000017");
    expect(first).toMatchObject({ online: true, match: { name: MIXER.title, brand: "KitchenAid", source: "upcitemdb", typicalPriceCents: 37999 } });
    await scan(ann, "050000000017");
    expect(products.calls).toEqual(["0050000000017"]); // remembered

    expect((await scan(ann, "040000000018")).match).toBeNull();
    await scan(ann, "040000000018");
    expect(products.calls.filter((c) => c === "0040000000018")).toHaveLength(1); // "not known" is remembered too

    await ann.addItem({ name: "Red stand mixer", barcode: "050000000017" });
    const after = (await scan(ann, "050000000017")).match;
    expect(after).toMatchObject({ name: "Red stand mixer", source: "ferret", images: MIXER.images }); // keeps the photos
  });
});

describe("product suggestions on an item", () => {
  it("are looked up in the background, offered, dismissable, and a photo can be used", async () => {
    const products = new FakeProducts({ "0050000000017": MIXER });
    const downloader = new FakeDownloader();
    const { user, jobs } = await setup({ products, downloader });
    const ann = await user("ann");
    const mixer = await ann.addItem({ name: "Mixer", barcode: "050000000017" });

    expect((await json<ItemProduct>(ann.as(`/api/v1/items/${mixer.id}/product`))).status).toBe("pending");
    await jobs.drain();
    const found = await json<ItemProduct>(ann.as(`/api/v1/items/${mixer.id}/product`));
    expect(found).toMatchObject({ status: "found", product: { title: MIXER.title, model: "KSM150PSER" } });
    // Offered, not applied.
    expect((await json<ItemListing>(ann.as(`/api/v1/items/${mixer.id}`))).name).toBe("Mixer");

    // The photo comes through the guarded downloader (public internet only, photos only), not a plain fetch.
    const attached = await send(ann, "POST", `/api/v1/items/${mixer.id}/product/photo`, { index: 0 });
    expect(attached.status).toBe(502); // not on "the web" yet
    downloader.files.set("https://images.example/mixer.jpg", await photo());
    expect((await send(ann, "POST", `/api/v1/items/${mixer.id}/product/photo`, { index: 0 })).status).toBe(201);
    expect((await send(ann, "POST", `/api/v1/items/${mixer.id}/product/photo`, { index: 5 })).status).toBe(404);

    await send(ann, "POST", `/api/v1/items/${mixer.id}/product/dismiss`);
    expect((await json<ItemProduct>(ann.as(`/api/v1/items/${mixer.id}/product`))).status).toBe("dismissed");
  });

  it("are off without a product database", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    const it = await ann.addItem({ name: "Mixer", barcode: "050000000017" });
    expect((await json<ItemProduct>(ann.as(`/api/v1/items/${it.id}/product`))).status).toBe("off");
  });
});

describe("barcode spellings", () => {
  it("treats a 12-digit UPC-A and its 13-digit EAN-13 as one code", async () => {
    const products = new FakeProducts({ "0049000028911": { title: "Diet Coke 12-pack", images: [] } });
    const { user } = await setup({ products });
    const ann = await user("ann");
    expect((await scan(ann, "049000028911")).match?.name).toBe("Diet Coke 12-pack");
    expect((await scan(ann, "0049000028911")).match?.name).toBe("Diet Coke 12-pack");
    expect(products.calls).toEqual(["0049000028911"]); // one lookup for both

    await ann.addItem({ name: "Diet Coke", barcode: "049000028911" });
    const found = await json<{ data: { name: string }[] }>(ann.as("/api/v1/items?barcode=0049000028911"));
    expect(found.data.map((i) => i.name)).toEqual(["Diet Coke"]);
  });
});

describe("the online database's allowance (Settings → Server)", () => {
  it("is kept from the last lookup, shown to the server admin, and in their bell when it runs low", async () => {
    const products = new FakeProducts({ "0012345678905": MIXER });
    const { user } = await setup({ products });
    const admin = await user("ann"); // the first account
    const bob = await user("bob");
    const status = () => json<BarcodeLookupStatus>(admin.as("/api/v1/server/barcode-lookups"));
    expect(await status()).toEqual({ on: true, quota: null });
    expect((await bob.as("/api/v1/server/barcode-lookups")).status).toBe(403);

    const later = new Date(Date.now() + 3 * 3600_000);
    products.allowance = { limit: 100, remaining: 63, resetsAt: later };
    await scan(admin, "012345678905");
    expect((await status()).quota).toMatchObject({ limit: 100, remaining: 63, resetsAt: later.toISOString() });
    const bell = async (u: User) => (await json<{ data: AttentionItem[] }>(u.as("/api/v1/attention"))).data.filter((a) => a.id === "service:barcode-quota");
    expect(await bell(admin)).toEqual([]);

    // Used up (the lookup is refused): urgent, for the admin only.
    products.allowance = { limit: 100, remaining: 0, resetsAt: later };
    vi.spyOn(products, "lookup").mockRejectedValueOnce(new Error("UPCitemdb 429 (daily limit reached)"));
    await scan(admin, "0098765432109");
    expect(await bell(admin)).toEqual([expect.objectContaining({ severity: "urgent", title: "Online barcode lookups are used up" })]);
    expect(await bell(bob)).toEqual([]);
  });

  it("counts as full again once its reset time has passed", async () => {
    const products = new FakeProducts({ "0012345678905": MIXER });
    const { user } = await setup({ products });
    const admin = await user("ann");
    products.allowance = { limit: 100, remaining: 0, resetsAt: new Date(Date.now() - 1000) };
    await scan(admin, "012345678905");
    expect((await json<BarcodeLookupStatus>(admin.as("/api/v1/server/barcode-lookups"))).quota).toMatchObject({ remaining: 100 });
  });

  it("is off where there's no online database", async () => {
    const { user } = await setup();
    const admin = await user("ann");
    expect(await json<BarcodeLookupStatus>(admin.as("/api/v1/server/barcode-lookups"))).toEqual({ on: false, quota: null });
  });

  it("is read from UPCitemdb's rate-limit headers, a refusal included", async () => {
    const reset = Math.floor(Date.now() / 1000) + 3600;
    const headers = (remaining: number) => ({ "x-ratelimit-limit": "100", "x-ratelimit-remaining": String(remaining), "x-ratelimit-reset": String(reset) });
    const fetch = vi.spyOn(globalThis, "fetch");
    const db = new UpcItemDb();
    expect(db.quota()).toBeNull();
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ code: "OK", items: [] }), { headers: headers(41) }));
    await db.lookup("0012345678905");
    expect(db.quota()).toEqual({ limit: 100, remaining: 41, resetsAt: new Date(reset * 1000) });
    fetch.mockResolvedValueOnce(new Response("{}", { status: 429, headers: headers(0) }));
    await expect(db.lookup("0012345678905")).rejects.toThrow("daily limit reached");
    expect(db.quota()?.remaining).toBe(0);
  });
});
