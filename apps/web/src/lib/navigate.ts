import type { RouterHistory } from "@tanstack/react-router";

let history: RouterHistory | null = null;

/** router.tsx hands over its history once it's made. */
export function setHistory(h: RouterHistory) {
  history = h;
}

/**
 * Open a `#/…` address in the app, through the router's history (rather than setting `location.hash`). `replace`:
 * instead of this page (Back skips it).
 */
export function navigateTo(href: string, opts: { replace?: boolean } = {}) {
  if (!history) {
    if (opts.replace) window.location.replace(href);
    else window.location.hash = href;
    return;
  }
  const path = href.replace(/^#/, "") || "/";
  if (opts.replace) history.replace(path);
  else history.push(path);
}
