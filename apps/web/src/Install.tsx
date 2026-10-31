/**
 * "Put Ferret on your Home Screen": on the sign-in screen and the dashboard of a phone or tablet that hasn't installed
 * it. On an iPhone or iPad, how — step by step for this browser (the first button moves: Safari 26's ⋯, older Safari's
 * Share at the bottom, an iPad's or Chrome's at the top), each button drawn as it looks, and "Show me where" points an
 * arrow at it on the screen. The installed app has its own sign-in, separate from Safari's, so on the sign-in screen it
 * says to add it first. On Android, a button for the browser's install dialog. "Not now" hides it on this device for a
 * month (lib/install.ts).
 */
import { type ReactNode, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { type HomeScreenSteps, dismissInstallOffer, homeScreenSteps, install, installOfferDismissed, useInstallWay } from "./lib/install";

export function InstallOffer({ where }: { where: "sign-in" | "home" }) {
  const way = useInstallWay();
  const [hidden, setHidden] = useState(installOfferDismissed);
  if (!way || hidden) return null;
  const notNow = () => {
    dismissInstallOffer();
    setHidden(true);
  };
  const why =
    where === "sign-in"
      ? "It opens full screen, like any app, and can remind you when things are due. Add it first, then sign in there."
      : "It opens full screen, like any app, and can remind you when things are due.";
  return (
    <section className="card border border-base-300 shadow-none" aria-labelledby="install-offer-title">
      <div className="card-body gap-3 p-4">
        <div className="flex items-start gap-3">
          <img src="/apple-touch-icon.png" alt="" className="size-12 shrink-0 rounded-[0.7rem]" />
          <div className="min-w-0">
            <h2 id="install-offer-title" className="font-semibold text-base-content">
              Put Ferret on your Home Screen
            </h2>
            <p className="text-sm text-base-content/70">{why}</p>
          </div>
        </div>
        {way === "ios" && <IosSteps />}
        <div className="flex flex-wrap items-center gap-2">
          {way === "prompt" && (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => void install()}>
              <span className="icon-[tabler--download] size-4" />
              Install
            </button>
          )}
          <button type="button" className="btn btn-text btn-sm" onClick={notNow}>
            Not now
          </button>
          <a href="/docs/guide/phone.html" className="link link-hover tap ms-auto text-sm text-base-content/70">
            More about phones
          </a>
        </div>
      </div>
    </section>
  );
}

/** A browser button as it looks, to find it by. */
function Key({ icon, children }: { icon: string; children?: ReactNode }) {
  return (
    <kbd className="kbd kbd-sm inline-flex items-center gap-1 align-middle font-sans font-medium">
      <span className={`${icon} size-4 shrink-0`} aria-hidden />
      {children}
    </kbd>
  );
}

const SHARE = <Key icon="icon-[tabler--square-arrow-up]">Share</Key>;
const ADD = <Key icon="icon-[tabler--square-plus]">Add to Home Screen</Key>;

function stepsFor(s: HomeScreenSteps): ReactNode[] {
  const add = [
    <>Scroll down and tap {ADD} — if it isn't there, tap <strong>Edit Actions</strong> or <strong>More</strong> first.</>,
    <>Tap <strong>Add</strong>, top right.</>,
  ];
  if (s.browser === "safari" && s.first === "more") {
    // Ferret's own tab bar has a ⋯ More too: say which.
    return [<>Tap Safari's <Key icon="icon-[tabler--dots]" /> at the very bottom right, beside the address — below Ferret's tabs.</>, <>Tap {SHARE}.</>, ...add];
  }
  if (s.browser === "safari" && s.device === "iphone") return [<>Tap {SHARE} in Safari's bar at the very bottom — below Ferret's tabs.</>, ...add];
  if (s.browser === "safari") return [<>Tap {SHARE} at the top right, beside the address.</>, ...add];
  if (s.browser === "chrome") return [<>Tap {SHARE} in the address bar, top right.</>, ...add];
  if (s.browser === "firefox") {
    return [<>Tap <Key icon="icon-[tabler--menu-2]" /> {s.device === "ipad" ? "at the top right" : "at the bottom right"}.</>, <>Tap {SHARE}.</>, ...add];
  }
  return [<>Open your browser's menu and tap {SHARE}.</>, ...add];
}

function IosSteps() {
  const s = homeScreenSteps();
  const [pointing, setPointing] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      <ol className="space-y-2 text-sm text-base-content/80">
        {stepsFor(s).map((step, i) => (
          <li key={i} className="flex items-start gap-2">
            <span className="badge badge-soft badge-primary badge-sm mt-0.5 shrink-0">{i + 1}</span>
            <span>{step}</span>
          </li>
        ))}
      </ol>
      {s.where.startsWith("bottom") && s.device === "iphone" && (
        <p className="text-xs text-base-content/70">No bar at the bottom? Tap the very bottom of the screen and it comes back.</p>
      )}
      <button type="button" className="btn btn-soft btn-primary btn-sm self-start" onClick={() => setPointing(true)}>
        <span className="icon-[tabler--hand-finger] size-4" />
        Show me where
      </button>
      {pointing && <PointAt steps={s} onDone={() => setPointing(false)} />}
    </div>
  );
}

/**
 * An arrow at the screen's edge, pointing at the browser's button, for a few seconds (or until tapped). The page —
 * Ferret's tab bar too, whose More is also ⋯ — is dimmed meanwhile, so it's clearly the browser's button, beyond it.
 */
function PointAt({ steps, onDone }: { steps: HomeScreenSteps; onDone: () => void }) {
  const { where, first, browser } = steps;
  useEffect(() => {
    const t = setTimeout(onDone, 8000);
    return () => clearTimeout(t);
  }, [onDone]);
  const up = where === "top-end";
  const place =
    where === "top-end"
      ? "top-[calc(env(safe-area-inset-top)+0.25rem)] end-3 items-end"
      : where === "bottom-end"
        ? "bottom-[calc(env(safe-area-inset-bottom)+0.25rem)] end-3 items-end"
        : "bottom-[calc(env(safe-area-inset-bottom)+0.25rem)] start-1/2 -translate-x-1/2 items-center";
  const whose = { safari: "Safari's", chrome: "Chrome's", firefox: "Firefox's", other: "The browser's" }[browser];
  const button = first === "more" ? "⋯ button" : first === "menu" ? "☰ menu" : "Share button";
  const label = `${whose} ${button} is just ${up ? "above" : "below"} here`;
  return createPortal(
    <button type="button" onClick={onDone} className="fixed inset-0 z-[90] bg-base-300/80" aria-label={`${label} (tap to hide)`}>
      <span className={`absolute flex flex-col gap-1 ${place}`}>
        {up && <span className="icon-[tabler--arrow-big-up-filled] size-12 animate-bounce text-primary drop-shadow-lg motion-reduce:animate-none" />}
        <span className="max-w-60 rounded-box bg-primary px-3 py-2 text-sm font-semibold text-primary-content shadow-lg">{label}</span>
        {!up && <span className="icon-[tabler--arrow-big-down-filled] size-12 animate-bounce text-primary drop-shadow-lg motion-reduce:animate-none" />}
      </span>
    </button>,
    document.body,
  );
}
