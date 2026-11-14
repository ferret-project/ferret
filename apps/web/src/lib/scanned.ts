/**
 * "This was opened by scanning its barcode": the scanner marks the thing it opens, and its page offers "Not this one?
 * Add another" — several of the same bought at once all share one barcode, which would otherwise always open the first.
 * Kept a short while (not taken once), so a page drawn twice still sees it.
 */
let mark: { itemId: string; at: number } | null = null;

export function markScanned(itemId: string) {
  mark = { itemId, at: Date.now() };
}

/** Opened by a barcode scan just now. */
export function wasJustScanned(itemId: string) {
  return mark?.itemId === itemId && Date.now() - mark.at < 10_000;
}
