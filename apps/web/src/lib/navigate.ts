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

/**
 * Back as people mean it: to the screen they came from when it's one of Ferret's (the router numbers its entries —
 * router.tsx stampEntry), else — a link opened fresh, a label scanned — to `parent`, replacing this entry so Back from
 * there doesn't come here again.
 */
export function goBack(parent: string) {
  if ((window.history.state?.__TSR_index ?? 0) > 0) window.history.back();
  else navigateTo(parent, { replace: true });
}
