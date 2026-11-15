/**
 * "Connect an app" — an app (claude.ai, ChatGPT…) signing in to Ferret with OAuth for /mcp (server: lib/oauth.ts).
 * Better Auth's authorization server sends people here:
 * - `#/connect/sign-in?…` when they aren't signed in: the request is remembered (localStorage, ten minutes) and started
 *   again once they are — whichever way they sign in, even an emailed link opened in another tab.
 * - `#/connect?…` every time an app asks: pick the household it gets and whether it can change things, then Allow.
 * - `#/connect/finish?…` the plugin's consent step, which Allow does itself: landing here approves nothing.
 * The `?…` after the route is the plugin's signed query, sent back to it as it came (`oauth_query`).
 */
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { t, ph } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { AuthScreen, Splash } from "./App";
import { AuthLayout } from "./AuthLayout";
import { api } from "./lib/api";
import { authClient } from "./lib/auth";

const PENDING_KEY = "ferret-oauth-pending";
const PENDING_TTL_MS = 10 * 60 * 1000;

/** The signed query after `#/connect…?` (read raw: it repeats some names, which a search object would lose). */
function hashQuery() {
  const hash = window.location.hash;
  const at = hash.indexOf("?");
  return at < 0 ? "" : hash.slice(at + 1);
}

/** The app's original request, without the plugin's signature — asked again once signed in. */
function authorizeUrl(query: string) {
  const params = new URLSearchParams(query);
  for (const key of [...params.keys()]) if (key === "sig" || key === "exp" || key.startsWith("ba_")) params.delete(key);
  return `/api/auth/oauth2/authorize?${params}`;
}

function rememberRequest(query: string) {
  if (!new URLSearchParams(query).get("client_id")) return;
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify({ url: authorizeUrl(query), at: Date.now() }));
  } catch {
    // private mode: signing in on this page still carries on (the effect below)
  }
}

/**
 * Once signed in (App.tsx's SignedIn): an app's request that was waiting for it carries on. True if the browser is
 * leaving for it.
 */
export function resumeOAuthRequest() {
  const pending = takePending();
  const fresh = typeof pending?.at === "number" && Date.now() - pending.at < PENDING_TTL_MS;
  if (!fresh || typeof pending?.url !== "string" || !pending.url.startsWith("/api/auth/oauth2/authorize?")) return false;
  window.location.assign(pending.url);
  return true;
}

function takePending(): { url?: unknown; at?: unknown } | null {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    localStorage.removeItem(PENDING_KEY);
    return raw ? (JSON.parse(raw) as { url?: unknown; at?: unknown }) : null;
  } catch {
    return null;
  }
}

