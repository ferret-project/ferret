/**
 * Settings → Server: what belongs to the whole server rather than one household, for its admin only — the nightly
 * backups (status, "Back up now", the copies kept, each one's restore check, how to restore), the server check, recall checks (on or off),
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
import { t, ph, plural, msg } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { MessageDescriptor } from "@lingui/core";
import { copyText } from "./lib/secure-context";

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
      <ServerCheck />
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
      <p className="font-medium"><Trans>Set Ferret's address (PUBLIC_URL)</Trans></p>
      <p className="text-sm">
        <Trans>It isn't set, so signing in works from the local address Ferret is opened at (an IP address or a name like
        umbrel.local, not a domain name) — but links it sends (invitations, password
        resets, share links, calendar feeds) point to <code className="break-all">{ph({ publicUrl: address.data.publicUrl })}</code>, and passkeys and
        single sign-on won't work. Set <code>PUBLIC_URL</code> in Ferret's settings — probably to <code className="break-all">{here}</code>{" "}
        — and restart it.</Trans>
      </p>
      <HelpLink page="hosting/configuration.html" label={t`Settings`} />
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
    return m < 1 ? t`just now` : m < 60 ? t`${m} min ago` : m < 48 * 60 ? t`${ph({ hours: Math.round(m / 60) })} h ago` : new Date(iso).toLocaleDateString();
  };
  return (
    <section className="card" aria-labelledby="service-errors-title">
      <div className="card-body gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="service-errors-title" className="card-title flex items-center gap-2">
            <span className="icon-[tabler--plug-connected-x] size-5 text-primary" />
            <Trans>Service errors</Trans>
          </h2>
          {rows.length > 0 && (
            <button type="button" className="btn btn-text btn-sm" disabled={clear.isPending} onClick={() => clear.mutate(undefined)}>
              <Trans>Clear all</Trans>
            </button>
          )}
        </div>
        <p className="text-sm text-base-content/70">
          <Trans>When a call to a service Ferret uses fails — the AI models, the vector store, the document reader, Apprise, push, the
          barcode and recall databases, maps — it's listed here, and you're told (push, your other apps, email) when one starts
          failing, at most every 6 hours each. Ferret carries on without them where it can.</Trans>
        </p>
        {!rows.length ? (
          <p className="flex items-center gap-2 text-sm text-success">
            <span className="icon-[tabler--circle-check] size-5" />
            <Trans>No errors.</Trans>
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
                    {plural(e.count, { one: "# time", other: "# times" })} <Trans>· last {ph({ when: ago(e.lastAt) })}</Trans>
                    {e.count > 1 ? t` · first ${ph({ when: ago(e.firstAt) })}` : ""}
                  </p>
                  <CopyDetails text={e.triage} />
                </div>
                <button type="button" className="btn btn-text btn-sm btn-square" aria-label={t`Clear this ${ph({ serviceName: e.serviceName })} error`} onClick={() => clear.mutate(e.id)}>
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
    await copyText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }
  return (
    <button type="button" className="btn btn-text btn-xs tap mt-1 -ms-2" onClick={copy}>
      <span className={`${copied ? "icon-[tabler--copy-check] text-success" : "icon-[tabler--copy]"} size-4`} />
      {copied ? t`Copied` : t`Copy details`}
    </button>
  );
}

/** The online barcode database (BARCODE_LOOKUP) and what's left of its daily allowance, as it said at the last lookup. */
/** What each kind of finding means, in the reader's language (the server's own sentence is the fallback). */
const CHECK_WORDS: Record<string, MessageDescriptor> = {
  "files.missing": msg`Files the database lists that aren't in the file store — their photos or documents can't be opened.`,
  "thumbnails.missing": msg`Small pictures (thumbnails) missing from the file store — those things show no picture in lists.`,
  "files.unreadable": msg`Files that won't decrypt with their household's key (from a sample) — damaged, or written with another FILES_KEY.`,
  "files.partial": msg`Only part of the files were looked for — run it again later for the rest.`,
  "items.room": msg`Things in a room that's been deleted or belongs to another household — they don't show under any room.`,
  "items.box": msg`Things in a box that's been deleted or belongs to another household.`,
  "items.category": msg`Things whose category was deleted — they count as having none.`,
  "locations.parent": msg`Places inside a place that's been deleted — they can't be reached in Places.`,
  "attachments.item": msg`Photos or documents whose thing is missing or in another household.`,
  "items.household": msg`Things belonging to a household that no longer exists.`,
  "households.members": msg`Households nobody is a member of — nobody can open them.`,
  "jobs.failed": msg`Background jobs that gave up after their last try in the last week (the service error log says why).`,
  "jobs.stuck": msg`Background jobs still running whose turn came over an hour ago — a slow model, or a restart mid-job.`,
  "imports.ai": msg`Imports sorted with AI that never finished.`,
  "downloads.stuck": msg`Downloads from a web address still waiting after a day.`,
  "roomscans.stuck": msg`Room scans that never finished.`,
};

