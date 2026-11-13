/**
 * Small pure helpers shared by the server and the web app. Kept free of zod so
 * the web bundle can import them without pulling in the schema library.
 */

export type WarrantyStatus = "active" | "expiring" | "expired";

// Fixed lists the schemas (index.ts) and the web app's pickers share.
export const itemConditions = ["new", "excellent", "good", "fair", "poor"] as const;
export const propertyTypes = ["home", "vacation", "rental", "storage", "vehicle", "other"] as const;
/** Whether a time zone name exists (e.g. "America/Denver"). */
export function isTimeZone(name: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/**
 * When a thing was last seen, by kind: "scanned" (its label or barcode looked up — maybe only while searching, the
 * weakest), "confirmed" (someone tapped "Still here", or found it) and "reviewed" (checked in a room review).
 */
export const sightingKinds = ["scanned", "confirmed", "reviewed"] as const;
export type SightingKind = (typeof sightingKinds)[number];
/** How it was seen: a label, barcode or pairing code scanned; a tap in the app; its box confirmed (so it's in there). */
export const sightingHows = ["label", "barcode", "pairing", "app", "box"] as const;
export type SightingHow = (typeof sightingHows)[number];

export const claimStatuses = ["filed", "in_progress", "approved", "denied", "resolved"] as const;
export type ClaimStatus = (typeof claimStatuses)[number];

/** Details an item can be missing — the Overview's "fill these in" list. document = a receipt or manual. */
export const missingDetails = ["photo", "value", "place", "document", "category", "serial"] as const;
/** "serial": worth at least this (value, else price paid, in minor units) and no serial number — what a claim asks for. */
export const SERIAL_WORTH_CENTS = 20_000;
export type MissingDetail = (typeof missingDetails)[number];

/** "Expiring" = active, ending within this many days. */
export const WARRANTY_EXPIRING_DAYS = 60;

/**
 * A moment's calendar date and clock time in a time zone (a household's; the server's own clock may be UTC).
 * No zone: the local clock — the device's in the web app. `weekday`: 0 = Sunday.
 */
export function localParts(d = new Date(), timeZone?: string) {
  if (!timeZone) {
    return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(), hour: d.getHours(), minute: d.getMinutes(), second: d.getSeconds(), weekday: d.getDay() };
  }
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hourCycle: "h23",
    weekday: "short",
  });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour),
    minute: Number(p.minute),
    second: Number(p.second),
    weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday!),
  };
}

