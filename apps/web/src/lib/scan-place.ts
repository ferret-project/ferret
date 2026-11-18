/**
 * "Where it goes", from a scan: a place's QR label → that place; a box's label (Ferret's, or a sticker of its own) →
 * that box. Anything else says why it can't be used. The item editor's Kept in uses it.
 */
import { labelCodeIn } from "@ferret/shared/utils";
import { t, ph } from "@lingui/core/macro";
import { api } from "./api";

export type ScannedPlace =
  | { kind: "place"; id: string; path: string }
  | { kind: "box"; id: string; name: string }
  | { kind: "no"; message: string };

export async function placeFromScan(householdId: string, scanned: string): Promise<ScannedPlace> {
  const code = labelCodeIn(scanned);
  if (code) {
    try {
      const label = await api.label(code);
      if (label.householdId !== householdId) return { kind: "no", message: t`That label belongs to another household.` };
      if (label.location) return { kind: "place", id: label.location.id, path: label.location.path };
      if (label.item?.isContainer) return { kind: "box", id: label.item.id, name: label.item.name };
      if (label.item) return { kind: "no", message: t`That label is on ${ph({ name: label.item.name })}, which isn't a box or a place.` };
      return { kind: "no", message: t`That label isn't on a place yet — stick it on one from the place's page first.` };
    } catch (err) {
      if ((err as { status?: number }).status === 404) return { kind: "no", message: t`That isn't one of this household's labels.` };
      throw err;
    }
  }
  // A box's own sticker (an asset tag), or a barcode on one.
  const found = await api.scan({ code: scanned, mode: "lookup" });
  const ids = found.action === "open" && found.item ? [found.item.id] : found.action === "choose" ? found.items.map((i) => i.id) : [];
  const boxes = (await Promise.all(ids.map((id) => api.getItem(id)))).filter((i) => i.isContainer);
  if (boxes.length === 1) return { kind: "box", id: boxes[0]!.id, name: boxes[0]!.name };
  if (ids.length) return { kind: "no", message: t`That code is on a thing, not a box or a place.` };
  return { kind: "no", message: t`That isn't a place's or a box's label.` };
}
