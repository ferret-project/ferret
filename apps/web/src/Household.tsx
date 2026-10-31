/**
 * Settings → Household: who's in it, their roles, and invitations. An invitation
 * is a link that only works for the address it was made for; when the server can
 * send email, Ferret emails it too (and Send again), else it says plainly that
 * the link has to be sent by hand (Messages, email…).
 * Member rows follow FlyonUI Pro "Dashboard Modal 15" (as the API key rows do);
 * the invite dialog "Dashboard Modal 14"; the link reveal "Dashboard Modal 7".
 */
import type { HouseholdRole, InvitationEmails } from "@ferret/shared";
import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { CopyField } from "./CopyField";
import { api } from "./lib/api";
import { authClient } from "./lib/auth";
import { Modal } from "./Modal";
import { navigateTo } from "./lib/navigate";

const ROLES: Record<HouseholdRole, { label: string; help: string }> = {
  owner: { label: "Owner", help: "Everything, including removing the household" },
  admin: { label: "Admin", help: "Adds and changes things, invites and manages people" },
  member: { label: "Member", help: "Adds and changes things" },
  viewer: { label: "Viewer", help: "Can look and ask, but not change anything" },
};
const INVITABLE: HouseholdRole[] = ["member", "viewer", "admin"];

/** The server skips sending one invitation again sooner than this (lib/invitation-email.ts). */
const RESEND_AFTER_MS = 5 * 60 * 1000;

export const inviteLink = (id: string) => `${window.location.origin}/#/invite/${encodeURIComponent(id)}`;

/** Better Auth client calls return { data, error } rather than throwing. */
async function run<T>(call: Promise<{ data: T | null; error: { message?: string; statusText?: string } | null }>) {
  const { data, error } = await call;
  if (error) throw new Error(error.message || error.statusText || "Something went wrong");
  return data as T;
}

