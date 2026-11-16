/**
 * Opening a file (a manual, a receipt, a photo's original) in Ferret's own viewer (DocumentViewer.tsx) instead of a new
 * tab: every link to a file of Ferret's (`/api/…`, `target="_blank"`) opens it. A new tab trapped people in an app on an
 * iPhone's Home Screen — it opens Ferret's own addresses inside itself, full screen, with no Back or Done — and the
 * viewer can open a manual where a search found its words (`data-find` on the link), marked. On a computer the viewer
 * offers the browser's own tab as well (links with `data-native` are left alone).
 */
import { useSyncExternalStore } from "react";
import { isIOS, isInstalled } from "./install";

export interface OpenDocument {
  url: string;
  /** What the link said, until the server's filename is known. */
  label: string;
  /** Words to find in it: it opens at the first page that has them, marked. */
  find?: string;
  /** The passage the search found (`data-near`): it opens at the page with that passage, rather than the first. */
  near?: string;
}

let current: OpenDocument | null = null;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((l) => l());

export function openDocument(doc: OpenDocument) {
  current = doc;
  changed();
}
export function closeDocument() {
  current = null;
  changed();
}
export const useOpenDocument = () =>
  useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => current,
  );

/** True where a new tab of Ferret's own would have no way back (so the viewer offers none): an installed app on an iPhone or iPad. */
export const opensInApp = () => isInstalled() && isIOS();

/** A file of Ferret's: an attachment, or a shared report's file. */
const FILE_PATH = /^\/api\/v1\/(attachments\/[^/]+\/(content|thumbnail)|shared\/[^/]+\/files\/[^/]+)$/;

/** Catches clicks on links to Ferret's files and opens them in the viewer instead. */
export function catchFileLinks() {
  document.addEventListener(
    "click",
    (e) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || a.target !== "_blank" || a.dataset.native !== undefined || a.origin !== location.origin || !FILE_PATH.test(a.pathname)) return;
      e.preventDefault();
      openDocument({ url: a.pathname + a.search, label: a.textContent?.trim() || a.getAttribute("aria-label") || "", find: a.dataset.find || undefined, near: a.dataset.near || undefined });
    },
    true,
  );
}
