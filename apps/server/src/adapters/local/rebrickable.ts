/**
 * Rebrickable (rebrickable.com): LEGO sets by number or name, with a picture, year, theme and piece count. Needs the
 * server admin's free key (`Authorization: key …`); plain fetch, so the Workers runtime uses it too. Only what was
 * typed or read off a box is sent.
 */
import type { CollectibleInfo } from "@ferret/shared";
import { CatalogKeyError, CatalogLimitError, type CollectibleCatalog } from "../../ports";

const API = "https://rebrickable.com/api/v3/lego";
const USER_AGENT = "Ferret/1 ( https://github.com/ferret-project/ferret )";
/** Themes rarely change: asked once a day. */
const THEMES_MS = 24 * 60 * 60 * 1000;

type RbSet = { set_num: string; name: string; year?: number; theme_id?: number; num_parts?: number; set_img_url?: string | null; set_url?: string | null };
type Theme = { id: number; parent_id: number | null; name: string };

/** "75192" → "75192-1" (Rebrickable numbers a set's versions); a typed "75192-2" stays. */
export const setNumberOf = (text: string) => {
  const m = text.trim().match(/^(\d{3,7})(?:-(\d{1,2}))?$/);
  return m ? `${m[1]}-${m[2] ?? "1"}` : null;
};

/**
 * Rebrickable lists matches by set number; people mean the set called what they typed: that name exactly first, then
 * names starting with it, the rest after — newer sets first within each, gear with no bricks (bags, key chains) last.
 */
export function rankSets(sets: RbSet[], text: string) {
  const q = text.trim().toLowerCase();
  const tier = (s: RbSet) => (!s.num_parts ? 3 : s.name.toLowerCase() === q ? 0 : s.name.toLowerCase().startsWith(q) ? 1 : 2);
  return [...sets].sort((a, b) => tier(a) - tier(b) || (b.year ?? 0) - (a.year ?? 0));
}

export function toSet(s: RbSet, themes: Map<number, Theme>): CollectibleInfo {
  const theme = s.theme_id != null ? themes.get(s.theme_id) : undefined;
  const parent = theme?.parent_id != null ? themes.get(theme.parent_id) : undefined;
  return {
    kind: "lego",
    id: s.set_num,
    name: s.name,
    year: s.year ?? null,
    setNumber: s.set_num.replace(/-1$/, ""),
    theme: theme ? [parent?.name, theme.name].filter(Boolean).join(" › ") : null,
    pieces: s.num_parts || null,
    image: s.set_img_url ?? null,
    imageLarge: s.set_img_url ?? null,
    url: s.set_url ?? null,
  };
}

export class RebrickableSets implements CollectibleCatalog {
  private themes: { at: number; map: Map<number, Theme> } | null = null;
  constructor(private readonly fetcher: typeof fetch = (input, init) => fetch(input, init)) {}

  private async json<T>(key: string, path: string): Promise<T | null> {
    const res = await this.fetcher(`${API}${path}`, { headers: { Accept: "application/json", Authorization: `key ${key}`, "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(20_000) });
    if (res.status === 401 || res.status === 403) throw new CatalogKeyError("Rebrickable refused the key");
    if (res.status === 429) throw new CatalogLimitError("Rebrickable: too many requests");
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Rebrickable: HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  private async themeMap(key: string) {
    if (this.themes && Date.now() - this.themes.at < THEMES_MS) return this.themes.map;
    const got = await this.json<{ results: Theme[] }>(key, "/themes/?page_size=1000").catch((err: unknown) => {
      if (err instanceof CatalogKeyError) throw err;
      return null; // a set without its theme's name beats none
    });
    if (!got) return this.themes?.map ?? new Map<number, Theme>();
    this.themes = { at: Date.now(), map: new Map(got.results.map((t) => [t.id, t])) };
    return this.themes.map;
  }

  async check(key: string) {
    try {
      return Boolean(await this.json(key, "/colors/?page_size=1"));
    } catch (err) {
      if (err instanceof CatalogKeyError) return false;
      throw err;
    }
  }

  async get(key: string, id: string) {
    const s = await this.json<RbSet>(key, `/sets/${encodeURIComponent(id)}/`);
    return s?.set_num ? toSet(s, await this.themeMap(key)) : null;
  }

  async find(key: string, q: { text: string }) {
    const text = q.text.trim();
    if (!text) return [];
    const number = setNumberOf(text);
    const [exact, found] = await Promise.all([
      number ? this.json<RbSet>(key, `/sets/${encodeURIComponent(number)}/`) : null,
      this.json<{ results: RbSet[] }>(key, `/sets/?${new URLSearchParams({ search: text, page_size: "100" })}`),
    ]);
    const themes = await this.themeMap(key);
    return [...(exact?.set_num ? [exact] : []), ...rankSets((found?.results ?? []).filter((s) => s.set_num !== exact?.set_num), text)].slice(0, 24).map((s) => toSet(s, themes));
  }
}
