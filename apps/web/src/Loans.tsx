import { locale } from "./i18n";
import { t as translateText } from "./i18n";
import { tr } from "./i18n";
/**
 * Lending (server: lib/loans.ts):
 * - LoanCard on an item's page: "Lend or borrow…", or who has it (since, due back, reminders) with "It's back".
 * - LoanDialog: lent to / borrowed from, who, their email and how often to remind them (lent), since, due back, a note.
 * - Loans (#/loans, account menu "Lent & borrowed"): everything out, overdue first.
 * - Borrower (#/b/:token, from a reminder email, no account): "I've given it back" / "Stop these reminders".
 */
import { BarSearch } from "./Nav";
import type { LoanDirection, LoanInput, LoanSummary } from "@ferret/shared";
import { today } from "@ferret/shared/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Logo } from "./AuthLayout";
import { HelpLink } from "./HelpLink";
import { api } from "./lib/api";
import { useCanEdit } from "./lib/auth";
import { itemHref } from "./lib/route";
import { DialogActions, Modal } from "./Modal";

const shortDate = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString(locale(), { month: "short", day: "numeric", year: "numeric" });
const EVERY = { get week() { return translateText("every week"); }, get "2weeks"() { return translateText("every 2 weeks"); }, get month() { return translateText("every month"); } } as const;

/** "With Sam since May 3 · due back May 10" */
export function loanLine(l: Pick<LoanSummary, "direction" | "person" | "since" | "dueOn">) {
  return translateText("{v0} since {v1}{v2}", { v0: l.direction === "lent" ? translateText("With {v0}", { v0: l.person }) : translateText("Borrowed from {v0}", { v0: l.person }), v1: shortDate(l.since), v2: l.dueOn ? translateText(" · due back {v0}", { v0: shortDate(l.dueOn) }) : "" });
}

function useRefresh(householdId: string, itemId?: string) {
  const qc = useQueryClient();
  return () =>
    Promise.all(
      [["loans", householdId], ["items", householdId], ["attention", householdId], ...(itemId ? [["item", householdId, itemId]] : [])].map((queryKey) =>
        qc.invalidateQueries({ queryKey }),
      ),
    );
}

