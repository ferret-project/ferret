/**
 * Deleting for good (server: lib/deletion.ts): the household — its owner only, typing its name — on Settings →
 * Household; your account — typing your email, with your password — on Settings → Security. Each says first what goes,
 * and points to Download everything.
 */
import { useMutation, useQuery } from "@tanstack/react-query";
import { type FormEvent, useContext, useState } from "react";
import { api } from "./lib/api";
import { authClient } from "./lib/auth";
import { HouseholdContext } from "./lib/household";
import { DialogActions, Modal } from "./Modal";

/** Leaves the app for its first screen, fresh (the household or account is gone). */
const startOver = () => window.location.replace("/");

/**
 * On a server that sells plans, deleting a household ends its plan (the service's `beforeDelete` hook); at home there are
 * none. (Usage's query — PlanUsage.tsx — but also with no household: the account can be deleted before making one.)
 */
function useSellsPlans() {
  const householdId = useContext(HouseholdContext)?.householdId;
  const plan = useQuery({ queryKey: ["plan", householdId], queryFn: api.plan, staleTime: 60_000, enabled: Boolean(householdId) });
  return Boolean(plan.data?.plan);
}

export function DeleteHousehold({ householdName }: { householdName: string }) {
  const { data: session } = authClient.useSession();
  const org = authClient.useActiveOrganization();
  const [open, setOpen] = useState(false);
  const owner = org.data?.members.find((m) => m.userId === session?.user.id)?.role === "owner";
  if (!owner) return null;
  return (
    <section className="card" aria-labelledby="delete-household-heading">
      <div className="card-body gap-3">
        <h2 id="delete-household-heading" className="card-title flex items-center gap-2">
          <span className="icon-[tabler--trash] size-5 text-error" />
          Delete this household
        </h2>
        <p className="text-sm text-base-content/70">
          Everything in {householdName} — things, photos, documents, places, history — is deleted for good, and everyone in it loses access. Download
          everything first if you might want it.
        </p>
        <div>
          <button type="button" className="btn btn-soft btn-error btn-wrap" onClick={() => setOpen(true)}>
            Delete household…
          </button>
        </div>
      </div>
      {open && <DeleteHouseholdDialog householdName={householdName} onClose={() => setOpen(false)} />}
    </section>
  );
}

function DeleteHouseholdDialog({ householdName, onClose }: { householdName: string; onClose: () => void }) {
  // The only household they're in: their account goes with it, in this same step.
  const info = useQuery({ queryKey: ["household-deletion"], queryFn: api.householdDeletion, staleTime: 0 });
  const [typed, setTyped] = useState("");
  const [password, setPassword] = useState("");
  const remove = useMutation({ mutationFn: () => api.deleteHousehold(typed, password || undefined), onSuccess: startOver });
  const alsoAccount = info.data?.alsoAccount ?? false;
  const plans = useSellsPlans();
  const matches = typed.trim().toLowerCase() === householdName.trim().toLowerCase() && Boolean(info.data) && (!info.data?.needsPassword || password.length > 0);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (matches) remove.mutate();
  };
  return (
    <Modal id="delete-household" title="Delete household" onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <p>
          This deletes <strong>{householdName}</strong> and everything in it, for good. It can't be undone.{plans && " If it's on a plan, the plan ends now."}
        </p>
        {alsoAccount && (
          <p>
            It's your only household, so <strong>your account is deleted too</strong>, and you're signed out.
          </p>
        )}
        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium">Type the household's name to confirm</span>
          <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" placeholder={householdName} />
        </label>
        {info.data?.needsPassword && (
          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium">Your password</span>
            <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          </label>
        )}
        {alsoAccount && !info.data?.needsPassword && <p className="text-sm text-base-content/70">You'll need to have signed in within the last 15 minutes.</p>}
        {remove.isError && <div className="alert alert-soft alert-error">{remove.error.message}</div>}
        <DialogActions>
          <button type="button" className="btn btn-text" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-error" disabled={!matches || remove.isPending}>
            {remove.isPending ? <span className="loading loading-spinner loading-sm" /> : "Delete for good"}
          </button>
        </DialogActions>
      </form>
    </Modal>
  );
}

export function DeleteAccount() {
  const [open, setOpen] = useState(false);
  return (
    <section className="card" aria-labelledby="delete-account-heading">
      <div className="card-body gap-3">
        <h2 id="delete-account-heading" className="card-title flex items-center gap-2">
          <span className="icon-[tabler--user-x] size-5 text-error" />
          Delete your account
        </h2>
        <p className="text-sm text-base-content/70">
          Your account is deleted for good, with any household only you are in. Households you share stay with the others.
        </p>
        <div>
          <button type="button" className="btn btn-soft btn-error btn-wrap" onClick={() => setOpen(true)}>
            Delete account…
          </button>
        </div>
      </div>
      {open && <DeleteAccountDialog onClose={() => setOpen(false)} />}
    </section>
  );
}

export function DeleteAccountDialog({ onClose }: { onClose: () => void }) {
  const { data: session } = authClient.useSession();
  const info = useQuery({ queryKey: ["account-deletion"], queryFn: api.accountDeletion, staleTime: 0 });
  const [typed, setTyped] = useState("");
  const [password, setPassword] = useState("");
  const remove = useMutation({ mutationFn: () => api.deleteAccount(typed, password || undefined), onSuccess: startOver });
  const email = session?.user.email ?? "";
  const d = info.data;
  const plans = useSellsPlans();
  const blocked = d ? d.serverAdmin || d.blockers.length > 0 : true;
  const ready = !blocked && typed.trim().toLowerCase() === email.toLowerCase() && (!d?.needsPassword || password.length > 0);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (ready) remove.mutate();
  };
  return (
    <Modal id="delete-account" title="Delete account" onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        {info.isPending && <span className="loading loading-spinner loading-sm" aria-label="Loading" />}
        {d?.serverAdmin && (
          <div className="alert alert-soft alert-warning">You're this server's admin. Hand that over to someone else first (Settings → Server).</div>
        )}
        {d && d.blockers.length > 0 && (
          <div className="alert alert-soft alert-warning">
            Other people are in {d.blockers.map((b) => b.name).join(", ")}. Make one of them its owner (Settings → Household), or delete it, first.
          </div>
        )}
        {d && !blocked && (
          <>
            <p>
              This deletes your account for good. It can't be undone.
              {d.households.length > 0 && (
                <>
                  {" "}
                  These households, which only you are in, are deleted with it: <strong>{d.households.map((h) => h.name).join(", ")}</strong>.
                  {plans && " If one is on a plan, the plan ends now."} Download everything first if you might want it.
                </>
              )}
            </p>
            <label className="flex flex-col gap-1">
              <span className="text-sm font-medium">Type your email address to confirm</span>
              <input className="input" type="email" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" placeholder={email} />
            </label>
            {d.needsPassword ? (
              <label className="flex flex-col gap-1">
                <span className="text-sm font-medium">Your password</span>
                <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
              </label>
            ) : (
              <p className="text-sm text-base-content/70">You'll need to have signed in within the last 15 minutes.</p>
            )}
          </>
        )}
        {remove.isError && <div className="alert alert-soft alert-error">{remove.error.message}</div>}
        <DialogActions>
          <button type="button" className="btn btn-text" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-error" disabled={!ready || remove.isPending}>
            {remove.isPending ? <span className="loading loading-spinner loading-sm" /> : "Delete for good"}
          </button>
        </DialogActions>
      </form>
    </Modal>
  );
}
