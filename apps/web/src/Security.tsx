/**
 * Settings → Security, for the signed-in person (not the household):
 * passkeys (Face ID, Touch ID, a security key — Better Auth's passkey plugin),
 * two-step sign-in with an authenticator app (Better Auth's two-factor plugin,
 * with backup codes), where they're signed in (sign one out, or every other),
 * and their last dozen sign-ins.
 */
import type { SessionSummary, SignInEntry } from "@ferret/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { api } from "./lib/api";
import { authClient, passkeysSupported } from "./lib/auth";
import { describeDevice, describeNetwork } from "./lib/device";
import { QrCode } from "./Labels";
import { Modal } from "./Modal";
import { DeleteAccount } from "./DeleteForGood";

export function Security() {
  return (
    <>
      <Passkeys />
      <TwoStep />
      <Sessions />
      <SignIns />
      <DeleteAccount />
    </>
  );
}

// ── Passkeys ────────────────────────────────────────────────────────────────
/**
 * Sign in with Face ID, Touch ID, Windows Hello or a security key instead of a password. Adding one needs a sign-in
 * from the last day (Better Auth's "fresh session"), and its owner is told (push, Apprise, email).
 */
function Passkeys() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["passkeys"], queryFn: () => unwrap(authClient.passkey.listUserPasskeys()) });
  const [error, setError] = useState<string | null>(null);
  const add = useMutation({
    mutationFn: async () => {
      setError(null);
      const { error: failed } = await authClient.passkey.addPasskey({ name: deviceName() });
      if (failed) {
        const code = (failed as { code?: string }).code;
        throw new Error(
          code === "SESSION_NOT_FRESH"
            ? "For safety, adding a passkey needs a recent sign-in — sign out and back in, then add it."
            : /cancel|abort|not allowed/i.test(failed.message ?? "")
              ? "Cancelled — nothing was added."
              : (failed.message ?? "Couldn't add it"),
        );
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["passkeys"] }),
    onError: (e) => setError(e.message),
  });
  const remove = useMutation({
    mutationFn: (id: string) => unwrap(authClient.passkey.deletePasskey({ id })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["passkeys"] }),
    onError: (e) => setError(e.message),
  });
  const keys = list.data ?? [];
  const supported = passkeysSupported();

  return (
    <section className="card" aria-labelledby="passkeys-title">
      <div className="card-body gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          {/* At least 16rem for the words, so on a phone the button goes under them rather than squeezing them. */}
          <div className="min-w-0 flex-1 basis-64 space-y-1">
            <h2 id="passkeys-title" className="card-title flex flex-wrap items-center gap-2">
              <span className="icon-[tabler--fingerprint] size-5 text-primary" />
              Passkeys
              {keys.length > 0 && <span className="badge badge-soft badge-success badge-sm">{keys.length}</span>}
            </h2>
            <p className="text-sm text-base-content/70">
              Sign in with Face ID, Touch ID, Windows Hello or a security key instead of your password — nothing to type, and
              nothing a fake site can steal. A passkey counts as both steps of two-step sign-in.
            </p>
          </div>
          {supported && (
            <button type="button" className="btn btn-primary btn-sm" disabled={add.isPending} onClick={() => add.mutate()}>
              {add.isPending ? <span className="loading loading-spinner loading-xs" /> : <span className="icon-[tabler--plus] size-4" />}
              Add a passkey
            </button>
          )}
        </div>
        {!supported && <div className="alert alert-soft alert-info text-sm">This browser can't use passkeys.</div>}
        {error && <div className="alert alert-soft alert-error text-sm" role="alert">{error}</div>}
        {keys.length > 0 && (
          <ul className="divide-y divide-base-content/10">
            {keys.map((k) => (
              <li key={k.id} className="flex flex-wrap items-center gap-3 py-3">
                <span className="icon-[tabler--key] size-5 shrink-0 text-base-content/70" />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{k.name || "Passkey"}</p>
                  <p className="text-sm text-base-content/70">
                    Added {k.createdAt ? new Date(k.createdAt).toLocaleDateString(undefined, { dateStyle: "medium" }) : ""}
                    {k.backedUp ? " · synced (iCloud, Google…)" : " · this device only"}
                  </p>
                </div>
                <button
                  type="button"
                  className="btn btn-text btn-sm btn-error"
                  disabled={remove.isPending}
                  onClick={() => window.confirm(`Remove “${k.name || "Passkey"}”? It won't sign in to Ferret any more.`) && remove.mutate(k.id)}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

/** A passkey's name from where it's made: "iPhone", "Mac", "Windows"… (the person can see it in the list). */
function deviceName() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Macintosh/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows";
  return "Passkey";
}

// ── Two-step sign-in ────────────────────────────────────────────────────────
type Dialog = "enable" | "disable" | "backup-codes" | null;

function TwoStep() {
  const session = authClient.useSession();
  const on = Boolean(session.data?.user.twoFactorEnabled);
  const [dialog, setDialog] = useState<Dialog>(null);

  return (
    <section className="card" aria-labelledby="two-step-title">
      <div className="card-body gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          {/* At least 16rem for the words, so on a phone the button goes under them rather than squeezing them. */}
          <div className="min-w-0 flex-1 basis-64 space-y-1">
            <h2 id="two-step-title" className="card-title flex flex-wrap items-center gap-2">
              <span className="icon-[tabler--shield-lock] size-5 text-primary" />
              Two-step sign-in
              {on ? <span className="badge badge-soft badge-success badge-sm">On</span> : <span className="badge badge-soft badge-sm">Off</span>}
            </h2>
            <p className="text-sm text-base-content/70">
              {on
                ? "Signing in takes your password and a code from your authenticator app. Devices you trust skip the code for 30 days."
                : "Ask for a code from an authenticator app (1Password, Google Authenticator, Authy…) as well as your password, so a leaked password isn't enough."}
            </p>
          </div>
          {!on && (
            <button type="button" className="btn btn-primary btn-sm" disabled={session.isPending} onClick={() => setDialog("enable")}>
              Turn on
            </button>
          )}
        </div>
        {on && (
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-soft btn-primary btn-sm" onClick={() => setDialog("backup-codes")}>
              <span className="icon-[tabler--lifebuoy] size-4" />
              New backup codes
            </button>
            <button type="button" className="btn btn-text btn-sm btn-error" onClick={() => setDialog("disable")}>
              Turn off
            </button>
          </div>
        )}
      </div>
      {dialog === "enable" && <EnableDialog onClose={() => setDialog(null)} />}
      {dialog === "disable" && <DisableDialog onClose={() => setDialog(null)} />}
      {dialog === "backup-codes" && <BackupCodesDialog onClose={() => setDialog(null)} />}
    </section>
  );
}

/** A Better Auth client call: its data, or throw its error (for useMutation). */
async function unwrap<T>(call: Promise<{ data: T | null; error: { message?: string } | null }>) {
  const { data, error } = await call;
  if (error || !data) throw new Error(error?.message ?? "Something went wrong");
  return data;
}

/** Password → scan the QR → confirm with a code → save the backup codes. */
function EnableDialog({ onClose }: { onClose: () => void }) {
  const [setup, setSetup] = useState<{ totpURI: string; backupCodes: string[] } | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const start = useMutation({
    mutationFn: async (password: string) => {
      const result = await unwrap(authClient.twoFactor.enable({ password }));
      if (result.method !== "totp") throw new Error("The server didn't offer an authenticator code");
      return result;
    },
    onSuccess: setSetup,
  });
  const confirm = useMutation({
    mutationFn: (code: string) => unwrap(authClient.twoFactor.verifyTotp({ code })),
    onSuccess: () => setConfirmed(true),
  });
  const secret = setup ? new URL(setup.totpURI).searchParams.get("secret") : null;

  return (
    <Modal id="two-step-enable" onClose={onClose}>
      <div className="flex flex-col gap-5">
        <div className="space-y-1 text-center">
          <h3 id="two-step-enable-title" className="text-2xl font-semibold text-base-content">
            {confirmed ? "Two-step sign-in is on" : "Turn on two-step sign-in"}
          </h3>
          <p className="text-base-content/80">
            {confirmed
              ? "Save these backup codes. Each one signs you in once if you lose your phone."
              : setup
                ? "Scan this with your authenticator app, then type the code it shows."
                : "First, your password."}
          </p>
        </div>

        {!setup && (
          <PasswordForm busy={start.isPending} error={start.error?.message} submit="Continue" onSubmit={(p) => start.mutate(p)} onCancel={onClose} />
        )}

        {setup && !confirmed && (
          <>
            <div className="flex flex-col items-center gap-3">
              <a href={setup.totpURI} aria-label="Open in your authenticator app">
                <QrCode value={setup.totpURI} className="size-48 rounded-box border border-base-content/10 p-2" />
              </a>
              <p className="text-center text-xs text-base-content/70">
                On this phone? Tap the code to open your authenticator app. Or type this key:
                <br />
                <code className="mt-1 inline-block break-all font-mono text-sm text-base-content">{secret?.match(/.{1,4}/g)?.join(" ")}</code>
              </p>
            </div>
            <CodeForm busy={confirm.isPending} error={confirm.error?.message} submit="Turn on" onSubmit={(code) => confirm.mutate(code)} onCancel={onClose} />
          </>
        )}

        {setup && confirmed && <BackupCodes codes={setup.backupCodes} onDone={onClose} />}
      </div>
    </Modal>
  );
}

function DisableDialog({ onClose }: { onClose: () => void }) {
  const disable = useMutation({
    mutationFn: (password: string) => unwrap(authClient.twoFactor.disable({ password })),
    onSuccess: onClose,
  });
  return (
    <Modal id="two-step-disable" onClose={onClose}>
      <div className="flex flex-col gap-5">
        <div className="space-y-1 text-center">
          <h3 id="two-step-disable-title" className="text-2xl font-semibold text-base-content">
            Turn off two-step sign-in?
          </h3>
          <p className="text-base-content/80">Your password alone will sign you in again. Your backup codes stop working.</p>
        </div>
        <PasswordForm busy={disable.isPending} error={disable.error?.message} submit="Turn off" danger onSubmit={(p) => disable.mutate(p)} onCancel={onClose} />
      </div>
    </Modal>
  );
}

function BackupCodesDialog({ onClose }: { onClose: () => void }) {
  const make = useMutation({
    mutationFn: (password: string) => unwrap(authClient.twoFactor.generateBackupCodes({ password })),
  });
  return (
    <Modal id="two-step-codes" onClose={onClose}>
      <div className="flex flex-col gap-5">
        <div className="space-y-1 text-center">
          <h3 id="two-step-codes-title" className="text-2xl font-semibold text-base-content">
            New backup codes
          </h3>
          <p className="text-base-content/80">
            {make.data ? "Your old codes no longer work. Save these somewhere safe." : "This replaces your old codes. Your password first."}
          </p>
        </div>
        {make.data ? (
          <BackupCodes codes={make.data.backupCodes} onDone={onClose} />
        ) : (
          <PasswordForm busy={make.isPending} error={make.error?.message} submit="Make new codes" onSubmit={(p) => make.mutate(p)} onCancel={onClose} />
        )}
      </div>
    </Modal>
  );
}

function BackupCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const text = `Ferret backup codes (${window.location.host}) — each works once\n\n${codes.join("\n")}\n`;
  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: "ferret-backup-codes.txt" });
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <>
      <ul className="grid grid-cols-2 gap-2 rounded-box bg-base-200 p-4 font-mono text-sm">
        {codes.map((c) => (
          <li key={c} className="text-center">
            {c}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <button
          type="button"
          className="btn btn-soft btn-secondary btn-sm"
          onClick={() => void navigator.clipboard.writeText(text).then(() => setCopied(true))}
        >
          <span className={`${copied ? "icon-[tabler--check]" : "icon-[tabler--copy]"} size-4`} />
          {copied ? "Copied" : "Copy"}
        </button>
        <button type="button" className="btn btn-soft btn-secondary btn-sm" onClick={download}>
          <span className="icon-[tabler--download] size-4" />
          Download
        </button>
        <button type="button" className="btn btn-primary" onClick={onDone}>
          I've saved them
        </button>
      </div>
    </>
  );
}

function PasswordForm(props: {
  busy: boolean;
  error?: string;
  submit: string;
  danger?: boolean;
  onSubmit: (password: string) => void;
  onCancel: () => void;
}) {
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    props.onSubmit(String(new FormData(e.currentTarget).get("password")));
  }
  return (
    <form className="flex flex-col gap-4" onSubmit={onSubmit}>
      <input name="password" type="password" className="input" placeholder="Password" autoComplete="current-password" required autoFocus />
      {props.error && <div className="alert alert-soft alert-error text-sm">{props.error}</div>}
      <div className="flex justify-end gap-3">
        <button type="button" className="btn btn-secondary btn-soft" onClick={props.onCancel}>
          Cancel
        </button>
        <button type="submit" className={`btn ${props.danger ? "btn-error" : "btn-primary"}`} disabled={props.busy}>
          {props.busy && <span className="loading loading-spinner loading-sm" />}
          {props.submit}
        </button>
      </div>
    </form>
  );
}

/** A 6-digit code from the authenticator app. Also used by the sign-in screen. */
export function CodeForm(props: {
  busy: boolean;
  error?: string;
  submit: string;
  onSubmit: (code: string) => void;
  onCancel?: () => void;
  children?: React.ReactNode;
}) {
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    props.onSubmit(String(new FormData(e.currentTarget).get("code")).replace(/\s/g, ""));
  }
  return (
    <form className="flex flex-col gap-4" onSubmit={onSubmit}>
      <input
        name="code"
        className="input text-center font-mono text-xl tracking-[0.4em]"
        placeholder="123456"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="\s*\d{3}\s*\d{3}\s*"
        title="The 6-digit code from your authenticator app"
        maxLength={8}
        required
        autoFocus
        aria-label="Code from your authenticator app"
      />
      {props.children}
      {props.error && <div className="alert alert-soft alert-error text-sm">{props.error}</div>}
      <div className="flex justify-end gap-3">
        {props.onCancel && (
          <button type="button" className="btn btn-secondary btn-soft" onClick={props.onCancel}>
            Cancel
          </button>
        )}
        <button type="submit" className="btn btn-primary grow sm:grow-0" disabled={props.busy}>
          {props.busy && <span className="loading loading-spinner loading-sm" />}
          {props.submit}
        </button>
      </div>
    </form>
  );
}

// ── Sessions ────────────────────────────────────────────────────────────────
function Sessions() {
  const qc = useQueryClient();
  const key = ["sessions"];
  const sessions = useQuery({ queryKey: key, queryFn: api.listSessions });
  const refresh = () => qc.invalidateQueries({ queryKey: key });
  const revokeOthers = useMutation({ mutationFn: api.revokeOtherSessions, onSuccess: refresh });
  const others = sessions.data?.data.filter((s) => !s.current).length ?? 0;

  function signOutOthers() {
    if (window.confirm(`Sign out ${others === 1 ? "your other session" : `all ${others} other sessions`}? They'll need your password to get back in.`)) {
      revokeOthers.mutate();
    }
  }

  return (
    <section className="card" aria-labelledby="sessions-title">
      <div className="card-body gap-4">
        <div className="space-y-1">
          <h2 id="sessions-title" className="card-title flex items-center gap-2">
            <span className="icon-[tabler--devices] size-5 text-primary" />
            Where you're signed in
            {sessions.data && <span className="badge badge-soft badge-primary badge-sm">{sessions.data.data.length}</span>}
          </h2>
          <p className="text-sm text-base-content/70">Each browser or phone you've signed in on. Don't recognise one? Sign it out.</p>
        </div>
        {sessions.isPending && <span className="loading loading-spinner text-primary" />}
        {sessions.isError && <div className="alert alert-soft alert-error">{sessions.error.message}</div>}
        {revokeOthers.isError && <div className="alert alert-soft alert-error">{revokeOthers.error.message}</div>}
        {revokeOthers.data && (
          <div className="alert alert-soft alert-success text-sm">
            Signed out {revokeOthers.data.signedOut} {revokeOthers.data.signedOut === 1 ? "session" : "sessions"}.
          </div>
        )}
        {sessions.data && (
          <ul className="space-y-1">
            {sessions.data.data.map((s) => (
              <SessionRow key={s.id} session={s} onChanged={refresh} />
            ))}
          </ul>
        )}
        {others > 0 && (
          <button type="button" className="btn btn-soft btn-error btn-sm self-start max-sm:w-full" disabled={revokeOthers.isPending} onClick={signOutOthers}>
            {revokeOthers.isPending ? <span className="loading loading-spinner loading-xs" /> : <span className="icon-[tabler--logout] size-4" />}
            Sign out everywhere else
          </button>
        )}
        <p className="text-xs text-base-content/70">API keys (Claude, scripts) aren't sessions — revoke those under Claude &amp; API.</p>
      </div>
    </section>
  );
}

function SessionRow({ session, onChanged }: { session: SessionSummary; onChanged: () => void }) {
  const revoke = useMutation({ mutationFn: () => api.revokeSession(session.id), onSuccess: onChanged });
  const device = describeDevice(session.userAgent);
  return (
    <li className="flex items-center gap-3 rounded-box p-2 hover:bg-neutral/10">
      <div className="avatar avatar-placeholder">
        <div className="size-10 rounded-full bg-primary/10 text-primary">
          <span className={`${device.icon} size-5`} />
        </div>
      </div>
      <div className="min-w-0 flex-1">
        <h3 className="flex flex-wrap items-center gap-2 font-medium text-base-content">
          {device.label}
          {session.current && <span className="badge badge-soft badge-success badge-sm">This device</span>}
        </h3>
        <p className="text-sm break-words text-base-content/70">
          {describeNetwork(session.ipAddress)} · signed in {formatWhen(session.signedInAt)}
          {!session.current && ` · active ${formatWhen(session.lastActiveAt)}`}
        </p>
        {revoke.isError && <p className="text-sm text-error">{revoke.error.message}</p>}
      </div>
      {!session.current && (
        <button
          type="button"
          className="btn btn-text btn-sm btn-error shrink-0"
          disabled={revoke.isPending}
          onClick={() => revoke.mutate()}
          aria-label={`Sign out ${device.label}`}
        >
          Sign out
        </button>
      )}
    </li>
  );
}

// ── Recent sign-ins ─────────────────────────────────────────────────────────
const METHOD: Record<SignInEntry["method"], string | null> = {
  password: null,
  "password+code": "with code",
  "password+backup-code": "with backup code",
  "sign-up": "account created",
  "email-link": "with an emailed link",
  passkey: "with a passkey",
  sso: "with single sign-on",
  "trusted-header": "through the sign-in proxy",
  failed: "wrong password",
};

function SignIns() {
  const signIns = useQuery({ queryKey: ["sign-ins"], queryFn: api.listSignIns });
  return (
    <section className="card" aria-labelledby="sign-ins-title">
      <div className="card-body gap-4">
        <div className="space-y-1">
          <h2 id="sign-ins-title" className="card-title flex items-center gap-2">
            <span className="icon-[tabler--history] size-5 text-primary" />
            Recent sign-ins
          </h2>
          <p className="text-sm text-base-content/70">
            Your last dozen, and wrong passwords: when, from which network, and on what. After a few wrong passwords Ferret
            slows down that address and asks every browser for a quick automatic check.
          </p>
        </div>
        {signIns.isPending && <span className="loading loading-spinner text-primary" />}
        {signIns.isError && <div className="alert alert-soft alert-error">{signIns.error.message}</div>}
        {signIns.data && signIns.data.data.length === 0 && (
          <p className="text-sm text-base-content/70">None recorded yet — sign-ins are kept from now on.</p>
        )}
        {signIns.data && signIns.data.data.length > 0 && (
          <ul className="divide-y divide-base-content/10">
            {signIns.data.data.map((s) => {
              const device = describeDevice(s.userAgent);
              const method = METHOD[s.method];
              return (
                <li key={s.at} className="flex items-center gap-3 py-2">
                  <span className={`${s.method === "failed" ? "icon-[tabler--lock-x] text-error" : `${device.icon} text-base-content/70`} size-5 shrink-0`} />
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-base-content">
                      {device.label}
                      {method && <span className={`badge badge-soft badge-sm ${s.method === "failed" ? "badge-error" : ""}`}>{method}</span>}
                    </p>
                    <p className="truncate text-xs text-base-content/70">{describeNetwork(s.ipAddress)}</p>
                  </div>
                  <time dateTime={s.at} className="shrink-0 text-xs text-base-content/70">
                    {formatWhen(s.at)}
                  </time>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

const formatWhen = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
