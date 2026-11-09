import { locale } from "./i18n";
import { t as translateText } from "./i18n";
import { LanguageSettings } from "./LanguageSettings";
import { tr } from "./i18n";
/**
 * Settings, in tabs (each its own #/settings… link): Household (members,
 * invitations), Plan & usage (PlanUsage.tsx), Notifications (calendar, push, other apps), Security (two-step
 * sign-in, sessions, recent sign-ins), Claude & API, and — for the server
 * admin only — Server (backups).
 *
 * Claude & API: keys let Claude (over MCP) and scripts use this
 * household's inventory. The key list is adapted from FlyonUI Pro "Dashboard
 * Modal 15" (member rows), the new-key dialog from "Dashboard Modal 14" and the
 * one-time reveal from "Dashboard Modal 7"; behaviour is plain React.
 */
import type { ApiKeySummary, NewApiKey } from "@ferret/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { api } from "./lib/api";
import { API_HREF, type SettingsSection, settingsHref } from "./lib/route";
import { CopyField } from "./CopyField";
import { DataExport } from "./DataExport";
import { DeleteHousehold } from "./DeleteForGood";
import { ShareLinks } from "./Shares";
import { WeeklySummary } from "./PayOff";
import { Household } from "./Household";
import { Notifications } from "./Notifications";
import { Reminders } from "./Reminders";
import { Security } from "./Security";
import { Server } from "./Server";
import { Modal } from "./Modal";
import { HelpLink } from "./HelpLink";
import { TimeZoneCard } from "./TimeZone";
import { CurrencyCard } from "./Currency";
import { AiFillCard } from "./AiFill";
import { NotInPlan, PlanUsage, usePlanFeature } from "./PlanUsage";
import { useRole } from "./lib/auth";

const TABS: { section: SettingsSection; label: string; icon: string }[] = [
  { section: "household", get label() { return translateText("Household"); }, icon: "icon-[tabler--users]" },
  { section: "plan", get label() { return translateText("Usage"); }, icon: "icon-[tabler--gauge]" },
  { section: "notifications", get label() { return translateText("Notifications"); }, icon: "icon-[tabler--bell]" },
  { section: "security", get label() { return translateText("Security"); }, icon: "icon-[tabler--shield-lock]" },
  { section: "api", get label() { return translateText("Claude & API"); }, icon: "icon-[tabler--key]" },
  { section: "server", get label() { return translateText("Server"); }, icon: "icon-[tabler--server]" },
];

export function Settings(props: { section: SettingsSection; householdName: string; householdId: string }) {
  const { section, householdName, householdId } = props;
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  const serverAdmin = me.data?.serverAdmin ?? false;
  const role = useRole(householdId);
  const tabs = TABS.filter((t) => t.section !== "server" || serverAdmin);
  return (
    <div className="min-h-dvh bg-base-200">
      <header className="sticky top-0 z-10 border-b border-base-300 bg-base-100/85 backdrop-blur-md">
        <nav className="navbar px-4">
          <div className="navbar-start items-center gap-2">
            <a href="#/" className="btn btn-text btn-sm btn-square" aria-label={translateText("Back to your stuff")}>
              <span className="icon-[tabler--arrow-left] size-5" />
            </a>
            <h1 className="text-lg font-semibold">{translateText("Settings")}</h1>
          </div>
          <div className="navbar-end items-center">
            <span className="badge badge-soft badge-primary">{householdName}</span>
          </div>
        </nav>
        <nav className="tabs tabs-bordered mx-auto max-w-4xl overflow-x-auto px-4 max-sm:px-1" aria-label={translateText("Settings sections")}>
          {tabs.map((t) => (
            <a
              key={t.section}
              href={settingsHref(t.section)}
              className={`tab shrink-0 gap-2 max-sm:grow max-sm:px-2 max-sm:text-sm ${t.section === section ? "tab-active" : ""}`}
              aria-current={t.section === section ? "page" : undefined}
            >
              <span className={`${t.icon} size-5 max-sm:hidden`} />
              {t.label}
            </a>
          ))}
        </nav>
      </header>

      <main className="mx-auto flex max-w-3xl flex-col gap-4 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        {section === "household" && (
          <>
            <LanguageSettings householdId={householdId} canManage={role === "owner" || role === "admin"} />
            <Household householdName={householdName} />
            <TimeZoneCard householdId={householdId} canManage={role === "owner" || role === "admin"} />
            <CurrencyCard householdId={householdId} canManage={role === "owner" || role === "admin"} />
            <AiFillCard householdId={householdId} canManage={role === "owner" || role === "admin"} />
            <DataExport householdName={householdName} householdId={householdId} />
            <DeleteHousehold householdName={householdName} />
            <ShareLinks householdId={householdId} />
          </>
        )}
        {section === "plan" && <PlanUsage householdId={householdId} isOwner={role === "owner"} />}
        {section === "notifications" && (
          <>
            <Reminders householdId={householdId} />
            <WeeklySummary />
            <Notifications householdId={householdId} />
          </>
        )}
        {section === "security" && <Security />}
        {section === "server" &&
          (serverAdmin ? <Server /> : me.isSuccess && <div className="alert alert-soft alert-info">{translateText("Only the server admin sees this.")}</div>)}
        {section === "api" && (
          <>
            <ApiKeys householdName={householdName} householdId={householdId} />
            <ConnectClaude />
          </>
        )}
      </main>
    </div>
  );
}

