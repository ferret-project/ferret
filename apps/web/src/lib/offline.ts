/**
 * Offline capture: photos and scans taken with no signal (a basement, a storage unit) wait on this device — in
 * IndexedDB — and go up by themselves once Ferret can be reached again.
 *
 * - A photo becomes a "New item" (in the room picked, if any) with the photo on it; the item's id is kept on the
 *   capture as soon as it's made, so a retry uploads to it rather than making another.
 * - A room scan's photos start the scan (POST /room-scans) once there's signal; the bell says when it's ready.
 * - A scan goes to POST /scan with its own id (`clientId`): sent twice, the count changes once. When the answer needs
 *   someone ("which item?", "what to do?", "nothing has this code") it stays here, for the dashboard to ask.
 * - What's kept to work offline: the household's id and name and its places (to pick a room) — in localStorage — and
 *   the captures themselves until they're uploaded. Signing out clears it all.
 */
import type { PlacesTree, ScanResult } from "@ferret/shared";
import { api } from "./api";

export type ScanAction = "use" | "restock" | "lookup" | "add";

interface Base {
  id: string;
  householdId: string;
  createdAt: number;
  /** Why the last try failed (not for "no signal": that just waits). */
  error?: string;
}
export type Capture =
  | (Base & { kind: "photo"; blob: Blob; filename: string; locationId: string | null; note: string; itemId?: string })
  | (Base & { kind: "scan"; code: string; mode: ScanAction; itemId?: string; result?: ScanResult })
  | (Base & { kind: "roomscan"; blobs: Blob[]; locationId: string });

const DB = "ferret-offline";
const STORE = "captures";
const CHANGED = "ferret:captures";
const HOME_KEY = "ferret-offline-home";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise<T>((resolve, reject) => {
    const req = work(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).finally(() => db.close());
}

/** Tell this tab and the others that the captures changed. */
function changed() {
  window.dispatchEvent(new Event(CHANGED));
  try {
    new BroadcastChannel(CHANGED).postMessage("changed");
  } catch {
    // Older browsers: other tabs catch up next time.
  }
}

export function onCapturesChanged(listener: () => void) {
  window.addEventListener(CHANGED, listener);
  let channel: BroadcastChannel | null = null;
  try {
    channel = new BroadcastChannel(CHANGED);
    channel.onmessage = listener;
  } catch {
    // as above
  }
  return () => {
    window.removeEventListener(CHANGED, listener);
    channel?.close();
  };
}

export async function listCaptures(householdId: string): Promise<Capture[]> {
  const all = (await tx("readonly", (s) => s.getAll())) as Capture[];
  return all.filter((c) => c.householdId === householdId).sort((a, b) => a.createdAt - b.createdAt);
}

export async function addCapture(c: Capture) {
  await tx("readwrite", (s) => s.put(c));
  // Ask the browser not to clear them to make room (iOS especially).
  void navigator.storage?.persist?.().catch(() => {});
  changed();
}

async function saveCapture(c: Capture) {
  await tx("readwrite", (s) => s.put(c));
  changed();
}

export async function removeCapture(id: string) {
  await tx("readwrite", (s) => s.delete(id));
  changed();
}

/** Signing out: nothing of this account stays on the device. */
export async function forgetOffline() {
  try {
    localStorage.removeItem(HOME_KEY);
  } catch {
    // nothing kept
  }
  try {
    await tx("readwrite", (s) => s.clear());
  } catch {
    // no database yet
  }
}

/** The household this device last used, and its places — enough to capture into it offline. */
export interface OfflineHome {
  householdId: string;
  householdName: string;
  places?: PlacesTree;
}

export function rememberedHome(): OfflineHome | null {
  try {
    const v = JSON.parse(localStorage.getItem(HOME_KEY) ?? "null") as OfflineHome | null;
    return v?.householdId ? v : null;
  } catch {
    return null;
  }
}

export function rememberHome(home: OfflineHome) {
  try {
    const before = rememberedHome();
    localStorage.setItem(HOME_KEY, JSON.stringify({ ...(before?.householdId === home.householdId ? before : {}), ...home }));
  } catch {
    // Offline capture just won't have the room list.
  }
}

/** A failure that's only "no signal" (or the server restarting): try again later, quietly. */
function isOffline(err: unknown) {
  const status = (err as { status?: number }).status;
  return !navigator.onLine || status === undefined || status === 0 || status === 502 || status === 503 || status === 504;
}

/**
 * Upload what's waiting, oldest first, one at a time (one tab at a time too). Stops at the first "no signal".
 * Returns how many went up.
 */
export async function syncCaptures(householdId: string): Promise<number> {
  const run = async () => {
    let done = 0;
    for (const c of await listCaptures(householdId)) {
      if (c.kind === "scan" && c.result) continue; // waiting for someone to answer it
      try {
        if (c.kind === "photo") {
          let itemId = c.itemId;
          if (!itemId) {
            const item = await api.createItem({ name: "New item", locationId: c.locationId, notes: c.note || null, origin: "photos" });
            itemId = item.id;
            await saveCapture({ ...c, itemId, error: undefined });
          }
          await api.uploadAttachment(itemId, new File([c.blob], c.filename, { type: c.blob.type }), "photo", () => {});
          await removeCapture(c.id);
        } else if (c.kind === "roomscan") {
          const photos = c.blobs.map((b, i) => new File([b], `room-${i}.jpg`, { type: b.type }));
          await api.startRoomScan(photos, { locationId: c.locationId });
          await removeCapture(c.id);
        } else {
          const result = await api.scan({ code: c.code, mode: c.mode, clientId: c.id, itemId: c.itemId });
          if (result.action === "adjusted" || result.action === "open") await removeCapture(c.id);
          else await saveCapture({ ...c, result, error: undefined });
        }
        done++;
      } catch (err) {
        if (isOffline(err)) break;
        await saveCapture({ ...c, error: err instanceof Error ? err.message : "Couldn't upload it" });
      }
    }
    return done;
  };
  const locks = (navigator as Navigator & { locks?: { request: <T>(name: string, cb: () => Promise<T>) => Promise<T> } }).locks;
  return locks ? locks.request("ferret-captures", run) : run();
}

/** Answer a scan that needed someone: send it again for this item (and/or what to do), with the same id. */
export async function answerScan(c: Extract<Capture, { kind: "scan" }>, answer: { itemId?: string; mode?: ScanAction }) {
  const result = await api.scan({ code: c.code, mode: answer.mode ?? c.mode, itemId: answer.itemId ?? c.itemId, clientId: c.id });
  if (result.action === "adjusted" || result.action === "open") {
    await removeCapture(c.id);
    return result;
  }
  await saveCapture({ ...c, itemId: answer.itemId ?? c.itemId, mode: answer.mode ?? c.mode, result });
  return result;
}
