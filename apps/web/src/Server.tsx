import { locale } from "./i18n";
import { t as translateText } from "./i18n";
import { tr } from "./i18n";
/**
 * Settings → Server: what belongs to the whole server rather than one household, for its admin only — the nightly
 * backups (status, "Back up now", the copies kept, each one's restore check, how to restore), recall checks (on or off),
 * certificates for the server's own connections, and handing the admin role to someone else. Restoring is a command on the server, not a button: see restoreCommands below.
 */
import type { BackupRun, BackupSnapshot, BackupStatus, ServerCertificate, ServerSecrets } from "@ferret/shared";
import { ServerAiFillCard } from "./AiFill";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DemoSwitches, DemoUsage, HostingUsageCard } from "./Demo";
import { type FormEvent, useState } from "react";
import { CopyField } from "./CopyField";
import { api } from "./lib/api";
import { SETTINGS_HREF } from "./lib/route";
import { DialogActions, Modal } from "./Modal";
import { HelpLink } from "./HelpLink";
import { navigateTo } from "./lib/navigate";

export function Server() {
  // The demo has no backups of its own: it's planted afresh every night.
  const demo = useQuery({ queryKey: ["auth-options"], queryFn: api.authOptions, staleTime: Infinity }).data?.demo;
  return (
    <>
      <AddressNotice />
      <DemoUsage />
      <HostingUsageCard />
      <DemoSwitches />
      {!demo && <Backups />}
      <ServiceErrors />
      <BarcodeLookups />
      <RecallChecks />
      <ServerAiFillCard />
      {!demo && <Certificates />}
      <ServerAdmin />
    </>
  );
}

/**
 * PUBLIC_URL unset (a one-click install that can't know its address): sign-ins work from wherever Ferret is opened, but
 * links Ferret sends and passkeys use the default — say so, with the address this page is open at to set it to.
 */
function AddressNotice() {
  const address = useQuery({ queryKey: ["server-address"], queryFn: api.serverAddress });
  if (!address.data || address.data.set) return null;
  const here = window.location.origin;
  return (
    <div className="alert alert-soft alert-warning flex-col items-start gap-2" role="status">
      <p className="font-medium">{translateText("Set Ferret's address (PUBLIC_URL)")}</p>
      <p className="text-sm">{tr("It isn't set, so signing in works from the local address Ferret is opened at (an IP address or a name like umbrel.local, not a domain name) — but links it sends (invitations, password resets, share links, calendar feeds) point to {v0}, and passkeys and single sign-on won't work. Set {v1} in Ferret's settings — probably to {v2}{v3}— and restart it.", { v0: <code className="break-all">{address.data.publicUrl}</code>, v1: <code>PUBLIC_URL</code>, v2: <code className="break-all">{here}</code>, v3: " " })}</p>
      <HelpLink page="hosting/configuration.html" label={translateText("Settings")} />
    </div>
  );
}

