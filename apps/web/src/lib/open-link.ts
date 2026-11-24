/**
 * `web+ferret:` links (the manifest's `protocol_handlers`): the installed web app is the handler, so another app on the
 * device (Ferret Menu on a Mac) can open a page in it rather than in a browser tab. The link holds the page's full
 * address — `web+ferret:https://ferret.example.com/#/items/abc`, or that address percent-encoded (so nothing on the way
 * can drop its `#…`) — and arrives as `/?open=<that link>`.
 *
 * Only a page on this Ferret is opened: with several Ferrets installed, the device may hand a link to the wrong one,
 * which then just opens at its home screen rather than going anywhere else.
 */
export function routeFromLink(link: string, origin: string): string | null {
  let inner = /^web\+ferret:(.*)$/is.exec(link.trim())?.[1];
  if (!inner) return null;
  let url: URL;
  try {
    if (!inner.includes("://")) inner = decodeURIComponent(inner);
    url = new URL(inner);
  } catch {
    return null;
  }
  if (url.origin !== origin || !url.hash.startsWith("#/")) return null;
  return url.hash;
}

/** Turns `/?open=…` into the page it names (before the router reads the address), and drops it from the address. */
export function takeOpenLink() {
  const params = new URLSearchParams(location.search);
  const link = params.get("open");
  if (link === null) return;
  params.delete("open");
  const search = params.toString();
  const route = routeFromLink(link, location.origin) ?? location.hash;
  history.replaceState(null, "", location.pathname + (search ? `?${search}` : "") + route);
}

takeOpenLink();
