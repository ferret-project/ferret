/**
 * Lending: a thing lent to someone, or borrowed from them, until it's back. One open loan per thing.
 *
 * A lent thing with the borrower's email can remind them every week, two weeks or month (`sendLoanReminders`, from
 * the hourly reminder tick, by Ferret's own email — MAIL_URL): "you still have Sam's ladder, since May 3". Each email
 * links to a page (`/b/<token>`, no account) where they can say it's back — the bell then asks someone here to agree —
 * or stop the reminders. The first reminder goes on the due date if there is one, else one interval after lending.
 * Borrowed things remind *you* (the bell) when they're due back.
 */
import { type BorrowerView, type LoanInput, type LoanPatch, type LoanSummary, addDays, addMonths, today } from "@ferret/shared";
import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { activity, item, loan, organization, user } from "../db/schema";
import type { Db, Deps } from "../ports";
import type { FileStore } from "./files";
import { type Caller, itemScope, logActivity, notFound } from "./inventory";
import { mailTo } from "./notifications";
import { hashToken, newToken } from "./shares";
import { todayFor, zoneCache } from "./household-time";
import { inList } from "./sql";

type Row = typeof loan.$inferSelect;
const sealLabel = (id: string) => `loan:${id}`;
export const borrowerUrl = (appUrl: string, token: string) => `${appUrl}/b/${token}`;

const summary = (r: Row, itemName: string, on: string): LoanSummary => ({
  id: r.id,
  itemId: r.itemId,
  itemName,
  direction: r.direction,
  person: r.person,
  email: r.email,
  since: r.since,
  dueOn: r.dueOn,
  note: r.note,
  remindEvery: r.remindEvery,
  lastRemindedOn: r.lastRemindedOn,
  borrowerReturnedAt: r.borrowerReturnedAt?.toISOString() ?? null,
  remindersStoppedAt: r.remindersStoppedAt?.toISOString() ?? null,
  returnedOn: r.returnedOn,
  overdue: !r.returnedOn && Boolean(r.dueOn && r.dueOn < on),
});

const words = (r: Pick<Row, "direction" | "person">, name: string) => (r.direction === "lent" ? `Lent ${name} to ${r.person}` : `Borrowed ${name} from ${r.person}`);

/** Open loans (and, with `all`, those returned in the last 90 days), newest first. */
export async function listLoans(v: Caller, opts: { all?: boolean; itemId?: string } = {}) {
  const where = [eq(loan.householdId, v.householdId)];
  if (opts.itemId) where.push(eq(loan.itemId, opts.itemId));
  if (!opts.all) where.push(isNull(loan.returnedOn));
  const rows = await v.db
    .select({ l: loan, name: item.name })
    .from(loan)
    .innerJoin(item, eq(item.id, loan.itemId))
    .where(and(...where, isNull(item.deletedAt)))
    .orderBy(desc(loan.since), desc(loan.createdAt))
    .limit(200);
  const cutoff = addDays(todayFor(v), -90);
  return rows.filter(({ l }) => !l.returnedOn || opts.itemId || l.returnedOn >= cutoff).map(({ l, name }) => summary(l, name, todayFor(v)));
}

/** Open loans for these items (for lists: "Lent to Sam"). */
export async function openLoansFor(v: Pick<Caller, "db" | "householdId">, itemIds: string[]) {
  const out = new Map<string, Row>();
  const rows = await v.db
    .select()
    .from(loan)
    .where(and(eq(loan.householdId, v.householdId), isNull(loan.returnedOn), inList(loan.itemId, itemIds)));
  for (const r of rows) out.set(r.itemId, r);
  return out;
}

async function itemOf(v: Caller, itemId: string) {
  const [row] = await v.db.select({ id: item.id, name: item.name }).from(item).where(and(eq(item.id, itemId), itemScope(v)));
  if (!row) throw notFound("Item");
  return row;
}

async function loanIn(v: Caller, id: string) {
  const [row] = await v.db
    .select({ l: loan, name: item.name })
    .from(loan)
    .innerJoin(item, eq(item.id, loan.itemId))
    .where(and(eq(loan.id, id), eq(loan.householdId, v.householdId)));
  if (!row) throw notFound("Loan");
  return row;
}

/** Reminders need somewhere to go and a link for the borrower: made the first time they're asked for. */
async function withToken(v: Caller, files: FileStore, r: Row) {
  if (r.tokenHash || r.direction !== "lent" || !r.email || !r.remindEvery) return r;
  const token = newToken();
  const [row] = await v.db
    .update(loan)
    .set({ tokenHash: await hashToken(token), tokenSealed: await files.seal(v.householdId, sealLabel(r.id), token) })
    .where(eq(loan.id, r.id))
    .returning();
  return row!;
}

