/** "Scan music": CDs and records by barcode from MusicBrainz (lib/products.ts, adapters/local/musicbrainz.ts). */
import type { BarcodeMatch, MusicLookupStatus, ProductInfo } from "@ferret/shared";
import { describe, expect, it } from "vitest";
import { MusicBrainzReleases, formatOf, pickRelease } from "../src/adapters/local/musicbrainz";
import type { ProductLookup } from "../src/ports";
import { FakeProducts, setup } from "./helpers";

type User = Awaited<ReturnType<Awaited<ReturnType<typeof setup>>["user"]>>;
const json = async <T>(res: Response | Promise<Response>) => (await (await res).json()) as T;
const send = (u: User, method: string, url: string, data?: object) => u.as(url, { method, ...(data ? { body: JSON.stringify(data) } : {}) });
const scan = (u: User, code: string, as?: "music") =>
  json<{ match: BarcodeMatch | null; online: boolean }>(u.as(`/api/v1/barcodes/${code}${as ? `?as=${as}` : ""}`));
const features = async (u: User) => (await json<{ features: { music: boolean } }>(u.as("/api/v1/me"))).features;

const OK_COMPUTER = "0724385522925";
const SHOP_ONLY = "0012345678905";

class FakeMusic implements ProductLookup {
  asked: string[] = [];
  async lookup(code: string): Promise<ProductInfo | null> {
    this.asked.push(code);
    if (code !== OK_COMPUTER) return null;
    return {
      barcode: code,
      title: "OK Computer",
      brand: "Radiohead",
      description: "CD · 1997 · Capitol Records · US",
      category: "Music",
      images: ["https://coverartarchive.org/release/6a09041b-0f79-3278-88d9-0552dd28d37f/front-500"],
      source: "MusicBrainz",
      kind: "music",
    };
  }
}

describe("music look-ups", () => {
  it("ask MusicBrainz only for codes scanned as music, once the server admin switches it on", async () => {
    const music = new FakeMusic();
    const products = new FakeProducts();
    const s = await setup({ music, products });
    const ann = await s.user("ann");

    // Off: scanning as music is an ordinary scan, and the app doesn't offer it.
    expect(await features(ann)).toMatchObject({ music: false });
    await scan(ann, OK_COMPUTER, "music");
    expect(music.asked).toEqual([]);

    expect(await json<MusicLookupStatus>(send(ann, "PUT", "/api/v1/server/music", { enabled: true }))).toMatchObject({ available: true, enabled: true });
    const shopCalls = products.calls.length;
    expect(await features(ann)).toMatchObject({ music: true });
    const found = await scan(ann, OK_COMPUTER, "music");
    expect(found.online).toBe(true);
    expect(found.match).toMatchObject({ name: "OK Computer", brand: "Radiohead", source: "musicbrainz", kind: "music", description: "CD · 1997 · Capitol Records · US" });
    expect(found.match?.images).toHaveLength(1);
    // Kept: asked once, for everyone on the server.
    await scan(ann, OK_COMPUTER, "music");
    expect(music.asked).toEqual([OK_COMPUTER]);
    // An ordinary scan never goes to MusicBrainz.
    await scan(ann, "0098765432109");
    expect(music.asked).toEqual([OK_COMPUTER]);
    expect(await json<MusicLookupStatus>(ann.as("/api/v1/server/music"))).toMatchObject({ releases: 1 });
    // Found on MusicBrainz: the shop database wasn't asked (only the ordinary scan above went there).
    expect(products.calls.length).toBe(shopCalls + 1);
  });

  it("is the server admin's switch", async () => {
    const s = await setup({ music: new FakeMusic() });
    await s.user("ann");
    const bob = await s.user("bob");
    expect((await send(bob, "PUT", "/api/v1/server/music", { enabled: true })).status).toBe(403);
  });

  it("falls back to the product database for a code MusicBrainz doesn't know — and doesn't unname what the shop database knew", async () => {
    const music = new FakeMusic();
    const products = new FakeProducts({ [SHOP_ONLY]: { title: "Some CD", images: [] } });
    const s = await setup({ music, products });
    const ann = await s.user("ann");
    await send(ann, "PUT", "/api/v1/server/music", { enabled: true });

    // Known to the shop database first (an ordinary scan), then scanned as music: MusicBrainz is asked, doesn't know it.
    expect((await scan(ann, SHOP_ONLY)).match).toMatchObject({ name: "Some CD", source: "upcitemdb" });
    expect((await scan(ann, SHOP_ONLY, "music")).match).toMatchObject({ name: "Some CD", source: "upcitemdb" });
    expect(music.asked).toEqual([SHOP_ONLY]);

    // Nobody knew it before: MusicBrainz, then the shop database.
    const fresh = "0055555555555";
    expect((await scan(ann, fresh, "music")).match).toBeNull();
    expect(music.asked).toContain(fresh);
    expect(products.calls).toContain(fresh);
  });

  it("replaces a shop database's answer with MusicBrainz's when scanned as music", async () => {
    const music = new FakeMusic();
    const products = new FakeProducts({ [OK_COMPUTER]: { title: "Radiohead OK Computer [CD] New", images: [] } });
    const s = await setup({ music, products });
    const ann = await s.user("ann");
    await send(ann, "PUT", "/api/v1/server/music", { enabled: true });
    expect((await scan(ann, OK_COMPUTER)).match).toMatchObject({ source: "upcitemdb" });
    expect((await scan(ann, OK_COMPUTER, "music")).match).toMatchObject({ name: "OK Computer", source: "musicbrainz" });
  });

  it("a household's own name for a code still wins", async () => {
    const music = new FakeMusic();
    const s = await setup({ music });
    const ann = await s.user("ann");
    await send(ann, "PUT", "/api/v1/server/music", { enabled: true });
    await ann.addItem({ name: "Dad's OK Computer", barcode: OK_COMPUTER });
    expect((await scan(ann, OK_COMPUTER, "music")).match).toMatchObject({ name: "Dad's OK Computer", source: "ferret" });
    expect(music.asked).toEqual([]);
  });
});

