/** Collector catalogs (lib/collectibles.ts): LEGO from Rebrickable, coins from Numista, comics from Comic Vine. */
import type { CoinIssuer, CollectibleCatalogStatus, CollectibleInfo, CollectiblePrice, CollectibleReadStatus, CollectibleValue } from "@ferret/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { ComicVineIssues, parseComicQuery, toComic } from "../src/adapters/local/comicvine";
import { NumistaCoins, issueLabel, toCoin } from "../src/adapters/local/numista";
import { RebrickableSets, setNumberOf, toSet } from "../src/adapters/local/rebrickable";
import { TmdbVideos, parseVideoQuery, toVideo } from "../src/adapters/local/tmdb";
import { IgdbGames, splitKey, toGame } from "../src/adapters/local/igdb";
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
const BREAKING_BAD: CollectibleInfo = { kind: "video", id: "tv-1396", name: "Breaking Bad", mediaType: "tv", year: 2008, studio: "AMC", url: "https://www.themoviedb.org/tv/1396", seasons: [{ number: 1, name: "Season 1", imageLarge: "https://image.tmdb.org/t/p/w780/s1.jpg" }], imageLarge: "https://image.tmdb.org/t/p/w780/show.jpg" };
const ZELDA: CollectibleInfo = { kind: "game", id: "7346", name: "The Legend of Zelda: Breath of the Wild", year: 2017, platforms: ["Wii U", "Nintendo Switch"], publisher: "Nintendo", url: "https://www.igdb.com/games/zelda" };
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
  const video = new FakeCatalog([BREAKING_BAD]);
  const game = new FakeCatalog([ZELDA]);
  const s = await setup({ collectibles: { lego, coin, comic, video, game }, ...opts });
  const ann = await s.user("ann");
  const on = async (...kinds: string[]) => {
    for (const k of kinds) expect((await send(ann, "PUT", `/api/v1/server/collectibles/${k}`, { key: KEY })).status).toBe(200);
  };
  return { ...s, ann, lego, coin, comic, video, game, on };
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
      { kind: "video", available: true, on: false, hint: null, kept: 0 },
      { kind: "game", available: true, on: false, hint: null, kept: 0 },
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

  it("read a film's case for its title, format and season, and keep a season's own poster", async () => {
    const ai = new FakeAi([{ title: "Breaking Bad", year: null, format: "blu ray", season: 1 }]);
    const downloader = new FakeDownloader();
    downloader.files.set("https://image.tmdb.org/t/p/w780/s1.jpg", await photo());
    const { ann, jobs, on } = await catalogs({ ai, downloader });
    await on("video");
    const { id } = await json<{ id: string }>(readPhoto(ann, "video"));
    await jobs.drain();
    expect(await json<CollectibleReadStatus>(ann.as(`/api/v1/collectibles/read/${id}`))).toMatchObject({ read: { query: "Breaking Bad", format: "Blu-ray", season: 1 }, candidates: [{ id: "tv-1396" }] });
    const box = await ann.addItem({ name: "Breaking Bad – Season 1", collectible: { kind: "video", id: "tv-1396", format: "Blu-ray", season: 1 } });
    expect((await json<{ collectible: unknown }>(ann.as(`/api/v1/items/${box.id}`))).collectible).toEqual({ kind: "video", id: "tv-1396", format: "Blu-ray", season: 1 });
    // Season 1's poster, not the show's (only that one is downloadable here).
    expect((await send(ann, "POST", `/api/v1/items/${box.id}/collectible/photo`)).status).toBe(201);
  });

  it("read a game's case for its title and platform", async () => {
    const ai = new FakeAi([{ title: "The Legend of Zelda: Breath of the Wild", platform: "Nintendo Switch", year: null }]);
    const { ann, jobs, game, on } = await catalogs({ ai });
    await on("game");
    const { id } = await json<{ id: string }>(readPhoto(ann, "game"));
    await jobs.drain();
    expect(await json<CollectibleReadStatus>(ann.as(`/api/v1/collectibles/read/${id}`))).toMatchObject({ read: { query: "The Legend of Zelda: Breath of the Wild", format: "Nintendo Switch" }, candidates: [{ id: "7346" }] });
    // Kept from the search: picking it asks nothing more.
    expect(await json(ann.as("/api/v1/collectibles/game/7346"))).toMatchObject({ publisher: "Nintendo" });
    expect(game.gets).toEqual([]);
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

  it("read film searches and turn TMDB's answers into films and shows", () => {
    expect(parseVideoQuery("Breaking Bad season 2")).toEqual({ title: "Breaking Bad", year: null, season: 2 });
    expect(parseVideoQuery("Dune (2021)")).toEqual({ title: "Dune", year: 2021, season: null });
    expect(parseVideoQuery("The Office S3")).toEqual({ title: "The Office", year: null, season: 3 });
    expect(parseVideoQuery("2001: A Space Odyssey")).toEqual({ title: "2001: A Space Odyssey", year: null, season: null });
    expect(toVideo({ id: 603, title: "The Matrix", release_date: "1999-03-31", poster_path: "/p.jpg", runtime: 136, genres: [{ name: "Action" }], production_companies: [{ name: "Village Roadshow Pictures" }] } as never, "movie")).toMatchObject({
      id: "movie-603",
      year: 1999,
      runtimeMin: 136,
      studio: "Village Roadshow Pictures",
      imageLarge: "https://image.tmdb.org/t/p/w780/p.jpg",
      url: "https://www.themoviedb.org/movie/603",
    });
  });

  it("split IGDB's two-part key, keep its Twitch token, and ask for games themselves", async () => {
    expect(splitKey("abc123 s3cret")).toEqual({ clientId: "abc123", secret: "s3cret" });
    expect(splitKey("abc123\ns3cret\n")).toEqual({ clientId: "abc123", secret: "s3cret" });
    expect(splitKey("abc123:s3cret")).toEqual({ clientId: "abc123", secret: "s3cret" });
    expect(splitKey("only-one")).toBeNull();
    expect(toGame({ id: 7346, name: "Zelda", first_release_date: 1488499200, cover: { image_id: "co3p2d" }, platforms: [{ name: "Nintendo Switch" }], involved_companies: [{ company: { name: "EPD" } }, { company: { name: "Nintendo" }, publisher: true }] })).toMatchObject({
      year: 2017,
      publisher: "Nintendo",
      platforms: ["Nintendo Switch"],
      imageLarge: "https://images.igdb.com/igdb/image/upload/t_cover_big_2x/co3p2d.jpg",
      url: "https://www.igdb.com/games/7346",
    });
    const calls: string[] = [];
    let tokens = 0;
    let refuse = false;
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://id.twitch.tv/")) {
        calls.push("token");
        return reply({ access_token: `t${++tokens}`, expires_in: 3600 });
      }
      calls.push(`${new Headers(init?.headers).get("authorization")} ${String(init?.body)}`);
      if (refuse) {
        refuse = false;
        return reply({ message: "Authorization Failure" }, 401);
      }
      return reply([{ id: 7346, name: "Zelda" }]);
    }) as typeof fetch;
    const igdb = new IgdbGames(fetcher);
    await igdb.find("id secret", { text: 'Zelda "BotW"' });
    await igdb.find("id secret", { text: "Zelda" });
    expect(calls.filter((c) => c === "token")).toHaveLength(1);
    expect(calls[1]).toContain("Bearer t1");
    // Quotes typed are the query's own: they're taken out of the title.
    expect(calls[1]).toContain('search "Zelda BotW";');
    expect(calls[1]).toContain("where game_type = (0,4,8,9,10,11)");
    // A token that ended early is swapped for a new one, once.
    refuse = true;
    await igdb.get("id secret", "7346");
    expect(calls.slice(-3)).toEqual([expect.stringContaining("Bearer t1"), "token", expect.stringContaining("Bearer t2")]);
    expect(await new IgdbGames((async () => reply({ message: "invalid client secret" }, 403)) as typeof fetch).check("id bad")).toBe(false);
  });

  it("send TMDB an API key in the address and a read token as a Bearer token, and put a typed year first", async () => {
    const seen: { url: URL; auth: string | null }[] = [];
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: new URL(String(input)), auth: new Headers(init?.headers).get("authorization") });
      return reply({ results: [{ id: 438631, media_type: "movie", title: "Dune", release_date: "2021-09-15" }, { id: 841, media_type: "movie", title: "Dune", release_date: "1984-12-14" }, { id: 1, media_type: "person", name: "Someone" }] });
    }) as typeof fetch;
    const found = await new TmdbVideos(fetcher).find("api-key-123", { text: "Dune 1984" });
    expect(found.map((f) => f.id)).toEqual(["movie-841", "movie-438631"]);
    expect(seen[0]!.url.searchParams.get("api_key")).toBe("api-key-123");
    expect(seen[0]!.url.searchParams.get("query")).toBe("Dune");
    await new TmdbVideos(fetcher).find("eyJhbGciOi.token", { text: "Dune" });
    expect(seen[1]!.auth).toBe("Bearer eyJhbGciOi.token");
    expect(seen[1]!.url.searchParams.has("api_key")).toBe(false);
    expect(await new TmdbVideos((async () => reply({ status_message: "Invalid API key" }, 401)) as typeof fetch).check("bad")).toBe(false);
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
