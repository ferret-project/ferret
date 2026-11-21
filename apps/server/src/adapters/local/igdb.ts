/**
 * IGDB (igdb.com, run by Twitch): video games by title, with the cover, year, platforms, publisher and genres. The
 * server admin's free key is a Twitch app's client ID and secret (pasted together); they're swapped for an app token
 * (client credentials), kept here until it nears its end. Plain fetch; only the words searched are sent.
 */
import type { CollectibleInfo } from "@ferret/shared";
import { CatalogKeyError, CatalogLimitError, type CollectibleCatalog } from "../../ports";

const API = "https://api.igdb.com/v4";
const TOKENS = "https://id.twitch.tv/oauth2/token";
const IMAGES = "https://images.igdb.com/igdb/image/upload";
const USER_AGENT = "Ferret/1 ( https://github.com/ferret-project/ferret )";
/** Games themselves: main games, standalone expansions, remakes, remasters, expanded games and ports — not DLC, bundles or mods. */
const GAME_TYPES = "(0,4,8,9,10,11)";
const FIELDS = "name,first_release_date,cover.image_id,platforms.name,involved_companies.company.name,involved_companies.publisher,genres.name,url";

type Game = {
  id: number;
  name: string;
  first_release_date?: number;
  cover?: { image_id?: string };
  platforms?: { name: string }[];
  involved_companies?: { company?: { name?: string }; publisher?: boolean }[];
  genres?: { name: string }[];
  url?: string;
};

/** "client-id secret", on two lines or one, or "client-id:secret". */
export function splitKey(key: string) {
  const [clientId, secret] = key.trim().split(/[\s:]+/);
  return clientId && secret ? { clientId, secret } : null;
}

export function toGame(g: Game): CollectibleInfo {
  const publisher = g.involved_companies?.find((c) => c.publisher)?.company?.name ?? null;
  return {
    kind: "game",
    id: String(g.id),
    name: g.name,
    year: g.first_release_date ? new Date(g.first_release_date * 1000).getUTCFullYear() : null,
    platforms: (g.platforms ?? []).map((p) => p.name),
    publisher,
    genres: (g.genres ?? []).map((x) => x.name),
    image: g.cover?.image_id ? `${IMAGES}/t_cover_small/${g.cover.image_id}.jpg` : null,
    imageLarge: g.cover?.image_id ? `${IMAGES}/t_cover_big_2x/${g.cover.image_id}.jpg` : null,
    url: g.url?.startsWith("https://") ? g.url : `https://www.igdb.com/games/${g.id}`,
  };
}

/** A game's title for IGDB's search: its quotes are the query's own. */
const quoted = (text: string) => `"${text.replace(/["\\]/g, " ").replace(/\s+/g, " ").trim()}"`;

export class IgdbGames implements CollectibleCatalog {
  private tokens = new Map<string, { token: string; until: number }>();
  constructor(private readonly fetcher: typeof fetch = (input, init) => fetch(input, init)) {}

  private async token(key: string, fresh = false) {
    const k = splitKey(key);
    if (!k) throw new CatalogKeyError("IGDB needs the client ID and the secret");
    const kept = this.tokens.get(k.clientId);
    if (!fresh && kept && kept.until > Date.now() + 60_000) return { clientId: k.clientId, token: kept.token };
    const res = await this.fetcher(TOKENS, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT },
      body: new URLSearchParams({ client_id: k.clientId, client_secret: k.secret, grant_type: "client_credentials" }),
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 400 || res.status === 401 || res.status === 403) throw new CatalogKeyError("Twitch refused the client ID or secret");
    if (!res.ok) throw new Error(`Twitch: HTTP ${res.status}`);
    const got = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!got.access_token) throw new Error("Twitch: no token in its answer");
    this.tokens.set(k.clientId, { token: got.access_token, until: Date.now() + (got.expires_in ?? 3600) * 1000 });
    return { clientId: k.clientId, token: got.access_token };
  }

  private async query(key: string, body: string, retried = false): Promise<Game[]> {
    const { clientId, token } = await this.token(key, retried);
    const res = await this.fetcher(`${API}/games`, {
      method: "POST",
      headers: { "Client-ID": clientId, Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "text/plain", "User-Agent": USER_AGENT },
      body,
      signal: AbortSignal.timeout(20_000),
    });
    // A token that ended early: ask for another once.
    if (res.status === 401 && !retried) return this.query(key, body, true);
    if (res.status === 401 || res.status === 403) throw new CatalogKeyError("IGDB refused the key");
    if (res.status === 429) throw new CatalogLimitError("IGDB: too many requests");
    if (!res.ok) throw new Error(`IGDB: HTTP ${res.status}`);
    return (await res.json()) as Game[];
  }

  async check(key: string) {
    try {
      await this.query(key, "fields name; limit 1;");
      return true;
    } catch (err) {
      if (err instanceof CatalogKeyError) return false;
      throw err;
    }
  }

  async get(key: string, id: string) {
    if (!/^\d+$/.test(id)) return null;
    const [game] = await this.query(key, `fields ${FIELDS}; where id = ${id};`);
    return game ? toGame(game) : null;
  }

  async find(key: string, q: { text: string; year?: number | null }) {
    const text = q.text.trim();
    if (!text) return [];
    const found = (await this.query(key, `search ${quoted(text)}; fields ${FIELDS}; where game_type = ${GAME_TYPES}; limit 20;`)).map(toGame);
    return q.year ? [...found.filter((g) => g.year === q.year), ...found.filter((g) => g.year !== q.year)] : found;
  }
}