/** Failed calls to the services Ferret uses (server: lib/service-errors.ts) — newest first, counted. */
function ServiceErrors() {
  const qc = useQueryClient();
  const errors = useQuery({ queryKey: ["service-errors"], queryFn: api.serviceErrors, refetchInterval: 60_000 });
  const clear = useMutation({
    mutationFn: (id?: string) => api.clearServiceErrors(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["service-errors"] });
      void qc.invalidateQueries({ queryKey: ["attention"] });
    },
  });
  const rows = errors.data?.data ?? [];
  const ago = (iso: string) => {
    const m = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
    return m < 1 ? translateText("just now") : m < 60 ? translateText("{v0} min ago", { v0: m }) : m < 48 * 60 ? translateText("{v0} h ago", { v0: Math.round(m / 60) }) : new Date(iso).toLocaleDateString(locale());
  };
  return (
    <section className="card" aria-labelledby="service-errors-title">
      <div className="card-body gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="service-errors-title" className="card-title flex items-center gap-2">
            <span className="icon-[tabler--plug-connected-x] size-5 text-primary" />
            {translateText("Service errors")}</h2>
          {rows.length > 0 && (
            <button type="button" className="btn btn-text btn-sm" disabled={clear.isPending} onClick={() => clear.mutate(undefined)}>
              {translateText("Clear all")}</button>
          )}
        </div>
        <p className="text-sm text-base-content/70">
          {translateText("When a call to a service Ferret uses fails — the AI models, the vector store, the document reader, Apprise, push, the barcode and recall databases, maps — it's listed here, and you're told (push, your other apps, email) when one starts failing, at most every 6 hours each. Ferret carries on without them where it can.")}</p>
        {!rows.length ? (
          <p className="flex items-center gap-2 text-sm text-success">
            <span className="icon-[tabler--circle-check] size-5" />
            {translateText("No errors.")}</p>
        ) : (
          <ul className="divide-y divide-base-content/10">
            {rows.map((e) => (
              <li key={e.id} className="flex items-start gap-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">
                    {e.serviceName} <span className="font-normal text-base-content/70">· {e.operation}</span>
                  </p>
                  <p className="break-words font-mono text-xs">{e.message}</p>
                  <p className="text-xs text-base-content/70">
                    {e.count} {e.count === 1 ? translateText("time") : translateText("times")}{tr(" · last {v0}", { v0: ago(e.lastAt) })}{e.count > 1 ? translateText(" · first {v0}", { v0: ago(e.firstAt) }) : ""}
                  </p>
                  <CopyDetails text={e.triage} />
                </div>
                <button type="button" className="btn btn-text btn-sm btn-square" aria-label={translateText("Clear this {v0} error", { v0: e.serviceName })} onClick={() => clear.mutate(e.id)}>
                  <span className="icon-[tabler--x] size-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

/** An error's triage notes (what failed, when, how, which server) to the clipboard — for a bug report, or Claude. */
function CopyDetails({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }
  return (
    <button type="button" className="btn btn-text btn-xs tap mt-1 -ms-2" onClick={copy}>
      <span className={`${copied ? "icon-[tabler--copy-check] text-success" : "icon-[tabler--copy]"} size-4`} />
      {copied ? translateText("Copied") : translateText("Copy details")}
    </button>
  );
}

/** The online barcode database (BARCODE_LOOKUP) and what's left of its daily allowance, as it said at the last lookup. */
function BarcodeLookups() {
  const status = useQuery({ queryKey: ["server-barcode-lookups"], queryFn: api.barcodeLookupStatus, refetchInterval: 60_000 });
  const s = status.data;
  if (!s?.on) return null;
  const q = s.quota;
  const share = q ? q.remaining / q.limit : 1;
  const tone = share === 0 ? "progress-error" : share <= 0.2 ? "progress-warning" : "progress-primary";
  const time = (iso: string) => new Date(iso).toLocaleTimeString(locale(), { hour: "numeric", minute: "2-digit" });
  // UPCitemdb's day runs 24 hours from its first lookup, so the refill is often tomorrow.
  const when = (iso: string) => {
    const d = new Date(iso);
    const days = Math.round((new Date(d).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86_400_000);
    return days === 0 ? translateText("at {v0}", { v0: time(iso) }) : days === 1 ? translateText("tomorrow at {v0}", { v0: time(iso) }) : translateText("{v0} at {v1}", { v0: d.toLocaleDateString(locale(), { weekday: "long" }), v1: time(iso) });
  };
  return (
    <section className="card" aria-labelledby="barcode-lookups-title">
      <div className="card-body gap-3">
        <h2 id="barcode-lookups-title" className="card-title flex items-center gap-2">
          <span className="icon-[tabler--barcode] size-5 text-primary" />
          {translateText("Online barcode lookups")}</h2>
        <p className="text-sm text-base-content/70">
          {translateText("Barcodes nobody here has saved yet are asked of the online product database, each once for the whole server. It allows so many a day; when they're used up, scans still match the barcode books and the rest are asked later.")}</p>
        {q ? (
          <>
            <div className="flex flex-wrap items-baseline justify-between gap-x-3">
              <span className="font-medium">{tr("{v0} of {v1} left", { v0: q.remaining.toLocaleString(locale()), v1: q.limit.toLocaleString(locale()) })}</span>
              <span className="text-sm text-base-content/70">{tr("fills up again {v0} · as of {v1}", { v0: when(q.resetsAt), v1: time(q.checkedAt) })}</span>
            </div>
            <progress className={`progress ${tone}`} value={Math.round(share * 100)} max={100} aria-label={translateText("{v0} of {v1} barcode lookups left", { v0: q.remaining, v1: q.limit })} />
          </>
        ) : (
          <p className="text-sm text-base-content/70">{translateText("Nothing asked yet — the allowance shows after the first lookup.")}</p>
        )}
      </div>
    </section>
  );
}

/** Recall checks: off until switched on, because they send the brands people own to the CPSC. */
function RecallChecks() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ["server-recalls"], queryFn: api.recallStatus });
  const toggle = useMutation({
    mutationFn: api.setRecallChecks,
    onSuccess: (data) => {
      qc.setQueryData(["server-recalls"], data);
      void qc.invalidateQueries({ queryKey: ["recalls"] });
    },
  });
  const s = status.data;
  if (!s) return null;
  return (
    <section className="card" aria-labelledby="recalls-title">
      <div className="card-body gap-3">
        <h2 id="recalls-title" className="card-title flex items-center gap-2">
          <span className="icon-[tabler--alert-triangle] size-5 text-primary" />
          {translateText("Recall checks")}<HelpLink page="guide/recalls.html" label={translateText("Recall checks")} />
        </h2>
        <p className="text-sm text-base-content/70">
          {translateText("Checks everyone's things against the US Consumer Product Safety Commission's recalls, daily, and says when one matches — on the thing's page and in the bell. To do that, the brands people own are sent to the CPSC (saferproducts.gov), each at most once a week; nothing else is.")}</p>
        <label className="flex cursor-pointer items-center gap-3">
          <input type="checkbox" className="switch switch-primary" checked={s.enabled} disabled={toggle.isPending || !s.available} onChange={(e) => toggle.mutate(e.target.checked)} />
          <span>{s.enabled ? translateText("On") : translateText("Off")}</span>
        </label>
        {s.enabled && (
          <p className="text-sm text-base-content/70">
            {s.brands} {s.brands === 1 ? translateText("brand") : translateText("brands")}{tr(" checked, {v0} ", { v0: s.recalls })}{s.recalls === 1 ? translateText("recall") : translateText("recalls")} {translateText("kept")}{s.lastCheckedAt ? translateText(" · last asked {v0}", { v0: new Date(s.lastCheckedAt).toLocaleString(locale()) }) : translateText(" · checking now")}.
          </p>
        )}
        {toggle.isError && <div className="alert alert-soft alert-error">{toggle.error.message}</div>}
      </div>
    </section>
  );
}

function Backups() {
  const qc = useQueryClient();
  const status = useQuery({
    queryKey: ["backup"],
    queryFn: api.backupStatus,
    // While one runs (or was just asked for), look again every few seconds.
    refetchInterval: (q) => (q.state.data?.last?.status === "running" ? 3000 : false),
  });
  const snapshots = useQuery({ queryKey: ["backup", "snapshots"], queryFn: api.backupSnapshots, enabled: !!status.data?.enabled });
  const [asked, setAsked] = useState(false);
  const now = useMutation({
    mutationFn: api.backupNow,
    onSuccess: () => {
      setAsked(true);
      // The job starts within a moment; then the status poll takes over.
      setTimeout(() => void qc.invalidateQueries({ queryKey: ["backup"] }), 1500);
    },
  });
  const s = status.data;
  const running = s?.last?.status === "running";

  return (
    <section className="card" aria-labelledby="backups-title">
      <div className="card-body gap-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <h2 id="backups-title" className="card-title flex items-center gap-2">
              <span className="icon-[tabler--database] size-5 text-primary" />
              {translateText("Backups")}<HelpLink page="hosting/backups.html" label={translateText("Backups")} />
            </h2>
            <p className="text-sm text-base-content/70">
              {s?.enabled
                ? translateText("Every night from {v0}:00, the database and every household's files are copied to {v1}, then opened again to check they'd restore. The newest {v2} are kept.", { v0: s.hour, v1: s.where, v2: s.keep })
                : s?.elsewhere
                  ? translateText("The database and every household's files, copied each night off this server.")
                  : translateText("The database and every household's files, copied each night to a folder off this machine and checked.")}
            </p>
          </div>
          {s?.enabled && (
            <button type="button" className="btn btn-primary" onClick={() => now.mutate()} disabled={now.isPending || running}>
              {(now.isPending || running) && <span className="loading loading-spinner loading-sm" />}
              {running ? translateText("Backing up…") : translateText("Back up now")}
            </button>
          )}
        </div>

        {status.isPending && <span className="loading loading-spinner text-primary" />}
        {status.isError && <div className="alert alert-soft alert-error">{status.error.message}</div>}
        {now.isError && <div className="alert alert-soft alert-error">{now.error.message}</div>}

        {s && !s.enabled && s.elsewhere && (
          // Backups made outside this server (Deps.backupElsewhere): where, and how the newest went.
          <div className={`alert alert-soft flex-col items-start gap-1 ${s.elsewhere.ok === false || !s.elsewhere.at ? "alert-warning" : "alert-success"}`}>
            <p className="font-medium">
              {s.elsewhere.at
                ? `${s.elsewhere.ok ? translateText("Last backup") : translateText("Last backup failed")}: ${new Date(s.elsewhere.at).toLocaleString(locale())}`
                : translateText("No backup has reported yet.")}
            </p>
            <p className="text-sm">{tr("They're made outside this server: {v0}.", { v0: s.elsewhere.where })}{s.elsewhere.detail ? ` ${s.elsewhere.detail}` : ""}
            </p>
          </div>
        )}

        {s && !s.enabled && !s.elsewhere && (
          <div className="alert alert-soft alert-warning flex-col items-start gap-2">
            <p className="font-medium">{translateText("Backups are off.")}</p>
            <p className="text-sm">{tr("Set {v0} in Ferret's {v1} to a folder on another machine — e.g. an NFS share on the NAS, mounted into the container — and restart Ferret. Keep {v2} in your password manager: a backup can't be opened without it.", { v0: <code>BACKUP_DIR</code>, v1: <code>{".env"}</code>, v2: <code>FILES_KEY</code> })}</p>
          </div>
        )}

        {s?.enabled && (
          <>
            <LastRun last={s.last} lastOk={s.lastOk} asked={asked} />
            <Snapshots data={snapshots.data?.data} loading={snapshots.isPending} error={snapshots.error?.message} />
          </>
        )}
        {s && <FilesKey keyId={s.keyId} keyFile={s.keyFile} folder={s.where} commandLine={!s.elsewhere} />}
        {s?.enabled && <Restoring />}
      </div>
    </section>
  );
}

function LastRun({ last, lastOk, asked }: { last: BackupRun | null; lastOk: BackupRun | null; asked: boolean }) {
  if (!last) {
    return <p className="text-sm text-base-content/70">{asked ? translateText("Starting…") : translateText("No backup yet — the first runs tonight, or now if you ask.")}</p>;
  }
  return (
    <div className="space-y-3">
      {last.status === "failed" && (
        <div className="alert alert-soft alert-error flex-col items-start gap-1" role="alert">
          <p className="font-medium">{tr("The last backup failed ({v0})", { v0: formatTime(last.startedAt) })}</p>
          <p className="text-sm break-words">{last.error}</p>
          <p className="text-sm">{lastOk ? translateText("The last one that worked: {v0}.", { v0: formatTime(lastOk.startedAt) }) : translateText("None has worked yet.")}</p>
        </div>
      )}
      {lastOk && (
        <div className="flex items-start gap-3">
          <span className="icon-[tabler--circle-check] mt-0.5 size-5 shrink-0 text-success" />
          <div className="min-w-0 space-y-0.5">
            <p className="font-medium">{tr("Last backup {v0}", { v0: formatTime(lastOk.startedAt) })}</p>
            <p className="text-sm text-base-content/70">
              {lastOk.files} {lastOk.files === 1 ? translateText("file") : translateText("files")} ({formatBytes(lastOk.filesBytes ?? 0)}
              {lastOk.filesCopied ? translateText(", {v0} new", { v0: lastOk.filesCopied }) : ""}{tr(") and the database ({v0})", { v0: formatBytes(lastOk.dbBytes ?? 0) })}</p>
            {lastOk.checked && <p className="text-sm text-base-content/70">{lastOk.checked}</p>}
          </div>
        </div>
      )}
    </div>
  );
}

function Snapshots({ data, loading, error }: { data?: BackupSnapshot[]; loading: boolean; error?: string }) {
  return (
    <div className="space-y-2">
      <h3 className="font-medium">{translateText("Copies kept")}</h3>
      {loading && <span className="loading loading-spinner text-primary" />}
      {error && <div className="alert alert-soft alert-error">{error}</div>}
      {data && data.length === 0 && <p className="text-sm text-base-content/70">{translateText("None yet.")}</p>}
      {data && data.length > 0 && (
        <ul className="divide-y divide-base-content/10">
          {data.map((snap) => (
            <SnapshotRow key={snap.name} snap={snap} />
          ))}
        </ul>
      )}
    </div>
  );
}

function SnapshotRow({ snap }: { snap: BackupSnapshot }) {
  const check = useMutation({ mutationFn: () => api.checkBackup(snap.name) });
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
      <div className="min-w-0 flex-1">
        <p className="font-medium">{formatTime(snap.createdAt)}</p>
        <p className="text-sm text-base-content/70">
          {snap.items} {snap.items === 1 ? translateText("item") : translateText("items")}, {snap.files} {snap.files === 1 ? translateText("file") : translateText("files")} ({formatBytes(snap.filesBytes)})
          · <code className="text-xs">{snap.name}</code>
        </p>
        {check.data && (
          <p className={`text-sm ${check.data.ok ? "text-success" : "text-error"}`} role="status">
            <span className={`${check.data.ok ? "icon-[tabler--circle-check]" : "icon-[tabler--alert-triangle]"} me-1 size-4 align-[-3px]`} />
            {check.data.summary}
          </p>
        )}
        {check.isError && <p className="text-sm text-error">{check.error.message}</p>}
      </div>
      <button type="button" className="btn btn-soft btn-sm" onClick={() => check.mutate()} disabled={check.isPending}>
        {check.isPending && <span className="loading loading-spinner loading-xs" />}
        {translateText("Check")}</button>
    </li>
  );
}

/** Restoring replaces every household's data, so it's done on the server itself, with Ferret stopped. */
/** What each secret is for, and what losing it costs — Settings → Server's Keys, and the help's table. */
const SECRET_ROLES: Record<ServerSecrets["secrets"][number]["name"], { what: string; lost: string }> = {
  FILES_KEY: { get what() { return translateText("Seals every photo, document and pairing code, and the backups."); }, get lost() { return translateText("Lost for good without a copy: nothing uploaded can be opened."); } },
  AUTH_SECRET: { get what() { return translateText("Signs sign-ins, and seals two-step sign-in."); }, get lost() { return translateText("Can be replaced: everyone signs in again, and two-step sign-in is set up again."); } },
  VAPID_PUBLIC_KEY: { get what() { return translateText("Push notifications: the key browsers subscribe with."); }, get lost() { return translateText("Remade by Ferret: each device turns push on again."); } },
  VAPID_PRIVATE_KEY: { get what() { return translateText("Push notifications: signs what Ferret sends."); }, get lost() { return translateText("Remade by Ferret: each device turns push on again."); } },
};

/**
 * The secrets Ferret needs: where each came from (its settings, or made by Ferret and kept in the data folder), what
 * losing it costs, FILES_KEY's fingerprint and the newest key file — never a secret, bar the push public key. Key files
 * are made on the command line only (lib/key-file.ts): whoever can run that can already read the server's settings; a
 * page could be misused by anyone holding the admin's session.
 */
function FilesKey({
  keyId,
  keyFile,
  folder,
  commandLine,
}: {
  keyId: string;
  keyFile: BackupStatus["keyFile"];
  folder: string | null;
  commandLine: boolean;
}) {
  const secrets = useQuery({ queryKey: ["server-secrets"], queryFn: api.serverSecrets });
  const list = secrets.data?.secrets ?? [];
  const keptByFerret = list.some((x) => x.source === "ferret");
  const filesKeyByFerret = list.some((x) => x.name === "FILES_KEY" && x.source === "ferret");
  return (
    <div className="space-y-3">
      <h3 className="font-medium">{translateText("Keys")}</h3>
      <p className="text-sm text-base-content/70">{tr("The secrets Ferret needs. Any set in Ferret's settings are used; the rest Ferret made itself and keeps in{v0}", { v0: " " })}{secrets.data?.file ? <code className="break-all">{secrets.data.file}</code> : translateText("its data folder")}{tr(" — never in its backups.{v0}{v1}'s fingerprint is {v2} ({v3} prints a key's, to check a saved copy).", { v0: " ", v1: <code>FILES_KEY</code>, v2: <code className="font-mono">{keyId}</code>, v3: <code>cli.js key fingerprint</code> })}</p>
      {secrets.isError && <div className="alert alert-soft alert-error">{secrets.error.message}</div>}
      {list.length > 0 && (
        <ul className="divide-y divide-base-content/10 rounded-box border border-base-content/15">
          {list.map((x) => (
            <li key={x.name} className="flex flex-wrap items-start justify-between gap-2 p-3">
              <div className="min-w-0 space-y-0.5">
                <p className="font-mono text-sm">{x.name}</p>
                <p className="text-sm text-base-content/70">{SECRET_ROLES[x.name].what}</p>
                <p className="text-sm text-base-content/70">{tr("If lost: {v0}", { v0: SECRET_ROLES[x.name].lost })}</p>
              </div>
              <span className={`badge badge-soft ${x.source === "none" ? "" : x.source === "ferret" ? "badge-info" : "badge-success"}`}>
                {x.source === "settings" ? translateText("From the settings") : x.source === "ferret" ? translateText("Made by Ferret") : translateText("Not set")}
              </span>
            </li>
          ))}
        </ul>
      )}
      {secrets.data?.pushPublicKey && (
        <CopyField label={translateText("Push public key (public — for tools that send to Ferret's subscribers)")} value={secrets.data.pushPublicKey} icon="icon-[tabler--bell]" />
      )}
      {filesKeyByFerret && !keyFile?.current && (
        <div className="alert alert-soft alert-warning text-sm">
          {translateText("FILES_KEY is only in this server's data folder. If that folder is lost, so is every photo and document — the backups too.\n          Make a key file and keep it, and its passphrase, somewhere else.")}</div>
      )}
      {keyFile?.current && (
        <p className="flex items-start gap-2 text-sm">
          <span className="icon-[tabler--circle-check] mt-0.5 size-4 shrink-0 text-success" />
          <span>{tr("Key file made {v0}, in {v1}.", { v0: formatTime(keyFile.at), v1: <code className="break-all">{keyFile.where}</code> })}</span>
        </p>
      )}
      {keyFile && !keyFile.current && (
        <div className="alert alert-soft alert-warning text-sm">{tr("The newest key file ({v0}) holds another FILES_KEY ({v1}), not the one in use. Make a new one.", { v0: formatTime(keyFile.at), v1: keyFile.keyId })}</div>
      )}
      {!keyFile && commandLine && !filesKeyByFerret && <p className="text-sm text-base-content/70">{translateText("No key file made yet.")}</p>}
      {commandLine && (
        <details className="rounded-box border border-base-content/15 p-3" open={filesKeyByFerret && !keyFile?.current}>
          <summary className="tap cursor-pointer font-medium">{translateText("Make a key file")}</summary>
          <div className="mt-3 space-y-3 text-sm text-base-content/80">
            <p>{tr("A key file holds these secrets sealed with a passphrase you choose, so it can be kept beside the backups. If they're ever lost, {v0} opens the file with the passphrase and gives them back. On the server, in Ferret's folder (or the container's console):", { v0: <code>cli.js key recover</code> })}</p>
            <CopyField label={translateText("Key file command")} value={keyExportCommand(folder)} icon="icon-[tabler--terminal-2]" />
            <p>
              {translateText("Use a long passphrase — a few unrelated words — and keep it in your password manager: anyone with the file can try passphrases. Then copy the file off this server.")}{keptByFerret ? translateText(" Make a new one if Ferret ever makes new keys (it says so in its log).") : ""}
            </p>
          </div>
        </details>
      )}
    </div>
  );
}

const keyExportCommand = (folder: string | null) => translateText("docker compose exec -it ferret node dist/cli.js key export {v0}", { v0: folder ?? "/data" });

function Restoring() {
  return (
    <details className="rounded-box border border-base-content/15 p-3">
      <summary className="tap cursor-pointer font-medium">{translateText("How to restore")}</summary>
      <div className="mt-3 space-y-3 text-sm text-base-content/80">
        <p>{tr("On the server, in Ferret's folder (where {v0} is), with the same {v1} — its{v2}{v3} opens the backup (lost it? {v4} gets it back from a key file):", { v0: <code>{"compose.yaml"}</code>, v1: <code>{".env"}</code>, v2: " ", v3: <code>FILES_KEY</code>, v4: <code>cli.js key recover</code> })}</p>
        <ol className="list-decimal space-y-3 ps-5">
          <li>
            {translateText("Rebuild a data folder from the newest copy (or name one from the list above at the end):")}<CopyField label={translateText("Restore command")} value={restoreCommand} icon="icon-[tabler--terminal-2]" />
          </li>
          <li>{tr("Stop Ferret ({v0}), move its data folder aside (the one mounted at {v1},{v2}{v3}), put {v4} in its place, and start it again ({v5}).", { v0: <code>{"docker compose stop ferret"}</code>, v1: <code>/data</code>, v2: " ", v3: <code>FERRET_DATA</code>, v4: <code>{"restored"}</code>, v5: <code>{"docker compose up -d ferret"}</code> })}</li>
        </ol>
        <p>{translateText("Search indexes rebuild themselves on start.")}</p>
      </div>
    </details>
  );
}

// The folder is made first, so it belongs to you (and the container's user), not root.
const restoreCommand = "mkdir restored && docker compose run --rm -v ./restored:/restore ferret node dist/cli.js backup restore /restore";

/**
 * Certificates for Ferret's own connections to your services (server: lib/certificates.ts): authorities to trust, and
 * client certificates presented only to the hosts they name. Hidden where the server can't use them (hosted).
 */
function Certificates() {
  const qc = useQueryClient();
  const certs = useQuery({ queryKey: ["server-certificates"], queryFn: api.serverCertificates });
  const [adding, setAdding] = useState<"trusted" | "client" | null>(null);
  const [removing, setRemoving] = useState<ServerCertificate | null>(null);
  const remove = useMutation({
    mutationFn: (id: string) => api.removeCertificate(id),
    onSuccess: (data) => {
      qc.setQueryData(["server-certificates"], data);
      void qc.invalidateQueries({ queryKey: ["attention"] });
      setRemoving(null);
    },
  });
  const d = certs.data;
  if (!d?.available) return null;
  return (
    <section className="card" aria-labelledby="certificates-title">
      <div className="card-body gap-4">
        <div className="space-y-1">
          <h2 id="certificates-title" className="card-title flex items-center gap-2">
            <span className="icon-[tabler--certificate] size-5 text-primary" />
            {translateText("Certificates")}<HelpLink page="hosting/certificates.html" label={translateText("Certificates")} />
          </h2>
          <p className="text-sm text-base-content/70">
            {translateText("For Ferret's own connections to your other services — Home Assistant, the AI models, Apprise, your sign-in provider. Downloads from the internet only ever trust the usual authorities.")}</p>
        </div>

        <div className="space-y-2">
          <h3 className="font-medium">{translateText("Trusted")}</h3>
          <p className="text-sm text-base-content/70">{translateText("Your own certificate authority, or a service's self-signed certificate.")}</p>
          <CertificateList list={d.trusted} empty={translateText("Only the usual authorities.")} onRemove={setRemoving} />
          <button type="button" className="btn btn-soft btn-primary btn-sm" onClick={() => setAdding("trusted")}>
            <span className="icon-[tabler--plus] size-4" />
            {translateText("Trust a certificate…")}</button>
        </div>

        <div className="space-y-2">
          <h3 className="font-medium">{translateText("Client certificates")}</h3>
          <p className="text-sm text-base-content/70">{translateText("For services that ask who's connecting (mutual TLS). Each is shown only to the hosts you name.")}</p>
          <CertificateList list={d.clients} empty={translateText("None.")} onRemove={setRemoving} />
          <button type="button" className="btn btn-soft btn-primary btn-sm" onClick={() => setAdding("client")}>
            <span className="icon-[tabler--plus] size-4" />
            {translateText("Add a client certificate…")}</button>
        </div>
      </div>

      {adding === "trusted" && <TrustDialog onClose={() => setAdding(null)} />}
      {adding === "client" && <ClientCertificateDialog onClose={() => setAdding(null)} />}
      {removing && (
        <Modal id="remove-certificate" onClose={() => setRemoving(null)}>
          <div className="flex flex-col gap-5">
            <div className="space-y-1 text-center">
              <h3 id="remove-certificate-title" className="text-xl font-semibold">{tr("Remove “{v0}”?", { v0: removing.name })}</h3>
              <p className="text-base-content/80">
                {removing.hosts
                  ? translateText("Ferret stops presenting it to {v0}.", { v0: removing.hosts.join(", ") })
                  : translateText("Ferret stops trusting it: services whose certificate it vouches for won't connect.")}
              </p>
            </div>
            {remove.isError && <div className="alert alert-soft alert-error">{remove.error.message}</div>}
            <div className="flex flex-wrap justify-end gap-3">
              <button type="button" className="btn btn-secondary btn-soft" onClick={() => setRemoving(null)}>
                {translateText("Cancel")}</button>
              <button type="button" className="btn btn-error" onClick={() => remove.mutate(removing.id)} disabled={remove.isPending}>
                {remove.isPending && <span className="loading loading-spinner loading-sm" />}
                {translateText("Remove")}</button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}

function CertificateList({ list, empty, onRemove }: { list: ServerCertificate[]; empty: string; onRemove: (c: ServerCertificate) => void }) {
  if (!list.length) return <p className="text-sm text-base-content/70">{empty}</p>;
  const soon = Date.now() + 30 * 86_400_000;
  return (
    <ul className="divide-y divide-base-300 rounded-box border border-base-300">
      {list.map((c) => {
        const ends = Date.parse(c.notAfter);
        return (
          <li key={c.id} className="flex flex-wrap items-start justify-between gap-2 p-3">
            <div className="min-w-0 space-y-0.5">
              <div className="font-medium break-words">{c.name}</div>
              <div className="text-sm break-words text-base-content/70">
                {c.subject}
                {c.issuer !== c.subject && translateText(" · from {v0}", { v0: c.issuer })}
              </div>
              {c.hosts && <div className="text-sm break-words text-base-content/70">{tr("For {v0}", { v0: c.hosts.join(", ") })}</div>}
              <div className="flex flex-wrap items-center gap-2 text-sm">
                {ends <= Date.now() ? (
                  <span className="badge badge-soft badge-error">{tr("Expired {v0}", { v0: formatDate(c.notAfter) })}</span>
                ) : ends < soon ? (
                  <span className="badge badge-soft badge-warning">{tr("Expires {v0}", { v0: formatDate(c.notAfter) })}</span>
                ) : (
                  <span className="text-base-content/70">{tr("Until {v0}", { v0: formatDate(c.notAfter) })}</span>
                )}
              </div>
            </div>
            <button type="button" className="btn btn-text btn-sm" onClick={() => onRemove(c)}>
              {translateText("Remove…")}</button>
          </li>
        );
      })}
    </ul>
  );
}

const formatDate = (iso: string) => new Date(iso).toLocaleDateString(locale(), { year: "numeric", month: "short", day: "numeric" });

function TrustDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [pem, setPem] = useState("");
  const add = useMutation({
    mutationFn: () => api.trustCertificate(name.trim(), pem),
    onSuccess: (data) => {
      qc.setQueryData(["server-certificates"], data);
      onClose();
    },
  });
  async function pick(f: File | undefined) {
    if (!f) return;
    setPem(await f.text());
    if (!name) setName(f.name.replace(/\.(pem|crt|cer)$/i, ""));
  }
  function onSubmit(e: FormEvent) {
    e.preventDefault();
    add.mutate();
  }
  return (
    <Modal id="trust-certificate" title={translateText("Trust a certificate")} onClose={onClose}>
      <form className="flex flex-col gap-4" onSubmit={onSubmit}>
        <p className="text-sm text-base-content/70">{tr("A certificate authority's certificate, or a service's own self-signed one, in PEM form ({v0}). Never its private key.", { v0: <code>{"-----BEGIN CERTIFICATE-----"}</code> })}</p>
        <div>
          <label className="label-text" htmlFor="trust-name">
            {translateText("Name")}</label>
          <input id="trust-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={translateText("e.g. Home CA")} maxLength={80} />
        </div>
        <div>
          <label className="label-text" htmlFor="trust-file">
            {translateText("File (.pem, .crt)")}</label>
          <input id="trust-file" type="file" className="input" accept=".pem,.crt,.cer,application/x-pem-file,application/x-x509-ca-cert" onChange={(e) => void pick(e.target.files?.[0])} />
        </div>
        <div>
          <label className="label-text" htmlFor="trust-pem">
            {translateText("Or paste it")}</label>
          <textarea id="trust-pem" className="textarea font-mono text-xs" rows={6} value={pem} onChange={(e) => setPem(e.target.value)} required spellCheck={false} />
        </div>
        {add.isError && <div className="alert alert-soft alert-error">{add.error.message}</div>}
        <DialogActions>
          <button type="button" className="btn btn-secondary btn-soft" onClick={onClose}>
            {translateText("Cancel")}</button>
          <button type="submit" className="btn btn-primary" disabled={add.isPending || !pem.trim()}>
            {add.isPending && <span className="loading loading-spinner loading-sm" />}
            {translateText("Trust it")}</button>
        </DialogActions>
      </form>
    </Modal>
  );
}

function ClientCertificateDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState("");
  const [hosts, setHosts] = useState("");
  const add = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error(translateText("Choose the certificate's file"));
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (const b of bytes) binary += String.fromCharCode(b);
      return api.addClientCertificate({ name: name.trim(), hosts: hosts.split(/[\s,]+/).filter(Boolean), pkcs12: btoa(binary), password });
    },
    onSuccess: (data) => {
      qc.setQueryData(["server-certificates"], data);
      void qc.invalidateQueries({ queryKey: ["attention"] });
      onClose();
    },
  });
  function onSubmit(e: FormEvent) {
    e.preventDefault();
    add.mutate();
  }
  return (
    <Modal id="client-certificate" title={translateText("Add a client certificate")} onClose={onClose}>
      <form className="flex flex-col gap-4" onSubmit={onSubmit}>
        <p className="text-sm text-base-content/70">
          {translateText("A PKCS#12 file (.p12 or .pfx) holding the certificate and its key. It's kept sealed on the server and never shown again.")}</p>
        <div>
          <label className="label-text" htmlFor="client-name">
            {translateText("Name")}</label>
          <input id="client-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={translateText("e.g. Ferret for Home Assistant")} maxLength={80} />
        </div>
        <div>
          <label className="label-text" htmlFor="client-file">
            {translateText("File (.p12, .pfx)")}</label>
          <input
            id="client-file"
            type="file"
            className="input"
            accept=".p12,.pfx,application/x-pkcs12"
            required
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              setFile(f);
              if (f && !name) setName(f.name.replace(/\.(p12|pfx)$/i, ""));
            }}
          />
        </div>
        <div>
          <label className="label-text" htmlFor="client-password">
            {translateText("Its password")}</label>
          <input id="client-password" type="password" className="input" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <div>
          <label className="label-text" htmlFor="client-hosts">
            {translateText("Show it to")}</label>
          <textarea
            id="client-hosts"
            className="textarea"
            rows={2}
            value={hosts}
            onChange={(e) => setHosts(e.target.value)}
            placeholder={translateText("ha.example.lan, *.example.lan")}
            required
            spellCheck={false}
            autoCapitalize="none"
          />
          <p className="mt-1 text-sm text-base-content/70">{tr("Host names or addresses, separated by commas. {v0} covers everything under it.", { v0: <code>{"*.example.lan"}</code> })}</p>
        </div>
        {add.isError && <div className="alert alert-soft alert-error">{add.error.message}</div>}
        <DialogActions>
          <button type="button" className="btn btn-secondary btn-soft" onClick={onClose}>
            {translateText("Cancel")}</button>
          <button type="submit" className="btn btn-primary" disabled={add.isPending}>
            {add.isPending && <span className="loading loading-spinner loading-sm" />}
            {translateText("Add it")}</button>
        </DialogActions>
      </form>
    </Modal>
  );
}

