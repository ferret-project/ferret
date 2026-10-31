import type { ItemListing, ItemOrigin, MissingDetail, SearchHit } from "@ferret/shared";
import { DeleteAccountDialog } from "./DeleteForGood";
import { usePlan } from "./PlanUsage";
import { CapturesCard, OfflineCapture, useCaptureSync } from "./Offline";
import { rememberHome, rememberedHome } from "./lib/offline";
import { AuthLayout, Logo } from "./AuthLayout";
import { NotFound } from "./NotFound";
import { DemoCounts, DemoNote, DemoSignIn } from "./Demo";
import { HumanCheck, type HumanCheckHandle } from "./HumanCheck";
import { InstallOffer } from "./Install";
import { looksLikeQuestion } from "@ferret/shared/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { api } from "./lib/api";
import { authClient, passkeysSupported, useCanEdit, signOut } from "./lib/auth";
import { findLocation, usePlaces } from "./lib/places";
import { type Route, addedHref, scanRoomHref, walkthroughHref, HOME_HREF, ITEMS_HREF, PLACES_HREF, itemHref } from "./lib/route";
import { useRoomScanOn } from "./lib/room-scan";
import { useRouteName } from "./lib/route-name";
import { HouseholdContext, useHousehold } from "./lib/household";
import { type Choice, ItemPicker } from "./Combobox";
import { Outlet } from "@tanstack/react-router";
import { Breadcrumbs, PlaceTiles, PropertyCards, PropertyHeader } from "./Browse";
import { MISSING_LABELS, money, OverviewSections } from "./Overview";
import { CategoryTiles, categoryIcon, flattenCategories, useCategories } from "./Catalog";
import { LabelBadge } from "./Boxes";
import { AttentionBell } from "./AttentionBell";
import { AddFromPhotos } from "./PhotoAdd";
import { ScanSession } from "./ScanSession";
import { CodeForm } from "./Security";
import { CHALLENGE_HEADER, solveSignInChallenge } from "./lib/challenge";
import type { Challenge } from "altcha-lib/types";
import { TabBar } from "./TabBar";
import { type Appearance, useAppearance } from "./lib/appearance";
import { ShareButton } from "./Shares";
import { RecallAlert } from "./PayOff";
import { ORIGIN_FILTER, itemOriginList } from "./lib/origin";
import { type AddContext, AddButton, AddFab, DesktopLinks, HouseholdBadge, MenuGroups, Sidebar, useScanRequests, useSidebarFolded } from "./Nav";
import { SearchBox, useSearchHotkeys, useSearchText } from "./Search";
import { Everything } from "./Everything";
import { ItemRow } from "./ItemRow";
import { navigateTo } from "./lib/navigate";
import { deviceTimeZone } from "./TimeZone";
import { Mascot } from "./Mascot";

/** The root: a splash on the first load, then the route's screen (router.tsx). */
export function App() {
  const { isPending } = authClient.useSession();
  // Only the first load: the session also goes pending when it refreshes (e.g. after a password that
  // still needs its two-step code), and unmounting the sign-in form then would lose its place.
  const loaded = useRef(false);
  if (!isPending) loaded.current = true;
  if (isPending && !loaded.current) return <Splash />;
  return (
    <>
      <DemoCounts />
      <Outlet />
    </>
  );
}

/** The signed-in screens' layout: sign in first (or capture offline), then a household. */
export function SignedIn() {
  const { data: session, error } = authClient.useSession();
  // Can't reach Ferret (no signal, or the server's restarting) on a device that was signed in: capture offline.
  const home = !session && (error || !navigator.onLine) ? rememberedHome() : null;
  if (home) return <OfflineCapture home={home} />;
  if (!session) return <AuthScreen />;
  return <HouseholdGate />;
}

export function Splash() {
  return (
    <div className="flex min-h-dvh items-center justify-center">
      <span className="loading loading-spinner loading-lg text-primary" />
    </div>
  );
}

// ── Sign in / sign up ───────────────────────────────────────────────────────
/**
 * Sign in, or create an account while sign-up is open. From an invitation link,
 * the email is fixed to the invited address and creating an account is always on offer.
 *
 * Every account but the first confirms its email: after signing up, "check your email"; the link comes back to
 * `/?verified=1#/…` (Better Auth adds `error=` when the link didn't work), where this says so and asks to sign in.
 */
