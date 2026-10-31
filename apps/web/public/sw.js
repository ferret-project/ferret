/*
 * Ferret's service worker: Web Push (reminders: shows the notification, opens the app where it points), and the app's
 * own files kept so it opens with no signal — for offline capture (src/lib/offline.ts).
 *
 * - What's kept: exactly the files in /precache.json (written by the build) — fetched when the app asks ("precache",
 *   once it's loaded and online), and anything no longer listed is dropped.
 * - Pages: the network first, always (so a deploy shows at once); the kept copy only when there's no signal.
 * - Your data is never kept: /api, /mcp, /calendar, the help and share links always go to the server.
 */
const SHELL = "ferret-shell-v1";
const NEVER = [/^\/api\//, /^\/mcp/, /^\/calendar\//, /^\/docs/, /^\/healthz/, /^\/[slb]\//];

async function precache() {
  const res = await fetch("/precache.json", { cache: "no-store" });
  if (!res.ok) return; // development (Vite) has none
  const { files } = await res.json();
  const cache = await caches.open(SHELL);
  const want = new Set(files.map((f) => new URL(f, self.location.origin).href));
  for (const req of await cache.keys()) if (!want.has(req.url)) await cache.delete(req);
  for (const url of want) {
    // Hashed files never change; the page ("/") and the public files are fetched afresh each time.
    const hashed = /\/assets\//.test(url);
    if (hashed && (await cache.match(url))) continue;
    const r = await fetch(url, { cache: "no-store" });
    if (r.ok) await cache.put(url, r);
  }
}

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(precache().catch(() => {}));
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) => Promise.all(names.filter((n) => n !== SHELL).map((n) => caches.delete(n)))).then(() => self.clients.claim()),
  );
});
self.addEventListener("message", (event) => {
  if (event.data === "precache") event.waitUntil(precache().catch(() => {}));
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || NEVER.some((r) => r.test(url.pathname))) return;
  if (req.mode === "navigate") {
    // The page: fresh when there's signal; the kept one when not.
    event.respondWith(fetch(req).catch(async () => (await caches.match("/")) || Response.error()));
    return;
  }
  event.respondWith(caches.match(req).then((hit) => hit || fetch(req)));
});
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data && event.data.text() };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "Ferret", {
      body: data.body || "",
      tag: data.tag,
      icon: "/favicon.svg",
      badge: "/favicon.svg",
      data: { url: data.url || "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      for (const w of windows) {
        if ("focus" in w) return w.navigate(url).then((c) => (c || w).focus());
      }
      return self.clients.openWindow(url);
    }),
  );
});
