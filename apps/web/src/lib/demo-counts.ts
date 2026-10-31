/**
 * The public demo's counts that only the browser sees (server lib/analytics.ts, POST /api/v1/usage): a visit and its
 * `?ref=`, the app installed, coming back after a day or a week, "Run your own". Off unless the server is the demo
 * (`startCounting`, from Demo.tsx), so a home Ferret never sends them. Nothing about who.
 */
type BrowserEvent = "visit" | "install" | "return.d1" | "return.d7" | "self_host.click";

let counting = false;

export function countUsage(event: BrowserEvent, ref?: string) {
  if (!counting) return;
  const body = JSON.stringify({ event, ...(ref && { ref }) });
  void fetch("/api/v1/usage", { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true }).catch(() => {});
}

const read = (store: Storage, key: string) => {
  try {
    return store.getItem(key);
  } catch {
    return null;
  }
};
const write = (store: Storage, key: string, value: string) => {
  try {
    store.setItem(key, value);
  } catch {
    // private mode: counted again next time, which is fine
  }
};

const DAY = 86_400_000;

/** Once per page load on the demo: the visit (once per browser session), install and returns (once per device). */
export function startCounting() {
  if (counting) return;
  counting = true;
  if (!read(sessionStorage, "ferret.demo.visit")) {
    write(sessionStorage, "ferret.demo.visit", "1");
    countUsage("visit", new URLSearchParams(location.search).get("ref") ?? undefined);
  }
  const standalone = matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
  if (standalone && !read(localStorage, "ferret.demo.installed")) {
    write(localStorage, "ferret.demo.installed", "1");
    countUsage("install");
  }
  const first = Number(read(localStorage, "ferret.demo.firstSeen")) || 0;
  if (!first) return write(localStorage, "ferret.demo.firstSeen", String(Date.now()));
  const away = Date.now() - first;
  for (const [event, after] of [["return.d1", DAY], ["return.d7", 7 * DAY]] as const) {
    if (away >= after && !read(localStorage, `ferret.demo.${event}`)) {
      write(localStorage, `ferret.demo.${event}`, "1");
      countUsage(event);
    }
  }
}