function ServerAdmin() {
  const qc = useQueryClient();
  const admin = useQuery({ queryKey: ["server-admin"], queryFn: api.serverAdmin });
  const [email, setEmail] = useState("");
  const [confirming, setConfirming] = useState(false);
  const handOver = useMutation({
    mutationFn: () => api.setServerAdmin(email.trim()),
    onSuccess: () => {
      setConfirming(false);
      void qc.invalidateQueries({ queryKey: ["me"] });
      void qc.invalidateQueries({ queryKey: ["attention"] });
      navigateTo(SETTINGS_HREF);
    },
  });
  function onSubmit(e: FormEvent) {
    e.preventDefault();
    handOver.reset();
    setConfirming(true);
  }

  return (
    <section className="card" aria-labelledby="server-admin-title">
      <div className="card-body gap-4">
        <div className="space-y-1">
          <h2 id="server-admin-title" className="card-title flex items-center gap-2">
            <span className="icon-[tabler--user-shield] size-5 text-primary" />
            {translateText("Server admin")}<HelpLink page="hosting/server-admin.html" label={translateText("Server admin")} />
          </h2>
          <p className="text-sm text-base-content/70">
            {translateText("You")}{admin.data ? ` (${admin.data.email})` : ""} {translateText("look after this server: its backups, and their alerts in the bell. It's one person at a time — you can hand it to someone else with an account here.")}</p>
        </div>
        <form className="flex flex-wrap items-end gap-2" onSubmit={onSubmit}>
          <div className="min-w-0 grow">
            <label className="label-text" htmlFor="new-admin">
              {translateText("Hand over to")}</label>
            <div className="input">
              <span className="icon-[tabler--mail] my-auto me-3 size-5 shrink-0 text-base-content/80" />
              <input id="new-admin" type="email" className="grow" placeholder={translateText("their account's email")} value={email} onChange={(e) => setEmail(e.target.value)} required />
            </div>
          </div>
          <button type="submit" className="btn btn-soft btn-primary">
            {translateText("Hand over…")}</button>
        </form>
        <p className="text-sm text-base-content/70">{tr("It also works from the server: {v0}", { v0: <code>{"docker compose exec ferret node dist/cli.js admin their@email"}</code> })}</p>
      </div>

      {confirming && (
        <Modal id="hand-over" onClose={() => setConfirming(false)}>
          <div className="flex flex-col gap-5">
            <div className="space-y-1 text-center">
              <h3 id="hand-over-title" className="text-xl font-semibold">{tr("Make {v0} the server admin?", { v0: email.trim() })}</h3>
              <p className="text-base-content/80">{translateText("You'll stop seeing this tab and backup alerts. Only they (or the command on the server) can give it back.")}</p>
            </div>
            {handOver.isError && <div className="alert alert-soft alert-error">{handOver.error.message}</div>}
            <div className="flex flex-wrap justify-end gap-3">
              <button type="button" className="btn btn-secondary btn-soft" onClick={() => setConfirming(false)}>
                {translateText("Cancel")}</button>
              <button type="button" className="btn btn-primary" onClick={() => handOver.mutate()} disabled={handOver.isPending}>
                {handOver.isPending && <span className="loading loading-spinner loading-sm" />}
                {translateText("Hand over")}</button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}

const formatTime = (iso: string) =>
  new Date(iso).toLocaleString(locale(), { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}
