/**
 * TMDB (themoviedb.org): films and TV shows by title, with the poster, year, runtime, genres, studio or network, and
 * a show's seasons. Needs the server admin's free key: an API key (sent as `api_key`, so addresses are never put in
 * errors) or a read access token (sent as a Bearer token). Plain fetch; only the words searched are sent.
 * This product uses the TMDB API but is not endorsed or certified by TMDB.
 */
import type { CollectibleInfo } from "@ferret/shared";
import { CatalogKeyError, CatalogLimitError, type CollectibleCatalog } from "../../ports";

const API = "https://api.themoviedb.org/3";
const IMAGES = "https://image.tmdb.org/t/p";
const USER_AGENT = "Ferret/1 ( https://github.com/ferret-project/ferret )";

type Brief = { id: number; media_type?: string; title?: string; name?: string; release_date?: string; first_air_date?: string; poster_path?: string | null };
type Movie = Brief & { runtime?: number | null; genres?: { name: string }[]; production_companies?: { name: string }[] };
type Show = Brief & {
  number_of_seasons?: number | null;
  episode_run_time?: number[];
  genres?: { name: string }[];
  networks?: { name: string }[];
  seasons?: { season_number: number; name: string; air_date?: string | null; poster_path?: string | null; episode_count?: number }[];
};

const yearOf = (date: string | null | undefined) => (date && /^\d{4}/.test(date) ? Number(date.slice(0, 4)) : null);
const poster = (path: string | null | undefined, size: "w185" | "w780") => (path ? `${IMAGES}/${size}${path}` : null);

/** "The Matrix 1999", "Breaking Bad (2008) season 2": the title, and a year or season if typed after it. */
export function parseVideoQuery(text: string): { title: string; year: number | null; season: number | null } {
  let rest = text.trim().replace(/\s+/g, " ");
  const s = rest.match(/[\s,–-]*\b(?:season|series|s)\s*(\d{1,2})$/i);
  const season = s ? Number(s[1]) : null;
  if (s) rest = rest.slice(0, s.index).trim();
  const y = rest.match(/\s\(?((?:19|20)\d{2})\)?$/);
  const year = y ? Number(y[1]) : null;
  if (y) rest = rest.slice(0, y.index).trim();
  return { title: rest, year, season };
}

export function toVideo(b: Brief | Movie | Show, type: "movie" | "tv"): CollectibleInfo {
  const m = b as Movie & Show;
  return {
    kind: "video",
    id: `${type}-${b.id}`,
    name: (type === "movie" ? b.title : b.name) ?? b.title ?? b.name ?? "",
    mediaType: type,
    year: yearOf(type === "movie" ? b.release_date : b.first_air_date),
    image: poster(b.poster_path, "w185"),
    imageLarge: poster(b.poster_path, "w780"),
    url: `https://www.themoviedb.org/${type}/${b.id}`,
    ...(m.genres ? { genres: m.genres.map((g) => g.name) } : {}),
    ...(type === "movie" && m.runtime ? { runtimeMin: m.runtime } : {}),
    ...(type === "tv" && m.episode_run_time?.[0] ? { runtimeMin: m.episode_run_time[0] } : {}),
    ...((type === "movie" ? m.production_companies : m.networks)?.[0] ? { studio: (type === "movie" ? m.production_companies : m.networks)![0]!.name } : {}),
    ...(type === "tv" && m.number_of_seasons ? { seasonCount: m.number_of_seasons } : {}),
    ...(type === "tv" && m.seasons
      ? { seasons: m.seasons.map((s) => ({ number: s.season_number, name: s.name, year: yearOf(s.air_date), image: poster(s.poster_path, "w185"), imageLarge: poster(s.poster_path, "w780"), episodes: s.episode_count ?? null })) }
      : {}),
  };
}

export class TmdbVideos implements CollectibleCatalog {
  constructor(private readonly fetcher: typeof fetch = (input, init) => fetch(input, init)) {}

  private async json<T>(key: string, path: string, params: Record<string, string> = {}): Promise<T | null> {
    // A read access token (a JWT) goes in the header; an API key in the address.
    const token = key.startsWith("eyJ");
    const query = new URLSearchParams({ language: "en-US", ...params, ...(token ? {} : { api_key: key }) });
    const res = await this.fetcher(`${API}${path}?${query}`, {
      headers: { Accept: "application/json", "User-Agent": USER_AGENT, ...(token ? { Authorization: `Bearer ${key}` } : {}) },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 401) throw new CatalogKeyError("TMDB refused the key");
    if (res.status === 429) throw new CatalogLimitError("TMDB: too many requests");
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`TMDB: HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  async check(key: string) {
    try {
      return Boolean(await this.json(key, "/configuration"));
    } catch (err) {
      if (err instanceof CatalogKeyError) return false;
      throw err;
    }
  }

  async get(key: string, id: string) {
    const m = id.match(/^(movie|tv)-(\d+)$/);
    if (!m) return null;
    const type = m[1] as "movie" | "tv";
    const got = await this.json<Movie | Show>(key, `/${type}/${m[2]}`);
    return got?.id ? toVideo(got, type) : null;
  }

  async find(key: string, q: { text: string; year?: number | null }) {
    const parsed = parseVideoQuery(q.text);
    if (!parsed.title) return [];
    const year = q.year ?? parsed.year;
    const got = await this.json<{ results?: Brief[] }>(key, "/search/multi", { query: parsed.title, include_adult: "false" });
    const found = (got?.results ?? []).filter((r) => r.media_type === "movie" || r.media_type === "tv").map((r) => toVideo(r, r.media_type as "movie" | "tv"));
    // A year typed or read picks the film (or the show that started then): those first.
    return year ? [...found.filter((f) => f.year === year), ...found.filter((f) => f.year !== year)] : found;
  }
}
