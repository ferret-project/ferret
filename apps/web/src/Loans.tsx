/**
 * Lending (server: lib/loans.ts):
 * - LoanCard on an item's page: "Lend or borrow…", or who has it (since, due back, reminders) with "It's back".
 *   Borrowed: not counted as the household's; "Given back" moves it to Past things (its banner there offers Borrow
 *   again, or keeping it in your things), "It's ours now…" (KeepDialog) makes it the household's — a gift, or bought.
 * - LoanDialog: lent to / borrowed from, who, their email and how often to remind them (lent), since, due back, a note.
 * - Loans (#/loans, account menu "Lent & borrowed"): everything out, overdue first.
 * - Borrower (#/b/:token, from a reminder email, no account): "I've given it back" / "Stop these reminders".
 */
import { TopBar } from "./Nav";
import type { LoanDirection, LoanInput, LoanSummary } from "@ferret/shared";
import { today } from "@ferret/shared/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Logo } from "./AuthLayout";
import { HelpLink } from "./HelpLink";
import { api } from "./lib/api";
import { useCanEdit } from "./lib/auth";
import { useRefreshAll } from "./Gone";
import { currencySymbol, toCents } from "./lib/money";
import { itemHref } from "./lib/route";
import { DialogActions, Modal } from "./Modal";
import { t, ph, msg } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";

const shortDate = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
const EVERY = { week: msg`every week`, "2weeks": msg`every 2 weeks`, month: msg`every month` } as const;

/** "With Sam since May 3 · due back May 10" */
export function loanLine(l: Pick<LoanSummary, "direction" | "person" | "since" | "dueOn">) {
  const since = shortDate(l.since);
  const line = l.direction === "lent" ? t`With ${ph({ person: l.person })} since ${since}` : t`Borrowed from ${ph({ person: l.person })} since ${since}`;
  return l.dueOn ? t`${line} · due back ${ph({ date: shortDate(l.dueOn) })}` : line;
}

/** Loans, and everything that lists or totals things (a borrowed thing given back or kept changes them). */
function useRefresh(householdId: string, itemId?: string) {
  const qc = useQueryClient();
  const all = useRefreshAll(householdId);
  return () =>
    Promise.all([
      all(),
      ...[["loans", householdId], ...(itemId ? [["item", householdId, itemId]] : [])].map((queryKey) => qc.invalidateQueries({ queryKey })),
    ]);
}