/** One of Better Auth's OAuth steps; it answers with where to go next. */
async function oauthStep(path: "/oauth2/continue" | "/oauth2/consent", body: Record<string, unknown>) {
  const res = await fetch(`/api/auth${path}`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as { url?: string; message?: string; error_description?: string };
  if (!res.ok || !json.url) throw new Error(json.error_description || json.message || t`Something went wrong — start again from the app.`);
  return json.url;
}

/** Signed out in the middle of connecting: sign in, then the app's request starts again. */
export function ConnectSignIn() {
  const { data: session } = authClient.useSession();
  const query = hashQuery();
  useEffect(() => rememberRequest(query), [query]);
  useEffect(() => {
    if (session) resumeOAuthRequest();
  }, [session]);
  if (session) return <Splash />;
  return <AuthScreen forApp intro={<p className="text-base-content/80"><Trans>Sign in to Ferret to connect an app to your inventory.</Trans></p>} />;
}

export function Connect() {
  const { data: session } = authClient.useSession();
  const query = hashQuery();
  const clientId = new URLSearchParams(query).get("client_id") ?? "";
  const request = useQuery({
    queryKey: ["oauth-connect", clientId],
    queryFn: () => api.oauthConnectRequest(clientId),
    enabled: Boolean(session && clientId),
    retry: false,
  });
  const [householdId, setHouseholdId] = useState<string | null>(null);
  const [canChange, setCanChange] = useState(true);
  useEffect(() => rememberRequest(query), [query]);

  const allow = useMutation({
    mutationFn: async () => {
      const household = households.find((h) => h.id === chosen);
      if (!household) throw new Error(t`Pick a household first.`);
      await api.oauthChoose({ clientId, householdId: household.id, readOnly: !canChange || household.role === "viewer" });
      let next = await oauthStep("/oauth2/continue", { postLogin: true, oauth_query: query });
      if (next.startsWith("/#/connect/finish?")) next = await oauthStep("/oauth2/consent", { accept: true, oauth_query: next.slice(next.indexOf("?") + 1) });
      clearPending();
      window.location.assign(next);
    },
  });
  const deny = useMutation({
    mutationFn: async () => {
      clearPending();
      window.location.assign(await oauthStep("/oauth2/consent", { accept: false, oauth_query: query }));
    },
  });

  if (!session) return <ConnectSignIn />;
  if (!clientId) return <Problem text={t`This link is missing the app's details. Start connecting again from the app.`} />;
  if (request.isPending) return <Splash />;
  if (request.isError) return <Problem text={request.error.message} />;

  const app = request.data;
  const households = app.households;
  if (households.length === 0) return <Problem text={t`You're not in a household yet. Make one in Ferret first, then connect ${ph({ name: app.name })} again.`} />;
  const chosen = householdId ?? (households.some((h) => h.id === app.activeHouseholdId) ? app.activeHouseholdId! : households[0]!.id);
  const household = households.find((h) => h.id === chosen)!;
  const viewer = household.role === "viewer";
  const writes = canChange && !viewer;
  const busy = allow.isPending || deny.isPending || allow.isSuccess;

  return (
    <AuthLayout
      icon="icon-[tabler--plug-connected]"
      title={t`Connect ${ph({ name: app.name })}`}
      subtitle={<Trans><strong>{ph({ name: app.name })}</strong> wants to use Ferret with your account, {ph({ email: session.user.email })}.</Trans>}
    >
      <div className="flex flex-col gap-5">
        <div className="alert alert-soft alert-warning items-start gap-2 text-sm">
          <span className="icon-[tabler--alert-triangle] mt-0.5 size-5 shrink-0" />
          <span>
            {app.redirectHost ? (
              <Trans>Ferret can't check an app's name. Only allow this if you just asked {ph({ name: app.name })} to connect — it sends you back to <strong>{ph({ host: app.redirectHost })}</strong>.</Trans>
            ) : (
              <Trans>Ferret can't check an app's name. Only allow this if you just asked {ph({ name: app.name })} to connect.</Trans>
            )}
          </span>
        </div>

        {households.length > 1 ? (
          <fieldset className="flex flex-col gap-2">
            <legend className="label-text mb-1"><Trans>Which household can it use?</Trans></legend>
            {households.map((h) => (
              <label key={h.id} className="flex min-h-11 items-center gap-3 rounded-box border border-base-content/15 px-3 has-checked:border-primary">
                <input type="radio" name="household" className="radio radio-primary" checked={h.id === chosen} onChange={() => setHouseholdId(h.id)} />
                <span className="min-w-0 flex-1 truncate">{h.name}</span>
                {h.role === "viewer" && <span className="badge badge-soft badge-info badge-sm"><Trans>Viewer</Trans></span>}
              </label>
            ))}
          </fieldset>
        ) : (
          <p className="text-sm text-base-content/80"><Trans>It can use <strong>{ph({ household: household.name })}</strong>.</Trans></p>
        )}

        <label className="flex min-h-11 items-start gap-3">
          <input type="checkbox" className="switch switch-primary mt-0.5" checked={writes} disabled={viewer} onChange={(e) => setCanChange(e.target.checked)} />
          <span>
            <span className="label-text block text-base"><Trans>Let it add and change things</Trans></span>
            <span className="text-sm text-base-content/70">
              {viewer ? (
                <Trans>You're a viewer in {ph({ household: household.name })}, so it can only look things up.</Trans>
              ) : (
                <Trans>Off: it can search and ask, but not add, change or remove anything.</Trans>
              )}
            </span>
          </span>
        </label>

        <ul className="space-y-1 text-sm text-base-content/80">
          <li className="flex gap-2"><span className="icon-[tabler--check] mt-0.5 size-4 shrink-0 text-success" /><Trans>Search and ask about everything in {ph({ household: household.name })}</Trans></li>
          {writes && <li className="flex gap-2"><span className="icon-[tabler--check] mt-0.5 size-4 shrink-0 text-success" /><Trans>Add, change and remove things there</Trans></li>}
          <li className="flex gap-2"><span className="icon-[tabler--x] mt-0.5 size-4 shrink-0 text-base-content/70" /><Trans>Not your other households, your password or your settings</Trans></li>
        </ul>

        {(allow.isError || deny.isError) && <div className="alert alert-soft alert-error">{(allow.error ?? deny.error)!.message}</div>}

        <div className="flex flex-wrap gap-3">
          <button type="button" className="btn btn-primary grow" disabled={busy} onClick={() => allow.mutate()}>
            {allow.isPending && <span className="loading loading-spinner loading-sm" />}
            <Trans>Allow</Trans>
          </button>
          <button type="button" className="btn btn-secondary btn-soft grow" disabled={busy} onClick={() => deny.mutate()}>
            <Trans>Cancel</Trans>
          </button>
        </div>
        <p className="text-sm text-base-content/70"><Trans>You can disconnect it any time in Settings → Claude & API.</Trans></p>
      </div>
    </AuthLayout>
  );
}

/**
 * The plugin's consent step. Allow above does it itself, so landing here means a link someone made, not a request
 * this person just approved: nothing is approved from here (the server refuses it without a choice for that app too).
 */
export function ConnectFinish() {
  return <Problem text={t`Nothing was connected. To connect an app, start again from the app itself.`} />;
}

function clearPending() {
  try {
    localStorage.removeItem(PENDING_KEY);
  } catch {
    // nothing kept
  }
}

function Problem({ text }: { text: string }) {
  return (
    <AuthLayout icon="icon-[tabler--plug-connected-x]" title={t`Couldn't connect the app`} subtitle={text}>
      <a href="#/" className="btn btn-primary"><Trans>Go to Ferret</Trans></a>
    </AuthLayout>
  );
}
