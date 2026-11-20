/** Trading cards (lib/cards.ts): Pokémon from TCGdex, Magic from Scryfall — read off a photo or typed, priced. */
import type { CardInfo, CardReadStatus, CardValue } from "@ferret/shared";
import { describe, expect, it } from "vitest";
import { ScryfallCards, toCard as scryfallCard } from "../src/adapters/local/scryfall";
import { TcgdexCards, finishName, pricesOf, toCard as tcgdexCard } from "../src/adapters/local/tcgdex";
import { cardPhotoKey, parseCardQuery, priceFor } from "../src/lib/cards";
import type { CardCatalog } from "../src/ports";
import { FakeAi, FakeDownloader, photo, setup } from "./helpers";

type User = Awaited<ReturnType<Awaited<ReturnType<typeof setup>>["user"]>>;
const json = async <T>(res: Response | Promise<Response>) => (await (await res).json()) as T;
const send = (u: User, method: string, url: string, data?: object) => u.as(url, { method, ...(data ? { body: JSON.stringify(data) } : {}) });
const features = async (u: User) => (await json<{ features: { cards: string[]; cardPhotos: boolean } }>(u.as("/api/v1/me"))).features;

const PIKACHU: CardInfo = {
  game: "pokemon",
  id: "sv03.5-025",
  name: "Pikachu",
  set: "151",
  setCode: "sv03.5",
  number: "025",
  setTotal: 165,
  rarity: "Common",
  image: "https://assets.tcgdex.net/en/sv/sv03.5/025/low.webp",
  imageLarge: "https://assets.tcgdex.net/en/sv/sv03.5/025/high.webp",
  finishes: ["Normal", "Reverse holofoil"],
  prices: [
    { finish: "Normal", currency: "USD", cents: 28, source: "TCGplayer" },
    { finish: "Reverse holofoil", currency: "USD", cents: 76, source: "TCGplayer" },
    { finish: "Normal", currency: "EUR", cents: 16, source: "Cardmarket" },
  ],
};
const BOLT: CardInfo = { ...PIKACHU, game: "magic", id: "bolt-m10", name: "Lightning Bolt", set: "Magic 2010", setCode: "M10", number: "146", setTotal: null, finishes: ["Normal", "Foil"], prices: [{ finish: "Normal", currency: "USD", cents: 163, source: "TCGplayer" }] };

class FakeCatalog implements CardCatalog {
  finds: object[] = [];
  gets: string[] = [];
  constructor(private readonly cards: CardInfo[]) {}
  async find(q: { name?: string | null }) {
    this.finds.push(q);
    return this.cards.filter((c) => c.name.toLowerCase() === q.name?.toLowerCase());
  }
  async get(id: string) {
    this.gets.push(id);
    return this.cards.find((c) => c.id === id) ?? null;
  }
}

async function cardsOn(opts: Parameters<typeof setup>[0] = {}) {
  const pokemon = new FakeCatalog([PIKACHU]);
  const magic = new FakeCatalog([BOLT]);
  const s = await setup({ cards: { pokemon, magic }, ...opts });
  const ann = await s.user("ann");
  return { ...s, ann, pokemon, magic };
}

const readPhoto = async (u: User, game?: string) => {
  const form = new FormData();
  form.set("photo", new File([await photo()], "card.jpg"));
  if (game) form.set("game", game);
  return u.as("/api/v1/cards/read", { method: "POST", body: form });
};

