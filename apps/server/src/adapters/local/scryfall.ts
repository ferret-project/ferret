/**
 * Scryfall (scryfall.com): Magic: The Gathering cards by name, set and collector number, with TCGplayer (USD) and
 * Cardmarket (EUR) prices and a picture of each printing. No key; Scryfall asks for a User-Agent, an Accept header and
 * no more than about ten requests a second, so calls here wait their turn. Only what's printed on the card is sent.
 */
import type { CardInfo, CardPrice } from "@ferret/shared";
import type { CardCatalog } from "../../ports";

const API = "https://api.scryfall.com";
const USER_AGENT = "Ferret/1 ( https://github.com/ferret-project/ferret )";
const GAP_MS = 120;
const MAX = 12;

type Images = { small?: string; normal?: string; large?: string };
type Card = {
  object?: string;
  id: string;
  name: string;
  set: string;
  set_name: string;
  collector_number: string;
  rarity?: string;
  released_at?: string;
  finishes?: string[];
  prices?: Record<string, string | null | undefined>;
  image_uris?: Images;
  card_faces?: { image_uris?: Images }[];
  scryfall_uri?: string;
};

const FINISHES: Record<string, string> = { nonfoil: "Normal", foil: "Foil", etched: "Etched" };
const PRICES: { key: string; finish: string; currency: "USD" | "EUR"; source: string }[] = [
  { key: "usd", finish: "Normal", currency: "USD", source: "TCGplayer" },
  { key: "usd_foil", finish: "Foil", currency: "USD", source: "TCGplayer" },
  { key: "usd_etched", finish: "Etched", currency: "USD", source: "TCGplayer" },
  { key: "eur", finish: "Normal", currency: "EUR", source: "Cardmarket" },
  { key: "eur_foil", finish: "Foil", currency: "EUR", source: "Cardmarket" },
];

export function toCard(c: Card): CardInfo {
  const images = c.image_uris ?? c.card_faces?.[0]?.image_uris;
  const prices: CardPrice[] = PRICES.flatMap((p) => {
    const n = Number(c.prices?.[p.key]);
    return Number.isFinite(n) && n > 0 ? [{ finish: p.finish, currency: p.currency, cents: Math.round(n * 100), source: p.source }] : [];
  });
  return {
    game: "magic",
    id: c.id,
    name: c.name,
    set: c.set_name,
    setCode: c.set.toUpperCase(),
    number: c.collector_number,
    setTotal: null,
    rarity: c.rarity ? c.rarity.charAt(0).toUpperCase() + c.rarity.slice(1) : null,
    image: images?.normal ?? images?.small ?? null,
    imageLarge: images?.large ?? images?.normal ?? null,
    finishes: (c.finishes ?? []).map((f) => FINISHES[f] ?? f),
    prices,
    url: c.scryfall_uri?.replace(/\?.*$/, "") ?? null,
    released: c.released_at ?? null,
  };
}

export class ScryfallCards implements CardCatalog {
  private queue: Promise<unknown> = Promise.resolve();
  private last = 0;
  constructor(private readonly fetcher: typeof fetch = (input, init) => fetch(input, init)) {}

  private turn<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const wait = this.last + GAP_MS - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      try {
        return await work();
      } finally {
        this.last = Date.now();
      }
    });
    this.queue = run.catch(() => {});
    return run;
  }

  private async json<T>(path: string): Promise<T | null> {
    const res = await this.turn(() => this.fetcher(`${API}${path}`, { headers: { Accept: "application/json", "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(20_000) }));
    if (res.status === 404) return null; // a search with no match answers 404 too
    if (!res.ok) throw new Error(`Scryfall: HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  async get(id: string): Promise<CardInfo | null> {
    const card = await this.json<Card>(`/cards/${encodeURIComponent(id)}`);
    return card?.id ? toCard(card) : null;
  }

  async find(q: { name?: string | null; number?: string | null; setCode?: string | null }): Promise<CardInfo[]> {
    const name = q.name?.trim().replace(/"/g, "");
    const set = q.setCode?.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
    const number = q.number?.trim().replace(/^0+(?=\d)/, "").replace(/\s/g, "");
    // Set and number read off the card: that's one printing exactly.
    if (set && number) {
      const exact = await this.json<Card>(`/cards/${encodeURIComponent(set)}/${encodeURIComponent(number)}`).catch(() => null);
      if (exact?.id && (!name || exact.name.toLowerCase().includes(name.toLowerCase().split(" // ")[0]!))) return [toCard(exact)];
    }
    if (!name) return [];
    const search = async (query: string) =>
      ((await this.json<{ data?: Card[] }>(`/cards/search?${new URLSearchParams({ q: query, unique: "prints", order: "released", dir: "desc" })}`))?.data ?? []).slice(0, MAX).map(toCard);
    // Every printing of that name, the newest first; narrowed by the set if that was read.
    const found = set ? await search(`!"${name}" set:${set}`) : [];
    return found.length ? found : search(`!"${name}"`);
  }
}
