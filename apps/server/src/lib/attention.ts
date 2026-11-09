import { tn } from "./i18n";
import { locale } from "./i18n";
import { withLanguage, preferredLanguage } from "./i18n";
import { t as translateText } from "./i18n";
/**
 * What needs attention now — the bell in the app's top bar, and Claude's
 * "what needs doing?": maintenance overdue or due within a week (a month, if
 * it's short of the part it uses), warranties
 * ending within a month, return windows closing within a week, claims with no news for two weeks, and photos read
 * but not yet turned into named items, things to buy (one entry: the shopping
 * list), lent and borrowed things (overdue, or "they say it's back") — and, for the server admin, backups that stopped working. It's a list of states, not events: an
 * entry goes away when the thing is done, so the count means "things to do".
 */
import { type AttentionItem, addDays } from "@ferret/shared";
import { and, count, desc, eq, gte, lte } from "drizzle-orm";
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
import { listLoans } from "./loans";
import { listRecalls } from "./recalls";
import { coverageChecks } from "./coverage";
import { openRoomScans } from "./room-scans";
import { moneyText, todayFor } from "./household-time";
import { suggestedTaskCount } from "./suggested-tasks";
import { aiFillEntries } from "./ai-fill";
import { duplicateCount } from "./duplicates";

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