export function AuthScreen({ email: invited, invitationId, intro }: { email?: string; invitationId?: string; intro?: React.ReactNode }) {
  const verified = verifiedReturn();
  const [mode, setMode] = useState<"signIn" | "signUp" | "forgot">(invited && !verified ? "signUp" : "signIn");
  // Signed up, waiting for the email to be confirmed: the address it went to.
  const [checkEmail, setCheckEmail] = useState<string | null>(null);
  // Tried to sign in before confirming: offer the link again.
  const [unconfirmed, setUnconfirmed] = useState<string | null>(null);
  const resend = useMutation({
    mutationFn: async (email: string) => {
      const result = await authClient.sendVerificationEmail({ email, callbackURL: verifyCallback(invitationId) });
      if (result.error) throw new Error(result.error.message || "Couldn't send it — try again in a minute");
    },
  });
  const options = useQuery({ queryKey: ["auth-options"], queryFn: api.authOptions, enabled: !invited });
  const canSignUp = Boolean(invited) || options.data?.signUp === true;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // "Are you a person?" before sign-up, when the server has the check (the public demo).
  const humanCheck = useRef<HumanCheckHandle>(null);
  const [humanToken, setHumanToken] = useState<string | null>(null);
  const checkingHuman = mode === "signUp" && options.data?.humanCheck;
  // Two-step sign-in is on: the password was right, now the authenticator code.
  const [needsCode, setNeedsCode] = useState(false);
  // After a few wrong passwords the server asks for a proof-of-work check; the browser solves it (a second or so).
  const [checking, setChecking] = useState(false);
  // Held back by wrong passwords: offer a link (by email and to their devices) that clears the count.
  const [held, setHeld] = useState<string | null>(null);
  const unlock = useMutation({ mutationFn: api.requestUnlock });
  const emailInput = useRef<HTMLInputElement>(null);
  const [forgotEmail, setForgotEmail] = useState<string | undefined>();
  // Back from an emailed sign-in link that didn't work (used, expired, or the account uses two-step sign-in).
  const [linkResult] = useState(linkReturn);
  const [ssoResult] = useState(ssoReturn);
  const sso = useMutation({
    mutationFn: async (provider: string) => {
      // Back to the page that was asked for (its #/… link), not always home.
      const { error } = await authClient.signIn.social({ provider: provider as "google", callbackURL: `/${window.location.hash}`, errorCallbackURL: "/?sso=failed" });
      if (error) throw new Error(error.message ?? "Single sign-on didn't work");
    },
  });
  // Behind a sign-in proxy (Authelia, Authentik…): it has already said who this is.
  const [viaProxy, setViaProxy] = useState(false);
  useEffect(() => {
    if (!options.data?.trustedHeader || invited) return;
    setViaProxy(true);
    void signInThroughProxy()
      .then((ok) => (ok ? window.location.reload() : setViaProxy(false)))
      .catch(() => setViaProxy(false));
  }, [options.data?.trustedHeader, invited]);
  // "Email me a sign-in link": sent to the address in the box (the answer is the same whether there's an account).
  const emailLink = useMutation({
    mutationFn: async (email: string) => {
      const { error } = await authClient.signIn.magicLink({ email, callbackURL: "/" });
      if (error) throw new Error(error.status === 429 ? "Too many requests from here — try again in a minute." : (error.message ?? "Something went wrong"));
    },
  });
  const passkey = useMutation({
    mutationFn: async () => {
      const { error } = await authClient.signIn.passkey();
      if (error && !/cancel|abort|not allowed/i.test(error.message ?? "")) throw new Error(error.message ?? "That passkey didn't work");
    },
  });
  // Passkeys in the Email box's suggestions (the browser's "conditional UI"): pick one and you're in.
  useEffect(() => {
    if (mode !== "signIn" || invited || !passkeysSupported()) return;
    const pkc = window.PublicKeyCredential as unknown as { isConditionalMediationAvailable?: () => Promise<boolean> };
    void pkc.isConditionalMediationAvailable?.().then((ok) => {
      if (ok) authClient.signIn.passkey({ autoFill: true }).catch(() => {});
    });
  }, [mode, invited]);
  useEffect(() => {
    if (linkResult) window.history.replaceState(null, "", `/${window.location.hash}`);
  }, [linkResult]);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const email = String(form.get("email"));
    const password = String(form.get("password"));
    if (checkingHuman && !humanToken) {
      setError("Tick the \"I'm a person\" check first.");
      return;
    }
    setBusy(true);
    setError(null);
    const result =
      mode === "signIn"
        ? await signInWithCheck(email, password)
        : await authClient.signUp.email({
            email,
            password,
            name: String(form.get("name")),
            callbackURL: verifyCallback(invitationId),
            // From an invitation link: its id shows the invitation is really this person's (invite-only sign-up).
            fetchOptions: {
              headers: {
                ...(invitationId && { "X-Invitation-Id": invitationId }),
                ...(checkingHuman && humanToken && { "X-Turnstile-Token": humanToken }),
              },
            },
          });
    setBusy(false);
    // Each token works once.
    if (checkingHuman) humanCheck.current?.reset();
    const code = (result.error as { code?: string } | null)?.code;
    if (code === "SIGN_IN_BACKOFF" || code === "CHALLENGE_REQUIRED") setHeld(email);
    if (code === "EMAIL_NOT_VERIFIED") {
      setUnconfirmed(email);
      setError("Confirm your email first — open the link we sent you.");
    } else if (result.error) setError(result.error.message ?? "Something went wrong");
    else if (mode === "signUp" && result.data && "token" in result.data && !result.data.token) {
      // The very first account is confirmed as it's made (no email to open): straight in. Everyone else checks their email.
      if ("user" in result.data && result.data.user.emailVerified) await signInWithCheck(email, password);
      else setCheckEmail(email);
    }
    else if (result.data && "twoFactorRedirect" in result.data && result.data.twoFactorRedirect) setNeedsCode(true);
    if (!result.error && verified) clearVerifiedReturn();
  }

  async function signInWithCheck(email: string, password: string) {
    let solved: string | undefined;
    for (let tries = 0; ; tries++) {
      const result = await authClient.signIn.email({
        email,
        password,
        fetchOptions: solved ? { headers: { [CHALLENGE_HEADER]: solved } } : undefined,
      });
      const error = result.error as { code?: string; challenge?: Challenge } | null;
      if (error?.code !== "CHALLENGE_REQUIRED" || !error.challenge || tries >= 2) return result;
      setChecking(true);
      try {
        solved = await solveSignInChallenge(error.challenge);
      } finally {
        setChecking(false);
      }
    }
  }

  if (needsCode) return <SignInCode onCancel={() => setNeedsCode(false)} />;
  if (mode === "forgot") return <ForgotPassword email={forgotEmail} onBack={() => setMode("signIn")} />;
  if (checkEmail) {
    return (
      <AuthLayout
        icon="icon-[tabler--mail-check]"
        title="Check your email"
        subtitle={
          <>
            We sent a link to <span className="font-medium text-base-content">{checkEmail}</span>. Open it to confirm it's your
            address, then sign in. It works for a day.
          </>
        }
      >
          <div className="flex flex-col gap-3">
            {resend.isSuccess ? (
              <div className="alert alert-soft alert-success text-sm">Sent again.</div>
            ) : (
              <button type="button" className="btn btn-soft btn-primary" disabled={resend.isPending} onClick={() => resend.mutate(checkEmail)}>
                Send it again
              </button>
            )}
            {resend.isError && <div className="alert alert-soft alert-error text-sm">{resend.error.message}</div>}
            <button type="button" className="btn btn-text btn-sm" onClick={() => {
              setCheckEmail(null);
              setMode("signIn");
            }}>
              Back to sign in
            </button>
          </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title={invited ? "Join your household" : mode === "signIn" ? "Welcome back" : "Create your account"}
      subtitle={intro ?? (mode === "signIn" ? "Sign in to find your stuff." : "Start keeping track of everything you own.")}
    >
        <div className="flex flex-col gap-4">
          {mode === "signIn" && !invited && options.data?.demo && (
            <DemoSignIn
              demo={options.data.demo}
              busy={busy}
              onSignIn={async () => {
                setBusy(true);
                setError(null);
                const result = await signInWithCheck(options.data!.demo!.email, options.data!.demo!.password);
                setBusy(false);
                if (result.error) setError(result.error.message ?? "Something went wrong");
              }}
            />
          )}
          <InstallOffer where="sign-in" />
          {viaProxy && (
            <div className="alert alert-soft alert-info text-sm" role="status">
              <span className="loading loading-spinner loading-xs" />
              Signing you in…
            </div>
          )}
          {ssoResult && (
            <div className="alert alert-soft alert-warning text-sm" role="status">
              {ssoResult}
            </div>
          )}
          {verified === "ok" && (
            <div className="alert alert-soft alert-success text-sm" role="status">
              Your email is confirmed. Sign in to carry on.
            </div>
          )}
          {verified === "failed" && (
            <div className="alert alert-soft alert-warning text-sm" role="status">
              That link didn't work — it may have expired. Sign in, and we'll offer a new one.
            </div>
          )}
          {linkResult && (
            <div className="alert alert-soft alert-warning text-sm" role="status">
              {linkResult === "two-step"
                ? "Your account uses two-step sign-in, so a link can't sign you in — use your password and code (or a passkey)."
                : "That sign-in link didn't work — each one works once, for 15 minutes. Ask for a new one below."}
            </div>
          )}
          <form onSubmit={onSubmit} className="flex flex-col gap-3">
            {mode === "signUp" && (
              <div>
                <label className="label-text" htmlFor="auth-name">
                  Your name
                </label>
                <input id="auth-name" name="name" className="input" required autoComplete="name" />
              </div>
            )}
            <div>
              <label className="label-text" htmlFor="auth-email">
                Email
              </label>
              <input
                id="auth-email"
                name="email"
                type="email"
                className="input"
                required
                autoComplete={mode === "signIn" && !invited ? "username webauthn" : "email"}
                defaultValue={invited}
                readOnly={Boolean(invited)}
                ref={emailInput}
              />
            </div>
            <div>
              <div className="flex items-end justify-between gap-2">
                <label className="label-text" htmlFor="auth-password">
                  Password
                </label>
                {mode === "signIn" && options.data?.passwordReset && (
                  <button
                    type="button"
                    className="link link-primary tap mb-1 text-sm"
                    onClick={() => {
                      setForgotEmail(emailInput.current?.value || held || undefined);
                      setMode("forgot");
                    }}
                  >
                    Forgot it?
                  </button>
                )}
              </div>
              <input
                id="auth-password"
                name="password"
                type="password"
                className="input"
                placeholder={mode === "signUp" ? "10 characters or more" : undefined}
                minLength={10}
                required
                autoComplete={mode === "signIn" ? "current-password" : "new-password"}
              />
            </div>
            {checkingHuman && <HumanCheck ref={humanCheck} siteKey={options.data!.humanCheck!.siteKey} onToken={setHumanToken} />}
            {error && <div className="alert alert-soft alert-error text-sm">{error}</div>}
            {unconfirmed && mode === "signIn" && (
              <div className="rounded-box bg-base-200 p-3 text-sm">
                {resend.isSuccess ? (
                  <p>A new link is on its way to {unconfirmed}.</p>
                ) : (
                  <button type="button" className="btn btn-soft btn-primary btn-sm w-full" disabled={resend.isPending} onClick={() => resend.mutate(unconfirmed)}>
                    {resend.isPending ? <span className="loading loading-spinner loading-xs" /> : <span className="icon-[tabler--mail] size-4" />}
                    Send the link again
                  </button>
                )}
                {resend.isError && <p className="mt-2 text-error">{resend.error.message}</p>}
              </div>
            )}
            {held && mode === "signIn" && (
              <div className="rounded-box bg-base-200 p-3 text-sm">
                {unlock.isSuccess ? (
                  <p>
                    If there's an account for {held}, a link to sign in again is on its way — by email, and to any devices
                    with Ferret notifications on. It works once, for 30 minutes.
                  </p>
                ) : (
                  <button type="button" className="btn btn-soft btn-primary btn-sm w-full" disabled={unlock.isPending} onClick={() => unlock.mutate(held)}>
                    {unlock.isPending ? <span className="loading loading-spinner loading-xs" /> : <span className="icon-[tabler--mail] size-4" />}
                    Email me a link to sign in again
                  </button>
                )}
              </div>
            )}
            <button className="btn btn-primary" disabled={busy}>
              {busy && <span className="loading loading-spinner loading-sm" />}
              {checking ? "Checking you're not a robot…" : mode === "signIn" ? "Sign in" : "Create account"}
            </button>
          </form>
          {mode === "signIn" && !invited && (passkeysSupported() || options.data?.signInLink || options.data?.sso) && (
            <div className="flex flex-col gap-2">
              <div className="divider my-0 text-xs text-base-content/70">or</div>
              {options.data?.sso && (
                <button type="button" className="btn btn-soft btn-primary btn-wrap" disabled={sso.isPending} onClick={() => sso.mutate(options.data!.sso!.providerId)}>
                  {sso.isPending ? <span className="loading loading-spinner loading-sm" /> : <span className="icon-[tabler--key] size-5" />}
                  Sign in with {options.data.sso.name}
                </button>
              )}
              {sso.isError && <div className="alert alert-soft alert-error text-sm">{sso.error.message}</div>}
              {passkeysSupported() && (
                <button type="button" className="btn btn-soft btn-primary" disabled={passkey.isPending} onClick={() => passkey.mutate()}>
                  {passkey.isPending ? <span className="loading loading-spinner loading-sm" /> : <span className="icon-[tabler--fingerprint] size-5" />}
                  Sign in with a passkey
                </button>
              )}
              {passkey.isError && <div className="alert alert-soft alert-error text-sm">{passkey.error.message}</div>}
              {options.data?.signInLink &&
                (emailLink.isSuccess ? (
                  <div className="alert alert-soft alert-success text-sm" role="status">
                    If there's an account for {emailLink.variables}, a sign-in link is on its way — it works once, for 15
                    minutes. (Accounts with two-step sign-in use their password and code instead.)
                  </div>
                ) : (
                  <button
                    type="button"
                    className="btn btn-soft btn-primary"
                    disabled={emailLink.isPending}
                    onClick={() => {
                      const email = emailInput.current?.value.trim() ?? "";
                      if (!emailInput.current?.checkValidity() || !email) {
                        emailInput.current?.reportValidity();
                        emailInput.current?.focus();
                        return;
                      }
                      emailLink.mutate(email);
                    }}
                  >
                    {emailLink.isPending ? <span className="loading loading-spinner loading-sm" /> : <span className="icon-[tabler--mail-forward] size-5" />}
                    Email me a sign-in link
                  </button>
                ))}
              {emailLink.isError && <div className="alert alert-soft alert-error text-sm">{emailLink.error.message}</div>}
            </div>
          )}
          {canSignUp && (
            <p className="text-center text-sm text-base-content/70">
              {mode === "signIn" ? "New here? " : "Have an account? "}
              <button type="button" className="link link-primary tap" onClick={() => setMode(mode === "signIn" ? "signUp" : "signIn")}>
                {mode === "signIn" ? "Create an account" : "Sign in"}
              </button>
            </p>
          )}
        </div>
    </AuthLayout>
  );
}

