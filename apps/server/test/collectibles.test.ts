/** Collector catalogs (lib/collectibles.ts): LEGO from Rebrickable, coins from Numista, comics from Comic Vine. */
import type { CoinIssuer, CollectibleCatalogStatus, CollectibleInfo, CollectiblePrice, CollectibleReadStatus, CollectibleValue } from "@ferret/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { ComicVineIssues, parseComicQuery, toComic } from "../src/adapters/local/comicvine";
import { NumistaCoins, issueLabel, toCoin } from "../src/adapters/local/numista";
import { RebrickableSets, setNumberOf, toSet } from "../src/adapters/local/rebrickable";
import { serverSetting } from "../src/db/schema";
import { collectiblePhotoKey } from "../src/lib/collectibles";
import { CatalogKeyError, type CollectibleCatalog } from "../src/ports";
import { FakeAi, FakeDownloader, photo, setup } from "./helpers";

type User = Awaited<ReturnType<Awaited<ReturnType<typeof setup>>["user"]>>;
const json = async <T>(res: Response | Promise<Response>) => (await (await res).json()) as T;
const send = (u: User, method: string, url: string, data?: object) => u.as(url, { method, ...(data ? { body: JSON.stringify(data) } : {}) });
const features = async (u: User) => (await json<{ features: { collectibles: string[] } }>(u.as("/api/v1/me"))).features;

const FALCON: CollectibleInfo = { kind: "lego", id: "75192-1", name: "Millennium Falcon", year: 2017, setNumber: "75192", theme: "Star Wars › Ultimate Collector Series", pieces: 7541, image: "https://cdn.rebrickable.com/media/sets/75192-1/30881.jpg", imageLarge: "https://cdn.rebrickable.com/media/sets/75192-1/30881.jpg", url: "https://rebrickable.com/sets/75192-1/" };
const QUARTER: CollectibleInfo = { kind: "coin", id: "55", name: '¼ Dollar "Washington Quarter"', year: 1965, yearTo: 1998, issuer: "United States", image: "https://en.numista.com/a-180.jpg", imageLarge: "https://en.numista.com/a-original.jpg", url: "https://en.numista.com/55" };
const LIBERIA: CollectibleInfo = { kind: "coin", id: "55640", name: "10 Dollars (George Washington)", year: 2003, issuer: "Liberia", url: "https://en.numista.com/55640" };
const ASM300: CollectibleInfo = { kind: "comic", id: "29584", name: "The Amazing Spider-Man #300", series: "The Amazing Spider-Man", issueNumber: "300", publisher: "Marvel", title: "Venom", year: 1988, url: "https://comicvine.gamespot.com/x/4000-29584/" };
const ISSUERS: CoinIssuer[] = [
  { code: "united-states", name: "United States" },
  { code: "etats-unis", name: "United States", parent: "United States" },
  { code: "germany", name: "Germany" },
  { code: "liberia", name: "Liberia" },
];
const KEY = "a-good-key-1234";

class FakeCatalog implements CollectibleCatalog {
  finds: { text: string; issuer?: string | null; year?: number | null }[] = [];
  gets: string[] = [];
  priced: string[] = [];
  keys: string[] = [];
  constructor(
    private readonly items: CollectibleInfo[],
    private readonly coins = false,
  ) {
    if (coins) {
      this.prices = async (key, id, issue, currency) => {
        this.keys.push(key);
        this.priced.push(`${id}:${issue}:${currency}`);
        return [
          { grade: "vf", cents: 31, currency, source: "Numista" },
          { grade: "unc", cents: 182, currency, source: "Numista" },
        ];
      };
      this.issuers = async () => ISSUERS;
    }
  }
  prices?: CollectibleCatalog["prices"];
  issuers?: CollectibleCatalog["issuers"];
  async check(key: string) {
    return key === KEY;
  }
  async find(key: string, q: { text: string; issuer?: string | null; year?: number | null }) {
    this.keys.push(key);
    this.finds.push(q);
    const words = q.text.toLowerCase().split(/\s+/).filter(Boolean);
    return this.items.filter((i) => words.every((w) => `${i.name} ${i.setNumber ?? ""}`.toLowerCase().includes(w)));
  }
  async get(key: string, id: string) {
    this.keys.push(key);
    this.gets.push(id);
    const found = this.items.find((i) => i.id === id);
    return found ? { ...found, ...(this.coins ? { issues: [{ id: "547", year: 1965, label: "1965" }] } : {}) } : null;
  }
}

