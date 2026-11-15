/**
 * iFixit's public API (no key): its device search, asked with a thing's brand and model only. Ferret links to the
 * device's page and never copies its guides (they're CC BY-NC-SA). Plain fetch to a fixed address.
 */
import type { RepairGuides } from "../../ports";

export class IfixitGuides implements RepairGuides {
  async searchDevices(query: string) {
    const url = `https://www.ifixit.com/api/2.0/search/${encodeURIComponent(query)}?filter=device&limit=5`;
    const res = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "Ferret home inventory (repair guides)" }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`iFixit search: HTTP ${res.status}`);
    const body = (await res.json()) as { results?: { title?: unknown; display_title?: unknown; url?: unknown }[] };
    if (!Array.isArray(body.results)) throw new Error("iFixit search: unexpected answer");
    return body.results.flatMap((r) => {
      const title = typeof r.display_title === "string" && r.display_title.trim() ? r.display_title.trim() : typeof r.title === "string" ? r.title.trim() : "";
      // Only links to iFixit's own pages are ever shown.
      const link = typeof r.url === "string" && r.url.startsWith("https://www.ifixit.com/") ? r.url : null;
      return title && link ? [{ title, url: link }] : [];
    });
  }
}
