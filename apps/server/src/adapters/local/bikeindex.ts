/**
 * Bike Index (bikeindex.org, a non-profit bike registry): bikes reported stolen, by serial number. No key; plain fetch;
 * only the serial is sent. Ferret never acts on anyone's Bike Index account — registering or reporting a bike is a
 * link to their site.
 */
import type { StolenBikeReport } from "@ferret/shared";
import type { StolenBikes } from "../../ports";

const API = "https://bikeindex.org/api/v3";
const USER_AGENT = "Ferret/1 ( https://github.com/ferret-project/ferret )";

type Bike = { id: number; serial?: string; manufacturer_name?: string; frame_model?: string | null; year?: number | null; stolen?: boolean; stolen_location?: string | null; date_stolen?: number | null; url?: string; thumb?: string | null };

/** Serial numbers compare as capitals, letters and digits only ("wtu 088-c0390k" = "WTU088C0390K"). */
export const serialKey = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

export function toReport(b: Bike): StolenBikeReport {
  return {
    id: String(b.id),
    serial: b.serial ?? "",
    maker: b.manufacturer_name ?? null,
    model: b.frame_model ?? null,
    year: b.year ?? null,
    stolenOn: b.date_stolen ? new Date(b.date_stolen * 1000).toISOString().slice(0, 10) : null,
    location: b.stolen_location ?? null,
    url: b.url?.startsWith("https://") ? b.url : `https://bikeindex.org/bikes/${b.id}`,
  };
}

export class BikeIndexRegistry implements StolenBikes {
  constructor(private readonly fetcher: typeof fetch = (input, init) => fetch(input, init)) {}

  async stolenWithSerial(serial: string): Promise<StolenBikeReport[]> {
    const key = serialKey(serial);
    if (key.length < 5) return [];
    const res = await this.fetcher(`${API}/search?${new URLSearchParams({ serial, stolenness: "stolen", per_page: "10" })}`, {
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`Bike Index: HTTP ${res.status}`);
    const body = (await res.json()) as { bikes?: Bike[] };
    // Bike Index also answers near misses: only this very serial counts.
    return (body.bikes ?? []).filter((b) => b.stolen && serialKey(b.serial ?? "") === key).map(toReport);
  }
}
