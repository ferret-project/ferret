/**
 * What needs attention now — the bell in the app's top bar, and Claude's
 * "what needs doing?": maintenance overdue or due within a week (a month, if
 * it's short of the part it uses), warranties
 * ending within a month, return windows closing within a week, claims with no news for two weeks, and photos read
 * but not yet turned into named items, things to buy (one entry: the shopping
 * list), lent and borrowed things (overdue, or "they say it's back") — and, for the server admin, backups that stopped working. It's a list of states, not events: an
 * entry goes away when the thing is done, so the count means "things to do".
 *
 * Written in the reader's language (`tr`, lib/language.ts): the app's bell and the reminders pass the person's; Claude,
 * webhooks and scripts get English. Names, error messages and recall notices stay as they are.
 */
import { type AttentionItem, addDays } from "@ferret/shared";
import { and, count, desc, eq, gte, isNull, lte } from "drizzle-orm";
import { attachment, backupRun, item } from "../db/schema";
import { listClaims } from "./claims";
import { isServerAdmin } from "./server-admin";
import { lastKeyFile } from "./key-file-log";
import { certificatesEnding } from "./certificates";
import { barcodeLookupStatus } from "./products";
import { serviceTrouble } from "./service-errors";
import { PARTS_AHEAD_DAYS, shoppingList } from "./stock";
import { type Caller, itemScope, listWarranties } from "./inventory";
import { listMaintenance } from "./maintenance";
import { inboxCount, syncTrouble } from "./paperless";
import { listLoans } from "./loans";
import { listRecalls } from "./recalls";
import { coverageChecks } from "./coverage";
import { openRoomScans } from "./room-scans";
import { moneyText, todayFor } from "./household-time";
import { suggestedTaskCount } from "./suggested-tasks";
import { aiFillEntries } from "./ai-fill";
import { duplicateCount } from "./duplicates";
import { trackingSummary } from "./room-reviews";
import { switchedOff } from "./webhooks";
import { type Tr, translator } from "./language";

const MAINTENANCE_DAYS = 7;
const WARRANTY_DAYS = 30;
/** A return window: in the bell this many days before its last day, urgent (so in the daily reminder) for the last few. */
const RETURN_DAYS = 7;
const RETURN_URGENT_DAYS = 2;
const CLAIM_QUIET_DAYS = 14;
/** Lent with no due date: the bell mentions it after this long. */
const LENT_LONG_DAYS = 60;
/** A nightly backup that hasn't worked for this long needs someone to look. */
const BACKUP_STALE_MS = 2 * 24 * 60 * 60 * 1000 + 6 * 60 * 60 * 1000;
/** What "Add from photos" names a thing until someone does. */
const PLACEHOLDER = "New item";

const dayDiff = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