describe("trading cards", () => {
  it("are off until the server admin switches them on", async () => {
    const { ann } = await cardsOn({ ai: new FakeAi([{}]) });
    expect(await features(ann)).toMatchObject({ cards: [] });
    expect((await ann.as("/api/v1/cards/search?game=pokemon&q=Pikachu")).status).toBe(409);
    expect((await readPhoto(ann)).status).toBe(409);
    expect(await json(send(ann, "PUT", "/api/v1/server/cards", { enabled: true }))).toMatchObject({ available: true, enabled: true });
    expect(await features(ann)).toEqual(expect.objectContaining({ cards: ["pokemon", "magic"], cardPhotos: true }));
  });

  it("read a photo of a card in the background, then offer the catalog's matching cards", async () => {
    const ai = new FakeAi([{ game: "pokemon", name: "Pikachu", number: "025", setTotal: "165", setCode: null }]);
    const { ann, jobs, files, pokemon } = await cardsOn({ ai });
    await send(ann, "PUT", "/api/v1/server/cards", { enabled: true });
    const started = await readPhoto(ann);
    expect(started.status).toBe(202);
    const { id } = await json<{ id: string }>(started);
    expect(await json<CardReadStatus>(ann.as(`/api/v1/cards/read/${id}`))).toMatchObject({ status: "pending" });
    await jobs.drain();
    const done = await json<CardReadStatus>(ann.as(`/api/v1/cards/read/${id}`));
    expect(done).toMatchObject({ status: "done", read: { game: "pokemon", name: "Pikachu", number: "025", setTotal: "165" } });
    expect(done.candidates?.map((c) => c.id)).toEqual([PIKACHU.id]);
    expect(pokemon.finds[0]).toMatchObject({ name: "Pikachu", number: "025", setTotal: "165" });
    expect(ai.calls[0]!.image).toBe("image/jpeg");
    // The photo was only for reading.
    const me = await json<{ activeHouseholdId: string }>(ann.as("/api/v1/me"));
    expect(await files.get(me.activeHouseholdId, cardPhotoKey(me.activeHouseholdId, id))).toBeNull();
    // Someone else's reading isn't theirs to see.
    const bob = await (await cardsOn()).user("bob");
    expect((await bob.as(`/api/v1/cards/read/${id}`)).status).toBe(404);
  });

  it("go by the game chosen, and leave a card nobody can read without candidates", async () => {
    const ai = new FakeAi([{ game: "pokemon", name: "Lightning Bolt", number: "146", setTotal: null, setCode: "M10" }, { game: null, name: null, number: null, setTotal: null, setCode: null }]);
    const { ann, jobs } = await cardsOn({ ai });
    await send(ann, "PUT", "/api/v1/server/cards", { enabled: true });
    const chosen = await json<{ id: string }>(readPhoto(ann, "magic"));
    await jobs.drain();
    expect(ai.calls[0]!.prompt).toContain("Magic: The Gathering");
    expect((await json<CardReadStatus>(ann.as(`/api/v1/cards/read/${chosen.id}`))).candidates?.map((c) => c.id)).toEqual([BOLT.id]);
    const blank = await json<{ id: string }>(readPhoto(ann));
    await jobs.drain();
    expect(await json<CardReadStatus>(ann.as(`/api/v1/cards/read/${blank.id}`))).toMatchObject({ status: "done", candidates: [] });
  });

  it("search what's typed", async () => {
    const { ann, magic } = await cardsOn({ ai: new FakeAi([{}]) });
    await send(ann, "PUT", "/api/v1/server/cards", { enabled: true });
    const found = await json<{ data: CardInfo[] }>(ann.as(`/api/v1/cards/search?game=magic&q=${encodeURIComponent("Lightning Bolt M10 146")}`));
    expect(found.data.map((c) => c.id)).toEqual([BOLT.id]);
    expect(magic.finds[0]).toMatchObject({ name: "Lightning Bolt", setCode: "M10", number: "146" });
  });

  it("price a card thing in the household's currency and finish, and keep the card's picture as its photo", async () => {
    const downloader = new FakeDownloader();
    downloader.files.set(PIKACHU.imageLarge!, await photo());
    const { ann } = await cardsOn({ downloader });
    await send(ann, "PUT", "/api/v1/server/cards", { enabled: true });
    const card = await ann.addItem({ name: "Pikachu", card: { game: "pokemon", id: PIKACHU.id, finish: "Reverse holofoil" } });
    expect((await json<{ card: unknown }>(ann.as(`/api/v1/items/${card.id}`))).card).toEqual({ game: "pokemon", id: PIKACHU.id, finish: "Reverse holofoil" });
    expect(await json(ann.as(`/api/v1/items/${card.id}/card`))).toMatchObject({ info: { name: "Pikachu" }, price: { cents: 76, currency: "USD", source: "TCGplayer" } });
    expect((await send(ann, "POST", `/api/v1/items/${card.id}/card/photo`)).status).toBe(201);
    const page = await json<{ photoId: string | null }>(ann.as(`/api/v1/items/${card.id}`));
    expect(page.photoId).toBeTruthy();
    // A thing that isn't a card has no card.
    const mug = await ann.addItem({ name: "Mug" });
    expect(await json(ann.as(`/api/v1/items/${mug.id}/card`))).toEqual({ card: null, info: null, price: null });
    expect((await send(ann, "POST", `/api/v1/items/${mug.id}/card/photo`)).status).toBe(422);
  });

  it("list a collection's cards beside today's prices, fetching the old ones in the background", async () => {
    const { ann, jobs, pokemon } = await cardsOn();
    await send(ann, "PUT", "/api/v1/server/cards", { enabled: true });
    const binder = await json<{ id: string }>(send(ann, "POST", "/api/v1/collections", { name: "Binder" }));
    await ann.addItem({ name: "Pikachu", valueCents: 10, collectionId: binder.id, card: { game: "pokemon", id: PIKACHU.id } });
    await ann.addItem({ name: "Not a card", collectionId: binder.id });
    const first = await json<{ data: CardValue[]; checking: number }>(ann.as(`/api/v1/cards/values?collectionId=${binder.id}`));
    expect(first).toMatchObject({ checking: 1, data: [{ name: "Pikachu", valueCents: 10, price: null }] });
    await jobs.drain();
    expect(pokemon.gets).toContain(PIKACHU.id);
    const then = await json<{ data: CardValue[]; checking: number }>(ann.as(`/api/v1/cards/values?collectionId=${binder.id}`));
    expect(then).toMatchObject({ checking: 0, data: [{ name: "Pikachu", price: { cents: 28, currency: "USD" } }] });
  });
});