function ApiKeys({ householdName, householdId }: { householdName: string; householdId: string }) {
  const qc = useQueryClient();
  const keysKey = ["api-keys", householdId];
  const keys = useQuery({ queryKey: keysKey, queryFn: api.listApiKeys });
  const refresh = () => qc.invalidateQueries({ queryKey: keysKey });
  const revoke = useMutation({ mutationFn: api.deleteApiKey, onSuccess: refresh });
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<NewApiKey | null>(null);
  const feature = usePlanFeature(householdId, "apiKeys");

  return (
    <>
      <section className="card" aria-labelledby="api-keys-title">
        <div className="card-body gap-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <h2 id="api-keys-title" className="card-title flex items-center gap-2">
                <span className="icon-[tabler--key] size-5 text-primary" />
                {translateText("API keys")}<HelpLink page="guide/claude.html" label={translateText("Claude and the API")} />
              </h2>
              <p className="text-sm text-base-content/70">{tr("Let Claude (or your own scripts) look things up and keep {v0}'s inventory up to date. A key only works for this household, and you can revoke it any time.", { v0: householdName })}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <a href={API_HREF} className="btn btn-soft btn-primary">
                <span className="icon-[tabler--book] size-5" />
                {translateText("API reference")}</a>
              {feature.on && (
                <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
                  <span className="icon-[tabler--plus] size-5" />
                  {translateText("New key")}</button>
              )}
            </div>
          </div>

          {!feature.on && <NotInPlan feature="apiKeys" planName={feature.planName} />}

          {keys.isPending && <span className="loading loading-spinner text-primary" />}
          {keys.isError && <div className="alert alert-soft alert-error">{keys.error.message}</div>}
          {revoke.isError && <div className="alert alert-soft alert-error">{revoke.error.message}</div>}
          {feature.on && keys.data && keys.data.data.length === 0 && (
            <div className="rounded-box border border-dashed border-base-content/20 p-6 text-center text-sm text-base-content/70">
              {translateText("No keys yet. Make one to connect Claude.")}</div>
          )}
          {keys.data && keys.data.data.length > 0 && (
            <ul className="space-y-2 *:flex *:flex-wrap *:items-center *:gap-3 *:rounded-box *:p-2 *:hover:bg-neutral/10">
              {keys.data.data.map((key) => (
                <KeyRow key={key.id} apiKey={key} onRevoke={() => revoke.mutate(key.id)} busy={revoke.isPending} />
              ))}
            </ul>
          )}
        </div>
      </section>

      {creating && (
        <CreateKeyModal
          onClose={() => setCreating(false)}
          onCreated={(key) => {
            setCreating(false);
            setCreated(key);
            void refresh();
          }}
        />
      )}
      {created && <RevealKeyModal apiKey={created} onClose={() => setCreated(null)} />}
    </>
  );
}