async function catalogs(opts: Parameters<typeof setup>[0] = {}) {
  const lego = new FakeCatalog([FALCON]);
  const coin = new FakeCatalog([LIBERIA, QUARTER], true);
  const comic = new FakeCatalog([ASM300]);
  const s = await setup({ collectibles: { lego, coin, comic }, ...opts });
  const ann = await s.user("ann");
  const on = async (...kinds: string[]) => {
    for (const k of kinds) expect((await send(ann, "PUT", `/api/v1/server/collectibles/${k}`, { key: KEY })).status).toBe(200);
  };
  return { ...s, ann, lego, coin, comic, on };
}

const readPhoto = async (u: User, kind: string) => {
  const form = new FormData();
  form.set("photo", new File([await photo()], "box.jpg"));
  form.set("kind", kind);
  return u.as("/api/v1/collectibles/read", { method: "POST", body: form });
};

describe("collector catalogs", () => {
  it("are off until the server admin saves a key the catalog takes — kept sealed, never sent back", async () => {
    const { ann, db, lego, on } = await catalogs();
    expect(await features(ann)).toMatchObject({ collectibles: [] });
    expect((await ann.as("/api/v1/collectibles/search?kind=lego&q=falcon")).status).toBe(409);
    expect((await send(ann, "PUT", "/api/v1/server/collectibles/lego", { key: "not-the-right-key" })).status).toBe(422);
    await on("lego");
    const status = await json<{ data: CollectibleCatalogStatus[] }>(ann.as("/api/v1/server/collectibles"));
    expect(status.data).toEqual([
      { kind: "lego", available: true, on: true, hint: "…1234", kept: 0 },
      { kind: "coin", available: true, on: false, hint: null, kept: 0 },
      { kind: "comic", available: true, on: false, hint: null, kept: 0 },
    ]);
    const [row] = await db.select().from(serverSetting).where(eq(serverSetting.key, "collectibles.lego.key"));
    expect(row!.value).not.toContain(KEY);
    expect(JSON.stringify(status)).not.toContain(KEY);
    expect(await features(ann)).toMatchObject({ collectibles: ["lego"] });
    // The key reaches the catalog, opened.
    await ann.as("/api/v1/collectibles/search?kind=lego&q=falcon");
    expect(lego.keys).toEqual([KEY]);
    // Removed: off again.
    await send(ann, "PUT", "/api/v1/server/collectibles/lego", { key: null });
    expect(await features(ann)).toMatchObject({ collectibles: [] });
  });

  it("let only the server admin save keys", async () => {
    const { user, on } = await catalogs();
    await on("lego");
    const bob = await user("bob");
    expect((await bob.as("/api/v1/server/collectibles")).status).toBe(403);
    expect((await send(bob, "PUT", "/api/v1/server/collectibles/lego", { key: KEY })).status).toBe(403);
  });

  it("search what's typed and keep sets and comics in the shared book", async () => {
    const { ann, lego, comic, on } = await catalogs();
    await on("lego", "comic");
    const sets = await json<{ data: CollectibleInfo[] }>(ann.as("/api/v1/collectibles/search?kind=lego&q=75192"));
    expect(sets.data.map((s) => s.id)).toEqual(["75192-1"]);
    // Picked: from the book, nothing asked again.
    expect(await json(ann.as("/api/v1/collectibles/lego/75192-1"))).toMatchObject({ name: "Millennium Falcon" });
    expect(lego.gets).toEqual([]);
    const comics = await json<{ data: CollectibleInfo[] }>(ann.as(`/api/v1/collectibles/search?kind=comic&q=${encodeURIComponent("Amazing Spider-Man #300")}`));
    expect(comics.data.map((c) => c.id)).toEqual(["29584"]);
    expect(comic.finds[0]!.text).toBe("Amazing Spider-Man #300");
    expect((await ann.as("/api/v1/collectibles/lego/nope-1")).status).toBe(404);
    expect((await ann.as("/api/v1/collectibles/stamps/1")).status).toBe(404);
  });

  it("find coins by a country named in the words, rank the nickname first, and pick issuers", async () => {
    const { ann, coin, on } = await catalogs();
    await on("coin");
    const found = await json<{ data: CollectibleInfo[] }>(ann.as(`/api/v1/collectibles/search?kind=coin&q=${encodeURIComponent("US Washington quarter")}&year=1965`));
    expect(coin.finds[0]).toEqual({ text: "washington quarter", issuer: "united-states", year: 1965 });
    expect(found.data.map((c) => c.id)).toEqual(["55"]);
    const picked = await json<{ data: CollectibleInfo[] }>(ann.as(`/api/v1/collectibles/search?kind=coin&q=dollar&issuer=liberia`));
    expect(coin.finds[1]).toEqual({ text: "dollar", issuer: "liberia", year: null });
    expect(picked.data.length).toBe(2);
    expect((await json<{ data: CoinIssuer[] }>(ann.as("/api/v1/collectibles/issuers?q=unit"))).data[0]).toEqual({ code: "united-states", name: "United States" });
  });

  it("read a photo in the background and search what the vision model read", async () => {
    const ai = new FakeAi([{ issuer: "United States of America", year: 1965, denomination: "Quarter dollar", design: "Washington" }, { setNumber: "No. 75192", name: "Millennium Falcon" }]);
    const { ann, jobs, files, coin, on } = await catalogs({ ai });
    await on("coin", "lego");
    const started = await readPhoto(ann, "coin");
    expect(started.status).toBe(202);
    const { id } = await json<{ id: string }>(started);
    expect(await json<CollectibleReadStatus>(ann.as(`/api/v1/collectibles/read/${id}`))).toMatchObject({ status: "pending" });
    await jobs.drain();
    const done = await json<CollectibleReadStatus>(ann.as(`/api/v1/collectibles/read/${id}`));
    // The design and face value together, as Numista's titles have them.
    expect(done).toMatchObject({ status: "done", read: { kind: "coin", query: "Washington Quarter dollar", issuer: "united-states", year: 1965 } });
    expect(done.candidates?.map((c) => c.id)).toEqual(["55"]);
    expect(coin.finds).toEqual([{ text: "Washington Quarter dollar", issuer: "united-states", year: 1965 }]);
    expect(ai.calls[0]!.prompt).toContain("coin");
    const me = await json<{ activeHouseholdId: string }>(ann.as("/api/v1/me"));
    expect(await files.get(me.activeHouseholdId, collectiblePhotoKey(me.activeHouseholdId, id))).toBeNull();
    const box = await json<{ id: string }>(readPhoto(ann, "lego"));
    await jobs.drain();
    expect(await json<CollectibleReadStatus>(ann.as(`/api/v1/collectibles/read/${box.id}`))).toMatchObject({ read: { query: "75192" }, candidates: [{ id: "75192-1" }] });
    // Someone else's reading isn't theirs to see; a catalog without a key can't be read for.
    const bob = await (await catalogs()).user("bob");
    expect((await bob.as(`/api/v1/collectibles/read/${id}`)).status).toBe(404);
    expect((await readPhoto(ann, "comic")).status).toBe(409);
  });

  it("try a coin's design alone when its face value was read in other words", async () => {
    const ai = new FakeAi([{ issuer: "Liberia", year: null, denomination: "Ten dollars", design: "George Washington" }]);
    const { ann, jobs, coin, on } = await catalogs({ ai });
    await on("coin");
    const { id } = await json<{ id: string }>(readPhoto(ann, "coin"));
    await jobs.drain();
    expect(coin.finds.map((f) => f.text)).toEqual(["George Washington Ten dollars", "George Washington"]);
    expect((await json<CollectibleReadStatus>(ann.as(`/api/v1/collectibles/read/${id}`))).candidates?.map((c) => c.id)).toEqual(["55640"]);
  });

  it("price a coin thing in the household's currency and grade", async () => {
    const { ann, coin, on } = await catalogs();
    await on("coin");
    const thing = await ann.addItem({ name: "1965 Washington quarter", collectible: { kind: "coin", id: "55", issue: "547", grade: "unc" } });
    expect((await json<{ collectible: unknown }>(ann.as(`/api/v1/items/${thing.id}`))).collectible).toEqual({ kind: "coin", id: "55", issue: "547", grade: "unc" });
    const got = await json<{ info: CollectibleInfo; prices: CollectiblePrice[]; price: CollectiblePrice }>(ann.as(`/api/v1/items/${thing.id}/collectible`));
    expect(got).toMatchObject({ info: { name: QUARTER.name, issues: [{ id: "547" }] }, price: { grade: "unc", cents: 182, currency: "USD" } });
    expect(coin.priced).toEqual(["55:547:USD"]);
    expect((await json<{ data: CollectiblePrice[] }>(ann.as("/api/v1/collectibles/coin/55/prices?issue=547"))).data).toHaveLength(2);
    expect(coin.priced).toHaveLength(1); // kept a week
    // Numista's pictures are its members' photos: never copied.
    expect((await send(ann, "POST", `/api/v1/items/${thing.id}/collectible/photo`)).status).toBe(422);
    const mug = await ann.addItem({ name: "Mug" });
    expect(await json(ann.as(`/api/v1/items/${mug.id}/collectible`))).toEqual({ collectible: null, info: null, prices: [], price: null });
    expect((await send(ann, "POST", `/api/v1/items/${mug.id}/collectible/photo`)).status).toBe(422);
  });

  it("keep a set's or comic's picture as the thing's photo", async () => {
    const downloader = new FakeDownloader();
    downloader.files.set(FALCON.imageLarge!, await photo());
    const { ann, on } = await catalogs({ downloader });
    await on("lego");
    const set = await ann.addItem({ name: "Millennium Falcon", collectible: { kind: "lego", id: "75192-1" } });
    expect(await json(ann.as(`/api/v1/items/${set.id}/collectible`))).toMatchObject({ info: { pieces: 7541 }, prices: [], price: null });
    expect((await send(ann, "POST", `/api/v1/items/${set.id}/collectible/photo`)).status).toBe(201);
    expect((await json<{ photoId: string | null }>(ann.as(`/api/v1/items/${set.id}`))).photoId).toBeTruthy();
  });

  it("list a collection's coins beside today's prices, fetching the old ones in the background", async () => {
    const { ann, jobs, coin, on } = await catalogs();
    await on("coin", "lego");
    const tray = await json<{ id: string }>(send(ann, "POST", "/api/v1/collections", { name: "Quarters" }));
    await ann.addItem({ name: "1965 quarter", valueCents: 25, collectionId: tray.id, collectible: { kind: "coin", id: "55", issue: "547", grade: "vf" } });
    await ann.addItem({ name: "No grade", collectionId: tray.id, collectible: { kind: "coin", id: "55" } });
    await ann.addItem({ name: "Falcon", collectionId: tray.id, collectible: { kind: "lego", id: "75192-1" } });
    const first = await json<{ data: CollectibleValue[]; checking: number }>(ann.as(`/api/v1/collectibles/values?collectionId=${tray.id}`));
    expect(first).toMatchObject({ checking: 1, data: [{ name: "1965 quarter", valueCents: 25, price: null }] });
    await jobs.drain();
    expect(coin.priced).toEqual(["55:547:USD"]);
    expect(await json(ann.as(`/api/v1/collectibles/values?collectionId=${tray.id}`))).toMatchObject({ checking: 0, data: [{ price: { grade: "vf", cents: 31 } }] });
  });

  it("say when a catalog refuses the server's key", async () => {
    const { ann, lego, on } = await catalogs();
    await on("lego");
    lego.find = async () => {
      throw new CatalogKeyError("refused");
    };
    const res = await ann.as("/api/v1/collectibles/search?kind=lego&q=castle");
    expect(res.status).toBe(502);
    expect((await json<{ error: { message: string } }>(res)).error.message).toContain("Settings → Server");
  });
});

