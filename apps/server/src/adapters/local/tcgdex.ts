/**
 * TCGdex (tcgdex.dev, open source): Pokémon cards by name and number, with TCGplayer (USD) and Cardmarket (EUR) prices
 * and a picture of each card. No key, plain fetch; only what's printed on the card (name, number) is sent.
 */
import type { CardInfo, CardPrice } from "@ferret/shared";
import type { CardCatalog } from "../../ports";

const API = "https://api.tcgdex.net/v2/en";
const USER_AGENT = "Ferret/1 ( https://github.com/ferret-project/ferret )";
/** Cards whose details are fetched for one question (each is a request). */
const MAX = 10;

type Brief = { id: string; localId: string; name: string; image?: string };
type Card = Brief & {
  rarity?: string | null;
  set?: { id?: string; name?: string; cardCount?: { official?: number; total?: number } };
  variants?: Record<string, boolean | undefined>;
  pricing?: {
    tcgplayer?: Record<string, unknown> & { unit?: string };
    cardmarket?: Record<string, unknown> & { unit?: string };
  } | null;
};

/** "reverse-holofoil" → "Reverse holofoil", "1stEditionHolofoil" → "1st edition holofoil". */
export function finishName(key: string) {
  const words = key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[-_]/g, " ")
    .toLowerCase()
    .trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const VARIANTS: Record<string, string> = { normal: "Normal", holo: "Holofoil", reverse: "Reverse holofoil", firstEdition: "1st edition" };

const toCents = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null);

export function pricesOf(pricing: Card["pricing"]): CardPrice[] {
  const prices: CardPrice[] = [];
  for (const [key, value] of Object.entries(pricing?.tcgplayer ?? {})) {
    if (key === "unit" || key === "updated" || !value || typeof value !== "object") continue;
    const p = value as { marketPrice?: number | null; midPrice?: number | null };
    const cents = toCents(p.marketPrice) ?? toCents(p.midPrice);
    if (cents) prices.push({ finish: finishName(key), currency: "USD", cents, source: "TCGplayer" });
  }
  const cm = pricing?.cardmarket;
  if (cm) {
    const normal = toCents(cm.trend) ?? toCents(cm.avg);
    if (normal) prices.push({ finish: "Normal", currency: "EUR", cents: normal, source: "Cardmarket" });
    const holo = toCents(cm["trend-holo"]) ?? toCents(cm["avg-holo"]);
    if (holo) prices.push({ finish: "Holofoil", currency: "EUR", cents: holo, source: "Cardmarket" });
  }
  return prices;
}

export function toCard(c: Card): CardInfo {
  const tcgplayer = Object.values(c.pricing?.tcgplayer ?? {}).find((v): v is { productId: number } => typeof (v as { productId?: unknown })?.productId === "number");
  return {
    game: "pokemon",
    id: c.id,
    name: c.name,
    set: c.set?.name ?? "",
    setCode: c.set?.id ?? c.id.split("-")[0] ?? "",
    number: c.localId,
    setTotal: c.set?.cardCount?.official ?? null,
    rarity: c.rarity && c.rarity !== "None" ? c.rarity : null,
    image: c.image ? `${c.image}/low.webp` : null,
    imageLarge: c.image ? `${c.image}/high.webp` : null,
    finishes: Object.entries(c.variants ?? {})
      .filter(([k, on]) => on && VARIANTS[k])
      .map(([k]) => VARIANTS[k]!),
    prices: pricesOf(c.pricing),
    url: tcgplayer ? `https://www.tcgplayer.com/product/${tcgplayer.productId}` : null,
  };
}

const digits = (s: string | null | undefined) => (s ?? "").replace(/^0+(?=\d)/, "").trim().toLowerCase();

export class TcgdexCards implements CardCatalog {
  constructor(private readonly fetcher: typeof fetch = (input, init) => fetch(input, init)) {}

  private async json<T>(path: string): Promise<T | null> {
    const res = await this.fetcher(`${API}${path}`, { headers: { Accept: "application/json", "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(20_000) });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`TCGdex: HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  async get(id: string): Promise<CardInfo | null> {
    const card = await this.json<Card>(`/cards/${encodeURIComponent(id)}`);
    return card?.id ? toCard(card) : null;
  }

  async find(q: { name?: string | null; number?: string | null; setTotal?: string | null }): Promise<CardInfo[]> {
    const name = q.name?.trim();
    if (!name) return [];
    const number = digits(q.number);
    const ask = async (match: string) => {
      const params = new URLSearchParams({ name: `${match}${name}` });
      if (number) params.set("localId", number);
      else params.set("pagination:itemsPerPage", String(MAX));
      return (await this.json<Brief[]>(`/cards?${params}`)) ?? [];
    };
    // The exact name first ("Pikachu", not every "Pikachu ex"), then any name containing it.
    let briefs = await ask("eq:");
    if (!briefs.length) briefs = await ask("");
    if (number) briefs = briefs.filter((b) => digits(b.localId) === number);
    const cards = (await Promise.all(briefs.slice(0, MAX).map((b) => this.get(b.id).catch(() => null)))).filter((c): c is CardInfo => c != null);
    // The set's size printed after the number ("025/198") picks the set: matching ones first.
    const total = Number(digits(q.setTotal));
    return total ? [...cards.filter((c) => c.setTotal === total), ...cards.filter((c) => c.setTotal !== total)] : cards;
  }
}