export async function needsAttention(v: Caller, tr: Tr = translator(undefined, null)): Promise<AttentionItem[]> {
  const on = todayFor(v);
  const [tasks, warranties, claims, unnamed, loans, recalls, coverage, returns] = await Promise.all([
    listMaintenance(v, { status: "open" }),
    listWarranties(v, "expiring"),
    listClaims(v, { open: true }),
    v.db
      .select({ id: item.id, analysis: attachment.analysis, photoId: attachment.id })
      .from(item)
      .leftJoin(attachment, and(eq(attachment.itemId, item.id), eq(attachment.kind, "photo"), isNull(attachment.deletedAt)))
      .where(and(itemScope(v), eq(item.name, PLACEHOLDER))),
    listLoans(v),
    listRecalls(v),
    coverageChecks(v),
    // Return windows closing this week (gone things are left out by itemScope; once the day passes, so is it).
    v.db
      .select({ id: item.id, name: item.name, returnBy: item.returnBy })
      .from(item)
      .where(and(itemScope(v), gte(item.returnBy, on), lte(item.returnBy, addDays(on, RETURN_DAYS)))),
  ]);
  const out: AttentionItem[] = [];

  for (const r of returns) {
    const days = dayDiff(on, r.returnBy!);
    out.push({
      kind: "return",
      severity: days <= RETURN_URGENT_DAYS ? "urgent" : "soon",
      id: r.id,
      title: tr("Return {thing}?", { thing: r.name }),
      detail:
        days === 0
          ? tr("Last day to return it")
          : days === 1
            ? tr("Last day to return it is tomorrow")
            : tr("{days, plural, one {# day left} other {# days left}} to return it", { days }),
      itemId: r.id,
      date: r.returnBy!,
    });
  }

  for (const t of tasks) {
    // Short of the part it uses: show it early, while there's time to order some.
    // (`shortOn` counts the other tasks using the same part, so it can be short with enough for one time.)
    // Its next time is today when it's overdue.
    const next = t.dueOn && t.dueOn < on ? on : t.dueOn;
    const short = t.part?.shortOn && t.part.shortOn === next ? t.part : null;
    if (!t.dueOn || t.dueOn > addDays(on, short ? PARTS_AHEAD_DAYS : MAINTENANCE_DAYS)) continue;
    const days = dayDiff(on, t.dueOn);
    const when =
      days < 0
        ? tr("{days, plural, one {# day overdue} other {# days overdue}}", { days: -days })
        : days === 0
          ? tr("Due today")
          : tr("Due in {days, plural, one {# day} other {# days}}", { days });
    out.push({
      kind: "maintenance",
      severity: days <= 0 ? "urgent" : "soon",
      id: t.id,
      title: t.itemName ? `${t.title} (${t.itemName})` : t.title,
      detail: short
        ? `${when} — ${
            short.left === 0
              ? tr("no {part} left", { part: short.name })
              : short.left < short.uses
                ? tr("only {count} {part} left", { count: short.left, part: short.name })
                : tr("not enough {part} left (other tasks use it too)", { part: short.name })
          }`
        : when,
      itemId: t.itemId,
      date: t.dueOn,
    });
  }

  // Recalls: the same product is urgent (stop using it?); a possible one is "check the model".
  for (const r of recalls) {
    out.push({
      kind: "recall",
      severity: r.match === "possible" ? "soon" : "urgent",
      id: r.id,
      title: r.match === "possible" ? tr("Possible recall: {thing}", { thing: r.itemName }) : tr("Recalled: {thing}", { thing: r.itemName }),
      detail: r.match === "possible" ? tr("{recall} — check the model", { recall: r.recall.title }) : r.recall.title,
      itemId: r.itemId,
      date: r.recall.recalledOn,
    });
  }

  // Insurance limits the things they cover have outgrown.
  for (const c of coverage) {
    if (c.shortCents <= 0) continue;
    const money = (x: number) => moneyText(v, x, { whole: true });
    out.push({
      kind: "coverage",
      severity: "soon",
      id: c.id,
      title: tr("{label}: worth {value}", { label: c.label, value: money(c.valueCents) }),
      detail: tr("Covered for {limit} — {short} short", { limit: money(c.limitCents), short: money(c.shortCents) }),
      itemId: null,
      date: null,
    });
  }

  // Lent and borrowed things: the borrower says it's back (agree?), it's overdue, or it's been out a long time.
  for (const l of loans) {
    const base = { kind: "loan" as const, id: l.id, itemId: l.itemId };
    if (l.borrowerReturnedAt) {
      out.push({ ...base, severity: "soon", title: tr("{person} says {thing} is back", { person: l.person, thing: l.itemName }), detail: tr("Is it? Mark it back on its page"), date: l.borrowerReturnedAt.slice(0, 10) });
      continue;
    }
    const names = { person: l.person, thing: l.itemName, since: tr.date(l.since) };
    if (l.direction === "borrowed" && l.dueOn && l.dueOn <= addDays(on, 3)) {
      const days = dayDiff(on, l.dueOn);
      out.push({
        ...base,
        severity: days <= 0 ? "urgent" : "soon",
        title: tr("Give {thing} back to {person}", names),
        detail:
          days < 0
            ? tr("{days, plural, one {# day overdue} other {# days overdue}}", { days: -days })
            : days === 0
              ? tr("Due back today")
              : tr("Due back in {days, plural, one {# day} other {# days}}", { days }),
        date: l.dueOn,
      });
    } else if (l.direction === "lent" && l.dueOn && l.dueOn < on) {
      out.push({ ...base, severity: "soon", title: tr("{thing} is still with {person}", names), detail: tr("Due back {due} (since {since})", { ...names, due: tr.date(l.dueOn) }), date: l.dueOn });
    } else if (l.direction === "lent" && !l.dueOn && dayDiff(l.since, on) >= LENT_LONG_DAYS) {
      out.push({ ...base, severity: "soon", title: tr("{thing} is still with {person}", names), detail: tr("{days, plural, one {# day} other {# days}}, since {since}", { ...names, days: dayDiff(l.since, on) }), date: l.since });
    }
  }

  for (const w of warranties) {
    const days = dayDiff(on, w.endsOn);
    if (days > WARRANTY_DAYS) continue;
    out.push({
      kind: "warranty",
      severity: days <= 7 ? "urgent" : "soon",
      id: w.id,
      title: w.provider ? tr("{thing} warranty ({provider})", { thing: w.itemName, provider: w.provider }) : tr("{thing} warranty", { thing: w.itemName }),
      detail: days <= 0 ? tr("Ends today") : tr("Ends in {days, plural, one {# day} other {# days}} — anything to claim?", { days }),
      itemId: w.itemId,
      date: w.endsOn,
    });
  }

  for (const c of claims) {
    const quiet = dayDiff(c.filedOn, on);
    if (c.status === "approved" || quiet < CLAIM_QUIET_DAYS) continue;
    out.push({
      kind: "claim",
      severity: "soon",
      id: c.id,
      title: c.reference ? tr("Claim for {thing} #{reference}", { thing: c.itemName, reference: c.reference }) : tr("Claim for {thing}", { thing: c.itemName }),
      detail: tr("Filed {days, plural, one {# day ago} other {# days ago}}, still {status} — follow up?", { days: quiet, status: claimStatus(tr, c.status) }),
      itemId: c.itemId,
      date: c.filedOn,
    });
  }

  // One entry per unnamed item; what the photo was read as, when it has been.
  const seen = new Set<string>();
  for (const u of unnamed) {
    if (seen.has(u.id)) continue;
    const read = unnamed.find((x) => x.id === u.id && x.analysis?.suggestions.name);
    const named = read?.analysis?.suggestions.name;
    // The photo it was made from, shown beside it: several taken in a row are told apart by the picture.
    const photoId = read?.photoId ?? unnamed.find((x) => x.id === u.id && x.photoId)?.photoId;
    seen.add(u.id);
    out.push({
      kind: "review",
      severity: "soon",
      id: u.id,
      title: named ? tr("Looks like: {name}", { name: named }) : tr("A new item to name"),
      detail: named ? tr("Added from a photo — confirm what it is") : tr("Added from a photo, still being read"),
      itemId: u.id,
      date: null,
      ...(photoId ? { photoId } : {}),
    });
  }

  // Room scans: ready to review (or failed — try again or dismiss). Being looked at: not yet a thing to do.
  for (const scan of await openRoomScans(v)) {
    if (scan.status === "pending") continue;
    const n = scan.candidates.length;
    out.push({
      kind: "roomscan",
      severity: "soon",
      id: scan.id,
      title: scan.status === "failed" ? tr("A room scan didn't work") : tr("Room scan ready to review"),
      detail:
        scan.status === "failed"
          ? (scan.error ?? tr("Couldn't look at the photos"))
          : n
            ? scan.placeName
              ? tr("{count, plural, one {# thing} other {# things}} found in {place}", { count: n, place: scan.placeName })
              : tr("{count, plural, one {# thing} other {# things}} found", { count: n })
            : scan.placeName
              ? tr("Nothing found yet in {place} — add what's there", { place: scan.placeName })
              : tr("Nothing found yet — add what's there"),
      itemId: null,
      date: null,
    });
  }

  // Things to buy: one entry for the whole list (urgent once something's run out — it's in the daily reminder then).
  const { items: toBuy } = await shoppingList(v);
  if (toBuy.length) {
    const runOut = toBuy.filter((i) => i.quantity === 0).length;
    const names = toBuy.map((i) => i.name);
    const first = names.slice(0, 3).join(", ");
    const listed = names.length > 3 ? tr("{names} and {count} more", { names: first, count: names.length - 3 }) : first;
    out.push({
      kind: "shopping",
      severity: runOut ? "urgent" : "soon",
      id: "shopping",
      title: toBuy.length === 1 ? tr("Buy {thing}", { thing: toBuy[0]!.name }) : tr("{count, plural, one {# thing} other {# things}} to buy", { count: toBuy.length }),
      detail: runOut
        ? runOut === toBuy.length
          ? tr("Run out: {list}", { list: listed })
          : tr("{count} run out: {list}", { count: runOut, list: listed })
        : tr("Running low: {list}", { list: listed }),
      itemId: null,
      date: null,
    });
  }

  // The AI's helpers: gentle lines, never urgent.
  const suggested = await suggestedTaskCount(v);
  if (suggested) {
    out.push({ kind: "ai", severity: "soon", id: "suggested-maintenance", title: tr("{count, plural, one {# suggested maintenance task} other {# suggested maintenance tasks}}", { count: suggested }), detail: tr("Found in manuals or typical for your things — add or dismiss"), itemId: null, date: null, href: "#/maintenance" });
  }
  const filled = (await aiFillEntries(v)).length;
  if (filled) {
    out.push({ kind: "ai", severity: "soon", id: "ai-filled", title: tr("AI filled in {count, plural, one {# detail} other {# details}}", { count: filled }), detail: tr("Check what it filled in"), itemId: null, date: null, href: "#/ai-filled" });
  }
  // Keeping track: gentle, never urgent — things nobody can find, and things not seen in a year (review a room).
  const tracking = await trackingSummary(v);
  if (tracking.misplaced) {
    const n = tracking.misplaced;
    out.push({ kind: "seen", severity: "soon", id: "misplaced", title: tr("{count, plural, one {# thing} other {# things}} nobody can find", { count: n }), detail: tr("Found it, or is it lost for good?"), itemId: null, date: null, href: "#/misplaced" });
  }
  if (tracking.notSeenYear) {
    const n = tracking.notSeenYear;
    out.push({ kind: "seen", severity: "soon", id: "not-seen", title: tr("{count, plural, one {# thing} other {# things}} not seen in a year", { count: n }), detail: tr("Review a room to check they're still there"), itemId: null, date: null, href: "#/review" });
  }
  // Paperless (lib/paperless.ts): documents waiting to be sorted, and a connection that's stopped working.
  const inbox = await inboxCount(v);
  if (inbox) {
    out.push({ kind: "paperless", severity: "soon", id: "paperless-inbox", title: tr("{count, plural, one {# document} other {# documents}} from Paperless to sort", { count: inbox }), detail: tr("Add each as a new thing, or attach it to one"), itemId: null, date: null, href: "#/paperless" });
  }
  const paperlessTrouble = await syncTrouble(v);
  if (paperlessTrouble) {
    out.push({ kind: "paperless", severity: "soon", id: "paperless-trouble", title: tr("Ferret can't reach Paperless"), detail: paperlessTrouble.error, itemId: null, date: null, href: "#/settings" });
  }
  const duplicates = await duplicateCount(v);
  if (duplicates) {
    out.push({ kind: "ai", severity: "soon", id: "duplicates", title: tr("{count, plural, one {# possible duplicate} other {# possible duplicates}}", { count: duplicates }), detail: tr("The same thing added twice? Merge or keep both"), itemId: null, date: null, href: "#/duplicates" });
  }
  const [{ n: noSerial } = { n: 0 }] = await v.db.select({ n: count() }).from(item).where(itemScope(v, { missing: "serial" }));
  if (noSerial) {
    out.push({
      kind: "ai",
      severity: "soon",
      id: "claim-ready",
      title: tr("{count, plural, one {# valuable thing has} other {# valuable things have}} no serial number", { count: noSerial }),
      detail: tr("Insurers ask for it — photograph the label and Ferret reads it"),
      itemId: null,
      date: null,
      href: "#/missing/serial",
    });
  }

  const backup = await backupTrouble(v, tr);
  if (backup) out.push(backup);
  // Webhooks Ferret switched off after their deliveries kept failing — for the household's owner and admins.
  for (const w of await switchedOff(v)) {
    out.push({
      kind: "service",
      severity: "soon",
      id: `webhook:${w.id}`,
      title: tr("Webhook “{name}” was switched off", { name: w.name }),
      detail: w.lastError
        ? tr("Its deliveries kept failing ({error}) — fix the address, then turn it on again", { error: w.lastError })
        : tr("Its deliveries kept failing — fix the address, then turn it on again"),
      itemId: null,
      date: w.disabledAt ? todayFor(v, w.disabledAt) : null,
      href: "#/settings/api",
    });
  }
  // Services Ferret depends on, failing in the last day — for the server admin.
  if (await isServerAdmin(v.db, v.userId)) {
    for (const t of await serviceTrouble(v.db)) {
      const mins = Math.round((Date.now() - t.lastAt.getTime()) / 60_000);
      out.push({
        kind: "service",
        severity: mins < 60 ? "urgent" : "soon",
        id: `service:${t.service}`,
        title: tr("{service} is failing", { service: t.name }),
        detail: tr("{count, plural, one {# error} other {# errors}} today, the last {ago}", {
          count: t.count,
          ago: mins < 1 ? tr("just now") : mins < 60 ? tr("{minutes} min ago", { minutes: mins }) : tr("{hours} h ago", { hours: Math.round(mins / 60) }),
        }),
        itemId: null,
        date: todayFor(v, t.lastAt),
      });
    }
  }

  // The online barcode database's daily allowance, nearly or all used — for the server admin.
  if (v.deps.products && (await isServerAdmin(v.db, v.userId))) {
    const { quota } = await barcodeLookupStatus(v.deps);
    if (quota && quota.remaining <= quota.limit * 0.2) {
      const at = new Date(quota.resetsAt).toLocaleString(tr.locale, { weekday: "short", hour: "numeric", minute: "2-digit", timeZone: v.timeZone });
      out.push({
        kind: "service",
        severity: quota.remaining === 0 ? "urgent" : "soon",
        id: "service:barcode-quota",
        title: quota.remaining === 0 ? tr("Online barcode lookups are used up") : tr("Online barcode lookups are running low"),
        detail: tr("{remaining} of {limit} left; it fills up again at {at}. Scans still match the barcode books.", { remaining: quota.remaining, limit: quota.limit, at }),
        itemId: null,
        date: null,
      });
    }
  }

  // Certificates Ferret uses for its own connections, ended or ending within 30 days — for the server admin.
  if (v.deps.tls && (await isServerAdmin(v.db, v.userId))) {
    for (const c of await certificatesEnding(v.db)) {
      out.push({
        kind: "service",
        severity: c.ended ? "urgent" : "soon",
        id: `service:certificate:${c.id}`,
        title: c.ended ? tr("Certificate “{name}” has expired", { name: c.name }) : tr("Certificate “{name}” expires soon", { name: c.name }),
        detail: c.ended
          ? tr("Ended {date} — add its replacement in Settings → Server → Certificates.", { date: tr.date(todayFor(v, new Date(c.notAfter))) })
          : tr("Ends {date} — add its replacement in Settings → Server → Certificates.", { date: tr.date(todayFor(v, new Date(c.notAfter))) }),
        itemId: null,
        date: todayFor(v, new Date(c.notAfter)),
      });
    }
  }

  // FILES_KEY made by Ferret and kept only in the data folder, with no key file of it yet — for the server admin.
  const s = v.deps.secrets;
  if (s?.sources.FILES_KEY === "ferret" && (await isServerAdmin(v.db, v.userId)) && !(await lastKeyFile(v.db, s.filesKeyId))?.current) {
    out.push({
      kind: "backup",
      severity: "soon",
      id: `backup:key-file:${s.filesKeyId}`,
      title: tr("Save a copy of Ferret's keys"),
      detail: tr("FILES_KEY is only in this server's data folder: lose that, and every photo, document and backup is lost too. Make a key file — Settings → Server → Keys."),
      itemId: null,
      date: null,
    });
  }

  // Urgent first; then by kind (things with a deadline before things waiting on someone); then soonest.
  const order: Record<AttentionItem["kind"], number> = { backup: 0, service: 0, recall: 1, maintenance: 2, return: 3, loan: 3, warranty: 4, shopping: 5, coverage: 6, claim: 7, review: 8, roomscan: 8, paperless: 8, ai: 9, seen: 10 };
  return out.sort(
    (a, b) =>
      (a.severity === b.severity ? 0 : a.severity === "urgent" ? -1 : 1) ||
      order[a.kind] - order[b.kind] ||
      (a.date ?? "9999").localeCompare(b.date ?? "9999"),
  );
}

