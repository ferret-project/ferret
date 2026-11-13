import type { ItemListing } from "@ferret/shared";
import { t, ph, msg } from "@lingui/core/macro";

const WHAT = { label: msg`Label`, barcode: msg`Barcode`, pairing: msg`Pairing code`, app: msg`Label`, box: msg`Label` } as const;

/** "3 days ago", "2 months ago", "just now" — in the device's language. */
export function whenAgo(iso: string) {
  const seconds = (new Date(iso).getTime() - Date.now()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [["year", 31_536_000], ["month", 2_592_000], ["week", 604_800], ["day", 86_400], ["hour", 3_600], ["minute", 60]];
  for (const [unit, size] of steps) if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit);
  return t`just now`;
}

/** "Label last scanned 3 days ago by Sam" — or null if it never was. `short`: "Scanned 3 days ago". */
export function lastScannedText(s: ItemListing["lastScanned"], short = false) {
  if (!s) return null;
  if (short) return t`Scanned ${ph({ when: whenAgo(s.at) })}`;
  const what = t(WHAT[s.how]);
  return s.by ? t`${ph({ what })} last scanned ${ph({ when: whenAgo(s.at) })} by ${ph({ person: s.by })}` : t`${ph({ what })} last scanned ${ph({ when: whenAgo(s.at) })}`;
}

/**
 * When it was last seen, whichever way: "Seen 3 days ago by Sam" ("Still here"), "Checked in a room review 2 months
 * ago", "Seen with its box…", or a scan's line. `short`: "Seen 3 days ago". Null if never.
 */
export function lastSeenText(s: ItemListing["lastSeen"], short = false) {
  if (!s) return null;
  const when = whenAgo(s.at);
  if (short) return t`Seen ${when}`;
  if (s.kind === "scanned") return lastScannedText({ at: s.at, by: s.by, how: s.how });
  const person = s.by ?? "";
  if (s.kind === "reviewed") {
    if (s.how === "box") return person ? t`Checked with its box in a room review ${when} by ${person}` : t`Checked with its box in a room review ${when}`;
    return person ? t`Checked in a room review ${when} by ${person}` : t`Checked in a room review ${when}`;
  }
  if (s.how === "box") return person ? t`Seen in its box ${when} by ${person}` : t`Seen in its box ${when}`;
  return person ? t`Seen ${when} by ${person}` : t`Seen ${when}`;
}