/** Where an email confirmation link brings the person back to: the invitation they came from, or the app. */
const verifyCallback = (invitationId?: string) => `/?verified=1#/${invitationId ? `invite/${encodeURIComponent(invitationId)}` : ""}`;

/** Back from a confirmation link: "ok", "failed" (expired or used), or null if not. */
function verifiedReturn(): "ok" | "failed" | null {
  const params = new URLSearchParams(window.location.search);
  if (params.has("sso")) return null; // back from single sign-on, not a confirmation link
  if (params.has("error")) return "failed";
  return params.get("verified") === "1" ? "ok" : null;
}

/** Back from single sign-on that didn't work: why, in words (or null). */
function ssoReturn(): string | null {
  const params = new URLSearchParams(window.location.search);
  if (params.get("sso") !== "failed") return null;
  const error = params.get("error");
  if (error === "invite_only") return "There's no Ferret account for you yet, and Ferret is invite-only — ask someone in your household for an invitation link.";
  if (error === "account_not_linked" || error === "email_not_verified") return "Your sign-in provider hasn't confirmed your email address, so Ferret can't tell which account is yours.";
  return "Single sign-on didn't work — try again, or sign in with your password.";
}

/** A forward-auth proxy in front of Ferret says who you are: ask for a session once per visit (sessionStorage). */
const PROXY_TRIED = "ferret-proxy-sign-in";
async function signInThroughProxy() {
  try {
    if (sessionStorage.getItem(PROXY_TRIED)) return false;
    sessionStorage.setItem(PROXY_TRIED, "1");
  } catch {
    // no storage: try anyway
  }
  const res = await fetch("/api/auth/sign-in/trusted-header", { method: "POST", credentials: "include" });
  return res.ok;
}

/** Back from an emailed sign-in link that didn't work: "failed" (used or expired) or "two-step" (the account needs its code). */
function linkReturn(): "failed" | "two-step" | null {
  const v = new URLSearchParams(window.location.search).get("signin-link");
  return v === "failed" || v === "two-step" ? v : null;
}

/** Once signed in, the address bar loses ?verified (and ?error) again. */
const clearVerifiedReturn = () => window.history.replaceState(null, "", `/${window.location.hash}`);

/**
 * "Forgot your password?" (only offered when the server can send email). The answer is the same whatever
 * is typed — the server never says whether an account uses an email.
 */
function ForgotPassword({ email, onBack }: { email?: string; onBack: () => void }) {
  const ask = useMutation({
    mutationFn: async (address: string) => {
      const { error } = await authClient.requestPasswordReset({ email: address });
      if (error) throw new Error(error.status === 429 ? "Too many requests from here — try again in a minute." : (error.message ?? "Something went wrong"));
    },
  });
  return (
    <AuthLayout
      icon={ask.isSuccess ? "icon-[tabler--mail-check]" : "icon-[tabler--key]"}
      title={ask.isSuccess ? "Check your email" : "Forgot your password?"}
      subtitle={
        ask.isSuccess
          ? "If an account uses that email, a link to choose a new password is on its way. It works once, for an hour. Nothing there? Check spam, or ask again in ten minutes."
          : "Type your email and we'll send a link to choose a new one."
      }
    >
        <div className="flex flex-col gap-4">
          {!ask.isSuccess && (
            <>
              <form
                className="flex flex-col gap-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  ask.mutate(String(new FormData(e.currentTarget).get("email")));
                }}
              >
                <div>
                  <label className="label-text" htmlFor="forgot-email">
                    Email
                  </label>
                  <input id="forgot-email" name="email" type="email" className="input" required autoComplete="email" defaultValue={email} autoFocus />
                </div>
                {ask.isError && <div className="alert alert-soft alert-error text-sm">{ask.error.message}</div>}
                <button className="btn btn-primary" disabled={ask.isPending}>
                  {ask.isPending && <span className="loading loading-spinner loading-sm" />}
                  Email me a link
                </button>
              </form>
            </>
          )}
          <button type="button" className="btn btn-text btn-sm self-center" onClick={onBack}>
            <span className="icon-[tabler--arrow-left] size-4" />
            Back to sign in
          </button>
        </div>
    </AuthLayout>
  );
}