describe("the MusicBrainz adapter", () => {
  const release = (over: Record<string, unknown>) => ({
    id: "r1",
    title: "OK Computer",
    barcode: "724385522925",
    status: "Official",
    date: "1997-07-01",
    country: "US",
    "artist-credit": [{ name: "Radiohead", joinphrase: "" }],
    "label-info": [{ label: { name: "Capitol Records" } }],
    media: [{ format: "CD", "track-count": 12 }],
    "release-group": { id: "rg1" },
    ...over,
  });

  it("names formats and picks the exact, official release", () => {
    expect(formatOf([{ format: "CD" }, { format: "CD" }, { format: "DVD" }])).toBe("2×CD + DVD");
    expect(formatOf([])).toBe("");
    const picked = pickRelease([release({ id: "near", barcode: "724385522926" }), release({ id: "boot", status: "Bootleg" }), release({ id: "ok" })] as never, "0724385522925");
    expect(picked?.id).toBe("ok");
    expect(pickRelease([release({ barcode: null })] as never, "0724385522925")).toBeUndefined();
  });

  it("asks for both spellings of a UPC, one call at a time, and falls back to the album's cover", async () => {
    const calls: { url: string; method: string; ua: string | null }[] = [];
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET", ua: new Headers(init?.headers).get("User-Agent") });
      if (url.startsWith("https://musicbrainz.org/")) {
        return Response.json({ releases: [release({ "artist-credit": [{ name: "Radiohead", joinphrase: " & " }, { name: "Friends", joinphrase: "" }] })] });
      }
      if (url.includes("/release/r1/")) return new Response("", { status: 404 });
      return new Response("", { status: 307, headers: { location: "https://archive.org/x.jpg" } });
    }) as typeof fetch;
    const p = await new MusicBrainzReleases(fetcher).lookup("0724385522925");
    expect(decodeURIComponent(calls[0]!.url)).toContain("barcode:(0724385522925 OR 724385522925)");
    expect(calls[0]!.ua).toMatch(/^Ferret\/1 \( https:\/\/github\.com\/ferret-project\/ferret \)$/);
    expect(p).toMatchObject({
      title: "OK Computer",
      brand: "Radiohead & Friends",
      description: "CD · 1997 · Capitol Records · US",
      kind: "music",
      images: ["https://coverartarchive.org/release-group/rg1/front-500"],
    });
  });

  it("answers null when nothing has the barcode", async () => {
    const fetcher = (async () => Response.json({ releases: [] })) as unknown as typeof fetch;
    expect(await new MusicBrainzReleases(fetcher).lookup("0724385522925")).toBeNull();
    const never = (async () => {
      throw new Error("asked");
    }) as unknown as typeof fetch;
    expect(await new MusicBrainzReleases(never).lookup("0000000000000")).toBeNull();
  });
});