function KeyRow({ apiKey, onRevoke, busy }: { apiKey: ApiKeySummary; onRevoke: () => void; busy: boolean }) {
  const [confirming, setConfirming] = useState(false);
  const expired = apiKey.expiresAt && new Date(apiKey.expiresAt) < new Date();
  return (
    <li>
      <div className="avatar avatar-placeholder">
        <div className="size-10 rounded-full bg-primary/10 text-primary">
          <span className={`${apiKey.readOnly ? "icon-[tabler--eye]" : "icon-[tabler--key]"} size-5`} />
        </div>
      </div>
      <div className="min-w-0 flex-1">
        <h3 className="flex flex-wrap items-center gap-2 font-medium text-base-content">
          <span className="truncate">{apiKey.name ?? translateText("Unnamed key")}</span>
          {apiKey.readOnly && <span className="badge badge-soft badge-info badge-sm">{translateText("Read-only")}</span>}
          {expired && <span className="badge badge-soft badge-error badge-sm">{translateText("Expired")}</span>}
        </h3>
        <p className="flex flex-wrap gap-x-2 text-sm text-base-content/70">
          <code>{apiKey.start}…</code>
          <span>{tr("made {v0}", { v0: formatDate(apiKey.createdAt) })}</span>
          <span>{apiKey.lastUsedAt ? translateText("last used {v0}", { v0: formatDate(apiKey.lastUsedAt) }) : translateText("never used")}</span>
          {apiKey.expiresAt && !expired && <span>{tr("expires {v0}", { v0: formatDate(apiKey.expiresAt) })}</span>}
        </p>
      </div>
      {confirming ? (
        <div className="flex shrink-0 gap-1 max-sm:w-full max-sm:justify-end">
          <button type="button" className="btn btn-error btn-sm" onClick={onRevoke} disabled={busy}>
            {translateText("Revoke")}</button>
          <button type="button" className="btn btn-text btn-sm" onClick={() => setConfirming(false)}>
            {translateText("Keep")}</button>
        </div>
      ) : (
        <button
          type="button"
          className="btn btn-text btn-sm btn-square btn-error shrink-0"
          aria-label={translateText("Revoke {v0}", { v0: apiKey.name ?? translateText("key") })}
          onClick={() => setConfirming(true)}
        >
          <span className="icon-[tabler--trash] size-5" />
        </button>
      )}
    </li>
  );
}

/** How to use a key: the endpoint, and the one-liner for Claude Code. */
function ConnectClaude() {
  return (
    <section className="card" aria-labelledby="connect-title">
      <div className="card-body gap-3">
        <h2 id="connect-title" className="card-title flex items-center gap-2">
          <span className="icon-[tabler--plug-connected] size-5 text-primary" />
          {translateText("Connect Claude")}</h2>
        <p className="text-sm text-base-content/70">{tr("Ferret speaks MCP at the address below. Send the key as {v0}.", { v0: <code>{"Authorization: Bearer …"}</code> })}</p>
        <CopyField label={translateText("MCP server URL")} value={mcpUrl()} icon="icon-[tabler--world]" />
        <p className="text-sm text-base-content/70">{tr("In Claude Code, run this once (with your key in place of {v0}):", { v0: <code>{"ferret_…"}</code> })}</p>
        <CopyField label={translateText("Claude Code command")} value={claudeCommand("ferret_…")} icon="icon-[tabler--terminal-2]" />
      </div>
    </section>
  );
}

const mcpUrl = () => `${window.location.origin}/mcp`;
const claudeCommand = (key: string) =>
  translateText("claude mcp add --transport http ferret {v0} --header \"Authorization: Bearer {v1}\"", { v0: mcpUrl(), v1: key });

const EXPIRY_OPTIONS = [
  { get label() { return translateText("Never"); }, days: null },
  { get label() { return translateText("30 days"); }, days: 30 },
  { get label() { return translateText("90 days"); }, days: 90 },
  { get label() { return translateText("1 year"); }, days: 365 },
] as const;