/** An emailed reset link: choose a new password. Every session is signed out once it's set. */
export function ResetPasswordScreen({ token }: { token: string }) {
  const [error, setError] = useState<string | null>(null);
  const reset = useMutation({
    mutationFn: async (newPassword: string) => {
      const { error } = await authClient.resetPassword({ newPassword, token });
      if (error) {
        throw new Error(
          error.code === "INVALID_TOKEN" ? "This link was used already or has expired — ask for a new one from the sign-in screen." : (error.message ?? "Something went wrong"),
        );
      }
    },
  });

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const password = String(form.get("password"));
    if (password !== String(form.get("confirm"))) return setError("The two passwords don't match");
    setError(null);
    reset.mutate(password);
  }

  return (
    <AuthLayout
      icon={reset.isSuccess ? "icon-[tabler--circle-check]" : "icon-[tabler--lock]"}
      title={reset.isSuccess ? "Password changed" : "Choose a new password"}
      subtitle={reset.isSuccess ? "Every device was signed out. Sign in with the new one." : "10 characters or more."}
    >
        <div className="flex flex-col gap-4">
          {!reset.isSuccess && (
            <form className="flex flex-col gap-3" onSubmit={onSubmit}>
              <div>
                <label className="label-text" htmlFor="reset-password">
                  New password
                </label>
                <input id="reset-password" name="password" type="password" className="input" minLength={10} required autoComplete="new-password" autoFocus />
              </div>
              <div>
                <label className="label-text" htmlFor="reset-confirm">
                  The same again
                </label>
                <input id="reset-confirm" name="confirm" type="password" className="input" minLength={10} required autoComplete="new-password" />
              </div>
              {(error ?? reset.error?.message) && <div className="alert alert-soft alert-error text-sm">{error ?? reset.error?.message}</div>}
              <button className="btn btn-primary" disabled={reset.isPending}>
                {reset.isPending && <span className="loading loading-spinner loading-sm" />}
                Set new password
              </button>
            </form>
          )}
          <a href="#/" className={reset.isSuccess ? "btn btn-primary" : "btn btn-text btn-sm self-center"}>
            {reset.isSuccess ? "Sign in" : "Back to sign in"}
          </a>
        </div>
    </AuthLayout>
  );
}

/** A "sign in again" link: clears the wrong-password count for its email, then back to signing in. */
export function UnlockScreen({ token }: { token: string }) {
  const use = useMutation({ mutationFn: () => api.useUnlock(token) });
  // Exactly once: the link only works once, and React runs effects twice in development.
  const sent = useRef(false);
  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    use.mutate();
  }, [use]);
  return (
    <AuthLayout
      icon="icon-[tabler--lock-open]"
      title="Sign in again"
      subtitle={use.isSuccess ? "Done — you can sign in again straight away." : use.isPending ? "One moment…" : undefined}
    >
        <div className="flex flex-col gap-4">
          {use.isPending && <span className="loading loading-spinner text-primary" />}
          {use.isError && <div className="alert alert-soft alert-error text-sm">{use.error.message}</div>}
          <a href="#/" className="btn btn-primary">
            Sign in
          </a>
        </div>
    </AuthLayout>
  );
}

/** The second step of signing in: a code from the authenticator app, or a backup code. */
function SignInCode({ onCancel }: { onCancel: () => void }) {
  const [backup, setBackup] = useState(false);
  const [trust, setTrust] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function verify(code: string) {
    setBusy(true);
    setError(null);
    const result = backup
      ? await authClient.twoFactor.verifyBackupCode({ code, trustDevice: trust })
      : await authClient.twoFactor.verifyTotp({ code, trustDevice: trust });
    setBusy(false);
    // On success the session updates and the app moves on by itself.
    if (result.error) setError(result.error.message ?? "That code didn't work");
  }

  return (
    <AuthLayout
      icon={backup ? "icon-[tabler--key]" : "icon-[tabler--device-mobile-message]"}
      title="Two-step sign-in"
      subtitle={backup ? "Type one of your backup codes. Each works once." : "Open your authenticator app and type the code for Ferret."}
    >
        <div className="flex flex-col gap-4">
          {backup ? (
            <form
              className="flex flex-col gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                void verify(String(new FormData(e.currentTarget).get("code")).trim());
              }}
            >
              <input name="code" className="input font-mono" placeholder="Backup code" autoComplete="off" autoCapitalize="off" required autoFocus />
              <TrustDevice checked={trust} onChange={setTrust} />
              {error && <div className="alert alert-soft alert-error text-sm">{error}</div>}
              <button className="btn btn-primary" disabled={busy}>
                {busy && <span className="loading loading-spinner loading-sm" />}
                Sign in
              </button>
            </form>
          ) : (
            <CodeForm busy={busy} error={error ?? undefined} submit="Sign in" onSubmit={(code) => void verify(code)}>
              <TrustDevice checked={trust} onChange={setTrust} />
            </CodeForm>
          )}
          <div className="flex flex-wrap justify-between gap-2">
            <button type="button" className="btn btn-text btn-sm" onClick={onCancel}>
              Back
            </button>
            <button
              type="button"
              className="btn btn-text btn-sm"
              onClick={() => {
                setBackup(!backup);
                setError(null);
              }}
            >
              {backup ? "Use the app instead" : "Lost your phone? Use a backup code"}
            </button>
          </div>
        </div>
    </AuthLayout>
  );
}

function TrustDevice({ checked, onChange }: { checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className="flex items-center gap-3 text-sm">
      <input type="checkbox" className="checkbox checkbox-primary checkbox-sm" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      Trust this device for 30 days
    </label>
  );
}

// ── Household selection ─────────────────────────────────────────────────────
function HouseholdGate() {
  const { data: active, isPending } = authClient.useActiveOrganization();
  const { data: households, isPending: listPending } = authClient.useListOrganizations();

  // If the user belongs to a household but none is active yet, pick the first.
  useEffect(() => {
    const first = households?.[0];
    if (!isPending && !active && first) void authClient.organization.setActive({ organizationId: first.id });
  }, [active, households, isPending]);

  if (isPending || listPending) return <Splash />;
  if (!active) return households?.length ? <Splash /> : <CreateHousehold />;
  return <Screens householdName={active.name} householdId={active.id} />;
}

function Screens({ householdName, householdId }: { householdName: string; householdId: string }) {
  const route = useRouteName();
  // Kept on this device for offline capture: the household and its places (to pick a room).
  const places = usePlaces(householdId);
  useEffect(() => rememberHome({ householdId, householdName, places: places.data }), [householdId, householdName, places.data]);
  useCaptureSync(householdId);
  const [folded, toggleSidebar] = useSidebarFolded();
  useSearchHotkeys(["home", "property", "place", "items", "category", "tag"].includes(route));
  return (
    // Big screens: the sidebar on the left (folded to icons, or open), each screen beside it.
    <HouseholdContext value={{ householdId, householdName }}>
      <div className={`transition-[padding] duration-200 motion-reduce:transition-none print:ps-0 ${folded ? "xl:ps-16" : "xl:ps-64"}`}>
        <Sidebar route={route} householdName={householdName} householdId={householdId} folded={folded} onToggle={toggleSidebar} />
        <Outlet />
        <TabBar route={route} />
      </div>
    </HouseholdContext>
  );
}