export function Household({ householdName }: { householdName: string }) {
  const { data: session } = authClient.useSession();
  const org = authClient.useActiveOrganization();
  const [inviting, setInviting] = useState(false);
  const [invited, setInvited] = useState<{ id: string; email: string; justNow?: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const me = org.data?.members.find((m) => m.userId === session?.user.id);
  const canManage = me?.role === "owner" || me?.role === "admin";
  const pending = (org.data?.invitations ?? []).filter((i) => i.status === "pending" && new Date(i.expiresAt) > new Date());
  const emails = useQuery({
    queryKey: ["invitation-emails", org.data?.id],
    queryFn: api.invitationEmails,
    enabled: canManage && Boolean(org.data),
    // While one is on its way, look again until it's gone (or failed).
    refetchInterval: (q) => (q.state.data?.data.some((e) => !e.sentAt && !e.error) ? 3000 : false),
  });
  const emailOn = emails.data?.email ?? false;

  async function act(call: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await call();
      await Promise.all([org.refetch(), emails.refetch()]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" aria-labelledby="household-title">
      <div className="card-body gap-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <h2 id="household-title" className="card-title flex items-center gap-2">
              <span className="icon-[tabler--users] size-5 text-primary" />
              {householdName}
            </h2>
            <p className="text-sm text-base-content/70">Everyone here shares the same inventory.</p>
          </div>
          {canManage && (
            <button type="button" className="btn btn-primary" onClick={() => setInviting(true)}>
              <span className="icon-[tabler--user-plus] size-5" />
              Invite
            </button>
          )}
        </div>

        {org.isPending && <span className="loading loading-spinner text-primary" />}
        {error && <div className="alert alert-soft alert-error">{error}</div>}

        {org.data && (
          <ul className="space-y-2 *:flex *:flex-wrap *:items-center *:gap-3 *:rounded-box *:p-2 *:hover:bg-neutral/10">
            {org.data.members.map((m) => (
              <MemberRow
                key={m.id}
                name={m.user.name}
                email={m.user.email}
                role={m.role as HouseholdRole}
                isMe={m.userId === session?.user.id}
                canManage={canManage && m.role !== "owner" && m.userId !== session?.user.id}
                busy={busy}
                onRole={(role) => act(() => run(authClient.organization.updateMemberRole({ memberId: m.id, role })))}
                onRemove={() => act(() => run(authClient.organization.removeMember({ memberIdOrEmail: m.id })))}
                onLeave={() =>
                  act(async () => {
                    await run(authClient.organization.leave({ organizationId: org.data!.id }));
                    navigateTo("#/");
                  })
                }
              />
            ))}
          </ul>
        )}

        {canManage && pending.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-sm font-medium text-base-content/70">Waiting to join</h3>
            <ul className="space-y-2 *:flex *:flex-wrap *:items-center *:gap-3 *:rounded-box *:border *:border-dashed *:border-base-content/20 *:p-2">
              {pending.map((i) => (
                <li key={i.id}>
                  <div className="avatar avatar-placeholder">
                    <div className="size-10 rounded-full bg-base-200 text-base-content/70">
                      <span className="icon-[tabler--mail] size-5" />
                    </div>
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-base-content">{i.email}</p>
                    <p className="text-sm text-base-content/70">
                      {ROLES[i.role as HouseholdRole]?.label ?? i.role} · link works until {formatDate(i.expiresAt)}
                    </p>
                    <EmailStatus emails={emails.data} id={i.id} />
                  </div>
                  <div className="flex flex-wrap gap-2 max-sm:w-full max-sm:justify-end">
                    {emailOn && mayResend(emails.data, i.id) && (
                      <button
                        type="button"
                        className="btn btn-soft btn-primary btn-sm"
                        disabled={busy}
                        onClick={() =>
                          act(() =>
                            run(
                              authClient.organization.inviteMember({
                                email: i.email,
                                role: i.role as Exclude<HouseholdRole, "owner">,
                                resend: true,
                              }),
                            ),
                          )
                        }
                      >
                        <span className="icon-[tabler--send] size-4" />
                        Send again
                      </button>
                    )}
                    <button type="button" className="btn btn-soft btn-primary btn-sm" onClick={() => setInvited({ id: i.id, email: i.email })}>
                      <span className="icon-[tabler--link] size-4" />
                      Link
                    </button>
                    <button
                      type="button"
                      className="btn btn-text btn-error btn-sm"
                      disabled={busy}
                      onClick={() => act(() => run(authClient.organization.cancelInvitation({ invitationId: i.id })))}
                    >
                      Cancel
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {inviting && (
        <InviteModal
          householdName={householdName}
          emailOn={emailOn}
          onClose={() => setInviting(false)}
          onInvited={(invitation) => {
            setInviting(false);
            setInvited({ ...invitation, justNow: true });
            void org.refetch();
            void emails.refetch();
          }}
        />
      )}
      {invited && <InviteLinkModal invitation={invited} emailOn={emailOn} householdName={householdName} onClose={() => setInvited(null)} />}
    </section>
  );
}

function MemberRow(props: {
  name: string;
  email: string;
  role: HouseholdRole;
  isMe: boolean;
  canManage: boolean;
  busy: boolean;
  onRole: (role: HouseholdRole) => void;
  onRemove: () => void;
  onLeave: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const initial = (props.name || props.email).slice(0, 1).toUpperCase();
  return (
    <li>
      <div className="avatar avatar-placeholder">
        <div className="size-10 rounded-full bg-primary/10 text-primary">
          <span className="text-lg">{initial}</span>
        </div>
      </div>
      <div className="min-w-0 flex-1">
        <h3 className="flex flex-wrap items-center gap-2 font-medium text-base-content">
          <span className="truncate">{props.name}</span>
          {props.isMe && <span className="badge badge-soft badge-primary badge-sm">You</span>}
        </h3>
        <p className="truncate text-sm text-base-content/70">{props.email}</p>
      </div>
      {confirming ? (
        <div className="flex items-center gap-2 max-sm:w-full max-sm:justify-end">
          <span className="text-sm text-base-content/80">{props.isMe ? "Leave?" : `Remove ${props.name}?`}</span>
          <button type="button" className="btn btn-error btn-sm" disabled={props.busy} onClick={props.isMe ? props.onLeave : props.onRemove}>
            {props.isMe ? "Leave" : "Remove"}
          </button>
          <button type="button" className="btn btn-text btn-sm" onClick={() => setConfirming(false)}>
            Keep
          </button>
        </div>
      ) : (
        <div className={`flex items-center gap-2 ${props.canManage ? "max-sm:w-full max-sm:justify-end" : ""}`}>
          {props.canManage ? (
            <select
              className="select select-sm w-32"
              aria-label={`Role for ${props.name}`}
              value={props.role}
              disabled={props.busy}
              onChange={(e) => props.onRole(e.target.value as HouseholdRole)}
            >
              {INVITABLE.map((r) => (
                <option key={r} value={r}>
                  {ROLES[r].label}
                </option>
              ))}
            </select>
          ) : (
            <span className="badge badge-soft badge-secondary" title={ROLES[props.role]?.help}>
              {ROLES[props.role]?.label ?? props.role}
            </span>
          )}
          {(props.canManage || (props.isMe && props.role !== "owner")) && (
            <button
              type="button"
              className="btn btn-text btn-sm btn-circle"
              aria-label={props.isMe ? "Leave this household" : `Remove ${props.name}`}
              onClick={() => setConfirming(true)}
            >
              <span className={`${props.isMe ? "icon-[tabler--logout]" : "icon-[tabler--user-minus]"} size-4`} />
            </button>
          )}
        </div>
      )}
    </li>
  );
}

/** Whether a pending invitation's email went out — or, without email here, that it never does. */
function EmailStatus({ emails, id }: { emails?: InvitationEmails; id: string }) {
  if (!emails) return null;
  if (!emails.email) return <p className="text-sm text-base-content/70">Not emailed — send them the link yourself</p>;
  const row = emails.data.find((e) => e.id === id);
  if (row?.error) return <p className="text-sm text-error">{row.error}</p>;
  if (row?.sentAt) return <p className="text-sm text-base-content/70">Sent by email {formatDate(row.sentAt)}</p>;
  if (row) return <p className="text-sm text-base-content/70">Sending by email…</p>;
  // Made before Ferret emailed invitations.
  return <p className="text-sm text-base-content/70">Not emailed yet</p>;
}

/** Send again: not while it's on its way, nor a few minutes after it went (the server would skip it). */
function mayResend(emails: InvitationEmails | undefined, id: string) {
  const row = emails?.data.find((e) => e.id === id);
  if (!row || row.error) return true;
  return Boolean(row.sentAt) && Date.now() - new Date(row.sentAt!).getTime() > RESEND_AFTER_MS;
}

function InviteModal(props: { householdName: string; emailOn: boolean; onClose: () => void; onInvited: (i: { id: string; email: string }) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const invitation = await run(
        authClient.organization.inviteMember({
          email: String(f.get("email")).trim(),
          role: String(f.get("role")) as Exclude<HouseholdRole, "owner">,
          resend: true,
        }),
      );
      props.onInvited({ id: invitation.id, email: invitation.email });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal id="invite" onClose={props.onClose}>
      <form className="flex flex-col gap-6" onSubmit={onSubmit}>
        <div className="space-y-1 text-center">
          <h3 id="invite-title" className="text-2xl font-semibold text-base-content">
            Invite to {props.householdName}
          </h3>
          <p className="text-base-content/80">{props.emailOn ? "Ferret emails them a link to join" : "You'll get a link to send them"}</p>
        </div>
        <div className="space-y-4">
          <div>
            <label className="label-text" htmlFor="invite-email">
              Their email
            </label>
            <div className="input">
              <span className="icon-[tabler--mail] my-auto me-3 size-5 shrink-0 text-base-content/80" />
              <input id="invite-email" name="email" type="email" className="grow" placeholder="sam@example.com" required autoFocus />
            </div>
            <p className="helper-text">They sign up (or in) with this address to join.</p>
          </div>
          <fieldset className="space-y-2">
            <legend className="label-text">They can…</legend>
            {INVITABLE.map((r, i) => (
              <label key={r} className="flex items-start gap-3">
                <input type="radio" name="role" value={r} className="radio radio-primary mt-0.5" defaultChecked={i === 0} />
                <span>
                  <span className="label-text block text-base">{ROLES[r].label}</span>
                  <span className="text-sm text-base-content/70">{ROLES[r].help}</span>
                </span>
              </label>
            ))}
          </fieldset>
        </div>
        {error && <div className="alert alert-soft alert-error">{error}</div>}
        <div className="flex flex-wrap items-center justify-end gap-4">
          <button type="button" className="btn btn-secondary btn-soft" onClick={props.onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy && <span className="loading loading-spinner loading-sm" />}
            {props.emailOn ? "Send invitation" : "Create invitation"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function InviteLinkModal(props: { invitation: { id: string; email: string; justNow?: boolean }; emailOn: boolean; householdName: string; onClose: () => void }) {
  const link = inviteLink(props.invitation.id);
  const canShare = typeof navigator.share === "function";
  return (
    <Modal id="invite-link" onClose={props.onClose}>
      <div className="flex flex-col gap-6">
        <div className="flex flex-col items-center text-center">
          <div className="avatar avatar-placeholder mb-4">
            <div className="size-16 rounded-xl border border-success/30 text-success">
              <span className={`${props.emailOn ? "icon-[tabler--mail-check]" : "icon-[tabler--link]"} size-8`} />
            </div>
          </div>
          <h3 id="invite-link-title" className="text-2xl font-semibold text-base-content">
            {props.emailOn ? (props.invitation.justNow ? "Invitation on its way to " : "Invitation for ") : "Send this to "}
            <span className="break-all">{props.invitation.email}</span>
          </h3>
          {props.emailOn ? (
            <p className="text-base-content/80">
              {props.invitation.justNow ? "Ferret is emailing them this link. " : ""}It works for two weeks, and only for that email address — copy or
              share it to send it another way too.
            </p>
          ) : (
            <p className="text-base-content/80">
              Ferret doesn't send this — copy the link and send it yourself. It works for two weeks, and only for that email address.
            </p>
          )}
        </div>
        <CopyField label="Invitation link" value={link} icon="icon-[tabler--link]" />
        <div className="flex flex-wrap justify-end gap-3">
          {canShare && (
            <button
              type="button"
              className="btn btn-soft btn-primary"
              onClick={() =>
                navigator.share({ title: `Join ${props.householdName} on Ferret`, text: `Join ${props.householdName} on Ferret:`, url: link }).catch(() => {})
              }
            >
              <span className="icon-[tabler--share] size-5" />
              Share
            </button>
          )}
          <button type="button" className="btn btn-primary" onClick={props.onClose}>
            Done
          </button>
        </div>
      </div>
    </Modal>
  );
}

const formatDate = (d: Date | string) => new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
