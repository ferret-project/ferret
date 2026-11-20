/**
 * endoflife.date (open data, MIT): when devices stop getting software and security updates — phones, tablets,
 * watches, e-readers, streaming sticks, Surface, Raspberry Pi… No key, plain fetch; nothing about a household is sent
 * (Ferret downloads the device lists and matches things itself).
 */
import type { SupportLifecycles } from "../../ports";
import type { SupportRelease } from "../../db/schema/inventory";

const API = "https://endoflife.date/api/v1";
const USER_AGENT = "Ferret/1 (https://github.com/ferret-project/ferret)";

type Release = { name: string; label?: string | null; releaseDate?: string | null; isEol?: boolean | null; eolFrom?: string | null };

export function toRelease(r: Release): SupportRelease {
  return { name: r.name, label: r.label?.trim() || r.name, releaseDate: r.releaseDate ?? null, eolFrom: r.eolFrom ?? null, isEol: Boolean(r.isEol) };
}

export class EndOfLife implements SupportLifecycles {
  constructor(private readonly fetcher: typeof fetch = (input, init) => fetch(input, init)) {}

  private async json<T>(path: string): Promise<T | null> {
    const res = await this.fetcher(`${API}${path}`, { headers: { Accept: "application/json", "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(20_000) });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`endoflife.date: HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  async devices() {
    const body = await this.json<{ result?: { name: string; label: string; category: string }[] }>("/products");
    return (body?.result ?? []).filter((p) => p.category === "device").map((p) => ({ name: p.name, label: p.label }));
  }

  async releases(product: string) {
    const body = await this.json<{ result?: { label: string; releases?: Release[] } }>(`/products/${encodeURIComponent(product)}`);
    if (!body?.result) return null;
    return { label: body.result.label, releases: (body.result.releases ?? []).map(toRelease) };
  }
}