function CreateHousehold() {
  const [error, setError] = useState<string | null>(null);
  // With no household, Settings is out of reach: deleting the account is offered here too.
  const [deleting, setDeleting] = useState(false);
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const name = String(new FormData(e.currentTarget).get("name")).trim();
    const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${crypto.randomUUID().slice(0, 6)}`;
    const result = await authClient.organization.create({ name, slug });
    if (result.error) setError(result.error.message ?? "Could not create household");
    // Where it is: this device's time zone, to start with (Settings → Household changes it).
    else if (result.data) await api.setHouseholdSettings({ timeZone: deviceTimeZone() }, result.data.id).catch(() => {});
  }
  return (
    <AuthLayout icon="icon-[tabler--home-heart]" title="Name your household" subtitle="Everything you track lives in a household. You can invite family later.">
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <div>
          <label className="label-text" htmlFor="household-name">
            Household name
          </label>
          <input id="household-name" name="name" className="input" placeholder="e.g. The Highland House" required />
        </div>
        {error && <div className="alert alert-soft alert-error text-sm">{error}</div>}
        <button className="btn btn-primary">Create household</button>
        <div className="flex flex-wrap justify-center gap-2">
          <button type="button" className="btn btn-text btn-sm" onClick={() => signOut()}>
            Sign out
          </button>
          <button type="button" className="btn btn-text btn-sm text-error" onClick={() => setDeleting(true)}>
            Delete my account
          </button>
        </div>
      </form>
      {deleting && <DeleteAccountDialog onClose={() => setDeleting(false)} />}
    </AuthLayout>
  );
}

/**
 * The signed-in user's menu: who they are, Settings, sign out.
 * Adapted from FlyonUI Pro "Dashboard Dropdown 9"; opened and closed by React.
 */
function AccountMenu({ householdName, householdId }: { householdName: string; householdId: string }) {
  const { data: session } = authClient.useSession();
  const { data: households } = authClient.useListOrganizations();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !(e.target as Element).closest("#account-menu")) setOpen(false);
    };
    document.addEventListener("click", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("click", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);
  const user = session?.user;
  const initial = (user?.name || user?.email || "?").slice(0, 1).toUpperCase();
  return (
    <div id="account-menu" className={`dropdown relative inline-flex ${open ? "open" : ""}`}>
      <button
        type="button"
        className="dropdown-toggle btn btn-circle btn-soft btn-primary"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
        onClick={() => setOpen(!open)}
      >
        {initial}
      </button>
      {open && (
        <ul className="dropdown-menu dropdown-open:opacity-100 absolute end-0 top-full max-h-[calc(100dvh-5rem)] w-72 space-y-0.5 overflow-y-auto" role="menu" aria-label="Account">
          <li className="dropdown-header mb-1 gap-3 px-4 pt-4 pb-3">
            <div className="avatar avatar-placeholder">
              <div className="w-10 rounded-full bg-primary/10 text-primary">
                <span className="text-lg">{initial}</span>
              </div>
            </div>
            <div className="min-w-0">
              <h6 className="mb-0.5 truncate font-semibold text-base-content">{user?.name}</h6>
              <p className="truncate text-sm text-base-content/80">{user?.email}</p>
              <span className="badge badge-soft badge-primary badge-sm mt-1 sm:hidden">{householdName}</span>
            </div>
          </li>
          {/* From xl the sidebar has the household switcher and every place, so this menu is just about you. */}
          {households && households.length > 1 && (
            <>
              <li className="dropdown-title px-4 pt-1 text-xs uppercase xl:hidden">Switch household</li>
              {households.map((h) => (
                <li key={h.id} className="xl:hidden">
                  <button
                    type="button"
                    className="dropdown-item px-3"
                    role="menuitemradio"
                    aria-checked={h.id === householdId}
                    onClick={() => {
                      setOpen(false);
                      if (h.id !== householdId) {
                        void authClient.organization.setActive({ organizationId: h.id });
                        navigateTo("#/");
                      }
                    }}
                  >
                    <span className={`${h.id === householdId ? "icon-[tabler--circle-check-filled] text-primary" : "icon-[tabler--circle]"} size-5`} />
                    <span className="truncate">{h.name}</span>
                  </button>
                </li>
              ))}
              <li className="dropdown-divider my-1 xl:hidden" role="separator" />
            </>
          )}
          {/* Everything that isn't a main place, grouped (Nav.tsx; the More tab on phones has the same). */}
          <MenuGroups onPick={() => setOpen(false)} className="xl:hidden" />
          <li className="dropdown-divider my-1 xl:hidden" role="separator" />
          <AppearanceChoice />
          <li className="dropdown-footer p-2 pt-1">
            <button
              type="button"
              className="btn btn-text btn-error btn-block h-11 justify-start px-3 font-normal"
              role="menuitem"
              onClick={() => signOut()}
            >
              <span className="icon-[tabler--logout] size-5" />
              Sign out
            </button>
          </li>
        </ul>
      )}
    </div>
  );
}

// ── Main screen ─────────────────────────────────────────────────────────────
/** The views under the search box: the dashboard, a property, a room, or the list of everything. */
type HomeView = Extract<Route, { name: "home" | "property" | "place" | "items" | "category" | "tag" }>;

/**
 * The home screen: search (and barcode scanning) on top; under it the dashboard,
 * a property's rooms, a room's places and things, or every item. While there's
 * a search, its results replace the view (inside a room, they're from that room).
 */
export function Home({ householdName, householdId, view }: { householdName: string; householdId: string; view: HomeView }) {
  const locationId = view.name === "place" ? view.locationId : undefined;
  const missing: MissingDetail | undefined = view.name === "items" ? view.missing : undefined;
  const origin = view.name === "items" ? view.origin : undefined;
  const categoryId = view.name === "category" ? view.id : undefined;
  const tag = view.name === "tag" ? view.tag : undefined;
  const categories = useCategories(householdId);
  const kind = categoryId ? flattenCategories(categories.data ?? []).find((c) => c.id === categoryId) : undefined;
  // A plan without AI (Settings → Plan & usage) has no Ask Ferret; a home Ferret always does.
  const aiAllowed = usePlan(householdId).data?.plan?.limits.ai ?? true;
  const roomScanOn = useRoomScanOn(householdId);
  // Wait for a pause in typing (searches by meaning call the embedding model) — unless Enter (or a link) says now.
  const [now, setNow] = useState<string | null>(null);
  const [search, setSearch] = useSearchText(JSON.stringify(view), setNow);
  /** The scanner is open: to look up and count, or (from + Add) to add things. */
  const [scanning, setScanning] = useState<false | "scan" | "add">(false);
  const [scanned, setScanned] = useState<string | null>(null);
  useScanRequests((adding) => setScanning(adding ? "add" : "scan")); // "+ Add → Scan a barcode", a top bar's scan
  const paused = useDebounced(search.trim(), 300);
  // Clearing is immediate: back to the view, not 300 ms of the old results.
  const query = !search.trim() ? "" : now !== null && now === search.trim() ? now : paused;
  const results = useRef<HTMLDivElement>(null);
  const qc = useQueryClient();
  const places = usePlaces(householdId);
  const canEdit = useCanEdit(householdId);
  const place = locationId ? findLocation(places.data, locationId) : undefined;
  const labels = useQuery({ queryKey: ["labels", householdId], queryFn: () => api.labels(), enabled: view.name === "place" });
  // Everything (not searching) has its own table, filters and pages.
  const everything = !query && view.name === "items";
  const listing = Boolean(query) || ["category", "tag"].includes(view.name) || (view.name === "place" && Boolean(place));
  const first = useQuery({
    // In a room (not searching): its boxes and loose things — not every box's contents.
    queryKey: ["items", householdId, query, locationId, missing, categoryId, tag, origin],
    // A search answers at once with the sure matches; maybe-matches are checked by the AI model behind it (below).
    queryFn: () => api.listItems(query, { locationId, missing, categoryId, tag, origin, topLevel: Boolean(locationId && !query), judge: "later" }),
    placeholderData: (previous) => previous, // keep showing results while the next search runs
    enabled: listing,
  });
  // The checked answer, when the first one held some back: it replaces the first when it's in.
  const checking = Boolean(query) && !first.isPlaceholderData && (first.data?.checking ?? 0) > 0;
  const checked = useQuery({
    queryKey: ["items", householdId, query, locationId, missing, categoryId, tag, origin, "checked"],
    queryFn: () => api.listItems(query, { locationId, missing, categoryId, tag, origin, judge: "now" }),
    enabled: listing && checking,
  });
  const items = checking && checked.data ? checked : first;
  const stillChecking = checking && !checked.data && !checked.isError;
  const property = view.name === "property" ? places.data?.properties.find((p) => p.id === view.id) : undefined;
  // New things go where you're looking.
  const addContext: AddContext = { locationId, categoryId, tag, name: place?.node.name ?? kind?.name ?? tag };
  const invalidate = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ["items", householdId] }),
      qc.invalidateQueries({ queryKey: ["places", householdId] }),
      qc.invalidateQueries({ queryKey: ["overview", householdId] }),
    ]);
  const create = useMutation({ mutationFn: api.createItem, onSuccess: invalidate });
  const [adding, setAdding] = useState(false);

  function onAdd(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const value = Number.parseFloat(String(data.get("value") || ""));
    create.mutate(
      {
        name: String(data.get("name")).trim(),
        brand: String(data.get("brand") || "").trim() || null,
        valueCents: Number.isFinite(value) ? Math.round(value * 100) : null,
        isContainer: data.get("isContainer") === "on",
        // Adding while looking at a place puts it there.
        locationId: locationId ?? null,
        categoryId: categoryId ?? null,
        tags: tag ? [tag] : [],
      },
      { onSuccess: () => form.reset() },
    );
  }

  return (
    <div className="min-h-dvh bg-base-200">
      {/* The top bar stays put: the logo, search and scan, the actions. On a phone the search is its own row under the logo. */}
      <nav className="sticky top-0 z-10 flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-base-300 bg-base-100/85 px-4 py-2.5 backdrop-blur-md sm:min-h-16 sm:flex-nowrap">
        <a href={HOME_HREF} className="tap shrink-0 xl:hidden" aria-label="Ferret home">
          <Logo className="text-lg text-primary" />
        </a>
        <div className="order-last w-full min-w-0 sm:order-none sm:mx-auto sm:max-w-2xl sm:flex-1">
          <SearchBox
            householdId={householdId}
            value={search}
            onChange={setSearch}
            query={query}
            onSubmit={() => setNow(search.trim())}
            placeholder={place ? `Search in ${place.node.name}…` : kind ? `Search in ${kind.name}…` : tag ? `Search in ${tag}…` : "Where's the…?"}
            busy={Boolean(query) && items.isFetching}
            results={results}
            scan={
              <button type="button" className="btn btn-soft btn-primary btn-square" aria-label="Scan a barcode" title="Scan a barcode" onClick={() => setScanning("scan")}>
                <span className="icon-[tabler--barcode] size-5" />
              </button>
            }
          />
        </div>
        <div className="ms-auto flex shrink-0 items-center gap-1 sm:ms-0">
          {/* On phones the main places are in the tab bar, and + Add floats above it. */}
          <DesktopLinks route={view.name} />
          <AddButton householdId={householdId} route={view.name} context={addContext} />
          <span className="contents xl:hidden">
            <HouseholdBadge householdName={householdName} householdId={householdId} />
          </span>
          <AttentionBell householdId={householdId} />
          <AccountMenu householdName={householdName} householdId={householdId} />
        </div>
      </nav>

      {/* The dashboard uses a wide screen; lists and search results stay at a width that reads well. */}
      <main className={`mx-auto flex w-full flex-col gap-4 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] max-sm:pb-24 ${!query && (view.name === "home" || view.name === "items") ? "max-w-7xl" : "max-w-3xl"}`}>
        {missing && !everything && (
          <div className="flex items-center gap-2">
            <span className="badge badge-soft badge-warning badge-lg h-auto max-w-full gap-1.5 py-1">
              <span className="icon-[tabler--list-check] size-4 shrink-0" />
              <span className="truncate">{MISSING_LABELS[missing].filter}</span>
              <a href={HOME_HREF} className="tap inline-flex shrink-0" aria-label="Back to the dashboard">
                <span className="icon-[tabler--x] size-4" />
              </a>
            </span>
          </div>
        )}
        {/* Scan to count: opens, changes counts or asks (ScanSession); an unknown code offers to add it. */}
        {scanning && (
          <ScanSession
            householdId={householdId}
            adding={scanning === "add"}
            onClose={() => setScanning(false)}
            onUnknown={(code) => {
              setScanning(false);
              setScanned(code);
            }}
          />
        )}
        {scanned &&
          (canEdit ? (
            <UnknownBarcode code={scanned} onDone={() => setScanned(null)} locationId={locationId} />
          ) : (
            <div className="alert alert-soft alert-info text-sm" role="status">
              Nothing has barcode <span className="font-mono">{scanned}</span>.
            </div>
          ))}

        {!query && view.name === "home" && <CapturesCard householdId={householdId} />}
        {!query && view.name === "home" && <DemoNote />}
        {!query && view.name === "home" && <InstallOffer where="home" />}
        {!query && view.name === "home" && <RecallAlert householdId={householdId} />}
        {!query && view.name === "home" && (
          <OverviewSections householdId={householdId} places={places.data && <PropertyCards tree={places.data} canEdit={canEdit} />} />
        )}

        {!query && view.name === "property" && (
          property ? (
            <>
              <PropertyHeader property={property} canEdit={canEdit} maps={Boolean(places.data?.maps)} />
              {property.locations.length ? (
                <PlaceTiles nodes={property.locations} title="Rooms" />
              ) : (
                <p className="text-sm text-base-content/70">
                  No rooms yet.{canEdit && <> Add them under <a className="link link-primary" href={PLACES_HREF}>Places</a>.</>}
                </p>
              )}
            </>
          ) : (
            places.data && <NotFound what="property" wrap={false} />
          )
        )}

        {!query && view.name === "place" && places.data && !place && <NotFound what="place" wrap={false} />}
        {!query && view.name === "place" && place && (
          <>
            <Breadcrumbs
              tree={places.data}
              locationId={view.locationId}
              beside={
                place && (
                  <LabelBadge
                    target={{ locationId: view.locationId }}
                    code={labels.data?.data.find((l) => l.location?.id === view.locationId)?.code ?? null}
                    name={place.node.name}
                    householdId={householdId}
                  />
                )
              }
            />
            {place && place.node.children.length > 0 && <PlaceTiles nodes={place.node.children} title={`Inside ${place.node.name}`} />}
          </>
        )}

        {everything && (
          <Everything
            householdId={householdId}
            missing={missing}
            origin={origin}
            placeFrom={places.data?.properties.length === 1 ? places.data.properties[0]!.name : undefined}
          />
        )}

        {!query && (view.name === "category" || view.name === "tag") && (
          <CollectionHeader
            icon={kind ? categoryIcon(kind) : "icon-[tabler--tag]"}
            title={kind?.name ?? tag ?? ""}
            subtitle={kind ? (kind.path !== kind.name ? kind.path : "Category") : "Tag"}
            items={items.data?.total}
            valueCents={items.data?.valueCents}

            action={
              <ShareButton
                householdId={householdId}
                target={kind ? { kind: "category", categoryId: kind.id } : { kind: "tag", tag: tag! }}
                what={kind ? `everything in ${kind.name}` : `everything tagged ${tag}`}
                className="btn btn-soft btn-primary btn-sm"
              />
            }
          />
        )}
        {!query && kind && kind.children.length > 0 && <CategoryTiles nodes={kind.children} title={`Inside ${kind.name}`} />}

        {listing && (
          <>
            {canEdit && !missing && !origin && !query && (
              // One line until you start typing (the room's things come first); then brand, value, a box — and the
              // other ways in (photos, a walkthrough), which + Add has too.
              <form onSubmit={onAdd} className="card">
                <div className="card-body flex-row flex-wrap items-end gap-2 p-3 sm:p-4">
                  <label className="input min-w-0 flex-1 basis-40 gap-2">
                    <span className="icon-[tabler--plus] my-auto size-5 shrink-0 text-base-content/70" />
                    <input
                      name="name"
                      className="grow"
                      aria-label="Name"
                      placeholder={place ? `Add to ${place.node.name}…` : kind ? `Add to ${kind.name}…` : tag ? `Add to ${tag}…` : "Add an item…"}
                      required
                      onFocus={() => setAdding(true)}
                    />
                  </label>
                  {adding && (
                    <>
                      <input name="brand" className="input w-36 max-w-full" placeholder="Brand" />
                      <input name="value" className="input w-28" placeholder="Value $" inputMode="decimal" />
                      <label className="flex h-11 items-center gap-2 text-sm text-base-content/80">
                        <input type="checkbox" name="isContainer" className="checkbox checkbox-primary checkbox-sm" />
                        It's a box
                      </label>
                    </>
                  )}
                  <button className="btn btn-primary" disabled={create.isPending}>
                    Add
                  </button>
                  {adding && (
                    <div className="flex w-full flex-wrap gap-2">
                      <AddFromPhotos householdId={householdId} locationId={locationId} categoryId={categoryId} tags={tag ? [tag] : []} />
                      {locationId && roomScanOn && (
                        <a href={scanRoomHref({ locationId })} className="btn btn-wrap btn-soft btn-primary">
                          <span className="icon-[tabler--scan-eye] size-5" />
                          Scan this room
                        </a>
                      )}
                      {locationId && (
                        <a href={walkthroughHref(locationId)} className="btn btn-wrap btn-soft btn-primary">
                          <span className="icon-[tabler--walk] size-5" />
                          Walk through this room
                        </a>
                      )}
                    </div>
                  )}
                </div>
              </form>
            )}

            {query && items.data && !(stillChecking && items.data.total === 0) && (
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-sm text-base-content/70" aria-live="polite">
                <span>
                  {items.data.total === 0 ? "No matches" : `${items.data.total} ${items.data.total === 1 ? "match" : "matches"}`}
                  {place ? ` in ${place.node.name}` : kind ? ` in ${kind.name}` : tag ? ` tagged ${tag}` : ""}
                </span>
                {(place || kind || tag || missing || origin) && (
                  <a href={`#/?q=${encodeURIComponent(query)}`} className="link link-primary tap">
                    Search everywhere
                  </a>
                )}
              </div>
            )}

            {looksLikeQuestion(query) && aiAllowed && <AskFerret key={query} question={query} />}

            {items.isError && <div className="alert alert-soft alert-error">{items.error.message}</div>}

            {view.name === "place" && !query && place && place.node.children.length > 0 && (
              <h2 className="font-semibold text-base-content">Things kept here</h2>
            )}
            <div ref={results}>
            {stillChecking && (
              <p className="mb-2 flex items-center gap-2 text-sm text-base-content/70" role="status">
                <span className="loading loading-spinner loading-xs" />
                Checking {first.data!.checking === 1 ? "one more possible match" : `${first.data!.checking} more possible matches`}…
              </p>
            )}
            <ul className="flex flex-col gap-2">
              {items.data?.data.map((item) => (
                <ItemRow
                  key={item.id}
                  item={item}
                  hit={items.data?.hits?.[item.id]}
                  // Show where below what's obvious: the place being looked at, or the only property.
                  placeFrom={place?.node.path ?? (places.data?.properties.length === 1 ? places.data.properties[0]!.name : undefined)}
                />
              ))}
            </ul>
            </div>

            {items.data && items.data.total === 0 && !stillChecking && (
              <div className="flex flex-col items-center gap-4 py-12 text-center text-base-content/70">
                {query ? <Mascot pose="searching" /> : !origin && !locationId && (missing ? <Mascot pose="asleep" /> : <Mascot pose="box" />)}
                {query
                  ? place || kind || tag
                    ? "Nothing here matches that — try Search everywhere."
                    : "Nothing matches that yet. Try fewer words, or what it's for (\u201csomething to cut wood\u201d)."
                  : origin
                    ? "Nothing added this way yet."
                    : missing
                    ? "All done — nothing is missing that."
                    : locationId
                      ? "Nothing kept here yet."
                      : "Nothing here yet — add your first item above."}
              </div>
            )}
          </>
        )}
      </main>
      <AddFab householdId={householdId} route={view.name} context={addContext} />
    </div>
  );
}