export async function createLoan(v: Caller, files: FileStore, itemId: string, input: LoanInput) {
  const thing = await itemOf(v, itemId);
  const [open] = await v.db.select({ id: loan.id }).from(loan).where(and(eq(loan.itemId, itemId), isNull(loan.returnedOn)));
  if (open) throw new HTTPException(409, { message: `${thing.name} is already lent or borrowed — mark it back first` });
  const lent = input.direction === "lent";
  const since = input.since ?? todayFor(v);
  if (input.dueOn && input.dueOn < since) throw new HTTPException(422, { message: "It can't be due back before it went" });
  const [row] = await v.db
    .insert(loan)
    .values({
      householdId: v.householdId,
      itemId,
      direction: input.direction,
      person: input.person,
      email: lent ? (input.email ?? null) : null,
      since,
      dueOn: input.dueOn ?? null,
      note: input.note ?? null,
      remindEvery: lent && input.email ? (input.remindEvery ?? null) : null,
      createdBy: v.userId,
    })
    .returning();
  await withToken(v, files, row!);
  await logActivity(v, "loan.create", row!.id, `${words(row!, thing.name)}${input.dueOn ? ` (due back ${input.dueOn})` : ""}`, itemId);
  return summary(row!, thing.name, todayFor(v));
}

export async function updateLoan(v: Caller, files: FileStore, id: string, patch: LoanPatch) {
  const { l, name } = await loanIn(v, id);
  const lent = l.direction === "lent";
  const email = patch.email !== undefined ? patch.email : l.email;
  const changes: Partial<Row> = {
    ...(patch.person !== undefined ? { person: patch.person } : {}),
    ...(patch.since ? { since: patch.since } : {}),
    ...(patch.dueOn !== undefined ? { dueOn: patch.dueOn } : {}),
    ...(patch.note !== undefined ? { note: patch.note } : {}),
    ...(lent && patch.email !== undefined ? { email: patch.email } : {}),
    ...(lent && patch.remindEvery !== undefined ? { remindEvery: email ? patch.remindEvery : null } : {}),
  };
  if (!email) changes.remindEvery = null;
  const since = changes.since ?? l.since;
  const due = changes.dueOn !== undefined ? changes.dueOn : l.dueOn;
  if (due && due < since) throw new HTTPException(422, { message: "It can't be due back before it went" });
  const [row] = await v.db.update(loan).set(changes).where(eq(loan.id, id)).returning();
  return summary(await withToken(v, files, row!), name, todayFor(v));
}

/** It's back (or, borrowed, given back): the loan ends; the borrower's link stops working. */
export async function returnLoan(v: Caller, id: string, on?: string | null) {
  const { l, name } = await loanIn(v, id);
  if (l.returnedOn) throw new HTTPException(409, { message: "That's already back" });
  const [row] = await v.db.update(loan).set({ returnedOn: on ?? todayFor(v), tokenHash: null, tokenSealed: null }).where(eq(loan.id, id)).returning();
  await logActivity(v, "loan.return", id, l.direction === "lent" ? `${name} is back from ${l.person}` : `Gave ${name} back to ${l.person}`, l.itemId);
  return summary(row!, name, todayFor(v));
}

/** A loan made by mistake. */
export async function deleteLoan(v: Caller, id: string) {
  const { l, name } = await loanIn(v, id);
  await v.db.delete(loan).where(eq(loan.id, id));
  await logActivity(v, "loan.delete", id, `Removed the loan of ${name} (${l.person})`, l.itemId);
}

// ── The borrower's page (no account) ────────────────────────────────────────

async function byToken(db: Db, token: string) {
  if (!/^[\w-]{20,100}$/.test(token)) throw new HTTPException(404, { message: "This link doesn't work" });
  const [row] = await db
    .select({ l: loan, name: item.name, owner: user.name })
    .from(loan)
    .innerJoin(item, eq(item.id, loan.itemId))
    .leftJoin(user, eq(user.id, loan.createdBy))
    .where(eq(loan.tokenHash, await hashToken(token)));
  if (!row) throw new HTTPException(404, { message: "This link doesn't work any more — the loan may be over" });
  return row;
}

const firstName = (name: string | null) => name?.trim().split(/\s+/)[0] || "Its owner";

