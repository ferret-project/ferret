/**
 * YouTube links (how-to videos on maintenance tasks): the video id from any of the usual link shapes, and the few
 * addresses Ferret builds from it. Only the 11-character id is ever stored.
 */

const ID = /^[A-Za-z0-9_-]{11}$/;

/** The video id in a YouTube link (watch, youtu.be, shorts, embed, live, the mobile site), or a bare id; else null. */
export function youtubeId(input: string): string | null {
  const text = input.trim();
  if (ID.test(text)) return text;
  // (No URL here: this package runs without the browser's or Node's types.)
  const m = /^(?:https?:\/\/)?(?:(?:www|m|music)\.)?(youtu\.be|youtube\.com|youtube-nocookie\.com)(\/[^?#]*)?(\?[^#]*)?/i.exec(text);
  if (!m) return null;
  const host = m[1]!.toLowerCase();
  const [, first, second] = (m[2] ?? "/").split("/");
  let id: string | undefined;
  if (host === "youtu.be") id = first;
  else if (first === "watch") id = /[?&]v=([^&]+)/.exec(m[3] ?? "")?.[1];
  else if (["shorts", "embed", "live", "v"].includes(first ?? "")) id = second;
  return id && ID.test(id) ? id : null;
}

export const youtubeWatchUrl = (id: string) => `https://www.youtube.com/watch?v=${id}`;
/** The small picture YouTube keeps for every video (320×180). */
export const youtubeThumbnail = (id: string) => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
/** The privacy-enhanced player: no cookies until it's played. */
export const youtubeEmbedUrl = (id: string) => `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0&playsinline=1`;
/** YouTube's own search, for servers without a YouTube key. */
export const youtubeSearchUrl = (query: string) => `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;

/** 754 → "12:34", 3723 → "1:02:03". */
export function videoLength(seconds: number) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const two = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}