/** The top of a category's or tag's (collection's) page: how many things and what they're worth (subcategories are tiles below it). */
function CollectionHeader(props: {
  icon: string;
  title: string;
  subtitle: string;
  items?: number;
  valueCents?: number;
  /** Share… (owners and admins). */
  action?: React.ReactNode;
}) {
  return (
    <section className="card">
      <div className="card-body gap-3 p-4 sm:p-6">
        <div className="flex items-center gap-4">
          <div className="avatar avatar-placeholder">
            <div className="size-14 rounded-box bg-primary/10 text-primary">
              <span className={`${props.icon} size-7`} />
            </div>
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm text-base-content/70">{props.subtitle}</p>
            <h1 className="truncate text-xl font-semibold text-base-content">{props.title}</h1>
            {props.items !== undefined && (
              <p className="text-sm text-base-content/70">
                {props.items} {props.items === 1 ? "thing" : "things"}
                {props.valueCents ? ` · ${money(props.valueCents)}` : ""}
              </p>
            )}
          </div>
          {props.action}
        </div>
      </div>
    </section>
  );
}

function useDebounced<T>(value: T, ms: number) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

/** For questions: a button that asks Ferret, and the answer with its sources. */
function AskFerret({ question }: { question: string }) {
  const ask = useMutation({ mutationFn: () => api.ask(question) });
  if (ask.isIdle) {
    return (
      <button type="button" className="btn btn-soft btn-primary self-start" onClick={() => ask.mutate()}>
        <span className="icon-[tabler--sparkles] size-5" />
        Ask Ferret
      </button>
    );
  }
  return (
    <section className="card border border-primary/20" aria-live="polite" aria-label="Ferret's answer">
      <div className="card-body gap-2 p-4">
        <h2 className="text-base-content/70 flex items-center gap-2 text-sm font-medium">
          <span className="icon-[tabler--sparkles] text-primary size-4" />
          Ferret
        </h2>
        {ask.isPending && (
          <p className="text-base-content/70 flex items-center gap-2">
            <span className="loading loading-dots loading-sm" /> Looking through your things…
          </p>
        )}
        {ask.isError && (
          <div className="flex items-center gap-2">
            <p className="text-error flex-1 text-sm">{ask.error.message}</p>
            <button type="button" className="btn btn-text btn-sm" onClick={() => ask.mutate()}>
              Try again
            </button>
          </div>
        )}
        {ask.data && (
          <>
            <p className={ask.data.found ? "text-base-content" : "text-base-content/70"}>{ask.data.answer}</p>
            {ask.data.citations.length > 0 && (
              <ul className="flex flex-wrap gap-2">
                {ask.data.citations.map((c) => (
                  <li key={`${c.itemId}:${c.attachmentId ?? ""}`}>
                    <a
                      href={c.attachmentId ? api.attachmentUrl(c.attachmentId) : itemHref(c.itemId)}
                      {...(c.attachmentId ? { target: "_blank", rel: "noreferrer" } : {})}
                      className="badge badge-soft badge-primary gap-1"
                    >
                      <span className={`${c.attachmentId ? "icon-[tabler--file-text]" : "icon-[tabler--box]"} size-3.5`} />
                      {c.attachmentId ? c.filename : c.itemName}
                    </a>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-base-content/70 text-xs">Answered by AI from your inventory — check the sources.</p>
          </>
        )}
      </div>
    </section>
  );
}

/**
 * After scanning a barcode no item has: if Ferret's barcode book (or the online
 * database) knows it, "Is it this?" — one tap adds it with that name, brand and
 * model (the person confirms; nothing is added on its own). Otherwise, name it.
 */
function UnknownBarcode({ code, onDone, locationId }: { code: string; onDone: () => void; locationId?: string }) {
  const qc = useQueryClient();
  const known = useQuery({ queryKey: ["barcode", code], queryFn: () => api.barcode(code), staleTime: Infinity, retry: false });
  const [other, setOther] = useState(false);
  const add = useMutation({
    mutationFn: (fields: { name: string; brand?: string | null; model?: string | null }) =>
      api.createItem({ ...fields, barcode: code, locationId: locationId ?? null, origin: "scan" }),
    onSuccess: (created) => {
      void qc.invalidateQueries({ queryKey: ["items"] });
      onDone();
      navigateTo(itemHref(created.id));
    },
  });
  const match = known.data?.match;

  if (known.isPending) {
    return (
      <div className="card border border-primary/20">
        <div className="card-body flex-row items-center gap-3 p-4 text-sm text-base-content/70">
          <span className="loading loading-spinner loading-sm text-primary" />
          Looking up <span className="font-mono">{code}</span>…
        </div>
      </div>
    );
  }

  if (match && !other) {
    return (
      <section className="card border border-primary/20" aria-label="Is it this?">
        <div className="card-body gap-3 p-4">
          <p className="text-sm text-base-content/70">
            <span className="icon-[tabler--barcode] me-1 inline-block size-4 align-[-3px]" />
            Is it this?
          </p>
          <div className="flex items-center gap-3">
            {match.images[0] ? (
              <img src={match.images[0]} alt="" referrerPolicy="no-referrer" className="size-16 shrink-0 rounded-field bg-white object-contain" />
            ) : (
              <span className="flex size-16 shrink-0 items-center justify-center rounded-field bg-base-200 text-base-content/40">
                <span className="icon-[tabler--box] size-7" />
              </span>
            )}
            <div className="min-w-0">
              <p className="line-clamp-2 font-medium text-base-content">{match.name}</p>
              <p className="truncate text-sm text-base-content/70">{[match.brand, match.model].filter(Boolean).join(" · ")}</p>
              <p className="text-xs text-base-content/70">
                {match.source === "ferret" ? "Saved in Ferret before" : "From the UPCitemdb product database"}
                {match.typicalPriceCents ? ` · usually ${money(match.typicalPriceCents)}` : ""}
              </p>
            </div>
          </div>
          {add.isError && <p className="text-sm text-error">{add.error.message}</p>}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn btn-primary"
              disabled={add.isPending}
              onClick={() => add.mutate({ name: match.name, brand: match.brand, model: match.model })}
            >
              {add.isPending && <span className="loading loading-spinner loading-sm" />}
              Add it
            </button>
            <button type="button" className="btn btn-soft btn-primary" onClick={() => setOther(true)}>
              Something else
            </button>
            <button type="button" className="btn btn-text" onClick={onDone}>
              Never mind
            </button>
          </div>
        </div>
      </section>
    );
  }

  return (
    <div className="flex flex-col gap-2">
    <form
      className="card border border-primary/20"
      onSubmit={(e) => {
        e.preventDefault();
        const name = String(new FormData(e.currentTarget).get("name")).trim();
        if (name) add.mutate({ name });
      }}
    >
      <div className="card-body gap-3 p-4">
        <p className="text-base-content/80 text-sm">
          <span className="icon-[tabler--barcode] me-1 inline-block size-4 align-[-3px]" />
          {other ? "What is it?" : <>Nothing has barcode <span className="font-mono">{code}</span> yet. What is it?</>}
        </p>
        <div className="flex gap-2">
          <input name="name" className="input flex-1" placeholder="e.g. Cordless drill" autoFocus required />
          <button className="btn btn-primary" disabled={add.isPending}>
            Add
          </button>
        </div>
        {add.isError && <p className="text-error text-sm">{add.error.message}</p>}
        <p className="text-xs text-base-content/70">Ferret remembers it: next time anyone scans this code, it knows.</p>
        <button type="button" className="btn btn-text btn-sm self-start" onClick={onDone}>
          Never mind
        </button>
      </div>
    </form>
    {/* Not a product's code (8–14 digits): maybe an asset tag or a sticker from elsewhere. */}
    {!/^\d{8,14}$/.test(code) && <StickLabel code={code} onDone={onDone} />}
    </div>
  );
}

/** A code that isn't a product's (an asset tag, a sticker from another app): put it on something you have as its label. */
function StickLabel({ code, onDone }: { code: string; onDone: () => void }) {
  const { householdId } = useHousehold();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<Choice | null>(null);
  const stick = useMutation({
    mutationFn: (t: Choice) => api.attachLabel(code, { itemId: t.id }),
    onSuccess: (_, t) => {
      void qc.invalidateQueries({ queryKey: ["item", householdId] });
      onDone();
      navigateTo(itemHref(t.id));
    },
  });
  if (!open) {
    return (
      <button type="button" className="btn btn-soft btn-sm btn-wrap self-start" onClick={() => setOpen(true)}>
        <span className="icon-[tabler--tag] size-4" />
        It's a label — put it on something I have
      </button>
    );
  }
  return (
    <div className="flex flex-col gap-2 rounded-box bg-base-200 p-3">
      <ItemPicker householdId={householdId} id="label-item" name="labelItem" label="Which thing is it on?" value={target} onChange={setTarget} />
      {stick.isError && <p className="text-sm text-error">{stick.error.message}</p>}
      <button type="button" className="btn btn-primary btn-sm self-start" disabled={!target || stick.isPending} onClick={() => target && stick.mutate(target)}>
        Put the label on it
      </button>
    </div>
  );
}

export const APPEARANCES: { value: Appearance; label: string; icon: string; help: string }[] = [
  { value: "auto", label: "Auto", icon: "icon-[tabler--device-mobile]", help: "Automatic: follow this device" },
  { value: "light", label: "Light", icon: "icon-[tabler--sun]", help: "Light" },
  { value: "dark", label: "Dark", icon: "icon-[tabler--moon]", help: "Dark" },
];

/** Appearance in the account menu: Automatic / Light / Dark, for this device (lib/appearance.ts). */
function AppearanceChoice() {
  const { choice, set } = useAppearance();
  return (
    <li className="px-3 pb-1" role="none">
      <p className="dropdown-title px-1 pt-1 text-xs" id="appearance-label">
        Appearance
      </p>
      <div className="join w-full" role="group" aria-labelledby="appearance-label">
        {APPEARANCES.map((a) => (
          <button
            key={a.value}
            type="button"
            role="menuitemradio"
            aria-checked={choice === a.value}
            aria-label={a.help}
            title={a.help}
            className={`btn join-item btn-sm grow gap-1 ${choice === a.value ? "btn-primary" : "btn-soft btn-secondary"}`}
            onClick={() => set(a.value)}
          >
            <span className={`${a.icon} size-4`} />
            {a.label}
          </button>
        ))}
      </div>
    </li>
  );
}
