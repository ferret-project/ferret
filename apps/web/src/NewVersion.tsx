/**
 * "A new version of Ferret is ready — Reload": Ferret is one page, so a tab left open across an update keeps running
 * the version it loaded. When the tab comes back into view (and every 15 minutes while it's in view), it asks the
 * server for the build's file list (precache.json, written by the build: vite.config.ts) and offers a reload when its
 * own script isn't in it any more. Development (Vite) has no list, so never shows it.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useEffect, useState } from "react";

const EVERY = 15 * 60_000;

/** The script this page was started from (`/assets/index-<hash>.js`), or null in development. */
function runningScript(): string | null {
  const src = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/"]')?.src;
  return src ? new URL(src).pathname : null;
}

async function newerOnServer(mine: string): Promise<boolean> {
  try {
    const res = await fetch("/precache.json", { cache: "no-store" });
    if (!res.ok) return false;
    const { files } = (await res.json()) as { files?: string[] };
    return Array.isArray(files) && files.length > 0 && !files.includes(mine);
  } catch {
    return false; // no signal: ask again later
  }
}

export function NewVersion() {
  const [ready, setReady] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const mine = runningScript();
    if (!mine || ready) return;
    let last = Date.now();
    const check = () => {
      if (document.visibilityState !== "visible" || !navigator.onLine) return;
      last = Date.now();
      void newerOnServer(mine).then((newer) => newer && setReady(true));
    };
    const onVisible = () => {
      if (Date.now() - last > 60_000) check();
    };
    const timer = window.setInterval(check, EVERY);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", check);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", check);
    };
  }, [ready]);

  if (!ready || dismissed) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-30 flex justify-center px-3 sm:bottom-4 print:hidden">
      <div className="alert pointer-events-auto flex w-auto max-w-md items-center gap-3 border border-base-300 bg-base-100 py-2 text-sm shadow-lg" role="status">
        <span className="icon-[tabler--refresh] size-5 shrink-0 text-primary" />
        <span className="text-base-content">
          <Trans>A new version of Ferret is ready.</Trans>
        </span>
        <button type="button" className="btn btn-primary btn-sm min-h-11" onClick={() => window.location.reload()}>
          <Trans>Reload</Trans>
        </button>
        <button type="button" className="btn btn-text btn-sm btn-square min-h-11 min-w-11" aria-label={t`Not now`} onClick={() => setDismissed(true)}>
          <span className="icon-[tabler--x] size-4" />
        </button>
      </div>
    </div>
  );
}