function CreateKeyModal({ onClose, onCreated }: { onClose: () => void; onCreated: (key: NewApiKey) => void }) {
  const create = useMutation({ mutationFn: api.createApiKey, onSuccess: onCreated });
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const days = String(form.get("expires"));
    create.mutate({
      name: String(form.get("name")).trim(),
      readOnly: form.get("readOnly") === "on",
      expiresInDays: days ? Number(days) : null,
    });
  }
  return (
    <Modal id="new-api-key" onClose={onClose}>
      <form className="flex flex-col gap-6" onSubmit={onSubmit}>
        <div className="space-y-1 text-center">
          <h3 id="new-api-key-title" className="text-2xl font-semibold text-base-content">
            {translateText("New API key")}</h3>
          <p className="text-base-content/80">{translateText("For Claude, or a script of your own")}</p>
        </div>

        <div className="space-y-4">
          <div>
            <label className="label-text" htmlFor="key-name">
              {translateText("Name")}</label>
            <div className="input">
              <span className="icon-[tabler--tag] my-auto me-3 size-5 shrink-0 text-base-content/80" />
              <input id="key-name" name="name" className="grow" placeholder={translateText("e.g. Claude Code on my Mac")} maxLength={60} required autoFocus />
            </div>
          </div>
          <div>
            <label className="label-text" htmlFor="key-expires">
              {translateText("Expires")}</label>
            <select id="key-expires" name="expires" className="select" defaultValue="">
              {EXPIRY_OPTIONS.map((o) => (
                <option key={o.label} value={o.days ?? ""}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <label className="flex min-h-11 items-start gap-3">
            <input type="checkbox" name="readOnly" className="switch switch-primary mt-0.5" />
            <span>
              <span className="label-text block text-base">{translateText("Read-only")}</span>
              <span className="text-sm text-base-content/70">{translateText("Can search and ask, but not add, change or remove anything.")}</span>
            </span>
          </label>
        </div>

        {create.isError && <div className="alert alert-soft alert-error">{create.error.message}</div>}

        <div className="flex flex-wrap items-center justify-end gap-4">
          <button type="button" className="btn btn-secondary btn-soft" onClick={onClose}>
            {translateText("Cancel")}</button>
          <button type="submit" className="btn btn-primary" disabled={create.isPending}>
            {create.isPending && <span className="loading loading-spinner loading-sm" />}
            {translateText("Create key")}</button>
        </div>
      </form>
    </Modal>
  );
}

function RevealKeyModal({ apiKey, onClose }: { apiKey: NewApiKey; onClose: () => void }) {
  return (
    <Modal id="api-key-created" onClose={onClose}>
      <div className="flex flex-col gap-6">
        <div className="flex flex-col items-center text-center">
          <div className="avatar avatar-placeholder mb-4">
            <div className="size-16 rounded-xl border border-success/30 text-success">
              <span className="icon-[tabler--key] size-8" />
            </div>
          </div>
          <h3 id="api-key-created-title" className="text-2xl font-semibold text-base-content">{tr("{v0} is ready", { v0: apiKey.name })}</h3>
          <p className="text-base-content/80">{translateText("Copy it now. Ferret only keeps a fingerprint, so it can't show it to you again.")}</p>
        </div>
        <CopyField label={translateText("API key")} value={apiKey.key} icon="icon-[tabler--key]" />
        <div className="space-y-2">
          <p className="text-sm text-base-content/70">{translateText("Connect Claude Code with it:")}</p>
          <CopyField label={translateText("Claude Code command")} value={claudeCommand(apiKey.key)} icon="icon-[tabler--terminal-2]" />
        </div>
        <hr className="-mx-6 border-base-content/20 sm:-mx-10" />
        <div className="flex justify-end">
          <button type="button" className="btn btn-primary" onClick={onClose}>
            {translateText("Done")}</button>
        </div>
      </div>
    </Modal>
  );
}

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString(locale(), { month: "short", day: "numeric", year: "numeric" });
