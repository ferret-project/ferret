/**
 * Browsing offline: the things this person looked at most recently (Recently viewed, the server's
 * lib/recently-viewed.ts) — their details and first photo, kept on this device in IndexedDB so the offline screen
 * (Offline.tsx) can show them read-only with no signal. Refreshed while Ferret can be reached (App.tsx); signing out
 * clears it (lib/offline.ts forgetOffline).
 */
import type { ItemListing } from "@ferret/shared";
import { api } from "./api";

/** How many are kept. */
export const OFFLINE_RECENT = 10;

export interface OfflineThing {
  /** `<householdId>:<itemId>` */
  key: string;
  householdId: string;
  /** 0 = viewed last. */
  order: number;
  item: ItemListing;
  photo: Blob | null;
  /** The photo `photo` is of, so an unchanged one isn't fetched again. */
  photoId: string | null;
  savedAt: number;
}

const DB = "ferret-offline-recent";
const STORE = "things";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "key" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function all(db: IDBDatabase): Promise<OfflineThing[]> {
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result as OfflineThing[]);
    req.onerror = () => reject(req.error);
  });
}

/** What's kept for this household, viewed last first. */
export async function offlineThings(householdId: string): Promise<OfflineThing[]> {
  const db = await open();
  try {
    return (await all(db)).filter((t) => t.householdId === householdId).sort((a, b) => a.order - b.order);
  } finally {
    db.close();
  }
}

async function photoOf(item: ItemListing, kept: OfflineThing | undefined): Promise<Blob | null> {
  if (!item.photoId) return null;
  if (kept?.photoId === item.photoId && kept.photo) return kept.photo;
  try {
    const res = await fetch(api.thumbnailUrl(item.photoId), { credentials: "include" });
    return res.ok ? await res.blob() : null;
  } catch {
    return null;
  }
}

let running: Promise<void> | null = null;
let soon: ReturnType<typeof setTimeout> | undefined;

/** After a thing's page is opened: keep the list in step, once things settle (a few pages in a row is one refresh). */
export function keepRecentOfflineSoon(householdId: string) {
  clearTimeout(soon);
  soon = setTimeout(() => void keepRecentOffline(householdId), 15_000);
}

/**
 * Keeps this household's most recently viewed things on the device, replacing what was kept. Quietly does nothing
 * when Ferret can't be reached (what's kept stays). One at a time per tab.
 */
export function keepRecentOffline(householdId: string): Promise<void> {
  running ??= (async () => {
    try {
      const cards = (await api.recentlyViewed(OFFLINE_RECENT)).data;
      const db = await open();
      try {
        const before = new Map((await all(db)).filter((t) => t.householdId === householdId).map((t) => [t.item.id, t]));
        const fresh: OfflineThing[] = [];
        for (const card of cards) {
          const item = await api.getItem(card.id).catch(() => null);
          if (!item) continue;
          const photo = await photoOf(item, before.get(item.id));
          fresh.push({ key: `${householdId}:${item.id}`, householdId, order: fresh.length, item, photo, photoId: photo ? item.photoId : null, savedAt: Date.now() });
        }
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(STORE, "readwrite");
          const store = tx.objectStore(STORE);
          for (const old of before.values()) store.delete(old.key);
          for (const t of fresh) store.put(t);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      } finally {
        db.close();
      }
    } catch {
      // No signal, or the server's down: keep what's there.
    } finally {
      running = null;
    }
  })();
  return running;
}

/** Signing out: nothing of theirs stays on the device. */
export async function forgetRecentOffline() {
  try {
    const db = await open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // no database yet
  }
}