export function LoanCard({ itemId, itemName, householdId, canEdit }: { itemId: string; itemName: string; householdId: string; canEdit: boolean }) {
  const loans = useQuery({ queryKey: ["loans", householdId, itemId], queryFn: () => api.itemLoans(itemId) });
  const refresh = useRefresh(householdId, itemId);
  const [editing, setEditing] = useState<LoanSummary | "new" | null>(null);
  const [keeping, setKeeping] = useState(false);
  const back = useMutation({ mutationFn: api.loanReturned, onSuccess: refresh });
  const open = loans.data?.data.find((l) => !l.returnedOn);
  if (!loans.data) return null;
  const dialog = editing && (
    <LoanDialog itemId={itemId} itemName={itemName} householdId={householdId} canEmail={loans.data.canEmail} loan={editing === "new" ? null : editing} onClose={() => setEditing(null)} />
  );
  if (!open) {
    return canEdit ? (
      <div>
        <button type="button" className="btn btn-soft btn-secondary btn-sm" onClick={() => setEditing("new")}>
          <span className="icon-[tabler--arrows-exchange] size-4" />
          <Trans>Lend or borrow…</Trans>
        </button>
        {dialog}
      </div>
    ) : null;
  }
  return (
    <section className="card" aria-labelledby={`loan-${itemId}`}>
      <div className="card-body gap-3">
        <h2 id={`loan-${itemId}`} className="card-title flex items-center gap-2">
          <span className="icon-[tabler--arrows-exchange] size-5 text-primary" />
          {open.direction === "lent" ? t`Lent out` : t`Borrowed`}
          <HelpLink page="guide/lending.html" label={t`Lending`} />
        </h2>
        <div>
          <p className={open.overdue ? "font-medium text-warning" : ""}>{loanLine(open)}</p>
          {open.direction === "lent" && open.remindEvery && (
            <p className="text-sm text-base-content/70">
              {open.remindersStoppedAt
                ? t`${ph({ person: open.person })} asked for no more reminders`
                : open.lastRemindedOn
                  ? t`Reminding ${ph({ email: open.email ?? "" })} ${ph({ every: t(EVERY[open.remindEvery]) })} · last ${ph({ date: shortDate(open.lastRemindedOn) })}`
                  : t`Reminding ${ph({ email: open.email ?? "" })} ${ph({ every: t(EVERY[open.remindEvery]) })}`}
            </p>
          )}
          {open.borrowerReturnedAt && <p className="text-sm font-medium text-info"><Trans>{ph({ person: open.person })} says it's back.</Trans></p>}
          {open.note && <p className="text-sm text-base-content/70">{open.note}</p>}
          {open.direction === "borrowed" && (
            <p className="text-sm text-base-content/70">
              <Trans>It's {ph({ person: open.person })}'s, so it isn't counted in your totals or the insurance report. Given back, it moves to Past things.</Trans>
            </p>
          )}
        </div>
        {canEdit && (
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-primary btn-sm" disabled={back.isPending} onClick={() => back.mutate(open.id)}>
              <span className="icon-[tabler--check] size-4" />
              {open.direction === "lent" ? t`It's back` : t`Given back`}
            </button>
            {open.direction === "borrowed" && (
              <button type="button" className="btn btn-soft btn-sm" onClick={() => setKeeping(true)}>
                <span className="icon-[tabler--gift] size-4" />
                <Trans>It's ours now…</Trans>
              </button>
            )}
            <button type="button" className="btn btn-soft btn-sm" onClick={() => setEditing(open)}>
              <Trans>Edit</Trans>
            </button>
          </div>
        )}
        {back.isError && <p className="text-sm text-error">{back.error.message}</p>}
      </div>
      {dialog}
      {keeping && <KeepDialog loan={open} householdId={householdId} onClose={() => setKeeping(false)} />}
    </section>
  );
}

function LoanDialog({
  itemId,
  itemName,
  householdId,
  canEmail,
  loan,
  onClose,
}: {
  itemId: string;
  itemName: string;
  householdId: string;
  canEmail: boolean;
  loan: LoanSummary | null;
  onClose: () => void;
}) {
  const refresh = useRefresh(householdId, itemId);
  const [direction, setDirection] = useState<LoanDirection>(loan?.direction ?? "lent");
  const [email, setEmail] = useState(loan?.email ?? "");
  const save = useMutation({
    mutationFn: (input: LoanInput) => (loan ? api.updateLoan(loan.id, input) : api.lend(itemId, input)),
    onSuccess: async () => {
      await refresh();
      onClose();
    },
  });
  const remove = useMutation({
    mutationFn: () => api.deleteLoan(loan!.id),
    onSuccess: async () => {
      await refresh();
      onClose();
    },
  });
  const lent = direction === "lent";
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const text = (k: string) => String(f.get(k) ?? "").trim() || null;
    save.mutate({
      direction,
      person: text("person")!,
      email: lent ? text("email") : null,
      since: text("since"),
      dueOn: text("due"),
      note: text("note"),
      remindEvery: lent && text("email") ? ((text("remind") as LoanInput["remindEvery"]) ?? null) : null,
    });
  }
  return (
    <Modal id="loan" title={loan ? `${itemName}: ${lent ? "lent" : "borrowed"}` : t`Lend or borrow ${itemName}`} onClose={onClose}>
      <form className="flex flex-col gap-4" onSubmit={onSubmit}>
        {!loan && (
          <fieldset className="flex flex-wrap gap-2">
            <legend className="label-text mb-2"><Trans>This is</Trans></legend>
            {(["lent", "borrowed"] as const).map((d) => (
              <label key={d} className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-field border px-3 ${direction === d ? "border-primary bg-primary/10" : "border-base-content/15"}`}>
                <input type="radio" name="direction" className="radio radio-primary radio-sm" checked={direction === d} onChange={() => setDirection(d)} />
                {d === "lent" ? t`Mine, lent to someone` : t`Someone's, borrowed by us`}
              </label>
            ))}
          </fieldset>
        )}
        <div>
          <label className="label-text" htmlFor="loan-person">
            {lent ? t`Who has it` : t`Whose it is`}
          </label>
          <input id="loan-person" name="person" className="input" required maxLength={80} defaultValue={loan?.person} placeholder={t`e.g. Sam next door`} autoFocus />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label-text" htmlFor="loan-since">
              <Trans>Since</Trans>
            </label>
            <input id="loan-since" name="since" type="date" className="input" defaultValue={loan?.since ?? today()} max={today()} required />
          </div>
          <div>
            <label className="label-text" htmlFor="loan-due">
              <Trans>Due back</Trans>
            </label>
            <input id="loan-due" name="due" type="date" className="input" defaultValue={loan?.dueOn ?? ""} />
          </div>
        </div>
        {lent && (
          <div className="rounded-box bg-base-200 p-3">
            <label className="label-text" htmlFor="loan-email">
              <Trans>Their email, to remind them (optional)</Trans>
            </label>
            <input id="loan-email" name="email" type="email" className="input" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="sam@example.com" maxLength={320} />
            {email.trim() && (
              <div className="mt-3">
                <label className="label-text" htmlFor="loan-remind">
                  <Trans>Remind them</Trans>
                </label>
                <select id="loan-remind" name="remind" className="select" defaultValue={loan?.remindEvery ?? "2weeks"}>
                  <option value="">{t`Don't`}</option>
                  <option value="week">{t`Every week`}</option>
                  <option value="2weeks">{t`Every 2 weeks`}</option>
                  <option value="month">{t`Every month`}</option>
                </select>
              </div>
            )}
            <p className="mt-2 text-sm text-base-content/70">
              {canEmail
                ? t`A friendly email that it's still with them — from the due date if there is one — with a link to say it's back or to stop the reminders.`
                : t`Ferret can't send email yet (whoever runs it sets MAIL_URL), so no reminders go until it can.`}
            </p>
          </div>
        )}
        <div>
          <label className="label-text" htmlFor="loan-note">
            <Trans>Note</Trans>
          </label>
          <input id="loan-note" name="note" className="input" maxLength={1000} defaultValue={loan?.note ?? ""} placeholder="optional" />
        </div>
        {loan && (
          <div>
            <button type="button" className="btn btn-text btn-error btn-sm" disabled={remove.isPending} onClick={() => window.confirm(t`Remove this loan? (Use “It's back” when it's back.)`) && remove.mutate()}>
              <Trans>Remove — it was a mistake</Trans>
            </button>
          </div>
        )}
        {(save.error ?? remove.error) && <div className="alert alert-soft alert-error">{(save.error ?? remove.error)!.message}</div>}
        <DialogActions>
          <button type="button" className="btn btn-secondary btn-soft" onClick={onClose}>
            <Trans>Cancel</Trans>
          </button>
          <button type="submit" className="btn btn-primary" disabled={save.isPending}>
            {save.isPending && <span className="loading loading-spinner loading-sm" />}
            <Trans>Save</Trans>
          </button>
        </DialogActions>
      </form>
    </Modal>
  );
}