/** Today (or `d`'s day) as yyyy-mm-dd in a time zone, or on the local clock (dates are calendar dates, not instants). */
export const today = (d = new Date(), timeZone?: string) => {
  const p = localParts(d, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
};

/** Adds whole months to a yyyy-mm-dd date, clamping to the month's end (Jan 31 + 1 month → Feb 28). */
export function addMonths(date: string, months: number) {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

export function warrantyStatus(endsOn: string, on = today()): WarrantyStatus {
  if (endsOn < on) return "expired";
  return endsOn <= addDays(on, WARRANTY_EXPIRING_DAYS) ? "expiring" : "active";
}

export function addDays(date: string, days: number) {
  const t = new Date(`${date}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}

// ── Maintenance ─────────────────────────────────────────────────────────────
export const intervalUnits = ["day", "week", "month", "year"] as const;
export type IntervalUnit = (typeof intervalUnits)[number];
export type MaintenanceStatus = "overdue" | "due" | "upcoming" | "done";

/** Kinds of extra field a category can give its items. */
export const categoryFieldTypes = ["text", "number", "date", "choice"] as const;

/** "Due" = due within this many days. */
export const MAINTENANCE_DUE_DAYS = 14;

/** The next due date: `count` `unit`s after `from` (the day it was done). */
export function nextDue(from: string, count: number, unit: IntervalUnit) {
  if (unit === "day") return addDays(from, count);
  if (unit === "week") return addDays(from, count * 7);
  return addMonths(from, unit === "year" ? count * 12 : count);
}

export function maintenanceStatus(dueOn: string | null, on = today()): MaintenanceStatus {
  if (!dueOn) return "done";
  if (dueOn < on) return "overdue";
  return dueOn <= addDays(on, MAINTENANCE_DUE_DAYS) ? "due" : "upcoming";
}

/** A day a task lands on in a calendar: `overdue` (shown on today), `due` (its real next date) or `expected` (a later repeat). */
export interface TaskOccurrence {
  on: string;
  kind: "overdue" | "due" | "expected";
}

/**
 * The days an open task lands on between `from` and `to` (inclusive): its next due date — today if that's past, as
 * the calendar feed does — then the repeats after it, as if each were done on the day it's due. Repeats come from
 * its time interval and, for maintenance by use, how fast the item's used (whichever's sooner, like `effectiveDue`).
 */
export function taskOccurrences(
  task: {
    dueOn: string | null;
    intervalCount: number | null;
    intervalUnit: IntervalUnit | null;
    usage?: { every: number; perDay: number | null } | null;
  },
  from: string,
  to: string,
  on = today(),
): TaskOccurrence[] {
  if (!task.dueOn) return [];
  const first = task.dueOn < on ? on : task.dueOn;
  const out: TaskOccurrence[] = [];
  if (first >= from && first <= to) out.push({ on: first, kind: task.dueOn < on ? "overdue" : "due" });
  const usageDays = task.usage?.perDay ? Math.max(1, Math.round(task.usage.every / task.usage.perDay)) : null;
  const after = (d: string) => {
    const byTime = task.intervalCount && task.intervalUnit ? nextDue(d, task.intervalCount, task.intervalUnit) : null;
    const byUse = usageDays ? addDays(d, usageDays) : null;
    return byTime && byUse ? (byTime < byUse ? byTime : byUse) : (byTime ?? byUse);
  };
  let d = first;
  for (let i = 0; i < 2000; i++) {
    const next = after(d);
    if (!next || next > to) break;
    d = next;
    if (d >= from) out.push({ on: d, kind: "expected" });
  }
  return out;
}

/** How far ahead the calendar feed lists repeats, and parts are counted forward. */
export const MAINTENANCE_AHEAD_MONTHS = 12;

/**
 * When each task's part runs short: stock is counted forward through every open task's due dates and repeats up to
 * `until` (`taskOccurrences`), soonest first, with the tasks that share a part drawing on the same stock. A task's
 * date is the first time it comes due with fewer than it uses left; tasks that stay covered aren't in the map.
 */
export function partShortfalls(
  tasks: {
    id: string;
    title: string;
    dueOn: string | null;
    intervalCount: number | null;
    intervalUnit: IntervalUnit | null;
    usage?: { every: number; perDay: number | null } | null;
    part: { itemId: string; uses: number; left: number } | null;
  }[],
  until: string,
  on = today(),
): Map<string, string> {
  const short = new Map<string, string>();
  const byPart = new Map<string, typeof tasks>();
  for (const t of tasks) if (t.part) byPart.set(t.part.itemId, [...(byPart.get(t.part.itemId) ?? []), t]);
  for (const group of byPart.values()) {
    let left = group[0]!.part!.left;
    const due = group
      .flatMap((t) => taskOccurrences(t, on, until, on).map((o) => ({ t, on: o.on })))
      .sort((a, b) => a.on.localeCompare(b.on) || a.t.title.localeCompare(b.t.title));
    for (const { t, on: day } of due) {
      if (short.has(t.id)) continue;
      if (left >= t.part!.uses) left -= t.part!.uses;
      else short.set(t.id, day);
    }
  }
  return short;
}

// ── Maintenance by use ("every 5,000 miles") ───────────────────────────────
export const usageUnits = ["miles", "km", "hours", "cycles"] as const;
export type UsageUnit = (typeof usageUnits)[number];

/** "5,000 miles", "1 hour" */
export function describeUsage(amount: number, unit: UsageUnit) {
  const n = Math.round(amount * 10) / 10;
  const word = n === 1 ? { miles: "mile", km: "km", hours: "hour", cycles: "cycle" }[unit] : unit;
  return `${n.toLocaleString("en-US")} ${word}`;
}

/** How fast an item's count goes up, per day, from its readings over the last year (at least a week apart); null if unknown. */
export function usagePerDay(readings: { value: number; readOn: string }[]) {
  const sorted = [...readings].sort((a, b) => a.readOn.localeCompare(b.readOn));
  const last = sorted.at(-1);
  if (!last) return null;
  const first = sorted.find((r) => r.readOn >= addDays(last.readOn, -365));
  if (!first || first === last) return null;
  const days = (Date.parse(`${last.readOn}T00:00:00Z`) - Date.parse(`${first.readOn}T00:00:00Z`)) / 86_400_000;
  if (days < 7 || last.value <= first.value) return null;
  return (last.value - first.value) / days;
}

/** With no rate yet (one reading), a usage task is looked at again this long after the last reading. */
export const USAGE_GUESS_DAYS = 365;

/**
 * When a task is next due, all told: the earlier of its time-based date and when its item's count is expected to reach
 * `usageDueAt` — the day a reading reached it, a projection from the rate, or (no rate yet) a year after the last
 * reading. `estimated`: the date comes from a projection or that guess, not a calendar.
 */
export function effectiveDue(
  task: { timeDueOn: string | null; usageDueAt: number | null },
  readings: { value: number; readOn: string }[],
  on = today(),
): { dueOn: string | null; estimated: boolean } {
  if (task.usageDueAt == null) return { dueOn: task.timeDueOn, estimated: false };
  const sorted = [...readings].sort((a, b) => a.readOn.localeCompare(b.readOn));
  const last = sorted.at(-1);
  let usageOn: string;
  let estimated = false;
  const reached = sorted.find((r) => r.value >= task.usageDueAt!);
  if (reached) usageOn = reached.readOn;
  else {
    const rate = usagePerDay(sorted);
    const from = last?.readOn ?? on;
    usageOn = rate && last ? addDays(from, Math.ceil((task.usageDueAt - last.value) / rate)) : addDays(from, USAGE_GUESS_DAYS);
    estimated = true;
  }
  if (task.timeDueOn && task.timeDueOn <= usageOn) return { dueOn: task.timeDueOn, estimated: false };
  return { dueOn: usageOn, estimated };
}

/** "every 3 months", "every year" */
export function describeInterval(count: number | null | undefined, unit: IntervalUnit | null | undefined) {
  if (!count || !unit) return "once";
  return count === 1 ? `every ${unit}` : `every ${count} ${unit}s`;
}

// ── Barcodes ────────────────────────────────────────────────────────────────
/**
 * The same product can scan as a 12-digit UPC-A or a 13-digit EAN-13 (a leading
 * 0): both spellings of a code, digits only, so either finds the other.
 */
export function barcodeVariants(raw: string) {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 12) return [digits, `0${digits}`];
  if (digits.length === 13 && digits.startsWith("0")) return [digits, digits.slice(1)];
  return digits ? [digits] : [];
}

/** Heuristic for showing "Ask Ferret": the search reads like a question. */
export const looksLikeQuestion = (q: string) =>
  /\?\s*$/.test(q) || /^(how|what|when|where|which|who|why|is|are|does|do|did|can|should|was)\b/i.test(q.trim());

/** Deleted things are kept this long (restorable, in "Recently deleted"), then purged for good. */
export const TRASH_DAYS = 30;

/**
 * The Apprise services people can send reminders to (URL scheme → name), and only these. Generic webhooks
 * (json://, xml://, form://) and apprise:// aren't here: they'd let anyone with an account make the server
 * send requests to any address on its network.
 */
export const NOTIFICATION_SERVICES: Record<string, string> = {
  ntfy: "ntfy",
  ntfys: "ntfy",
  pover: "Pushover",
  prowl: "Prowl",
  pbul: "Pushbullet",
  tgram: "Telegram",
  hassio: "Home Assistant",
  hassios: "Home Assistant",
  mailto: "Email",
  mailtos: "Email",
  discord: "Discord",
  slack: "Slack",
  msteams: "Microsoft Teams",
  signal: "Signal",
  signals: "Signal",
  matrix: "Matrix",
  matrixs: "Matrix",
  gotify: "Gotify",
  gotifys: "Gotify",
  bark: "Bark",
  barks: "Bark",
  pushme: "PushMe",
  whatsapp: "WhatsApp",
};

export * from "./pairing";
export * from "./import";
export * from "./amazon";
export * from "./money";

/** The plan features that are simply on or off (PlanLimits in the shared schemas). */
export type PlanFeature = "apiKeys" | "shareLinks" | "calendarFeeds";

/** What each is called, for "… are part of paid plans". */
export const PLAN_FEATURE_NAMES: Record<PlanFeature, string> = {
  apiKeys: "API keys (scripts and Claude)",
  shareLinks: "Share links",
  calendarFeeds: "Calendar feeds",
};

export const aiFillKinds = ["details", "returnBy", "warranty"] as const;
export type AiFillKind = (typeof aiFillKinds)[number];
export type AiFillSwitches = Partial<Record<AiFillKind, boolean>>;
export const AI_FILL_KIND_NAMES: Record<AiFillKind, { label: string; hint: string }> = {
  details: { label: "Details from photos and receipts", hint: "Brand, model, serial number, barcode, purchase date and price paid — only empty fields" },
  returnBy: { label: "Return-by dates", hint: "The last day to return it, from a receipt" },
  warranty: { label: "Warranties", hint: "From a receipt or warranty card, when the purchase date is known" },
};