export async function needsAttention(v: Caller): Promise<AttentionItem[]> {
  return withLanguage(await preferredLanguage(v.db, v.userId, v.householdId), async () => {
  const on = todayFor(v);
  const [tasks, warranties, claims, unnamed, loans, recalls, coverage, returns] = await Promise.all([
    listMaintenance(v, { status: "open" }),
    listWarranties(v, "expiring"),
    listClaims(v, { open: true }),
    v.db
      .select({ id: item.id, analysis: attachment.analysis })
      .from(item)
      .leftJoin(attachment, and(eq(attachment.itemId, item.id), eq(attachment.kind, "photo")))
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
      title: translateText("Return {v0}?", { v0: r.name }),
      detail: days === 0 ? translateText("Last day to return it") : days === 1 ? translateText("Last day to return it is tomorrow") : translateText("{v0} days left to return it", { v0: days }),
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
    const when = days < 0 ? translateText("{v0} {v1} overdue", { v0: -days, v1: days === -1 ? translateText("day") : translateText("days") }) : days === 0 ? translateText("Due today") : tn(days, "Due in {count} day", "Due in {count} days");
    out.push({
      kind: "maintenance",
      severity: days <= 0 ? "urgent" : "soon",
      id: t.id,
      title: t.itemName ? `${t.title} (${t.itemName})` : t.title,
      detail: short
        ? `${when} — ${short.left === 0 ? translateText("no {v0} left", { v0: short.name }) : short.left < short.uses ? translateText("only {v0} {v1} left", { v0: short.left, v1: short.name }) : translateText("not enough {v0} left (other tasks use it too)", { v0: short.name })}`
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
      title: translateText("{v0}: {v1}", { v0: r.match === "possible" ? translateText("Possible recall") : translateText("Recalled"), v1: r.itemName }),
      detail: r.match === "possible" ? translateText("{v0} — check the model", { v0: r.recall.title }) : r.recall.title,
      itemId: r.itemId,
      date: r.recall.recalledOn,
    });
  }

  // Insurance limits the things they cover have outgrown.
  for (const c of coverage) {
    if (c.shortCents <= 0) continue;
    const money = (x: number) => moneyText(v, x, { whole: true });
    out.push({ kind: "coverage", severity: "soon", id: c.id, title: translateText("{v0}: worth {v1}", { v0: c.label, v1: money(c.valueCents) }), detail: translateText("Covered for {v0} — {v1} short", { v0: money(c.limitCents), v1: money(c.shortCents) }), itemId: null, date: null });
  }

  // Lent and borrowed things: the borrower says it's back (agree?), it's overdue, or it's been out a long time.
  for (const l of loans) {
    const base = { kind: "loan" as const, id: l.id, itemId: l.itemId };
    if (l.borrowerReturnedAt) {
      out.push({ ...base, severity: "soon", title: translateText("{v0} says {v1} is back", { v0: l.person, v1: l.itemName }), detail: translateText("Is it? Mark it back on its page"), date: l.borrowerReturnedAt.slice(0, 10) });
      continue;
    }
    const since = translateText("since {v0}", { v0: l.since });
    if (l.direction === "borrowed" && l.dueOn && l.dueOn <= addDays(on, 3)) {
      const days = dayDiff(on, l.dueOn);
      out.push({
        ...base,
        severity: days <= 0 ? "urgent" : "soon",
        title: translateText("Give {v0} back to {v1}", { v0: l.itemName, v1: l.person }),
        detail: days < 0 ? translateText("{v0} {v1} overdue", { v0: -days, v1: days === -1 ? translateText("day") : translateText("days") }) : days === 0 ? translateText("Due back today") : tn(days, "Due back in {count} day", "Due back in {count} days"),
        date: l.dueOn,
      });
    } else if (l.direction === "lent" && l.dueOn && l.dueOn < on) {
      out.push({ ...base, severity: "soon", title: translateText("{v0} is still with {v1}", { v0: l.itemName, v1: l.person }), detail: translateText("Due back {v0} ({v1})", { v0: l.dueOn, v1: since }), date: l.dueOn });
    } else if (l.direction === "lent" && !l.dueOn && dayDiff(l.since, on) >= LENT_LONG_DAYS) {
      out.push({ ...base, severity: "soon", title: translateText("{v0} is still with {v1}", { v0: l.itemName, v1: l.person }), detail: translateText("{v0} days, {v1}", { v0: dayDiff(l.since, on), v1: since }), date: l.since });
    }
  }

  for (const w of warranties) {
    const days = dayDiff(on, w.endsOn);
    if (days > WARRANTY_DAYS) continue;
    out.push({
      kind: "warranty",
      severity: days <= 7 ? "urgent" : "soon",
      id: w.id,
      title: translateText("{v0} warranty{v1}", { v0: w.itemName, v1: w.provider ? ` (${w.provider})` : "" }),
      detail: days <= 0 ? translateText("Ends today") : tn(days, "Ends in {count} day — anything to claim?", "Ends in {count} days — anything to claim?"),
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
      title: translateText("Claim for {v0}{v1}", { v0: c.itemName, v1: c.reference ? ` #${c.reference}` : "" }),
      detail: translateText("Filed {v0} days ago, still {v1} — follow up?", { v0: quiet, v1: c.status.replace("_", " ") }),
      itemId: c.itemId,
      date: c.filedOn,
    });
  }

  // One entry per unnamed item; what the photo was read as, when it has been.
  const seen = new Set<string>();
  for (const u of unnamed) {
    if (seen.has(u.id)) continue;
    const named = unnamed.find((x) => x.id === u.id && x.analysis?.suggestions.name)?.analysis?.suggestions.name;
    seen.add(u.id);
    out.push({
      kind: "review",
      severity: "soon",
      id: u.id,
      title: named ? translateText("Looks like: {v0}", { v0: named }) : translateText("A new item to name"),
      detail: named ? translateText("Added from a photo — confirm what it is") : translateText("Added from a photo, still being read"),
      itemId: u.id,
      date: null,
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
      title: scan.status === "failed" ? translateText("A room scan didn't work") : translateText("Room scan ready to review"),
      detail:
        scan.status === "failed"
          ? (scan.error ?? translateText("Couldn't look at the photos"))
          : `${n ? tn(n, "{count} thing found", "{count} things found") : translateText("Nothing found yet — add what's there")}${scan.placeName ? translateText(" in {v0}", { v0: scan.placeName }) : ""}`,
      itemId: null,
      date: null,
    });
  }

  // Things to buy: one entry for the whole list (urgent once something's run out — it's in the daily reminder then).
  const { items: toBuy } = await shoppingList(v);
  if (toBuy.length) {
    const runOut = toBuy.filter((i) => i.quantity === 0).length;
    const names = toBuy.map((i) => i.name);
    const listed = names.slice(0, 3).join(", ") + (names.length > 3 ? translateText(" and {v0} more", { v0: names.length - 3 }) : "");
    out.push({
      kind: "shopping",
      severity: runOut ? "urgent" : "soon",
      id: "shopping",
      title: toBuy.length === 1 ? translateText("Buy {v0}", { v0: toBuy[0]!.name }) : translateText("{v0} things to buy", { v0: toBuy.length }),
      detail: runOut ? `${runOut === toBuy.length ? translateText("Run out") : translateText("{v0} run out", { v0: runOut })}: ${listed}` : translateText("Running low: {v0}", { v0: listed }),
      itemId: null,
      date: null,
    });
  }

  // The AI's helpers: gentle lines, never urgent.
  const suggested = await suggestedTaskCount(v);
  if (suggested) {
    out.push({ kind: "ai", severity: "soon", id: "suggested-maintenance", title: tn(suggested, "{count} suggested maintenance task", "{count} suggested maintenance tasks"), detail: translateText("Found in manuals or typical for your things — add or dismiss"), itemId: null, date: null, href: "#/maintenance" });
  }
  const filled = (await aiFillEntries(v)).length;
  if (filled) {
    out.push({ kind: "ai", severity: "soon", id: "ai-filled", title: tn(filled, "AI filled in {count} detail", "AI filled in {count} details"), detail: translateText("Check what it filled in"), itemId: null, date: null, href: "#/ai-filled" });
  }
  const duplicates = await duplicateCount(v);
  if (duplicates) {
    out.push({ kind: "ai", severity: "soon", id: "duplicates", title: tn(duplicates, "{count} possible duplicate", "{count} possible duplicates"), detail: translateText("The same thing added twice? Merge or keep both"), itemId: null, date: null, href: "#/duplicates" });
  }
  const [{ n: noSerial } = { n: 0 }] = await v.db.select({ n: count() }).from(item).where(itemScope(v, { missing: "serial" }));
  if (noSerial) {
    out.push({
      kind: "ai",
      severity: "soon",
      id: "claim-ready",
      title: tn(noSerial, "{count} valuable thing has no serial number", "{count} valuable things have no serial number"),
      detail: translateText("Insurers ask for it — photograph the label and Ferret reads it"),
      itemId: null,
      date: null,
      href: "#/missing/serial",
    });
  }

  const backup = await backupTrouble(v);
  if (backup) out.push(backup);
  // Services Ferret depends on, failing in the last day — for the server admin.
  if (await isServerAdmin(v.db, v.userId)) {
    for (const t of await serviceTrouble(v.db)) {
      const mins = Math.round((Date.now() - t.lastAt.getTime()) / 60_000);
      out.push({
        kind: "service",
        severity: mins < 60 ? "urgent" : "soon",
        id: `service:${t.service}`,
        title: translateText("{v0} is failing", { v0: t.name }),
        detail: tn(t.count, "{count} error today, the last {v2}", "{count} errors today, the last {v2}", { v2: mins < 1 ? translateText("just now") : mins < 60 ? translateText("{v0} min ago", { v0: mins }) : translateText("{v0} h ago", { v0: Math.round(mins / 60) }) }),
        itemId: null,
        date: todayFor(v, t.lastAt),
      });
    }
  }

  // The online barcode database's daily allowance, nearly or all used — for the server admin.
  if (v.deps.products && (await isServerAdmin(v.db, v.userId))) {
    const { quota } = await barcodeLookupStatus(v.deps);
    if (quota && quota.remaining <= quota.limit * 0.2) {
      const at = new Date(quota.resetsAt).toLocaleString(locale(), { weekday: "short", hour: "numeric", minute: "2-digit", timeZone: v.timeZone });
      out.push({
        kind: "service",
        severity: quota.remaining === 0 ? "urgent" : "soon",
        id: "service:barcode-quota",
        title: quota.remaining === 0 ? translateText("Online barcode lookups are used up") : translateText("Online barcode lookups are running low"),
        detail: translateText("{v0} of {v1} left; it fills up again at {v2}. Scans still match the barcode books.", { v0: quota.remaining, v1: quota.limit, v2: at }),
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
        title: c.ended ? translateText("Certificate \"{v0}\" has expired", { v0: c.name }) : translateText("Certificate \"{v0}\" expires soon", { v0: c.name }),
        detail: translateText("{v0} {v1} — add its replacement in Settings → Server → Certificates.", { v0: c.ended ? translateText("Ended") : translateText("Ends"), v1: todayFor(v, new Date(c.notAfter)) }),
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
      title: translateText("Save a copy of Ferret's keys"),
      detail: translateText("FILES_KEY is only in this server's data folder: lose that, and every photo, document and backup is lost too. Make a key file — Settings → Server → Keys."),
      itemId: null,
      date: null,
    });
  }

  // Urgent first; then by kind (things with a deadline before things waiting on someone); then soonest.
  const order: Record<AttentionItem["kind"], number> = { backup: 0, service: 0, recall: 1, maintenance: 2, return: 3, loan: 3, warranty: 4, shopping: 5, coverage: 6, claim: 7, review: 8, roomscan: 8, ai: 9 };
  return out.sort(
    (a, b) =>
      (a.severity === b.severity ? 0 : a.severity === "urgent" ? -1 : 1) ||
      order[a.kind] - order[b.kind] ||
      (a.date ?? "9999").localeCompare(b.date ?? "9999"),
  );

  });
}

/** Backups made elsewhere (Deps.backupElsewhere): the newest failed, or none for a day and a half. */
async function backupElsewhereTrouble(v: Caller, elsewhere: NonNullable<Caller["deps"]["backupElsewhere"]>): Promise<AttentionItem | null> {
  const run = await elsewhere.latest();
  const stale = !run || Date.now() - run.at.getTime() > BACKUP_STALE_MS;
  if (run && run.ok && !stale) return null;
  return {
    kind: "backup",
    severity: "urgent",
    id: "backup:elsewhere",
    title: run && !run.ok ? translateText("Backup failed") : translateText("Backups have stopped"),
    detail: run ? translateText("{v0} since {v1}{v2} ({v3})", { v0: run.ok ? translateText("None") : translateText("Failed"), v1: todayFor(v, run.at), v2: run.detail ? `: ${run.detail}` : "", v3: elsewhere.where }) : translateText("None reported yet ({v0})", { v0: elsewhere.where }),
    itemId: null,
    date: run ? todayFor(v, run.at) : null,
  };
}

/** The server's backups failing, or none lately — for the server admin (the one who can fix it), in any household. */
async function backupTrouble(v: Caller): Promise<AttentionItem | null> {
  if (v.deps.backupElsewhere && !v.deps.backups && (await isServerAdmin(v.db, v.userId))) return backupElsewhereTrouble(v, v.deps.backupElsewhere);
  if (!v.deps.backups || !(await isServerAdmin(v.db, v.userId))) return null;
  const [last] = await v.db.select().from(backupRun).orderBy(desc(backupRun.startedAt)).limit(1);
  if (!last) return null; // the first one hasn't run yet
  const [lastOk] = await v.db.select().from(backupRun).where(eq(backupRun.status, "ok")).orderBy(desc(backupRun.startedAt)).limit(1);
  const failing = last.status === "failed";
  const stale = !lastOk || Date.now() - lastOk.startedAt.getTime() > BACKUP_STALE_MS;
  if (!failing && !stale) return null;
  const since = lastOk ? translateText("No backup since {v0}", { v0: todayFor(v, lastOk.startedAt) }) : translateText("No backup has worked yet");
  return {
    kind: "backup",
    severity: failing && !stale ? "soon" : "urgent",
    id: last.id,
    title: failing ? translateText("Backup failed") : translateText("Backups have stopped"),
    detail: failing && last.error ? `${since}: ${last.error}` : since,
    itemId: null,
    date: todayFor(v, (lastOk ?? last).startedAt),
  };
}
