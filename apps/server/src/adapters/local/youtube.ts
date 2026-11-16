/**
 * YouTube, for how-to videos on maintenance tasks (lib/videos.ts). A pasted link is described by oEmbed (no key); with
 * `YOUTUBE_API_KEY` (YouTube Data API v3) Ferret can also search — `search.list` (100 units of the free 10,000 a day)
 * then `videos.list` for lengths (1 unit). Only the words searched for and video ids leave the server. Plain fetch
 * to fixed addresses, so it runs anywhere.
 */
import type { VideoInfo, Videos } from "../../ports";

const API = "https://www.googleapis.com/youtube/v3";
const timeout = () => AbortSignal.timeout(15_000);

/** ISO 8601 durations as YouTube writes them: "PT1H2M3S" → 3723. */
export function isoSeconds(text: string): number | null {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(text);
  if (!m || text === "P" || text === "PT") return null;
  const [, d = "0", h = "0", min = "0", s = "0"] = m;
  return Number(d) * 86400 + Number(h) * 3600 + Number(min) * 60 + Number(s);
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** YouTube's titles come HTML-escaped from the Data API ("Clean &amp; descale"). */
const unescape = (s: string) =>
  s.replace(/&(amp|lt|gt|quot|#39|#x27);/g, (_, e: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", "#x27": "'" })[e] ?? _);

export class YouTubeVideos implements Videos {
  search?: (query: string) => Promise<VideoInfo[]>;

  constructor(private readonly key?: string) {
    if (key) this.search = (query) => this.find(query);
  }

  async describe(videoId: string): Promise<VideoInfo | null> {
    if (this.key) {
      const [found] = await this.details([videoId]);
      return found ?? null;
    }
    const watch = `https://www.youtube.com/watch?v=${videoId}`;
    const res = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(watch)}`, { signal: timeout() });
    // 400/401/403/404: no such video, private, or not allowed elsewhere.
    if (res.status >= 400 && res.status < 500) return null;
    if (!res.ok) throw new Error(`YouTube oEmbed: HTTP ${res.status}`);
    const body = (await res.json()) as { title?: unknown; author_name?: unknown };
    const title = str(body.title);
    return title ? { videoId, title, channel: str(body.author_name), seconds: null } : null;
  }

  private async call(path: string, params: Record<string, string>) {
    const url = `${API}/${path}?${new URLSearchParams({ ...params, key: this.key! })}`;
    const res = await fetch(url, { headers: { Accept: "application/json" }, signal: timeout() });
    if (!res.ok) {
      // Google's reason (quotaExceeded, keyInvalid, ipRefererBlocked…) without the key, which is only in the address.
      const reason = await res
        .json()
        .then((b) => {
          const error = (b as { error?: { errors?: { reason?: string }[]; message?: string } }).error;
          return error?.errors?.[0]?.reason ?? error?.message;
        })
        .catch(() => null);
      throw new Error(`YouTube ${path}: HTTP ${res.status}${reason ? ` (${reason})` : ""}`);
    }
    return (await res.json()) as { items?: unknown[] };
  }

  private async details(ids: string[]): Promise<VideoInfo[]> {
    if (!ids.length) return [];
    const body = await this.call("videos", { part: "snippet,contentDetails,status", id: ids.join(","), maxResults: String(ids.length) });
    const byId = new Map<string, VideoInfo>();
    for (const raw of body.items ?? []) {
      const v = raw as { id?: unknown; snippet?: { title?: unknown; channelTitle?: unknown }; contentDetails?: { duration?: unknown }; status?: { embeddable?: unknown; privacyStatus?: unknown } };
      const id = str(v.id);
      const title = str(v.snippet?.title);
      if (!id || !title || v.status?.embeddable === false || v.status?.privacyStatus === "private") continue;
      const duration = str(v.contentDetails?.duration);
      byId.set(id, { videoId: id, title: unescape(title), channel: str(v.snippet?.channelTitle), seconds: duration ? isoSeconds(duration) : null });
    }
    return ids.flatMap((id) => byId.get(id) ?? []);
  }

  private async find(query: string): Promise<VideoInfo[]> {
    const body = await this.call("search", { part: "id", type: "video", videoEmbeddable: "true", safeSearch: "moderate", maxResults: "10", q: query });
    const ids = (body.items ?? []).flatMap((raw) => {
      const id = str((raw as { id?: { videoId?: unknown } }).id?.videoId);
      return id ? [id] : [];
    });
    return this.details(ids);
  }
}
