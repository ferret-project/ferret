/**
 * Installing Ferret on a phone (Install.tsx shows the offer). iOS has no install API: the offer says how (Share → Add
 * to Home Screen). Chrome/Edge on Android fire `beforeinstallprompt`, kept here from the first page load (it comes
 * once, early) so the offer's button can open the browser's own install dialog.
 */
import { useSyncExternalStore } from "react";

type InstallPromptEvent = Event & { prompt(): Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };

let deferred: InstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((l) => l());

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault(); // the offer is ours, not the browser's bar
  deferred = e as InstallPromptEvent;
  changed();
});
window.addEventListener("appinstalled", () => {
  deferred = null;
  changed();
});

/** Opened from the Home Screen (or as an installed app). */
export const isInstalled = () =>
  window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;

/** An iPhone or iPad (iPadOS says it's a Mac, but a Mac has no touch screen). */
export const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);

/**
 * Where "Add to Home Screen" is on this iPhone or iPad — it moves between browsers and versions:
 * - Safari 26 on an iPhone: the ⋯ button at the right of the address bar (at the bottom) → Share → Add to Home Screen;
 * - older Safari on an iPhone: Share, in the bar at the bottom;
 * - Safari on an iPad: Share, at the top right;
 * - Chrome: Share, in the address bar at the top right; Firefox: the ☰ menu at the bottom right → Share.
 * `where` is where on the screen that first button is, for the "Show me where" arrow.
 */
export interface HomeScreenSteps {
  browser: "safari" | "chrome" | "firefox" | "other";
  device: "iphone" | "ipad";
  first: "more" | "share" | "menu";
  where: "bottom-end" | "bottom-center" | "top-end";
}

export function homeScreenSteps(ua = navigator.userAgent): HomeScreenSteps {
  const device = /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? "ipad" : "iphone";
  if (/CriOS\//.test(ua)) return { browser: "chrome", device, first: "share", where: "top-end" };
  if (/FxiOS\//.test(ua)) return { browser: "firefox", device, first: "menu", where: device === "ipad" ? "top-end" : "bottom-end" };
  if (/EdgiOS\/|OPiOS\/|DuckDuckGo/.test(ua)) return { browser: "other", device, first: "share", where: "bottom-center" };
  if (device === "ipad") return { browser: "safari", device, first: "share", where: "top-end" };
  // Safari's own version (iOS 26 keeps saying "OS 18_6" in the user agent, but Version/ is Safari's).
  const version = Number(/Version\/(\d+)/.exec(ua)?.[1] ?? 0);
  return version >= 26 ? { browser: "safari", device, first: "more", where: "bottom-end" } : { browser: "safari", device, first: "share", where: "bottom-center" };
}

/** Apps' own browsers (Facebook, Instagram, the Google app…) can't add to the Home Screen. */
const inAppBrowser = () => /FBAN|FBAV|Instagram|GSA\/|Line\//.test(navigator.userAgent);

/** How Ferret can be installed here: "ios" (Share → Add to Home Screen), "prompt" (the browser's dialog), or not at all. */
export type InstallWay = "ios" | "prompt" | null;

function installWay(): InstallWay {
  if (isInstalled()) return null;
  if (deferred) return "prompt";
  return isIOS() && !inAppBrowser() ? "ios" : null;
}

export function useInstallWay(): InstallWay {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    installWay,
  );
}

/** The browser's own install dialog ("prompt" only). True if it was installed. */
export async function install() {
  const e = deferred;
  if (!e) return false;
  deferred = null; // each event can prompt once
  await e.prompt();
  const { outcome } = await e.userChoice;
  changed();
  return outcome === "accepted";
}

const DISMISSED_KEY = "ferret.installOffer.dismissed";
const QUIET_DAYS = 30;

/** "Not now": the offer stays away from this device for a month. */
export function dismissInstallOffer() {
  try {
    localStorage.setItem(DISMISSED_KEY, String(Date.now()));
  } catch {
    /* private browsing: just this visit */
  }
}

export function installOfferDismissed() {
  try {
    const at = Number(localStorage.getItem(DISMISSED_KEY));
    return Boolean(at) && Date.now() - at < QUIET_DAYS * 24 * 60 * 60 * 1000;
  } catch {
    return false;
  }
}