/** #/loans — everything lent out or borrowed, overdue first. */
/** "It's ours now": its owner gave it to us, or we bought it — it becomes the household's, history and all. */
function KeepDialog({ loan, householdId, onClose }: { loan: LoanSummary; householdId: string; onClose: () => void }) {
  const refresh = useRefresh(householdId, loan.itemId);
  const [bought, setBought] = useState(false);
  const save = useMutation({
    mutationFn: (input: { on: string; priceCents: number | null }) => api.loanKept(loan.id, input),
    onSuccess: async () => {
      await refresh();
      onClose();
    },
  });
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    save.mutate({ on: String(f.get("on")), priceCents: bought ? toCents(f.get("price")) : null });
  }
  return (
    <Modal id="loan-keep" title={t`Is ${ph({ name: loan.itemName })} yours now?`} onClose={onClose}>
      <form className="flex flex-col gap-4" onSubmit={onSubmit}>
        <p className="text-sm text-base-content/70">
          <Trans>It stops being {ph({ person: loan.person })}'s and counts as yours — in your totals and the insurance report. Its history, maintenance and repairs stay with it.</Trans>
        </p>
        <fieldset className="flex flex-col gap-2">
          <legend className="label-text mb-1"><Trans>How</Trans></legend>
          <label className="flex min-h-11 cursor-pointer items-center gap-3">
            <input type="radio" name="how" className="radio radio-primary radio-sm" checked={!bought} onChange={() => setBought(false)} />
            <Trans>{ph({ person: loan.person })} gave it to us</Trans>
          </label>
          <label className="flex min-h-11 cursor-pointer items-center gap-3">
            <input type="radio" name="how" className="radio radio-primary radio-sm" checked={bought} onChange={() => setBought(true)} />
            <Trans>We bought it</Trans>
          </label>
        </fieldset>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label-text" htmlFor="keep-on">
              <Trans>When</Trans>
            </label>
            <input id="keep-on" name="on" type="date" className="input" defaultValue={today()} min={loan.since} max={today()} required />
          </div>
          {bought && (
            <div>
              <label className="label-text" htmlFor="keep-price">
                <Trans>Paid</Trans>
              </label>
              <div className="input">
                <span className="my-auto me-1 text-base-content/70">{currencySymbol()}</span>
                <input id="keep-price" name="price" className="grow" inputMode="decimal" placeholder={t`optional`} />
              </div>
            </div>
          )}
        </div>
        {save.isError && <div className="alert alert-soft alert-error">{save.error.message}</div>}
        <DialogActions>
          <button type="button" className="btn btn-secondary btn-soft" onClick={onClose}>
            <Trans>Cancel</Trans>
          </button>
          <button type="submit" className="btn btn-primary" disabled={save.isPending}>
            {save.isPending && <span className="loading loading-spinner loading-sm" />}
            <Trans>It's ours</Trans>
          </button>
        </DialogActions>
      </form>
    </Modal>
  );
}