describe("collector catalog adapters", () => {
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("read set numbers and comic searches", () => {
    expect(setNumberOf("75192")).toBe("75192-1");
    expect(setNumberOf("10179-2")).toBe("10179-2");
    expect(setNumberOf("Millennium Falcon")).toBeNull();
    expect(parseComicQuery("Amazing Spider-Man 300")).toEqual({ series: "Amazing Spider-Man", year: null, number: "300" });
    expect(parseComicQuery("Batman (2016) #50")).toEqual({ series: "Batman", year: 2016, number: "50" });
    expect(parseComicQuery("Saga")).toEqual({ series: "Saga", year: null, number: null });
    expect(parseComicQuery("X-Men 1.5")).toEqual({ series: "X-Men", year: null, number: "1.5" });
  });

  it("turn the catalogs' answers into sets, coins and comics", () => {
    const themes = new Map([
      [158, { id: 158, parent_id: null, name: "Star Wars" }],
      [171, { id: 171, parent_id: 158, name: "Ultimate Collector Series" }],
    ]);
    expect(toSet({ set_num: "75192-1", name: "Millennium Falcon", year: 2017, theme_id: 171, num_parts: 7541, set_img_url: "https://cdn/x.jpg", set_url: "https://rebrickable.com/sets/75192-1/" }, themes)).toMatchObject({ setNumber: "75192", theme: "Star Wars › Ultimate Collector Series", pieces: 7541, url: "https://rebrickable.com/sets/75192-1/" });
    expect(toCoin({ id: 55, title: "¼ Dollar", issuer: { name: "United States" }, min_year: 1965, max_year: 1998, obverse_thumbnail: "http://not-secure/x.jpg" })).toMatchObject({ id: "55", yearTo: 1998, image: null, url: "https://en.numista.com/55" });
    expect(issueLabel({ id: 1, year: 1968, mint_letter: "D" })).toBe("1968 D");
    expect(issueLabel({ id: 2, year: 1965, comment: "SMS" })).toBe("1965 · SMS");
    expect(issueLabel({ id: 3, is_dated: false })).toBe("Undated");
    expect(toComic({ id: 29584, name: "Venom", issue_number: "300", cover_date: "1988-05-31", volume: { id: 2127, name: "The Amazing Spider-Man" }, site_detail_url: "https://comicvine.gamespot.com/x/" }, "Marvel")).toMatchObject({ name: "The Amazing Spider-Man #300", title: "Venom", year: 1988, publisher: "Marvel", url: "https://comicvine.gamespot.com/x/" });
  });

  it("send each key the way its catalog wants, and tell a refused key from trouble", async () => {
    const seen: { url: string; headers: Headers }[] = [];
    const fetcher = (status: number, body: unknown) => (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(input), headers: new Headers(init?.headers) });
      return reply(body, status);
    }) as typeof fetch;
    expect(await new RebrickableSets(fetcher(200, { results: [] })).check("rb-key")).toBe(true);
    expect(seen.at(-1)!.headers.get("authorization")).toBe("key rb-key");
    expect(await new RebrickableSets(fetcher(401, { detail: "Invalid token." })).check("bad")).toBe(false);
    expect(await new NumistaCoins(fetcher(200, { id: 55 })).check("nu-key")).toBe(true);
    expect(seen.at(-1)!.headers.get("numista-api-key")).toBe("nu-key");
    expect(await new ComicVineIssues(fetcher(401, { status_code: 100, error: "Invalid API Key", results: [] }), 0).check("bad")).toBe(false);
    await expect(new NumistaCoins(fetcher(500, {})).find("k", { text: "dime" })).rejects.toThrow("Numista: HTTP 500");
    // Comic Vine's key goes in the address: never in an error.
    await expect(new ComicVineIssues(fetcher(500, { status_code: 0, error: "boom", results: [] }), 0).get("secret-cv-key", "1")).rejects.toThrow(/^Comic Vine: HTTP 500 \(boom\)$/);
  });

  it("ask Comic Vine for that issue of the series that fit", async () => {
    const urls: string[] = [];
    const fetcher = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      urls.push(`${url.pathname}?${url.searchParams.get("resources") ?? url.searchParams.get("filter")}`);
      if (url.pathname.endsWith("/search/"))
        return reply({ status_code: 1, results: [{ id: 87154, name: "The Amazing Spider-Man", start_year: "2016", count_of_issues: 2 }, { id: 2127, name: "The Amazing Spider-Man", start_year: "1963", count_of_issues: 651, publisher: { name: "Marvel" } }] });
      return reply({ status_code: 1, results: [{ id: 29584, issue_number: "300", volume: { id: 2127, name: "The Amazing Spider-Man" } }] });
    }) as typeof fetch;
    const found = await new ComicVineIssues(fetcher, 0).find("k", { text: "Amazing Spider-Man 300" });
    expect(urls).toEqual(["/api/search/?volume", "/api/issues/?volume:2127,issue_number:300"]);
    expect(found).toMatchObject([{ id: "29584", publisher: "Marvel" }]);
  });
});
