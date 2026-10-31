/**
 * Settings → Server: what belongs to the whole server rather than one household, for its admin only — the nightly
 * backups (status, "Back up now", the copies kept, each one's restore check, how to restore), recall checks (on or off)
 * and handing the admin role to someone else. Restoring is a command on the server, not a button: see restoreCommands below.
 */
import type { BackupRun, BackupSnapshot } from "@ferret/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DemoSwitches, DemoUsage, HostingUsageCard } from "./Demo";
import { type FormEvent, useState } from "react";
import { CopyField } from "./CopyField";
import { api } from "./lib/api";
import { SETTINGS_HREF } from "./lib/route";
import { Modal } from "./Modal";
import { HelpLink } from "./HelpLink";
import { navigateTo } from "./lib/navigate";

export function Server() {
  // The demo has no backups of its own: it's planted afresh every night.
  const demo = useQuery({ queryKey: ["auth-options"], queryFn: api.authOptions, staleTime: Infinity }).data?.demo;
  return (
    <>
      <DemoUsage />
      <HostingUsageCard />
      <DemoSwitches />
      {!demo && <Backups />}
      <ServiceErrors />
      <BarcodeLookups />
      <RecallChecks />
      <ServerAdmin />
    </>
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
    return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : new Date(iso).toLocaleDateString();
  };
  return (
    <section className="card" aria-labelledby="service-errors-title">
      <div className="card-body gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="service-errors-title" className="card-title flex items-center gap-2">
            <span className="icon-[tabler--plug-connected-x] size-5 text-primary" />
            Service errors
          </h2>
          {rows.length > 0 && (
            <button type="button" className="btn btn-text btn-sm" disabled={clear.isPending} onClick={() => clear.mutate(undefined)}>
              Clear all
            </button>
          )}
        </div>
        <p className="text-sm text-base-content/70">
          When a call to a service Ferret uses fails — the AI models, the vector store, the document reader, Apprise, push, the
          barcode and recall databases, maps — it's listed here, and you're told (push, your other apps, email) when one starts
          failing, at most every 6 hours each. Ferret carries on without them where it can.
        </p>
        {!rows.length ? (
          <p className="flex items-center gap-2 text-sm text-success">
            <span className="icon-[tabler--circle-check] size-5" />
            No errors.
          </p>
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
                    {e.count} {e.count === 1 ? "time" : "times"} · last {ago(e.lastAt)}
                    {e.count > 1 ? ` · first ${ago(e.firstAt)}` : ""}
                  </p>
                  <CopyDetails text={e.triage} />
                </div>
                <button type="button" className="btn btn-text btn-sm btn-square" aria-label={`Clear this ${e.serviceName} error`} onClick={() => clear.mutate(e.id)}>
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
      {copied ? "Copied" : "Copy details"}
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
  const time = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  // UPCitemdb's day runs 24 hours from its first lookup, so the refill is often tomorrow.
  const when = (iso: string) => {
    const d = new Date(iso);
    const days = Math.round((new Date(d).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86_400_000);
    return days === 0 ? `at ${time(iso)}` : days === 1 ? `tomorrow at ${time(iso)}` : `${d.toLocaleDateString(undefined, { weekday: "long" })} at ${time(iso)}`;
  };
  return (
    <section className="card" aria-labelledby="barcode-lookups-title">
      <div className="card-body gap-3">
        <h2 id="barcode-lookups-title" className="card-title flex items-center gap-2">
          <span className="icon-[tabler--barcode] size-5 text-primary" />
          Online barcode lookups
        </h2>
        <p className="text-sm text-base-content/70">
          Barcodes nobody here has saved yet are asked of the online product database, each once for the whole server. It allows so many a
          day; when they're used up, scans still match the barcode books and the rest are asked later.
        </p>
        {q ? (
          <>
            <div className="flex flex-wrap items-baseline justify-between gap-x-3">
              <span className="font-medium">
                {q.remaining.toLocaleString()} of {q.limit.toLocaleString()} left
              </span>
              <span className="text-sm text-base-content/70">
                fills up again {when(q.resetsAt)} · as of {time(q.checkedAt)}
              </span>
            </div>
            <progress className={`progress ${tone}`} value={Math.round(share * 100)} max={100} aria-label={`${q.remaining} of ${q.limit} barcode lookups left`} />
          </>
        ) : (
          <p className="text-sm text-base-content/70">Nothing asked yet — the allowance shows after the first lookup.</p>
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
          Recall checks
          <HelpLink page="guide/recalls.html" label="Recall checks" />
        </h2>
        <p className="text-sm text-base-content/70">
          Checks everyone's things against the US Consumer Product Safety Commission's recalls, daily, and says when one matches — on the
          thing's page and in the bell. To do that, the brands people own are sent to the CPSC (saferproducts.gov), each at most once a week;
          nothing else is.
        </p>
        <label className="flex cursor-pointer items-center gap-3">
          <input type="checkbox" className="switch switch-primary" checked={s.enabled} disabled={toggle.isPending || !s.available} onChange={(e) => toggle.mutate(e.target.checked)} />
          <span>{s.enabled ? "On" : "Off"}</span>
        </label>
        {s.enabled && (
          <p className="text-sm text-base-content/70">
            {s.brands} {s.brands === 1 ? "brand" : "brands"} checked, {s.recalls} {s.recalls === 1 ? "recall" : "recalls"} kept
            {s.lastCheckedAt ? ` · last asked ${new Date(s.lastCheckedAt).toLocaleString()}` : " · checking now"}.
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
              Backups
              <HelpLink page="hosting/backups.html" label="Backups" />
            </h2>
            <p className="text-sm text-base-content/70">
              {s?.enabled
                ? `Every night from ${s.hour}:00, the database and every household's files are copied to ${s.where}, then opened again to check they'd restore. The newest ${s.keep} are kept.`
                : s?.elsewhere
                  ? "The database and every household's files, copied each night off this server."
                  : "The database and every household's files, copied each night to a folder off this machine and checked."}
            </p>
          </div>
          {s?.enabled && (
            <button type="button" className="btn btn-primary" onClick={() => now.mutate()} disabled={now.isPending || running}>
              {(now.isPending || running) && <span className="loading loading-spinner loading-sm" />}
              {running ? "Backing up…" : "Back up now"}
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
                ? `${s.elsewhere.ok ? "Last backup" : "Last backup failed"}: ${new Date(s.elsewhere.at).toLocaleString()}`
                : "No backup has reported yet."}
            </p>
            <p className="text-sm">
              They're made outside this server: {s.elsewhere.where}.{s.elsewhere.detail ? ` ${s.elsewhere.detail}` : ""}
            </p>
          </div>
        )}

        {s && !s.enabled && !s.elsewhere && (
          <div className="alert alert-soft alert-warning flex-col items-start gap-2">
            <p className="font-medium">Backups are off.</p>
            <p className="text-sm">
              Set <code>BACKUP_DIR</code> in Ferret's <code>.env</code> to a folder on another machine — e.g. an NFS share on the NAS,
              mounted into the container — and restart Ferret. Keep <code>FILES_KEY</code> in your password manager: a backup can't be
              opened without it.
            </p>
          </div>
        )}

        {s?.enabled && (
          <>
            <LastRun last={s.last} lastOk={s.lastOk} asked={asked} />
            <Snapshots data={snapshots.data?.data} loading={snapshots.isPending} error={snapshots.error?.message} />
            <Restoring />
          </>
        )}
      </div>
    </section>
  );
}

function LastRun({ last, lastOk, asked }: { last: BackupRun | null; lastOk: BackupRun | null; asked: boolean }) {
  if (!last) {
    return <p className="text-sm text-base-content/70">{asked ? "Starting…" : "No backup yet — the first runs tonight, or now if you ask."}</p>;
  }
  return (
    <div className="space-y-3">
      {last.status === "failed" && (
        <div className="alert alert-soft alert-error flex-col items-start gap-1" role="alert">
          <p className="font-medium">The last backup failed ({formatTime(last.startedAt)})</p>
          <p className="text-sm break-words">{last.error}</p>
          <p className="text-sm">{lastOk ? `The last one that worked: ${formatTime(lastOk.startedAt)}.` : "None has worked yet."}</p>
        </div>
      )}
      {lastOk && (
        <div className="flex items-start gap-3">
          <span className="icon-[tabler--circle-check] mt-0.5 size-5 shrink-0 text-success" />
          <div className="min-w-0 space-y-0.5">
            <p className="font-medium">Last backup {formatTime(lastOk.startedAt)}</p>
            <p className="text-sm text-base-content/70">
              {lastOk.files} {lastOk.files === 1 ? "file" : "files"} ({formatBytes(lastOk.filesBytes ?? 0)}
              {lastOk.filesCopied ? `, ${lastOk.filesCopied} new` : ""}) and the database ({formatBytes(lastOk.dbBytes ?? 0)})
            </p>
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
      <h3 className="font-medium">Copies kept</h3>
      {loading && <span className="loading loading-spinner text-primary" />}
      {error && <div className="alert alert-soft alert-error">{error}</div>}
      {data && data.length === 0 && <p className="text-sm text-base-content/70">None yet.</p>}
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
          {snap.items} {snap.items === 1 ? "item" : "items"}, {snap.files} {snap.files === 1 ? "file" : "files"} ({formatBytes(snap.filesBytes)})
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
        Check
      </button>
    </li>
  );
}

/** Restoring replaces every household's data, so it's done on the server itself, with Ferret stopped. */
function Restoring() {
  return (
    <details className="rounded-box border border-base-content/15 p-3">
      <summary className="tap cursor-pointer font-medium">How to restore</summary>
      <div className="mt-3 space-y-3 text-sm text-base-content/80">
        <p>
          On the server, in Ferret's folder (where <code>compose.yaml</code> is), with the same <code>.env</code> — its{" "}
          <code>FILES_KEY</code> opens the backup:
        </p>
        <ol className="list-decimal space-y-3 ps-5">
          <li>
            Rebuild a data folder from the newest copy (or name one from the list above at the end):
            <CopyField label="Restore command" value={restoreCommand} icon="icon-[tabler--terminal-2]" />
          </li>
          <li>
            Stop Ferret (<code>docker compose stop ferret</code>), move its data folder aside (the one mounted at <code>/data</code>,{" "}
            <code>FERRET_DATA</code>), put <code>restored</code> in its place, and start it again (<code>docker compose up -d ferret</code>).
          </li>
        </ol>
        <p>Search indexes rebuild themselves on start.</p>
      </div>
    </details>
  );
}

// The folder is made first, so it belongs to you (and the container's user), not root.
const restoreCommand = "mkdir restored && docker compose run --rm -v ./restored:/restore ferret node dist/cli.js backup restore /restore";

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
            Server admin
            <HelpLink page="hosting/server-admin.html" label="Server admin" />
          </h2>
          <p className="text-sm text-base-content/70">
            You{admin.data ? ` (${admin.data.email})` : ""} look after this server: its backups, and their alerts in the bell. It's one
            person at a time — you can hand it to someone else with an account here.
          </p>
        </div>
        <form className="flex flex-wrap items-end gap-2" onSubmit={onSubmit}>
          <div className="min-w-0 grow">
            <label className="label-text" htmlFor="new-admin">
              Hand over to
            </label>
            <div className="input">
              <span className="icon-[tabler--mail] my-auto me-3 size-5 shrink-0 text-base-content/80" />
              <input id="new-admin" type="email" className="grow" placeholder="their account's email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </div>
          </div>
          <button type="submit" className="btn btn-soft btn-primary">
            Hand over…
          </button>
        </form>
        <p className="text-sm text-base-content/70">
          It also works from the server: <code>docker compose exec ferret node dist/cli.js admin their@email</code>
        </p>
      </div>

      {confirming && (
        <Modal id="hand-over" onClose={() => setConfirming(false)}>
          <div className="flex flex-col gap-5">
            <div className="space-y-1 text-center">
              <h3 id="hand-over-title" className="text-xl font-semibold">
                Make {email.trim()} the server admin?
              </h3>
              <p className="text-base-content/80">You'll stop seeing this tab and backup alerts. Only they (or the command on the server) can give it back.</p>
            </div>
            {handOver.isError && <div className="alert alert-soft alert-error">{handOver.error.message}</div>}
            <div className="flex flex-wrap justify-end gap-3">
              <button type="button" className="btn btn-secondary btn-soft" onClick={() => setConfirming(false)}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary" onClick={() => handOver.mutate()} disabled={handOver.isPending}>
                {handOver.isPending && <span className="loading loading-spinner loading-sm" />}
                Hand over
              </button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}

const formatTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });

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