export function LoanCard({ itemId, itemName, householdId, canEdit }: { itemId: string; itemName: string; householdId: string; canEdit: boolean }) {
  const loans = useQuery({ queryKey: ["loans", householdId, itemId], queryFn: () => api.itemLoans(itemId) });
  const refresh = useRefresh(householdId, itemId);
  const [editing, setEditing] = useState<LoanSummary | "new" | null>(null);
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
          {translateText("Lend or borrow…")}</button>
        {dialog}
      </div>
    ) : null;
  }
  return (
    <section className="card" aria-labelledby={`loan-${itemId}`}>
      <div className="card-body gap-3">
        <h2 id={`loan-${itemId}`} className="card-title flex items-center gap-2">
          <span className="icon-[tabler--arrows-exchange] size-5 text-primary" />
          {open.direction === "lent" ? translateText("Lent out") : translateText("Borrowed")}
          <HelpLink page="guide/lending.html" label={translateText("Lending")} />
        </h2>
        <div>
          <p className={open.overdue ? "font-medium text-warning" : ""}>{loanLine(open)}</p>
          {open.direction === "lent" && open.remindEvery && (
            <p className="text-sm text-base-content/70">
              {open.remindersStoppedAt
                ? translateText("{v0} asked for no more reminders", { v0: open.person })
                : translateText("Reminding {v0} {v1}{v2}", { v0: open.email, v1: EVERY[open.remindEvery], v2: open.lastRemindedOn ? translateText(" · last {v0}", { v0: shortDate(open.lastRemindedOn) }) : "" })}
            </p>
          )}
          {open.borrowerReturnedAt && <p className="text-sm font-medium text-info">{tr("{v0} says it's back.", { v0: open.person })}</p>}
          {open.note && <p className="text-sm text-base-content/70">{open.note}</p>}
        </div>
        {canEdit && (
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-primary btn-sm" disabled={back.isPending} onClick={() => back.mutate(open.id)}>
              <span className="icon-[tabler--check] size-4" />
              {open.direction === "lent" ? translateText("It's back") : translateText("Given back")}
            </button>
            <button type="button" className="btn btn-soft btn-sm" onClick={() => setEditing(open)}>
              {translateText("Edit")}</button>
          </div>
        )}
        {back.isError && <p className="text-sm text-error">{back.error.message}</p>}
      </div>
      {dialog}
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
    <Modal id="loan" title={loan ? translateText("{v0}: {v1}", { v0: itemName, v1: lent ? translateText("Lent") : translateText("Borrowed") }) : translateText("Lend or borrow {v0}", { v0: itemName })} onClose={onClose}>
      <form className="flex flex-col gap-4" onSubmit={onSubmit}>
        {!loan && (
          <fieldset className="flex flex-wrap gap-2">
            <legend className="label-text mb-2">{translateText("This is")}</legend>
            {(["lent", "borrowed"] as const).map((d) => (
              <label key={d} className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-field border px-3 ${direction === d ? "border-primary bg-primary/10" : "border-base-content/15"}`}>
                <input type="radio" name="direction" className="radio radio-primary radio-sm" checked={direction === d} onChange={() => setDirection(d)} />
                {d === "lent" ? translateText("Mine, lent to someone") : translateText("Someone's, borrowed by us")}
              </label>
            ))}
          </fieldset>
        )}
        <div>
          <label className="label-text" htmlFor="loan-person">
            {lent ? translateText("Who has it") : translateText("Whose it is")}
          </label>
          <input id="loan-person" name="person" className="input" required maxLength={80} defaultValue={loan?.person} placeholder={translateText("e.g. Sam next door")} autoFocus />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label-text" htmlFor="loan-since">
              {translateText("Since")}</label>
            <input id="loan-since" name="since" type="date" className="input" defaultValue={loan?.since ?? today()} max={today()} required />
          </div>
          <div>
            <label className="label-text" htmlFor="loan-due">
              {translateText("Due back")}</label>
            <input id="loan-due" name="due" type="date" className="input" defaultValue={loan?.dueOn ?? ""} />
          </div>
        </div>
        {lent && (
          <div className="rounded-box bg-base-200 p-3">
            <label className="label-text" htmlFor="loan-email">
              {translateText("Their email, to remind them (optional)")}</label>
            <input id="loan-email" name="email" type="email" className="input" value={email} onChange={(e) => setEmail(e.target.value)} placeholder={translateText("sam@example.com")} maxLength={320} />
            {email.trim() && (
              <div className="mt-3">
                <label className="label-text" htmlFor="loan-remind">
                  {translateText("Remind them")}</label>
                <select id="loan-remind" name="remind" className="select" defaultValue={loan?.remindEvery ?? "2weeks"}>
                  <option value="">{translateText("Don't")}</option>
                  <option value="week">{translateText("Every week")}</option>
                  <option value="2weeks">{translateText("Every 2 weeks")}</option>
                  <option value="month">{translateText("Every month")}</option>
                </select>
              </div>
            )}
            <p className="mt-2 text-sm text-base-content/70">
              {canEmail
                ? translateText("A friendly email that it's still with them — from the due date if there is one — with a link to say it's back or to stop the reminders.")
                : translateText("Ferret can't send email yet (whoever runs it sets MAIL_URL), so no reminders go until it can.")}
            </p>
          </div>
        )}
        <div>
          <label className="label-text" htmlFor="loan-note">
            {translateText("Note")}</label>
          <input id="loan-note" name="note" className="input" maxLength={1000} defaultValue={loan?.note ?? ""} placeholder={translateText("optional")} />
        </div>
        {loan && (
          <div>
            <button type="button" className="btn btn-text btn-error btn-sm" disabled={remove.isPending} onClick={() => window.confirm(translateText("Remove this loan? (Use “It's back” when it's back.)")) && remove.mutate()}>
              {translateText("Remove — it was a mistake")}</button>
          </div>
        )}
        {(save.error ?? remove.error) && <div className="alert alert-soft alert-error">{(save.error ?? remove.error)!.message}</div>}
        <DialogActions>
          <button type="button" className="btn btn-secondary btn-soft" onClick={onClose}>
            {translateText("Cancel")}</button>
          <button type="submit" className="btn btn-primary" disabled={save.isPending}>
            {save.isPending && <span className="loading loading-spinner loading-sm" />}
            {translateText("Save")}</button>
        </DialogActions>
      </form>
    </Modal>
  );
}

/** #/loans — everything lent out or borrowed, overdue first. */
export function Loans({ householdId }: { householdId: string }) {
  const loans = useQuery({ queryKey: ["loans", householdId], queryFn: () => api.loans() });
  const canEdit = useCanEdit(householdId);
  const refresh = useRefresh(householdId);
  const back = useMutation({ mutationFn: api.loanReturned, onSuccess: refresh });
  const all = [...(loans.data?.data ?? [])].sort((a, b) => Number(b.overdue) - Number(a.overdue) || (a.dueOn ?? "9999").localeCompare(b.dueOn ?? "9999"));
  const groups = [
    { title: translateText("Lent out"), list: all.filter((l) => l.direction === "lent") },
    { title: translateText("Borrowed"), list: all.filter((l) => l.direction === "borrowed") },
  ];
  return (
    <div className="min-h-dvh bg-base-200">
      <nav className="navbar sticky top-0 z-10 border-b border-base-300 bg-base-100/85 backdrop-blur-md px-4">
        <div className="navbar-start w-full min-w-0 items-center gap-2">
          <a href="#/" className="btn btn-text btn-sm btn-square" aria-label={translateText("Back")}>
            <span className="icon-[tabler--arrow-left] size-5" />
          </a>
          <h1 className="truncate text-lg font-semibold">{translateText("Lent & borrowed")}</h1>
          <HelpLink page="guide/lending.html" label={translateText("Lending")} />
        </div>
        <BarSearch />
      </nav>
      <main className="mx-auto flex max-w-3xl flex-col gap-4 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        {loans.isPending && <span className="loading loading-spinner text-primary mx-auto my-12" />}
        {loans.data && !all.length && (
          <div className="card">
            <div className="card-body items-center gap-3 text-center">
              <span className="icon-[tabler--arrows-exchange] size-10 text-primary" />
              <h2 className="text-lg font-semibold">{translateText("Nothing's out")}</h2>
              <p className="max-w-sm text-sm text-base-content/70">
                {translateText("Lend something from its page (Lend or borrow…) and it's listed here until it's back — with a reminder email to whoever has it, if you like.")}</p>
            </div>
          </div>
        )}
        {groups.map(
          (g) =>
            g.list.length > 0 && (
              <section key={g.title} className="card">
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
                            {l.overdue ? translateText(" · overdue") : ""}
                            {l.borrowerReturnedAt ? translateText(" · {v0} says it's back", { v0: l.person }) : ""}
                          </span>
                        </a>
                        {canEdit && (
                          <button type="button" className="btn btn-soft btn-sm" disabled={back.isPending} onClick={() => back.mutate(l.id)}>
                            {l.direction === "lent" ? translateText("It's back") : translateText("Given back")}
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
              <h1 className="text-xl font-semibold">{tr("Hi {v0} — you have {v1}'s {v2}", { v0: v.person, v1: v.owner, v2: v.itemName })}</h1>
              <p className="text-base-content/80">{tr("{v0} lent it to you on {v1}", { v0: v.owner, v1: shortDate(v.since) })}{v.dueOn ? translateText(", to bring back by {v0}", { v0: shortDate(v.dueOn) }) : ""}.
              </p>
              {v.returned || v.reportedBack ? (
                <div className="alert alert-soft alert-success">{tr("Thanks — {v0} knows it's back. No more reminders.", { v0: v.owner })}</div>
              ) : (
                <div className="flex flex-col gap-2">
                  <button type="button" className="btn btn-primary" disabled={back.isPending} onClick={() => back.mutate()}>
                    <span className="icon-[tabler--check] size-5" />
                    {translateText("I've given it back")}</button>
                  {v.stopped ? (
                    <p className="text-sm text-base-content/70">{translateText("No more reminders will be sent.")}</p>
                  ) : (
                    <button type="button" className="btn btn-soft" disabled={stop.isPending} onClick={() => stop.mutate()}>
                      {translateText("Stop these reminders")}</button>
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