describe("card helpers", () => {
  it("read what's typed", () => {
    expect(parseCardQuery("Pikachu 025/165", "pokemon")).toEqual({ name: "Pikachu", number: "025", setTotal: "165", setCode: null });
    expect(parseCardQuery("Pikachu ex 25", "pokemon")).toEqual({ name: "Pikachu ex", number: "25", setTotal: null, setCode: null });
    expect(parseCardQuery("Lightning Bolt M10 146", "magic")).toEqual({ name: "Lightning Bolt", number: "146", setTotal: null, setCode: "M10" });
    expect(parseCardQuery("Charizard", "pokemon")).toEqual({ name: "Charizard", number: null, setTotal: null, setCode: null });
  });

  it("pick the price for a finish and currency", () => {
    expect(priceFor(PIKACHU, "Reverse holofoil", "USD")?.cents).toBe(76);
    expect(priceFor(PIKACHU, null, "USD")?.cents).toBe(28);
    expect(priceFor(PIKACHU, null, "EUR")?.source).toBe("Cardmarket");
    expect(priceFor(PIKACHU, "Holofoil", "USD")).toBeNull(); // not that finish's price
    expect(priceFor(PIKACHU, null, "PLN")).toBeNull();
  });

  it("turn TCGdex's answer into a card", () => {
    expect(finishName("reverse-holofoil")).toBe("Reverse holofoil");
    expect(finishName("1stEditionHolofoil")).toBe("1st edition holofoil");
    expect(pricesOf({ tcgplayer: { unit: "USD", normal: { marketPrice: 0.28, productId: 1 } }, cardmarket: { unit: "EUR", trend: 0.16, "trend-holo": 0.66 } })).toEqual([
      { finish: "Normal", currency: "USD", cents: 28, source: "TCGplayer" },
      { finish: "Normal", currency: "EUR", cents: 16, source: "Cardmarket" },
      { finish: "Holofoil", currency: "EUR", cents: 66, source: "Cardmarket" },
    ]);
    const c = tcgdexCard({ id: "sv03.5-025", localId: "025", name: "Pikachu", image: "https://assets.tcgdex.net/x", rarity: "None", set: { id: "sv03.5", name: "151", cardCount: { official: 165 } }, variants: { normal: true, reverse: true, holo: false }, pricing: { tcgplayer: { normal: { productId: 7, marketPrice: 1 } } } });
    expect(c).toMatchObject({ rarity: null, setTotal: 165, finishes: ["Normal", "Reverse holofoil"], image: "https://assets.tcgdex.net/x/low.webp", url: "https://www.tcgplayer.com/product/7" });
  });

  it("turn Scryfall's answer into a card, the front face of a two-faced one", () => {
    const c = scryfallCard({ id: "x", name: "Delver of Secrets // Insectile Aberration", set: "isd", set_name: "Innistrad", collector_number: "51", rarity: "common", finishes: ["nonfoil", "foil"], prices: { usd: "1.20", usd_foil: null, eur: "0.90" }, card_faces: [{ image_uris: { normal: "https://cards.scryfall.io/n.jpg", large: "https://cards.scryfall.io/l.jpg" } }], scryfall_uri: "https://scryfall.com/card/isd/51?utm_source=api" });
    expect(c).toMatchObject({ setCode: "ISD", rarity: "Common", finishes: ["Normal", "Foil"], image: "https://cards.scryfall.io/n.jpg", imageLarge: "https://cards.scryfall.io/l.jpg", url: "https://scryfall.com/card/isd/51" });
    expect(c.prices).toEqual([
      { finish: "Normal", currency: "USD", cents: 120, source: "TCGplayer" },
      { finish: "Normal", currency: "EUR", cents: 90, source: "Cardmarket" },
    ]);
  });

  it("ask Scryfall for the exact printing when the set and number were read", async () => {
    const urls: string[] = [];
    const fetcher = (async (input: string | URL | Request) => {
      urls.push(String(input));
      return Response.json({ id: "b", name: "Lightning Bolt", set: "m10", set_name: "Magic 2010", collector_number: "146", prices: {}, image_uris: {} });
    }) as typeof fetch;
    const found = await new ScryfallCards(fetcher).find({ name: "Lightning Bolt", setCode: "M10", number: "0146" });
    expect(urls).toEqual(["https://api.scryfall.com/cards/m10/146"]);
    expect(found.map((c) => c.id)).toEqual(["b"]);
  });

  it("ask TCGdex for the exact name and number, and put the printed set size first", async () => {
    const urls: string[] = [];
    const card = (id: string, total: number) => ({ id, localId: "025", name: "Pikachu", set: { id: id.split("-")[0], name: id, cardCount: { official: total } } });
    const fetcher = (async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("/cards?")) return Response.json([{ id: "a-025", localId: "025", name: "Pikachu" }, { id: "b-025", localId: "025", name: "Pikachu" }, { id: "c-125", localId: "125", name: "Pikachu" }]);
      return Response.json(url.endsWith("a-025") ? card("a-025", 100) : card("b-025", 165));
    }) as typeof fetch;
    const found = await new TcgdexCards(fetcher).find({ name: "Pikachu", number: "025", setTotal: "165" });
    expect(decodeURIComponent(urls[0]!)).toContain("name=eq:Pikachu&localId=25");
    expect(found.map((c) => c.id)).toEqual(["b-025", "a-025"]);
  });
});