export async function borrowerView(db: Db, token: string): Promise<BorrowerView> {
  const { l, name, owner } = await byToken(db, token);
  return {
    person: l.person,
    owner: firstName(owner),
    itemName: name,
    since: l.since,
    dueOn: l.dueOn,
    returned: Boolean(l.returnedOn),
    reportedBack: Boolean(l.borrowerReturnedAt),
    stopped: Boolean(l.remindersStoppedAt),
  };
}

/** The borrower says it's back: no more reminders, and the bell asks someone here to agree. */
export async function borrowerReturned(db: Db, token: string) {
  const { l, name } = await byToken(db, token);
  if (!l.borrowerReturnedAt && !l.returnedOn) {
    await db.update(loan).set({ borrowerReturnedAt: new Date() }).where(eq(loan.id, l.id));
    await db.insert(activity).values({
      householdId: l.householdId,
      actorId: null,
      via: "web",
      action: "loan.reported",
      entityType: "loan",
      entityId: l.id,
      itemId: l.itemId,
      summary: `${l.person} says ${name} is back`,
    });
  }
  return borrowerView(db, token);
}

export async function borrowerStop(db: Db, token: string) {
  const { l } = await byToken(db, token);
  if (!l.remindersStoppedAt) await db.update(loan).set({ remindersStoppedAt: new Date() }).where(eq(loan.id, l.id));
  return borrowerView(db, token);
}

// ── Reminders to borrowers ──────────────────────────────────────────────────

const STEP = { week: (d: string) => addDays(d, 7), "2weeks": (d: string) => addDays(d, 14), month: (d: string) => addMonths(d, 1) } as const;

/** When this loan's next reminder is due (null: none). */
export function nextReminder(r: Pick<Row, "remindEvery" | "since" | "dueOn" | "lastRemindedOn">) {
  if (!r.remindEvery) return null;
  const step = STEP[r.remindEvery];
  if (r.lastRemindedOn) return step(r.lastRemindedOn);
  return r.dueOn ?? step(r.since);
}

const longDate = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

/** Emails every borrower whose reminder is due today (at most one a day each). Returns how many went. */
export async function sendLoanReminders(
  deps: Pick<Deps, "db" | "notifier"> & {
    files: FileStore;
    mailUrl?: string;
    appUrl: string;
    /** Today for this household (null: not yet time there). Default: today where it is. */
    dayFor?: (householdId: string) => Promise<string | null>;
    /** One day for every household (tests). */
    on?: string;
  },
) {
  const { db, notifier, files, mailUrl } = deps;
  if (!notifier || !mailUrl) return 0;
  const zoneOf = zoneCache(db);
  const dayFor = deps.dayFor ?? (async (householdId: string) => today(undefined, await zoneOf(householdId)));
  const rows = await db
    .select({ l: loan, name: item.name, owner: user.name, household: organization.name })
    .from(loan)
    .innerJoin(item, eq(item.id, loan.itemId))
    .innerJoin(organization, eq(organization.id, loan.householdId))
    .leftJoin(user, eq(user.id, loan.createdBy))
    .where(
      and(
        eq(loan.direction, "lent"),
        isNull(loan.returnedOn),
        isNull(loan.borrowerReturnedAt),
        isNull(loan.remindersStoppedAt),
        isNotNull(loan.email),
        isNotNull(loan.remindEvery),
        isNotNull(loan.tokenSealed),
        isNull(item.deletedAt),
      ),
    );
  let sent = 0;
  for (const { l, name, owner } of rows) {
    const on = deps.on ?? (await dayFor(l.householdId));
    const next = nextReminder(l);
    if (!on || !next || next > on || l.lastRemindedOn === on) continue;
    const who = firstName(owner);
    const link = borrowerUrl(deps.appUrl, await files.open(l.householdId, sealLabel(l.id), l.tokenSealed!));
    try {
      await notifier.send(mailTo(mailUrl, l.email!), {
        title: `A reminder from ${who}: ${name}`,
        body:
          `Hi ${l.person},\n\n${who} lent you ${name} on ${longDate(l.since)}` +
          `${l.dueOn ? `, to bring back by ${longDate(l.dueOn)}` : ""}. This is a friendly reminder that it's still with you.\n\n` +
          `Already given it back, or don't want these reminders? Let ${who} know here:\n${link}\n\n— sent by Ferret, ${who}'s home inventory`,
      });
      await db.update(loan).set({ lastRemindedOn: on }).where(eq(loan.id, l.id));
      sent++;
    } catch (err) {
      console.warn(`Loan reminder for ${l.id} failed: ${String(err)}`);
    }
  }
  return sent;
}