export function Loans({ householdId }: { householdId: string }) {
  const loans = useQuery({ queryKey: ["loans", householdId], queryFn: () => api.loans() });
  const canEdit = useCanEdit(householdId);
  const refresh = useRefresh(householdId);
  // A borrowed thing given back went to Past things: said here, with "Keep it in my things" to undo that.
  const [moved, setMoved] = useState<{ itemId: string; name: string } | null>(null);
  const back = useMutation({
    mutationFn: api.loanReturned,
    onSuccess: async (l) => {
      setMoved(l.movedToPast ? { itemId: l.itemId, name: l.itemName } : null);
      await refresh();
    },
  });
  const keep = useMutation({
    mutationFn: (itemId: string) => api.updateItem(itemId, { disposition: null }),
    onSuccess: async () => {
      setMoved(null);
      await refresh();
    },
  });
  const all = [...(loans.data?.data ?? [])].sort((a, b) => Number(b.overdue) - Number(a.overdue) || (a.dueOn ?? "9999").localeCompare(b.dueOn ?? "9999"));
  const groups = [
    { key: "lent", title: t`Lent out`, list: all.filter((l) => l.direction === "lent") },
    { key: "borrowed", title: t`Borrowed`, list: all.filter((l) => l.direction === "borrowed") },
  ];
  return (
    <div className="min-h-dvh bg-base-200">
      <TopBar
        title={<Trans>Lent &amp; borrowed</Trans>}
        back="#/"
        help={<HelpLink page="guide/lending.html" label={t`Lending`} />}
      />
      <main className="mx-auto flex max-w-3xl flex-col gap-4 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        {loans.isPending && <span className="loading loading-spinner text-primary mx-auto my-12" />}
        {moved && (
          <div className="alert alert-soft alert-success flex flex-wrap items-center gap-3" role="status">
            <span className="icon-[tabler--arrow-back-up] size-5 shrink-0" />
            <p className="min-w-0 flex-1 text-sm">
              <Trans>{ph({ name: moved.name })} moved to Past things, as given back.</Trans>
            </p>
            <button type="button" className="btn btn-soft btn-sm" disabled={keep.isPending} onClick={() => keep.mutate(moved.itemId)}>
              <Trans>Keep it in my things</Trans>
            </button>
          </div>
        )}
        {keep.isError && <div className="alert alert-soft alert-error">{keep.error.message}</div>}
        {loans.data && !all.length && (
          <div className="card">
            <div className="card-body items-center gap-3 text-center">
              <span className="icon-[tabler--arrows-exchange] size-10 text-primary" />
              <h2 className="text-lg font-semibold"><Trans>Nothing's out</Trans></h2>
              <p className="max-w-sm text-sm text-base-content/70">
                <Trans>Lend something from its page (Lend or borrow…) and it's listed here until it's back — with a reminder email to whoever has it, if
                you like.</Trans>
              </p>
            </div>
          </div>
        )}
        {groups.map(
          (g) =>
            g.list.length > 0 && (
              <section key={g.key} className="card">
                <div className="card-body gap-2 p-4 sm:p-6">
                  <h2 className="card-title text-base">
                    {g.title} <span className="badge badge-soft">{g.list.length}</span>
                  </h2>
                  <ul className="divide-y divide-base-content/10">
                    {g.list.map((l) => (
                      <li key={l.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2">
                        <a href={itemHref(l.itemId)} className="min-w-0 flex-1 basis-48">
                          <span className="block truncate font-medium">{l.itemName}</span>
                          <span className={`block text-sm ${l.overdue ? "text-warning" : "text-base-content/70"}`}>
                            {loanLine(l)}
                            {l.overdue ? t` · overdue` : ""}
                            {l.borrowerReturnedAt ? t` · ${ph({ person: l.person })} says it's back` : ""}
                          </span>
                        </a>
                        {canEdit && (
                          <button type="button" className="btn btn-soft btn-sm" disabled={back.isPending} onClick={() => back.mutate(l.id)}>
                            {l.direction === "lent" ? t`It's back` : t`Given back`}
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              </section>
            ),
        )}
      </main>
    </div>
  );
}

/** #/b/:token — the borrower's page, from a reminder email. No account. */
export function Borrower({ token }: { token: string }) {
  const qc = useQueryClient();
  const view = useQuery({ queryKey: ["borrowed", token], queryFn: () => api.borrowed(token), retry: false });
  const set = (data: Awaited<ReturnType<typeof api.borrowed>>) => qc.setQueryData(["borrowed", token], data);
  const back = useMutation({ mutationFn: () => api.borrowedReturned(token), onSuccess: set });
  const stop = useMutation({ mutationFn: () => api.borrowedStop(token), onSuccess: set });
  const v = view.data;
  return (
    <div className="flex min-h-dvh items-start justify-center bg-base-200 p-4 pt-[10vh]">
      <section className="card w-full max-w-md">
        <div className="card-body gap-4">
          <Logo className="text-lg text-primary" />
          {view.isPending && <span className="loading loading-spinner text-primary mx-auto" />}
          {view.isError && <p>{view.error.message}</p>}
          {v && (
            <>
              <h1 className="text-xl font-semibold">
                <Trans>Hi {ph({ person: v.person })} — you have {ph({ owner: v.owner })}'s {ph({ itemName: v.itemName })}</Trans>
              </h1>
              <p className="text-base-content/80">
                {v.dueOn
                  ? t`${ph({ owner: v.owner })} lent it to you on ${ph({ since: shortDate(v.since) })}, to bring back by ${ph({ due: shortDate(v.dueOn) })}.`
                  : t`${ph({ owner: v.owner })} lent it to you on ${ph({ since: shortDate(v.since) })}.`}
              </p>
              {v.returned || v.reportedBack ? (
                <div className="alert alert-soft alert-success"><Trans>Thanks — {ph({ owner: v.owner })} knows it's back. No more reminders.</Trans></div>
              ) : (
                <div className="flex flex-col gap-2">
                  <button type="button" className="btn btn-primary" disabled={back.isPending} onClick={() => back.mutate()}>
                    <span className="icon-[tabler--check] size-5" />
                    <Trans>I've given it back</Trans>
                  </button>
                  {v.stopped ? (
                    <p className="text-sm text-base-content/70"><Trans>No more reminders will be sent.</Trans></p>
                  ) : (
                    <button type="button" className="btn btn-soft" disabled={stop.isPending} onClick={() => stop.mutate()}>
                      <Trans>Stop these reminders</Trans>
                    </button>
                  )}
                </div>
              )}
              {(back.error ?? stop.error) && <p className="text-sm text-error">{(back.error ?? stop.error)!.message}</p>}
            </>
          )}
        </div>
      </section>
    </div>
  );
}
