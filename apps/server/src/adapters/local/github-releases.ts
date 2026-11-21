/**
 * Ferret's releases on GitHub: the newest one, for "a new version is out" in Settings → Server. Asked only when the
 * server admin switches it on, at most once a day; GitHub sees the server's address and nothing else.
 */
import type { Releases } from "../../ports";

const LATEST = "https://api.github.com/repos/ferret-project/ferret/releases/latest";

export class GitHubReleases implements Releases {
  constructor(
    readonly current: string,
    private readonly fetcher: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  async latest() {
    const res = await this.fetcher(LATEST, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "Ferret", "X-GitHub-Api-Version": "2022-11-28" },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub: HTTP ${res.status}`);
    const r = (await res.json()) as { tag_name?: string; name?: string | null; body?: string | null; html_url?: string; published_at?: string | null; draft?: boolean; prerelease?: boolean };
    if (!r.tag_name || r.draft || r.prerelease) return null;
    return {
      version: r.tag_name.replace(/^v/, ""),
      name: r.name?.trim() || r.tag_name,
      notes: (r.body ?? "").slice(0, 20_000),
      url: r.html_url ?? `https://github.com/ferret-project/ferret/releases/tag/${encodeURIComponent(r.tag_name)}`,
      publishedAt: r.published_at ?? new Date().toISOString(),
    };
  }
}