/** Backups made elsewhere (Deps.backupElsewhere): the newest failed, or none for a day and a half. */
async function backupElsewhereTrouble(v: Caller, elsewhere: NonNullable<Caller["deps"]["backupElsewhere"]>, tr: Tr): Promise<AttentionItem | null> {
  const run = await elsewhere.latest();
  const stale = !run || Date.now() - run.at.getTime() > BACKUP_STALE_MS;
  if (run && run.ok && !stale) return null;
  return {
    kind: "backup",
    severity: "urgent",
    id: "backup:elsewhere",
    title: run && !run.ok ? tr("Backup failed") : tr("Backups have stopped"),
    detail: run
      ? `${run.ok ? tr("None since {date}", { date: tr.date(todayFor(v, run.at)) }) : tr("Failed since {date}", { date: tr.date(todayFor(v, run.at)) })}${run.detail ? `: ${run.detail}` : ""} (${elsewhere.where})`
      : tr("None reported yet ({where})", { where: elsewhere.where }),
    itemId: null,
    date: run ? todayFor(v, run.at) : null,
  };
}

/** The server's backups failing, or none lately — for the server admin (the one who can fix it), in any household. */
async function backupTrouble(v: Caller, tr: Tr): Promise<AttentionItem | null> {
  if (v.deps.backupElsewhere && !v.deps.backups && (await isServerAdmin(v.db, v.userId))) return backupElsewhereTrouble(v, v.deps.backupElsewhere, tr);
  if (!v.deps.backups || !(await isServerAdmin(v.db, v.userId))) return null;
  const [last] = await v.db.select().from(backupRun).orderBy(desc(backupRun.startedAt)).limit(1);
  if (!last) return null; // the first one hasn't run yet
  const [lastOk] = await v.db.select().from(backupRun).where(eq(backupRun.status, "ok")).orderBy(desc(backupRun.startedAt)).limit(1);
  const failing = last.status === "failed";
  const stale = !lastOk || Date.now() - lastOk.startedAt.getTime() > BACKUP_STALE_MS;
  if (!failing && !stale) return null;
  const since = lastOk ? tr("No backup since {date}", { date: tr.date(todayFor(v, lastOk.startedAt)) }) : tr("No backup has worked yet");
  return {
    kind: "backup",
    severity: failing && !stale ? "soon" : "urgent",
    id: last.id,
    title: failing ? tr("Backup failed") : tr("Backups have stopped"),
    detail: failing && last.error ? `${since}: ${last.error}` : since,
    itemId: null,
    date: todayFor(v, (lastOk ?? last).startedAt),
  };
}

/** A warranty claim's status in words, for "still … — follow up?". */
function claimStatus(tr: Tr, status: string) {
  if (status === "filed") return tr("filed");
  if (status === "in_progress") return tr("in progress");
  if (status === "denied") return tr("denied");
  return status.replace("_", " ");
}