/** Server check: on demand, read-only — files, rows pointing at nothing, unfinished work, backups. */
function ServerCheck() {
  const check = useMutation({ mutationFn: api.serverCheck });
  const r = check.data;
  const problems = r?.findings.filter((f) => f.level === "problem").length ?? 0;
  return (
    <section className="card" aria-labelledby="server-check-title">
      <div className="card-body gap-3">
        <h2 id="server-check-title" className="card-title flex items-center gap-2">
          <span className="icon-[tabler--stethoscope] size-5 text-primary" />
          <Trans>Server check</Trans>
        </h2>
        <p className="text-sm text-base-content/70">
          <Trans>Looks over the running server: every file the database expects is in the store (and a few decrypt), nothing points at something deleted, no work was left unfinished, and backups are recent. It changes nothing.</Trans>
        </p>
        <div>
          <button type="button" className="btn btn-soft btn-primary btn-wrap" disabled={check.isPending} onClick={() => check.mutate()}>
            {check.isPending ? <span className="loading loading-spinner loading-sm" /> : <span className="icon-[tabler--player-play] size-5" />}
            {r ? t`Check again` : t`Check now`}
          </button>
        </div>
        {check.isError && <div className="alert alert-soft alert-error">{check.error.message}</div>}
        {r && (
          <>
            <p className="text-sm text-base-content/70">
              {t`Looked for ${ph({ checked: r.files.checked.toLocaleString() })} of ${ph({ total: r.files.total.toLocaleString() })} files and decrypted ${ph({ decrypted: r.files.decrypted })} · ${ph({ seconds: (r.ms / 1000).toFixed(1) })} s`}
            </p>
            {r.findings.length === 0 ? (
              <div className="alert alert-soft alert-success flex items-center gap-2">
                <span className="icon-[tabler--circle-check] size-5" />
                <Trans>Everything looks right.</Trans>
              </div>
            ) : (
              <ul className="flex flex-col gap-2">
                {r.findings.map((f) => (
                  <li key={f.kind} className={`rounded-box border p-3 ${f.level === "problem" ? "border-error/40 bg-error/5" : "border-base-content/15"}`}>
                    <p className="flex items-start gap-2">
                      <span className={`mt-0.5 size-5 shrink-0 ${f.level === "problem" ? "icon-[tabler--alert-triangle] text-error" : "icon-[tabler--info-circle] text-base-content/70"}`} />
                      <span className="min-w-0 flex-1">
                        {CHECK_WORDS[f.kind] ? t(CHECK_WORDS[f.kind]!) : f.text}
                        {f.count > 1 && <span className="badge badge-soft badge-sm ms-2">{f.count.toLocaleString()}</span>}
                      </span>
                    </p>
                    {f.examples.length > 0 && (
                      <ul className="ms-7 mt-1 list-disc ps-4 text-sm text-base-content/70">
                        {f.examples.map((e, i) => (
                          <li key={i} className="break-words">{e}</li>
                        ))}
                        {f.count > f.examples.length && <li className="list-none">{t`and ${ph({ more: (f.count - f.examples.length).toLocaleString() })} more`}</li>}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {problems > 0 && (
              <p className="text-sm text-base-content/70">
                <Trans>The help's Server check page says what to do about each.</Trans> <HelpLink page="hosting/server-check.html" label={t`Server check`} />
              </p>
            )}
          </>
        )}
      </div>
    </section>
  );
}

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
    return days === 0 ? t`at ${ph({ time: time(iso) })}` : days === 1 ? t`tomorrow at ${ph({ time: time(iso) })}` : t`${ph({ day: d.toLocaleDateString(undefined, { weekday: "long" }) })} at ${ph({ time: time(iso) })}`;
  };
  return (
    <section className="card" aria-labelledby="barcode-lookups-title">
      <div className="card-body gap-3">
        <h2 id="barcode-lookups-title" className="card-title flex items-center gap-2">
          <span className="icon-[tabler--barcode] size-5 text-primary" />
          <Trans>Online barcode lookups</Trans>
        </h2>
        <p className="text-sm text-base-content/70">
          <Trans>Barcodes nobody here has saved yet are asked of the online product database, each once for the whole server. It allows so many a
          day; when they're used up, scans still match the barcode books and the rest are asked later.</Trans>
        </p>
        {q ? (
          <>
            <div className="flex flex-wrap items-baseline justify-between gap-x-3">
              <Trans><span className="font-medium">
                {ph({ left: q.remaining.toLocaleString() })} of {ph({ limit: q.limit.toLocaleString() })} left
              </span>
              <span className="text-sm text-base-content/70">
                fills up again {ph({ when: when(q.resetsAt) })} · as of {ph({ time: time(q.checkedAt) })}
              </span></Trans>
            </div>
            <progress className={`progress ${tone}`} value={Math.round(share * 100)} max={100} aria-label={t`${ph({ remaining: q.remaining })} of ${ph({ limit: q.limit })} barcode lookups left`} />
          </>
        ) : (
          <p className="text-sm text-base-content/70"><Trans>Nothing asked yet — the allowance shows after the first lookup.</Trans></p>
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
          <Trans>Recall checks</Trans>
          <HelpLink page="guide/recalls.html" label={t`Recall checks`} />
        </h2>
        <p className="text-sm text-base-content/70">
          <Trans>Checks everyone's things against the US Consumer Product Safety Commission's recalls, daily, and says when one matches — on the
          thing's page and in the bell. To do that, the brands people own are sent to the CPSC (saferproducts.gov), each at most once a week;
          nothing else is.</Trans>
        </p>
        <label className="flex cursor-pointer items-center gap-3">
          <input type="checkbox" className="switch switch-primary" checked={s.enabled} disabled={toggle.isPending || !s.available} onChange={(e) => toggle.mutate(e.target.checked)} />
          <span>{s.enabled ? t`On` : t`Off`}</span>
        </label>
        {s.enabled && (
          <p className="text-sm text-base-content/70">
            {plural(s.brands, { one: "# brand checked", other: "# brands checked" })}, {plural(s.recalls, { one: "# recall kept", other: "# recalls kept" })}
            {s.lastCheckedAt ? t` · last asked ${ph({ when: new Date(s.lastCheckedAt).toLocaleString() })}` : t` · checking now`}.
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
              <Trans>Backups</Trans>
              <HelpLink page="hosting/backups.html" label={t`Backups`} />
            </h2>
            <p className="text-sm text-base-content/70">
              {s?.enabled
                ? t`Every night from ${ph({ hour: s.hour })}:00, the database and every household's files are copied to ${ph({ where: s.where ?? "" })}, then opened again to check they'd restore. The newest ${ph({ keep: s.keep })} are kept.`
                : s?.elsewhere
                  ? t`The database and every household's files, copied each night off this server.`
                  : t`The database and every household's files, copied each night to a folder off this machine and checked.`}
            </p>
          </div>
          {s?.enabled && (
            <button type="button" className="btn btn-primary" onClick={() => now.mutate()} disabled={now.isPending || running}>
              {(now.isPending || running) && <span className="loading loading-spinner loading-sm" />}
              {running ? t`Backing up…` : t`Back up now`}
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
                ? s.elsewhere.ok ? t`Last backup: ${ph({ when: new Date(s.elsewhere.at).toLocaleString() })}` : t`Last backup failed: ${ph({ when: new Date(s.elsewhere.at).toLocaleString() })}`
                : t`No backup has reported yet.`}
            </p>
            <p className="text-sm">
              <Trans>They're made outside this server: {ph({ where: s.elsewhere.where })}</Trans>.{s.elsewhere.detail ? ` ${s.elsewhere.detail}` : ""}
            </p>
          </div>
        )}

        {s && !s.enabled && !s.elsewhere && (
          <div className="alert alert-soft alert-warning flex-col items-start gap-2">
            <p className="font-medium"><Trans>Backups are off.</Trans></p>
            <p className="text-sm">
              <Trans>Set <code>BACKUP_DIR</code> in Ferret's <code>.env</code> to a folder on another machine — e.g. an NFS share on the NAS,
              mounted into the container — and restart Ferret. Keep <code>FILES_KEY</code> in your password manager: a backup can't be
              opened without it.</Trans>
            </p>
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
    return <p className="text-sm text-base-content/70">{asked ? t`Starting…` : t`No backup yet — the first runs tonight, or now if you ask.`}</p>;
  }
  return (
    <div className="space-y-3">
      {last.status === "failed" && (
        <div className="alert alert-soft alert-error flex-col items-start gap-1" role="alert">
          <p className="font-medium"><Trans>The last backup failed ({ph({ formatTime: formatTime(last.startedAt) })}</Trans>)</p>
          <p className="text-sm break-words">{last.error}</p>
          <p className="text-sm">{lastOk ? t`The last one that worked: ${ph({ formatTime: formatTime(lastOk.startedAt) })}.` : t`None has worked yet.`}</p>
        </div>
      )}
      {lastOk && (
        <div className="flex items-start gap-3">
          <span className="icon-[tabler--circle-check] mt-0.5 size-5 shrink-0 text-success" />
          <div className="min-w-0 space-y-0.5">
            <p className="font-medium"><Trans>Last backup {ph({ when: formatTime(lastOk.startedAt) })}</Trans></p>
            <p className="text-sm text-base-content/70">
              {lastOk.filesCopied
                ? t`${ph({ files: plural(lastOk.files ?? 0, { one: "# file", other: "# files" }) })} (${ph({ size: formatBytes(lastOk.filesBytes ?? 0) })}, ${ph({ copied: lastOk.filesCopied })} new) and the database (${ph({ dbSize: formatBytes(lastOk.dbBytes ?? 0) })})`
                : t`${ph({ files: plural(lastOk.files ?? 0, { one: "# file", other: "# files" }) })} (${ph({ size: formatBytes(lastOk.filesBytes ?? 0) })}) and the database (${ph({ dbSize: formatBytes(lastOk.dbBytes ?? 0) })})`}
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
      <h3 className="font-medium"><Trans>Copies kept</Trans></h3>
      {loading && <span className="loading loading-spinner text-primary" />}
      {error && <div className="alert alert-soft alert-error">{error}</div>}
      {data && data.length === 0 && <p className="text-sm text-base-content/70"><Trans>None yet.</Trans></p>}
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
          {plural(snap.items, { one: "# item", other: "# items" })}, {plural(snap.files, { one: "# file", other: "# files" })} ({formatBytes(snap.filesBytes)})
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
        <Trans>Check</Trans>
      </button>
    </li>
  );
}

/** Restoring replaces every household's data, so it's done on the server itself, with Ferret stopped. */
/** What each secret is for, and what losing it costs — Settings → Server's Keys, and the help's table. */
const SECRET_ROLES: Record<ServerSecrets["secrets"][number]["name"], { what: MessageDescriptor; lost: MessageDescriptor }> = {
  FILES_KEY: { what: msg`Seals every photo, document and pairing code, and the backups.`, lost: msg`Lost for good without a copy: nothing uploaded can be opened.` },
  AUTH_SECRET: { what: msg`Signs sign-ins, and seals two-step sign-in.`, lost: msg`Can be replaced: everyone signs in again, and two-step sign-in is set up again.` },
  VAPID_PUBLIC_KEY: { what: msg`Push notifications: the key browsers subscribe with.`, lost: msg`Remade by Ferret: each device turns push on again.` },
  VAPID_PRIVATE_KEY: { what: msg`Push notifications: signs what Ferret sends.`, lost: msg`Remade by Ferret: each device turns push on again.` },
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
      <h3 className="font-medium"><Trans>Keys</Trans></h3>
      <p className="text-sm text-base-content/70">
        {secrets.data?.file ? (
          <Trans>
            The secrets Ferret needs. Any set in Ferret's settings are used; the rest Ferret made itself and keeps in{" "}
            <code className="break-all">{ph({ file: secrets.data.file })}</code> — never in its backups.
          </Trans>
        ) : (
          <Trans>The secrets Ferret needs. Any set in Ferret's settings are used; the rest Ferret made itself and keeps in its data folder — never in its backups.</Trans>
        )}{" "}
        <Trans>
        <code>FILES_KEY</code>'s fingerprint is <code className="font-mono">{keyId}</code> (<code>cli.js key fingerprint</code> prints a
        key's, to check a saved copy).</Trans>
      </p>
      {secrets.isError && <div className="alert alert-soft alert-error">{secrets.error.message}</div>}
      {list.length > 0 && (
        <ul className="divide-y divide-base-content/10 rounded-box border border-base-content/15">
          {list.map((x) => (
            <li key={x.name} className="flex flex-wrap items-start justify-between gap-2 p-3">
              <div className="min-w-0 space-y-0.5">
                <p className="font-mono text-sm">{x.name}</p>
                <p className="text-sm text-base-content/70">{t(SECRET_ROLES[x.name].what)}</p>
                <p className="text-sm text-base-content/70"><Trans>If lost: {ph({ lost: t(SECRET_ROLES[x.name].lost) })}</Trans></p>
              </div>
              <span className={`badge badge-soft ${x.source === "none" ? "" : x.source === "ferret" ? "badge-info" : "badge-success"}`}>
                {x.source === "settings" ? t`From the settings` : x.source === "ferret" ? t`Made by Ferret` : t`Not set`}
              </span>
            </li>
          ))}
        </ul>
      )}
      {secrets.data?.pushPublicKey && (
        <CopyField label={t`Push public key (public — for tools that send to Ferret's subscribers)`} value={secrets.data.pushPublicKey} icon="icon-[tabler--bell]" />
      )}
      {filesKeyByFerret && !keyFile?.current && (
        <div className="alert alert-soft alert-warning text-sm">
          <Trans>FILES_KEY is only in this server's data folder. If that folder is lost, so is every photo and document — the backups too.
          Make a key file and keep it, and its passphrase, somewhere else.</Trans>
        </div>
      )}
      {keyFile?.current && (
        <p className="flex items-start gap-2 text-sm">
          <span className="icon-[tabler--circle-check] mt-0.5 size-4 shrink-0 text-success" />
          <span>
            <Trans>Key file made {ph({ formatTime: formatTime(keyFile.at) })}, in</Trans> <code className="break-all">{keyFile.where}</code>.
          </span>
        </p>
      )}
      {keyFile && !keyFile.current && (
        <div className="alert alert-soft alert-warning text-sm">
          <Trans>The newest key file ({ph({ formatTime: formatTime(keyFile.at) })}) holds another FILES_KEY ({ph({ keyId: keyFile.keyId })}), not the one in use. Make a new one.</Trans>
        </div>
      )}
      {!keyFile && commandLine && !filesKeyByFerret && <p className="text-sm text-base-content/70"><Trans>No key file made yet.</Trans></p>}
      {commandLine && (
        <details className="rounded-box border border-base-content/15 p-3" open={filesKeyByFerret && !keyFile?.current}>
          <summary className="tap cursor-pointer font-medium"><Trans>Make a key file</Trans></summary>
          <div className="mt-3 space-y-3 text-sm text-base-content/80">
            <p>
              <Trans>A key file holds these secrets sealed with a passphrase you choose, so it can be kept beside the backups. If they're ever
              lost, <code>cli.js key recover</code> opens the file with the passphrase and gives them back. On the server, in Ferret's
              folder (or the container's console):</Trans>
            </p>
            <CopyField label={t`Key file command`} value={keyExportCommand(folder)} icon="icon-[tabler--terminal-2]" />
            <p>
              <Trans>Use a long passphrase — a few unrelated words — and keep it in your password manager: anyone with the file can try
              passphrases. Then copy the file off this server.</Trans>
              {keptByFerret ? t` Make a new one if Ferret ever makes new keys (it says so in its log).` : ""}
            </p>
          </div>
        </details>
      )}
    </div>
  );
}

const keyExportCommand = (folder: string | null) => `docker compose exec -it ferret node dist/cli.js key export ${folder ?? "/data"}`;

function Restoring() {
  return (
    <details className="rounded-box border border-base-content/15 p-3">
      <summary className="tap cursor-pointer font-medium"><Trans>How to restore</Trans></summary>
      <div className="mt-3 space-y-3 text-sm text-base-content/80">
        <p>
          <Trans>On the server, in Ferret's folder (where <code>compose.yaml</code> is), with the same <code>.env</code> — its{" "}
          <code>FILES_KEY</code> opens the backup (lost it? <code>cli.js key recover</code> gets it back from a key file):</Trans>
        </p>
        <ol className="list-decimal space-y-3 ps-5">
          <li>
            <Trans>Rebuild a data folder from the newest copy (or name one from the list above at the end):</Trans>
            <CopyField label={t`Restore command`} value={restoreCommand} icon="icon-[tabler--terminal-2]" />
          </li>
          <li>
            <Trans>Stop Ferret (<code>docker compose stop ferret</code>), move its data folder aside (the one mounted at <code>/data</code>,{" "}
            <code>FERRET_DATA</code>), put <code>restored</code> in its place, and start it again (<code>docker compose up -d ferret</code></Trans>).
          </li>
        </ol>
        <p><Trans>Search indexes rebuild themselves on start.</Trans></p>
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
            <Trans>Certificates</Trans>
            <HelpLink page="hosting/certificates.html" label={t`Certificates`} />
          </h2>
          <p className="text-sm text-base-content/70">
            <Trans>For Ferret's own connections to your other services — Home Assistant, the AI models, Apprise, your sign-in provider. Downloads from the internet
            only ever trust the usual authorities.</Trans>
          </p>
        </div>

        <div className="space-y-2">
          <h3 className="font-medium"><Trans>Trusted</Trans></h3>
          <p className="text-sm text-base-content/70"><Trans>Your own certificate authority, or a service's self-signed certificate.</Trans></p>
          <CertificateList list={d.trusted} empty={t`Only the usual authorities.`} onRemove={setRemoving} />
          <button type="button" className="btn btn-soft btn-primary btn-sm" onClick={() => setAdding("trusted")}>
            <span className="icon-[tabler--plus] size-4" />
            <Trans>Trust a certificate…</Trans>
          </button>
        </div>

        <div className="space-y-2">
          <h3 className="font-medium"><Trans>Client certificates</Trans></h3>
          <p className="text-sm text-base-content/70"><Trans>For services that ask who's connecting (mutual TLS). Each is shown only to the hosts you name.</Trans></p>
          <CertificateList list={d.clients} empty={t`None.`} onRemove={setRemoving} />
          <button type="button" className="btn btn-soft btn-primary btn-sm" onClick={() => setAdding("client")}>
            <span className="icon-[tabler--plus] size-4" />
            <Trans>Add a client certificate…</Trans>
          </button>
        </div>
      </div>

      {adding === "trusted" && <TrustDialog onClose={() => setAdding(null)} />}
      {adding === "client" && <ClientCertificateDialog onClose={() => setAdding(null)} />}
      {removing && (
        <Modal id="remove-certificate" onClose={() => setRemoving(null)}>
          <div className="flex flex-col gap-5">
            <div className="space-y-1 text-center">
              <h3 id="remove-certificate-title" className="text-xl font-semibold">
                <Trans>Remove “{ph({ name: removing.name })}</Trans>”?
              </h3>
              <p className="text-base-content/80">
                {removing.hosts
                  ? t`Ferret stops presenting it to ${ph({ join: removing.hosts.join(", ") })}.`
                  : t`Ferret stops trusting it: services whose certificate it vouches for won't connect.`}
              </p>
            </div>
            {remove.isError && <div className="alert alert-soft alert-error">{remove.error.message}</div>}
            <div className="flex flex-wrap justify-end gap-3">
              <button type="button" className="btn btn-secondary btn-soft" onClick={() => setRemoving(null)}>
                <Trans>Cancel</Trans>
              </button>
              <button type="button" className="btn btn-error" onClick={() => remove.mutate(removing.id)} disabled={remove.isPending}>
                {remove.isPending && <span className="loading loading-spinner loading-sm" />}
                <Trans>Remove</Trans>
              </button>
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
                {c.issuer !== c.subject && t` · from ${ph({ issuer: c.issuer })}`}
              </div>
              {c.hosts && <div className="text-sm break-words text-base-content/70"><Trans>For {ph({ join: c.hosts.join(", ") })}</Trans></div>}
              <div className="flex flex-wrap items-center gap-2 text-sm">
                {ends <= Date.now() ? (
                  <span className="badge badge-soft badge-error"><Trans>Expired {ph({ formatDate: formatDate(c.notAfter) })}</Trans></span>
                ) : ends < soon ? (
                  <span className="badge badge-soft badge-warning"><Trans>Expires {ph({ formatDate: formatDate(c.notAfter) })}</Trans></span>
                ) : (
                  <span className="text-base-content/70"><Trans>Until {ph({ formatDate: formatDate(c.notAfter) })}</Trans></span>
                )}
              </div>
            </div>
            <button type="button" className="btn btn-text btn-sm" onClick={() => onRemove(c)}>
              <Trans>Remove…</Trans>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

const formatDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

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
    <Modal id="trust-certificate" title={t`Trust a certificate`} onClose={onClose}>
      <form className="flex flex-col gap-4" onSubmit={onSubmit}>
        <p className="text-sm text-base-content/70">
          <Trans>A certificate authority's certificate, or a service's own self-signed one, in PEM form (<code>-----BEGIN CERTIFICATE-----</code>). Never its private key.</Trans>
        </p>
        <div>
          <label className="label-text" htmlFor="trust-name">
            <Trans>Name</Trans>
          </label>
          <input id="trust-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={t`e.g. Home CA`} maxLength={80} />
        </div>
        <div>
          <label className="label-text" htmlFor="trust-file">
            <Trans>File (.pem, .crt)</Trans>
          </label>
          <input id="trust-file" type="file" className="input" accept=".pem,.crt,.cer,application/x-pem-file,application/x-x509-ca-cert" onChange={(e) => void pick(e.target.files?.[0])} />
        </div>
        <div>
          <label className="label-text" htmlFor="trust-pem">
            <Trans>Or paste it</Trans>
          </label>
          <textarea id="trust-pem" className="textarea font-mono text-xs" rows={6} value={pem} onChange={(e) => setPem(e.target.value)} required spellCheck={false} />
        </div>
        {add.isError && <div className="alert alert-soft alert-error">{add.error.message}</div>}
        <DialogActions>
          <button type="button" className="btn btn-secondary btn-soft" onClick={onClose}>
            <Trans>Cancel</Trans>
          </button>
          <button type="submit" className="btn btn-primary" disabled={add.isPending || !pem.trim()}>
            {add.isPending && <span className="loading loading-spinner loading-sm" />}
            <Trans>Trust it</Trans>
          </button>
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
      if (!file) throw new Error(t`Choose the certificate's file`);
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
    <Modal id="client-certificate" title={t`Add a client certificate`} onClose={onClose}>
      <form className="flex flex-col gap-4" onSubmit={onSubmit}>
        <p className="text-sm text-base-content/70">
          <Trans>A PKCS#12 file (.p12 or .pfx) holding the certificate and its key. It's kept sealed on the server and never shown again.</Trans>
        </p>
        <div>
          <label className="label-text" htmlFor="client-name">
            <Trans>Name</Trans>
          </label>
          <input id="client-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={t`e.g. Ferret for Home Assistant`} maxLength={80} />
        </div>
        <div>
          <label className="label-text" htmlFor="client-file">
            <Trans>File (.p12, .pfx)</Trans>
          </label>
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
            <Trans>Its password</Trans>
          </label>
          <input id="client-password" type="password" className="input" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <div>
          <label className="label-text" htmlFor="client-hosts">
            <Trans>Show it to</Trans>
          </label>
          <textarea
            id="client-hosts"
            className="textarea"
            rows={2}
            value={hosts}
            onChange={(e) => setHosts(e.target.value)}
            placeholder={t`ha.example.lan, *.example.lan`}
            required
            spellCheck={false}
            autoCapitalize="none"
          />
          <p className="mt-1 text-sm text-base-content/70"><Trans>Host names or addresses, separated by commas. <code>*.example.lan</code> covers everything under it.</Trans></p>
        </div>
        {add.isError && <div className="alert alert-soft alert-error">{add.error.message}</div>}
        <DialogActions>
          <button type="button" className="btn btn-secondary btn-soft" onClick={onClose}>
            <Trans>Cancel</Trans>
          </button>
          <button type="submit" className="btn btn-primary" disabled={add.isPending}>
            {add.isPending && <span className="loading loading-spinner loading-sm" />}
            <Trans>Add it</Trans>
          </button>
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
            <Trans>Server admin</Trans>
            <HelpLink page="hosting/server-admin.html" label={t`Server admin`} />
          </h2>
          <p className="text-sm text-base-content/70">
            <Trans>You</Trans>{admin.data ? ` (${admin.data.email})` : ""} <Trans>look after this server: its backups, and their alerts in the bell. It's one
            person at a time — you can hand it to someone else with an account here.</Trans>
          </p>
        </div>
        <form className="flex flex-wrap items-end gap-2" onSubmit={onSubmit}>
          <div className="min-w-0 grow">
            <label className="label-text" htmlFor="new-admin">
              <Trans>Hand over to</Trans>
            </label>
            <div className="input">
              <span className="icon-[tabler--mail] my-auto me-3 size-5 shrink-0 text-base-content/80" />
              <input id="new-admin" type="email" className="grow" placeholder={t`their account's email`} value={email} onChange={(e) => setEmail(e.target.value)} required />
            </div>
          </div>
          <button type="submit" className="btn btn-soft btn-primary">
            <Trans>Hand over…</Trans>
          </button>
        </form>
        <p className="text-sm text-base-content/70">
          <Trans>It also works from the server: <code>docker compose exec ferret node dist/cli.js admin their@email</code></Trans>
        </p>
      </div>

      {confirming && (
        <Modal id="hand-over" onClose={() => setConfirming(false)}>
          <div className="flex flex-col gap-5">
            <div className="space-y-1 text-center">
              <h3 id="hand-over-title" className="text-xl font-semibold">
                <Trans>Make {ph({ trim: email.trim() })} the server admin?</Trans>
              </h3>
              <p className="text-base-content/80"><Trans>You'll stop seeing this tab and backup alerts. Only they (or the command on the server) can give it back.</Trans></p>
            </div>
            {handOver.isError && <div className="alert alert-soft alert-error">{handOver.error.message}</div>}
            <div className="flex flex-wrap justify-end gap-3">
              <button type="button" className="btn btn-secondary btn-soft" onClick={() => setConfirming(false)}>
                <Trans>Cancel</Trans>
              </button>
              <button type="button" className="btn btn-primary" onClick={() => handOver.mutate()} disabled={handOver.isPending}>
                {handOver.isPending && <span className="loading loading-spinner loading-sm" />}
                <Trans>Hand over</Trans>
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
