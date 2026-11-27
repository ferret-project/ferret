/**
 * Settings → Server: what belongs to the whole server rather than one household, for its admin only — the nightly
 * backups (status, "Back up now", the copies kept, each one's restore check, how to restore), the server check, recall checks (on or off),
 * certificates for the server's own connections, and handing the admin role to someone else. Restoring is a command on the server, not a button: see restoreCommands below.
 */
import { KeyDetails } from "./SigningKey";
import type { DiskSpaceEntry, BackupRun, BackupSnapshot, BackupStatus, BookLookupStatus, GradingStatus, CollectibleCatalogStatus, CollectibleKind, ServerCertificate, ServerSecrets } from "@ferret/shared";
import { ServerAiFillCard } from "./AiFill";
import { AiPrompts, PROMPT_NAMES } from "./Prompts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DemoSwitches, DemoUsage, HostingUsageCard } from "./Demo";
import { type FormEvent, type ReactNode, useState } from "react";
import { CopyField } from "./CopyField";
import { api } from "./lib/api";
import { SETTINGS_HREF, settingsHref } from "./lib/route";
import { useSearch } from "@tanstack/react-router";
import { DialogActions, Modal } from "./Modal";
import { HelpLink } from "./HelpLink";
import { navigateTo } from "./lib/navigate";
import { t, ph, plural, msg } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { MessageDescriptor } from "@lingui/core";
import { copyText } from "./lib/secure-context";

/** Server's parts (`?part=`): what it's doing first — the bell and the error emails link to it. */
const PARTS = [
  { key: "status", label: msg`Status`, icon: "icon-[tabler--heart-rate-monitor]" },
  { key: "ai", label: msg`AI`, icon: "icon-[tabler--sparkles]" },
  { key: "lookups", label: msg`Lookups`, icon: "icon-[tabler--world-search]" },
  { key: "access", label: msg`Access`, icon: "icon-[tabler--lock]" },
] as const;
type Part = (typeof PARTS)[number]["key"];

/** Cards in two columns on a wide screen, balanced by height (each kept whole); one column on a phone, in order. */
function Columns({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-4 lg:block lg:columns-2 lg:gap-4 lg:[&>*]:mb-4 lg:[&>*]:break-inside-avoid">{children}</div>;
}

/** A group of lookups under its own heading. */
function Group({ title, intro, children }: { title: string; intro: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-lg font-semibold text-base-content">{title}</h2>
        <p className="text-sm text-base-content/70">{intro}</p>
      </div>
      <Columns>{children}</Columns>
    </section>
  );
}

export function Server() {
  // The demo has no backups of its own: it's planted afresh every night.
  const demo = useQuery({ queryKey: ["auth-options"], queryFn: api.authOptions, staleTime: Infinity }).data?.demo;
  const asked = (useSearch({ strict: false }) as { part?: string }).part;
  const part: Part = PARTS.some((p) => p.key === asked) ? (asked as Part) : "status";
  const hrefOf = (key: Part) => (key === "status" ? settingsHref("server") : `${settingsHref("server")}?part=${key}`);
  return (
    <>
      <AddressNotice />
      <nav className="flex flex-wrap gap-2" aria-label={t`Server settings`}>
        {PARTS.map((p) => (
          <a
            key={p.key}
            href={hrefOf(p.key)}
            // Like Settings' own tabs: they replace each other in history.
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
              e.preventDefault();
              navigateTo(hrefOf(p.key), { replace: true });
            }}
            className={`btn btn-sm gap-1.5 rounded-full ${part === p.key ? "btn-primary" : "btn-soft"}`}
            aria-current={part === p.key ? "page" : undefined}
          >
            <span className={`${p.icon} size-4`} />
            {t(p.label)}
          </a>
        ))}
      </nav>
      {part === "status" && (
        <Columns>
          <DemoUsage />
          <HostingUsageCard />
          <DemoSwitches />
          {!demo && <Backups />}
          <ServerCheck />
          <Updates />
          <ServiceErrors />
        </Columns>
      )}
      {part === "ai" && (
        <Columns>
          <SearchIndex />
          <AskLimits />
          <ServerAiFillCard />
          {!demo && <AiPrompts />}
        </Columns>
      )}
      {part === "lookups" && (
        <>
          <Group title={t`Products and prices`} intro={t`What a barcode is, what it's worth, and what it costs to run.`}>
            <BarcodeLookups />
            <OpenFactsLookups />
            <EbayListings />
            <ExchangeRateLookups />
            <EnergyStarLookups />
          </Group>
          <Group title={t`Safety and upkeep`} intro={t`Recalls, vehicles, repair guides and how long things are supported.`}>
            <RecallChecks />
            <VehicleLookups />
            <RepairGuideLinks />
            <SupportLookups />
          </Group>
          <Group title={t`Collections`} intro={t`Books, music, cards, coins and other things people collect.`}>
            <BookLookups />
            <MusicLookups />
            <CardLookups />
            <CollectorCatalogs />
            <GradingKeys />
            <BikeIndexLookups />
          </Group>
        </>
      )}
      {part === "access" && (
        <Columns>
          {!demo && <KeysCard />}
          <ServerAdmin />
          {!demo && <Certificates />}
        </Columns>
      )}
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
  "prompts.changed": msg`AI prompts with your own extra instructions (AI prompts, below) — if AI answers look odd, try without them.`,
  "disk.low": msg`A disk Ferret writes to is nearly full — when it fills, uploads, the database and backups stop.`,
};

const HOLDS: Record<DiskSpaceEntry["holds"][number], MessageDescriptor> = { database: msg`Database`, files: msg`Photos and documents`, backups: msg`Backups` };

/** Free space on each disk Ferret writes to (none shown where the server has no disk of its own). */
function DiskSpace() {
  const disks = useQuery({ queryKey: ["server-disk"], queryFn: api.diskSpace, staleTime: 60_000 }).data?.data;
  if (!disks?.length) return null;
  return (
    <ul className="flex flex-col gap-2" aria-label={t`Disk space`}>
      {disks.map((d) => {
        const used = Math.round(((d.totalBytes - d.freeBytes) / Math.max(d.totalBytes, 1)) * 100);
        return (
          <li key={d.holds.join("+")} className="flex flex-col gap-1">
            <span className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
              <span className="font-medium">{d.holds.map((h) => t(HOLDS[h])).join(", ")}</span>
              <span className={d.low ? "font-medium text-error" : "text-base-content/70"}>
                {t`${ph({ free: formatBytes(d.freeBytes) })} free of ${ph({ total: formatBytes(d.totalBytes) })}`}
              </span>
            </span>
            <progress className={`progress h-1.5 ${d.low ? "progress-error" : "progress-primary"}`} value={used} max={100} aria-label={t`${ph({ used })}% used`} />
          </li>
        );
      })}
    </ul>
  );
}

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
        <DiskSpace />
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
                          <li key={i} className="break-words">{f.kind === "prompts.changed" && e in PROMPT_NAMES ? t(PROMPT_NAMES[e as keyof typeof PROMPT_NAMES]) : e}</li>
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

/**
 * Search by meaning's index: which embedding model and store made it, how many things are embedded, and a re-index
 * under way (after EMBED_MODEL or QDRANT_COLLECTION changed — the server notices at start — or Re-index everything).
 */
function SearchIndex() {
  const qc = useQueryClient();
  const [asking, setAsking] = useState(false);
  const status = useQuery({
    queryKey: ["server-search-index"],
    queryFn: api.searchIndexStatus,
    // While things are being embedded, follow along.
    refetchInterval: (q) => (q.state.data && q.state.data.indexed < q.state.data.things ? 5000 : false),
  });
  const rebuild = useMutation({
    mutationFn: api.rebuildSearchIndex,
    onSuccess: (data) => {
      qc.setQueryData(["server-search-index"], data);
      setAsking(false);
    },
  });
  const s = status.data;
  if (!s?.available) return null;
  const where = [s.model, s.store].filter(Boolean).join(" → ");
  const before = s.previous ? [s.previous.model, s.previous.store].filter(Boolean).join(" → ") : "";
  const indexed = s.indexed.toLocaleString();
  const things = s.things.toLocaleString();
  return (
    <section className="card" aria-labelledby="search-index-title">
      <div className="card-body gap-3">
        <h2 id="search-index-title" className="card-title flex items-center gap-2">
          <span className="icon-[tabler--brain] size-5 text-primary" />
          <Trans>Smart search</Trans>
          <HelpLink page="hosting/ai.html#changing-the-embedding-model" label={t`Smart search`} />
        </h2>
        {where && <p className="text-sm break-words">{where}</p>}
        <p className="text-sm text-base-content/70">
          <Trans>{indexed} of {things} things embedded.</Trans>
        </p>
        {s.reindexingSince && (
          <div className="alert alert-soft alert-info flex items-start gap-2">
            <span className="icon-[tabler--refresh] mt-0.5 size-5 shrink-0" />
            <span className="min-w-0 break-words">
              {before ? (
                <Trans>Embedding everything again, because the index was made by {before}. Until it's done, smart search finds only the things already embedded; keyword search works as usual.</Trans>
              ) : (
                <Trans>Embedding everything again. Until it's done, smart search finds only the things already embedded; keyword search works as usual.</Trans>
              )}
            </span>
          </div>
        )}
        <p className="text-sm text-base-content/70">
          <Trans>Ferret embeds everything again by itself when EMBED_MODEL or the vector store changes. Re-index everything is for a change it can't see, like new weights under the same model name.</Trans>
        </p>
        {asking ? (
          <div className="flex flex-col gap-2 rounded-box border border-base-content/15 p-3">
            <p className="text-sm">
              <Trans>Clear the index and embed all {things} things again? Until it's done, smart search finds only the things already embedded.</Trans>
            </p>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn btn-primary btn-wrap" disabled={rebuild.isPending} onClick={() => rebuild.mutate()}>
                {rebuild.isPending && <span className="loading loading-spinner loading-sm" />}
                <Trans>Re-index everything</Trans>
              </button>
              <button type="button" className="btn btn-soft" disabled={rebuild.isPending} onClick={() => setAsking(false)}>
                <Trans>Cancel</Trans>
              </button>
            </div>
          </div>
        ) : (
          <div>
            <button type="button" className="btn btn-soft btn-primary btn-wrap" disabled={!!s.reindexingSince} onClick={() => setAsking(true)}>
              <span className="icon-[tabler--refresh] size-5" />
              <Trans>Re-index everything…</Trans>
            </button>
          </div>
        )}
        {rebuild.isError && <div className="alert alert-soft alert-error">{rebuild.error.message}</div>}
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
        {s.fda != null && (
          <p className="text-sm text-base-content/70">
            <Trans>Also the FDA's food and medicine recalls: this server fetches the last two years' reports once a day (nothing about anyone's things
            is sent) and matches them by barcode, so a can or a bottle of pills you scanned in is flagged if it's recalled.</Trans>
          </p>
        )}
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
        {s.enabled && s.fda != null && <p className="text-sm text-base-content/70">{plural(s.fda, { one: "# FDA food or medicine recall with a barcode kept.", other: "# FDA food and medicine recalls with a barcode kept." })}</p>}
        {toggle.isError && <div className="alert alert-soft alert-error">{toggle.error.message}</div>}
      </div>
    </section>
  );
}

/**
 * New versions of Ferret: off until switched on (GitHub is asked once a day). A newer release goes in the bell, with
 * its notes here. Not offered where Ferret is updated for you (hosted, the demo).
 */
function Updates() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ["server-updates"], queryFn: api.updateStatus });
  const toggle = useMutation({
    mutationFn: api.setUpdates,
    onSuccess: (data) => {
      qc.setQueryData(["server-updates"], data);
      // The check runs in the background: look again shortly for what it found.
      if (data.enabled) setTimeout(() => void qc.invalidateQueries({ queryKey: ["server-updates"] }), 4000);
      void qc.invalidateQueries({ queryKey: ["attention"] });
    },
  });
  const s = status.data;
  if (!s?.available) return null;
  return (
    <section className="card" aria-labelledby="updates-title">
      <div className="card-body gap-3">
        <h2 id="updates-title" className="card-title flex items-center gap-2">
          <span className="icon-[tabler--refresh] size-5 text-primary" />
          <Trans>Updates</Trans>
          <HelpLink page="hosting/server-admin.html#updates" label={t`Updates`} />
        </h2>
        <p className="text-sm text-base-content/70">
          <Trans>This server runs Ferret {ph({ version: s.current })}. Switched on, Ferret asks GitHub once a day for its newest release and tells you in the bell
          when there's a newer one, with what's new. GitHub sees this server's address; nothing else is sent.</Trans>
        </p>
        <label className="flex cursor-pointer items-center gap-3">
          <input type="checkbox" className="switch switch-primary" checked={s.enabled} disabled={toggle.isPending} onChange={(e) => toggle.mutate(e.target.checked)} />
          <span>{s.enabled ? t`On` : t`Off`}</span>
        </label>
        {s.enabled && s.latest && !/^\d{4}\.\d+\.\d+/.test(s.current) && (
          <p className="text-sm text-base-content/70">{t`This is a build between releases, so it can't be compared — the newest release is ${ph({ version: s.latest.version })}.`}</p>
        )}
        {s.enabled && s.latest && !s.newer && /^\d{4}\.\d+\.\d+/.test(s.current) && (
          <p className="flex items-center gap-2 text-sm text-base-content/70">
            <span className="icon-[tabler--circle-check] size-5 text-success" />
            {t`Up to date — ${ph({ version: s.latest.version })} is the newest release.`}
          </p>
        )}
        {s.newer && s.latest && (
          <div className="flex flex-col gap-2 rounded-box border border-primary/30 bg-primary/5 p-3">
            <p className="font-medium">{t`Ferret ${ph({ version: s.latest.version })} is out`}</p>
            {s.latest.notes && <div className="max-h-60 overflow-y-auto whitespace-pre-line break-words text-sm text-base-content/80">{s.latest.notes}</div>}
            <p className="text-sm text-base-content/70">
              <Trans>To update a Docker install: pull the new image and start it again (docker compose pull, then docker compose up -d). Unraid, TrueNAS and the other app stores update it from their own screens.</Trans>
            </p>
            <a className="link tap w-fit text-sm" href={s.latest.url} target="_blank" rel="noreferrer noopener">
              <span className="icon-[tabler--external-link] me-1 size-4 align-[-0.15em]" />
              {t`The release on GitHub`}
            </a>
          </div>
        )}
        {toggle.isError && <div className="alert alert-soft alert-error">{toggle.error.message}</div>}
      </div>
    </section>
  );
}

/** Vehicle look-ups (NHTSA): off until switched on, because they send VINs, and makes, models and years, to NHTSA. */
function VehicleLookups() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ["server-vehicles"], queryFn: api.vehicleLookupStatus });
  const toggle = useMutation({
    mutationFn: api.setVehicleLookups,
    onSuccess: (data) => {
      qc.setQueryData(["server-vehicles"], data);
      void qc.invalidateQueries({ queryKey: ["recalls"] });
    },
  });
  const s = status.data;
  if (!s) return null;
  return (
    <section className="card" aria-labelledby="vehicles-title">
      <div className="card-body gap-3">
        <h2 id="vehicles-title" className="card-title flex items-center gap-2">
          <span className="icon-[tabler--car] size-5 text-primary" />
          <Trans>Vehicle look-ups</Trans>
          <HelpLink page="guide/recalls.html#vehicles" label={t`Vehicle look-ups`} />
        </h2>
        <p className="text-sm text-base-content/70">
          <Trans>Reads a vehicle's VIN — a Vehicles category's VIN field, or a serial number that is one — with the US National Highway
          Traffic Safety Administration's decoder, and offers its make, model and year on the thing's page. Vehicles are also checked
          against NHTSA's recalls, which the product recall checks don't cover. To do that, the VIN and the make, model and year are
          sent to NHTSA (nhtsa.gov); nothing else is.</Trans>
        </p>
        <label className="flex cursor-pointer items-center gap-3">
          <input type="checkbox" className="switch switch-primary" checked={s.enabled} disabled={toggle.isPending || !s.available} onChange={(e) => toggle.mutate(e.target.checked)} />
          <span>{s.enabled ? t`On` : t`Off`}</span>
        </label>
        {s.enabled && (
          <p className="text-sm text-base-content/70">
            {plural(s.vehicles, { one: "# vehicle read", other: "# vehicles read" })}, {plural(s.recalls, { one: "# vehicle recall kept", other: "# vehicle recalls kept" })}.
          </p>
        )}
        {toggle.isError && <div className="alert alert-soft alert-error">{toggle.error.message}</div>}
        {s.enabled && <FuelEconomyLookups />}
      </div>
    </section>
  );
}

/** Fuel economy (fueleconomy.gov), inside Vehicle look-ups: a decoded vehicle's make, model and year are sent to it. */
function FuelEconomyLookups() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ["server-fuel-economy"], queryFn: api.fuelEconomyStatus });
  const toggle = useMutation({ mutationFn: api.setFuelEconomy, onSuccess: (data) => qc.setQueryData(["server-fuel-economy"], data) });
  const s = status.data;
  if (!s?.available) return null;
  return (
    <div className="flex flex-col gap-3 border-t border-base-content/10 pt-3">
      <h3 className="flex items-center gap-2 font-medium">
        <span className="icon-[tabler--gas-station] size-5 text-primary" />
        <Trans>Fuel economy</Trans>
      </h3>
      <p className="text-sm text-base-content/70">
        <Trans>Shows a vehicle's EPA miles per gallon on its page, and what a year's fuel costs, from fueleconomy.gov (free, no key). Someone
        confirms which of its entries the vehicle is — the one with the VIN's engine comes first. A decoded vehicle's make, model and year
        are sent; nothing else is.</Trans>
      </p>
      <label className="flex cursor-pointer items-center gap-3">
        <input type="checkbox" className="switch switch-primary" checked={s.enabled} disabled={toggle.isPending} onChange={(e) => toggle.mutate(e.target.checked)} />
        <span>{s.enabled ? t`On` : t`Off`}</span>
      </label>
      {s.enabled && <p className="text-sm text-base-content/70">{plural(s.vehicles, { one: "# vehicle confirmed", other: "# vehicles confirmed" })}.</p>}
      {s.enabled && s.prices.available && (
        <p className="text-sm text-base-content/70">
          {s.prices.week
            ? t`Fuel is priced at this week's average in the vehicle's state or region (the EIA's, the week of ${ph({ week: s.prices.week })}); an electric car at its state's home electricity rate.`
            : s.prices.hint
              ? t`Fetching this week's fuel prices from the EIA…`
              : t`With an EIA key (in ENERGY STAR look-ups, below), fuel is priced at this week's average in the vehicle's state or region. Without one, the cost is EPA's estimate at US average prices.`}
        </p>
      )}
      {toggle.isError && <div className="alert alert-soft alert-error">{toggle.error.message}</div>}
    </div>
  );
}

/** Context sizes offered: what model servers are commonly started with. */
const CONTEXT_SIZES = [4096, 8192, 16384, 32768, 65536, 131072];
const tokensText = (n: number) => (n % 1024 === 0 ? `${n / 1024}K` : n.toLocaleString());

/**
 * Ask Ferret's limits: the answering model's context size. Ask fits what it reads (and room for the reply) inside it —
 * set too high for the model, long manuals get cut off by the model server or refused; too low, they're read in
 * shorter pieces.
 */
function AskLimits() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ["server-ask"], queryFn: api.askSettings });
  const save = useMutation({ mutationFn: api.setAskSettings, onSuccess: (data) => qc.setQueryData(["server-ask"], data) });
  const s = status.data;
  if (!s) return null;
  const reads = s.readChars.toLocaleString();
  const readsHowTo = s.readCharsHowTo.toLocaleString();
  const sizes = CONTEXT_SIZES.includes(s.contextTokens) ? CONTEXT_SIZES : [...CONTEXT_SIZES, s.contextTokens].sort((a, b) => a - b);
  return (
    <section className="card" aria-labelledby="ask-limits-title">
      <div className="card-body gap-3">
        <h2 id="ask-limits-title" className="card-title flex items-center gap-2">
          <span className="icon-[tabler--sparkles] size-5 text-primary" />
          <Trans>Ask Ferret</Trans>
          <HelpLink page="hosting/ai.html#ask-ferret" label={t`Ask Ferret`} />
        </h2>
        <p className="text-sm text-base-content/70">
          <Trans>How much the answering model can read at once (its context size, in tokens). Set it to the context size its model
          server runs it with (each server has its own setting for it — see the help). Bigger reads more of a long manual for each question, and is slower;
          bigger than the model allows, and answers come back cut off or fail.</Trans>
        </p>
        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium"><Trans>Context size</Trans></span>
          <select
            className="select max-w-xs"
            value={s.isDefault ? "" : String(s.contextTokens)}
            disabled={save.isPending}
            onChange={(e) => save.mutate(e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">{t`Default (${ph({ size: tokensText(s.default) })})`}</option>
            {sizes.map((n) => (
              <option key={n} value={n}>
                {t`${ph({ size: tokensText(n) })} tokens`}
              </option>
            ))}
          </select>
        </label>
        <p className="text-sm text-base-content/70">
          <Trans>
            A question reads up to about {reads} characters of your things and documents — {readsHowTo} for a
            how-to question, which leaves more room for the steps.
          </Trans>
        </p>
        {save.isError && <div className="alert alert-soft alert-error">{save.error.message}</div>}
      </div>
    </section>
  );
}

/** Repair guide links (iFixit): off until switched on, because they send things' brands and models to iFixit. */
function RepairGuideLinks() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ["server-repair-guides"], queryFn: api.repairGuideStatus });
  const toggle = useMutation({ mutationFn: api.setRepairGuides, onSuccess: (data) => qc.setQueryData(["server-repair-guides"], data) });
  const s = status.data;
  if (!s) return null;
  return (
    <section className="card" aria-labelledby="repair-guides-title">
      <div className="card-body gap-3">
        <h2 id="repair-guides-title" className="card-title flex items-center gap-2">
          <span className="icon-[tabler--tools] size-5 text-primary" />
          <Trans>Repair guides</Trans>
          <HelpLink page="guide/repairs.html#repair-guides" label={t`Repair guides`} />
        </h2>
        <p className="text-sm text-base-content/70">
          <Trans>Links a thing to iFixit's page for its exact model — repair guides, parts and troubleshooting — when its brand and model
          surely match one. To find it, the brand and model are sent to iFixit's search (ifixit.com), each at most once a month; nothing
          else is. Ferret only links to iFixit and never copies its guides.</Trans>
        </p>
        <label className="flex cursor-pointer items-center gap-3">
          <input type="checkbox" className="switch switch-primary" checked={s.enabled} disabled={toggle.isPending || !s.available} onChange={(e) => toggle.mutate(e.target.checked)} />
          <span>{s.enabled ? t`On` : t`Off`}</span>
        </label>
        {s.enabled && (
          <p className="text-sm text-base-content/70">
            {plural(s.asked, { one: "# model asked about", other: "# models asked about" })}, {plural(s.found, { one: "# with guides", other: "# with guides" })}.
          </p>
        )}
        {toggle.isError && <div className="alert alert-soft alert-error">{toggle.error.message}</div>}
      </div>
    </section>
  );
}

/** Book look-ups (Open Library): off until switched on, because a book's ISBN is sent to Open Library. */
function BookLookups() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ["server-books"], queryFn: api.bookLookupStatus });
  const toggle = useMutation({ mutationFn: api.setBookLookups, onSuccess: (data) => qc.setQueryData(["server-books"], data) });
  const s = status.data;
  if (!s) return null;
  return (
    <section className="card" aria-labelledby="books-title">
      <div className="card-body gap-3">
        <h2 id="books-title" className="card-title flex items-center gap-2">
          <span className="icon-[tabler--book] size-5 text-primary" />
          <Trans>Book look-ups</Trans>
          <HelpLink page="guide/adding-things.html#books" label={t`Book look-ups`} />
        </h2>
        <p className="text-sm text-base-content/70">
          <Trans>A book's barcode is its ISBN: scanned or saved, it's asked of Open Library (openlibrary.org) for the title, author and cover — each
          once for the whole server, free, and not counted against any lookup allowance. Only the ISBN is sent. It also adds "Books by title" to + Add, for
          older books without a barcode (the words searched for are sent).</Trans>
        </p>
        <label className="flex cursor-pointer items-center gap-3">
          <input type="checkbox" className="switch switch-primary" checked={s.enabled} disabled={toggle.isPending || !s.available} onChange={(e) => toggle.mutate(e.target.checked)} />
          <span>{s.enabled ? t`On` : t`Off`}</span>
        </label>
        {s.enabled && <p className="text-sm text-base-content/70">{plural(s.books, { one: "# book found", other: "# books found" })}.</p>}
        {toggle.isError && <div className="alert alert-soft alert-error">{toggle.error.message}</div>}
        {s.enabled && s.google?.available && (
          <OptionalKey
            intro={
              <Trans>Google Books (optional): asked together with Open Library, and their answers merged field by field — so a book gets Google's cover and
              blurb when Open Library has none, and recent and non-English books are found. It needs a free API key from a Google Cloud project with the
              Books API enabled.</Trans>
            }
            hint={s.google.hint}
            label={t`Google Books API key`}
            removeQuestion={t`Remove the Google Books key? Only Open Library will be asked.`}
            save={api.setGoogleBooksKey}
            onSaved={(data) => qc.setQueryData(["server-books"], data)}
          />
        )}
      </div>
    </section>
  );
}

/** An optional outside service's key (Google Books, the EIA): pasted, checked by the server, then shown only by its last four characters. */
function OptionalKey<T>({ intro, hint, label, removeQuestion, save, onSaved }: { intro: ReactNode; hint: string | null; label: string; removeQuestion: string; save: (key: string | null) => Promise<T>; onSaved: (data: T) => void }) {
  const [key, setKey] = useState("");
  const [editing, setEditing] = useState(false);
  const mutation = useMutation({
    mutationFn: save,
    onSuccess: (data) => {
      setKey("");
      setEditing(false);
      onSaved(data);
    },
  });
  return (
    <div className="flex flex-col gap-2 border-t border-base-content/10 pt-3">
      <p className="text-sm text-base-content/70">{intro}</p>
      {hint && !editing ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="badge badge-soft badge-success">{t`On`} · {hint}</span>
          <button type="button" className="btn btn-text btn-sm" onClick={() => setEditing(true)}><Trans>Change key</Trans></button>
          <button type="button" className="btn btn-text btn-sm text-error" disabled={mutation.isPending} onClick={() => confirm(removeQuestion) && mutation.mutate(null)}>
            <Trans>Remove</Trans>
          </button>
        </div>
      ) : (
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (key.trim()) mutation.mutate(key.trim());
          }}
        >
          <input className="input min-w-0 flex-1 font-mono" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder={t`Paste the API key`} aria-label={label} />
          <button className="btn btn-soft btn-primary" disabled={mutation.isPending || !key.trim()}>
            {mutation.isPending ? <span className="loading loading-spinner loading-sm" /> : <Trans>Check and save</Trans>}
          </button>
          {editing && <button type="button" className="btn btn-text" onClick={() => setEditing(false)}><Trans>Cancel</Trans></button>}
        </form>
      )}
      {mutation.isError && <div className="alert alert-soft alert-error">{mutation.error.message}</div>}
    </div>
  );
}

/** Exchange rates (the European Central Bank's, via Frankfurter): off until switched on. */
function ExchangeRateLookups() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ["server-exchange-rates"], queryFn: api.exchangeRateStatus, refetchInterval: (q) => (q.state.data?.enabled && !q.state.data.date ? 3000 : false) });
  const toggle = useMutation({
    mutationFn: api.setExchangeRates,
    onSuccess: (data) => {
      qc.setQueryData(["server-exchange-rates"], data);
      void qc.invalidateQueries({ queryKey: ["exchange-rates"] });
    },
  });
  const s = status.data;
  if (!s) return null;
  return (
    <section className="card" aria-labelledby="exchange-rates-title">
      <div className="card-body gap-3">
        <h2 id="exchange-rates-title" className="card-title flex items-center gap-2">
          <span className="icon-[tabler--currency-euro] size-5 text-primary" />
          <Trans>Exchange rates</Trans>
          <HelpLink page="hosting/server-admin.html#exchange-rates" label={t`Exchange rates`} />
        </h2>
        <p className="text-sm text-base-content/70">
          <Trans>Some prices come in another currency: the online product database's are US dollars, card prices dollars or euros. With exchange rates on,
          they show in each household's own currency (marked ≈, the original beside it) and can be used as a thing's value. The European Central Bank's
          rates, fetched once a day from Frankfurter (frankfurter.dev) — nothing about anyone is sent.</Trans>
        </p>
        <label className="flex cursor-pointer items-center gap-3">
          <input type="checkbox" className="switch switch-primary" checked={s.enabled} disabled={toggle.isPending || !s.available} onChange={(e) => toggle.mutate(e.target.checked)} />
          <span>{s.enabled ? t`On` : t`Off`}</span>
        </label>
        {s.enabled && s.date && <p className="text-sm text-base-content/70">{t`Rates from ${ph({ date: s.date })}.`}</p>}
        {toggle.isError && <div className="alert alert-soft alert-error">{toggle.error.message}</div>}
      </div>
    </section>
  );
}

/** Device support (endoflife.date): off until switched on. Only its public device lists are downloaded. */
function SupportLookups() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ["server-support"], queryFn: api.supportLookupStatus });
  const toggle = useMutation({ mutationFn: api.setSupportLookups, onSuccess: (data) => qc.setQueryData(["server-support"], data) });
  const s = status.data;
  if (!s) return null;
  return (
    <section className="card" aria-labelledby="support-title">
      <div className="card-body gap-3">
        <h2 id="support-title" className="card-title flex items-center gap-2">
          <span className="icon-[tabler--device-mobile-cog] size-5 text-primary" />
          <Trans>Device support</Trans>
          <HelpLink page="guide/replacements.html#software-updates" label={t`Device support`} />
        </h2>
        <p className="text-sm text-base-content/70">
          <Trans>When phones, tablets, watches, e-readers and the like stop getting security updates, from endoflife.date. A thing that looks like one
          of its devices is offered on its page to confirm; once confirmed, the bell warns 90 days before its updates stop. Ferret downloads
          endoflife.date's public device lists once a day — nothing about your things is sent.</Trans>
        </p>
        <label className="flex cursor-pointer items-center gap-3">
          <input type="checkbox" className="switch switch-primary" checked={s.enabled} disabled={toggle.isPending || !s.available} onChange={(e) => toggle.mutate(e.target.checked)} />
          <span>{s.enabled ? t`On` : t`Off`}</span>
        </label>
        {s.enabled && (
          <p className="text-sm text-base-content/70">
            {plural(s.devices, { one: "# device model known", other: "# device models known" })} · {plural(s.tracked, { one: "# thing tracked", other: "# things tracked" })}
          </p>
        )}
        {toggle.isError && <div className="alert alert-soft alert-error">{toggle.error.message}</div>}
      </div>
    </section>
  );
}

/** The Open Food Facts databases: off until switched on, because barcodes the product database doesn't know are sent to them. */
function OpenFactsLookups() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ["server-open-facts"], queryFn: api.openFactsStatus });
  const toggle = useMutation({ mutationFn: api.setOpenFacts, onSuccess: (data) => qc.setQueryData(["server-open-facts"], data) });
  const s = status.data;
  if (!s) return null;
  return (
    <section className="card" aria-labelledby="open-facts-title">
      <div className="card-body gap-3">
        <h2 id="open-facts-title" className="card-title flex items-center gap-2">
          <span className="icon-[tabler--basket] size-5 text-primary" />
          <Trans>Groceries and household goods</Trans>
          <HelpLink page="guide/adding-things.html#scanning-a-barcode" label={t`Groceries and household goods`} />
        </h2>
        <p className="text-sm text-base-content/70">
          <Trans>A barcode the online product database doesn't know — or every barcode, if there isn't one — is asked of Open Food Facts, Open Products
          Facts and Open Beauty Facts (openfoodfacts.org): groceries, cleaning supplies, batteries, light bulbs, toiletries. Free, with no allowance, and
          once for the whole server. Only the barcode is sent.</Trans>
        </p>
        <label className="flex cursor-pointer items-center gap-3">
          <input type="checkbox" className="switch switch-primary" checked={s.enabled} disabled={toggle.isPending || !s.available} onChange={(e) => toggle.mutate(e.target.checked)} />
          <span>{s.enabled ? t`On` : t`Off`}</span>
        </label>
        {s.enabled && <p className="text-sm text-base-content/70">{plural(s.products, { one: "# product found", other: "# products found" })}.</p>}
        {toggle.isError && <div className="alert alert-soft alert-error">{toggle.error.message}</div>}
      </div>
    </section>
  );
}

/** Trading card look-ups (TCGdex, Scryfall): off until switched on, because what's printed on a card is sent to them. */
function CardLookups() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ["server-cards"], queryFn: api.cardLookupStatus });
  const toggle = useMutation({
    mutationFn: api.setCardLookups,
    onSuccess: (data) => {
      qc.setQueryData(["server-cards"], data);
      void qc.invalidateQueries({ queryKey: ["me"] }); // + Add's "Scan cards" tile
    },
  });
  const s = status.data;
  if (!s) return null;
  return (
    <section className="card" aria-labelledby="cards-title">
      <div className="card-body gap-3">
        <h2 id="cards-title" className="card-title flex items-center gap-2">
          <span className="icon-[tabler--cards] size-5 text-primary" />
          <Trans>Trading cards</Trans>
          <HelpLink page="guide/adding-things.html#trading-cards" label={t`Trading cards`} />
        </h2>
        <p className="text-sm text-base-content/70">
          <Trans>Adds "Scan cards" to + Add: Pokémon cards are looked up on TCGdex (tcgdex.dev) and Magic cards on Scryfall (scryfall.com) — the
          card, its picture and today's market price. Free, with no allowance. Only what's printed on a card (its name, number and set) is sent;
          reading a photo of one uses this server's vision model and counts as an AI action.</Trans>
        </p>
        <label className="flex cursor-pointer items-center gap-3">
          <input type="checkbox" className="switch switch-primary" checked={s.enabled} disabled={toggle.isPending || !s.available} onChange={(e) => toggle.mutate(e.target.checked)} />
          <span>{s.enabled ? t`On` : t`Off`}</span>
        </label>
        {s.enabled && <p className="text-sm text-base-content/70">{plural(s.cards, { one: "# card looked up", other: "# cards looked up" })}.</p>}
        {toggle.isError && <div className="alert alert-soft alert-error">{toggle.error.message}</div>}
      </div>
    </section>
  );
}

// not translated (names of services)
const CATALOGS: Partial<Record<CollectibleKind, { service: string; what: MessageDescriptor; icon: string; signup: string; keyAt: string }>> = {
  lego: { service: "Rebrickable", what: msg`LEGO sets`, icon: "icon-[tabler--lego]", signup: "https://rebrickable.com", keyAt: "https://rebrickable.com/api/" },
  coin: { service: "Numista", what: msg`Coins`, icon: "icon-[tabler--coin]", signup: "https://en.numista.com", keyAt: "https://en.numista.com/api/" },
  comic: { service: "Comic Vine", what: msg`Comics`, icon: "icon-[tabler--book]", signup: "https://comicvine.gamespot.com", keyAt: "https://comicvine.gamespot.com/api/" },
  video: { service: "TMDB", what: msg`Movies & TV`, icon: "icon-[tabler--movie]", signup: "https://www.themoviedb.org", keyAt: "https://www.themoviedb.org/settings/api" },
  record: { service: "Discogs", what: msg`Records & CDs`, icon: "icon-[tabler--vinyl]", signup: "https://www.discogs.com", keyAt: "https://www.discogs.com/settings/developers" },
  game: { service: "IGDB", what: msg`Video games`, icon: "icon-[tabler--device-gamepad-2]", signup: "https://www.igdb.com", keyAt: "https://dev.twitch.tv/console/apps" },
};

/** Collector catalogs (Rebrickable, Numista, Comic Vine): each on once its free key is saved; the key is never shown again. */
function CollectorCatalogs() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ["server-collectibles"], queryFn: api.collectibleCatalogs });
  // Keyless ones (books by title) come with their own switch elsewhere.
  const rows = status.data?.data.filter((c) => c.available && !c.keyless);
  if (!rows?.length) return null;
  return (
    <section className="card" aria-labelledby="collectors-title">
      <div className="card-body gap-3">
        <h2 id="collectors-title" className="card-title flex items-center gap-2">
          <span className="icon-[tabler--lego] size-5 text-primary" />
          <Trans>Collector catalogs</Trans>
          <HelpLink page="hosting/server-admin.html#collector-catalogs" label={t`Collector catalogs`} />
        </h2>
        <p className="text-sm text-base-content/70">
          <Trans>Adds LEGO sets, coins, comics, movies and TV shows, video games, and records to + Add, looked up with their pictures and details — and coins' prices by grade. Each catalog needs a free key from an
          account there: paste it here and that catalog is on. Only the words people search for are sent; reading a photo uses this server's vision model and
          counts as an AI action.</Trans>
        </p>
        <ul className="divide-y divide-base-content/10">
          {rows.map((c) => (
            <CatalogKey key={c.kind} status={c} onSaved={(data) => {
              qc.setQueryData(["server-collectibles"], { data });
              void qc.invalidateQueries({ queryKey: ["me"] }); // + Add's tiles
            }} />
          ))}
        </ul>
        {rows.some((c) => c.kind === "video") && (
          <p className="text-xs text-base-content/70">
            {/* TMDB's terms ask for this notice, in English. */}
            {/* not translated */}
            This product uses the TMDB API but is not endorsed or certified by TMDB.
          </p>
        )}
      </div>
    </section>
  );
}

function CatalogKey({ status, onSaved }: { status: CollectibleCatalogStatus; onSaved: (data: CollectibleCatalogStatus[]) => void }) {
  const c = CATALOGS[status.kind]!;
  const [key, setKey] = useState("");
  const [editing, setEditing] = useState(false);
  const save = useMutation({
    mutationFn: (value: string | null) => api.setCollectibleKey(status.kind, value),
    onSuccess: (r) => {
      setKey("");
      setEditing(false);
      onSaved(r.data);
    },
  });
  return (
    <li className="flex flex-col gap-2 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`${c.icon} size-5 text-base-content/60`} />
        <span className="font-medium">{t(c.what)}</span>
        <span className="text-sm text-base-content/70">
          <a className="link tap" href={c.signup} target="_blank" rel="noreferrer noopener">{c.service}</a>
        </span>
        {status.on ? (
          <span className="badge badge-soft badge-success">{t`On`} · {status.hint}</span>
        ) : (
          <span className="badge badge-soft">{t`Off`}</span>
        )}
      </div>
      {status.on && !editing ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-base-content/70">{plural(status.kept, { one: "# looked up", other: "# looked up" })}</span>
          <button type="button" className="btn btn-text btn-sm" onClick={() => setEditing(true)}><Trans>Change key</Trans></button>
          <button type="button" className="btn btn-text btn-sm text-error" disabled={save.isPending} onClick={() => confirm(t`Remove the ${ph({ service: c.service })} key? People won't be able to look things up there until a key is saved again.`) && save.mutate(null)}>
            <Trans>Remove</Trans>
          </button>
        </div>
      ) : (
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (key.trim()) save.mutate(key.trim());
          }}
        >
          <input className="input min-w-0 flex-1 font-mono" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder={t`Paste the API key`} aria-label={t`${ph({ service: c.service })} API key`} />
          <button className="btn btn-soft btn-primary" disabled={save.isPending || !key.trim()}>
            {save.isPending ? <span className="loading loading-spinner loading-sm" /> : <Trans>Check and save</Trans>}
          </button>
          {editing && <button type="button" className="btn btn-text" onClick={() => setEditing(false)}><Trans>Cancel</Trans></button>}
          {status.kind === "record" && (
            <p className="w-full text-xs text-base-content/70">
              <Trans>Discogs: generate a personal access token. Prices for each condition also need the account's seller settings saved once.</Trans>
            </p>
          )}
          {status.kind === "game" && (
            <p className="w-full text-xs text-base-content/70">
              <Trans>IGDB uses a Twitch app: paste its client ID and its secret, separated by a space.</Trans>
            </p>
          )}
          <p className="w-full text-xs text-base-content/70">
            <Trans>Get one free at <a className="link" href={c.keyAt} target="_blank" rel="noreferrer noopener">{c.service}</a> after signing in.</Trans>
          </p>
        </form>
      )}
      {save.isError && <div className="alert alert-soft alert-error">{save.error.message}</div>}
    </li>
  );
}

/** Graded coins and cards: PCGS's and PSA's keys (PSA approves accounts for its API first). */
function GradingKeys() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ["server-graded"], queryFn: api.gradingStatus });
  const rows = status.data?.data.filter((g) => g.available);
  if (!rows?.length) return null;
  const onSaved = (data: { data: GradingStatus[] }) => {
    qc.setQueryData(["server-graded"], data);
    void qc.invalidateQueries({ queryKey: ["me"] });
  };
  return (
    <section className="card" aria-labelledby="graded-title">
      <div className="card-body gap-3">
        <h2 id="graded-title" className="card-title flex items-center gap-2">
          <span className="icon-[tabler--certificate] size-5 text-primary" />
          <Trans>Graded coins and cards</Trans>
          <HelpLink page="hosting/server-admin.html#graded-coins-and-cards" label={t`Graded coins and cards`} />
        </h2>
        <p className="text-sm text-base-content/70">
          <Trans>On a coin's or card's page, its slab's certificate number is checked with PCGS (coins) or PSA (cards): the grade, how many are graded the
          same and higher, and PCGS's price guide value. Each needs a free key from an account there; only certificate numbers are sent.</Trans>
        </p>
        {rows.map((g) =>
          g.by === "pcgs" ? (
            <OptionalKey
              key={g.by}
              intro={<Trans>PCGS (coins): sign in at pcgs.com/publicapi for its API token.</Trans>}
              hint={g.hint}
              label={t`PCGS API token`}
              removeQuestion={t`Remove the PCGS key? Coins' certificates won't be checked.`}
              save={(key) => api.setGradingKey("pcgs", key)}
              onSaved={onSaved}
            />
          ) : (
            <OptionalKey
              key={g.by}
              intro={<Trans>PSA (cards): sign in at psacard.com/publicapi for its access token. PSA approves accounts for its API before the token works.</Trans>}
              hint={g.hint}
              label={t`PSA access token`}
              removeQuestion={t`Remove the PSA key? Cards' certificates won't be checked.`}
              save={(key) => api.setGradingKey("psa", key)}
              onSaved={onSaved}
            />
          ),
        )}
      </div>
    </section>
  );
}

/** Bike Index look-ups: off until switched on, because bikes' serial numbers are sent to bikeindex.org. */
function BikeIndexLookups() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ["server-bike-index"], queryFn: api.bikeIndexStatus });
  const toggle = useMutation({ mutationFn: api.setBikeIndex, onSuccess: (data) => qc.setQueryData(["server-bike-index"], data) });
  const s = status.data;
  if (!s?.available) return null;
  return (
    <section className="card" aria-labelledby="bike-index-server-title">
      <div className="card-body gap-3">
        <h2 id="bike-index-server-title" className="card-title flex items-center gap-2">
          <span className="icon-[tabler--bike] size-5 text-primary" />
          <Trans>Bike Index look-ups</Trans>
          <HelpLink page="hosting/server-admin.html#bike-index-look-ups" label={t`Bike Index look-ups`} />
        </h2>
        <p className="text-sm text-base-content/70">
          <Trans>On a bike's page, says whether a bike with its serial number is reported stolen on Bike Index (bikeindex.org, a non-profit registry) —
          worth knowing about one bought second-hand — with links to register it there, or report it once it's marked stolen. Free, no key. Only
          bikes' serial numbers are sent.</Trans>
        </p>
        <label className="flex cursor-pointer items-center gap-3">
          <input type="checkbox" className="switch switch-primary" checked={s.enabled} disabled={toggle.isPending} onChange={(e) => toggle.mutate(e.target.checked)} />
          <span>{s.enabled ? t`On` : t`Off`}</span>
        </label>
        {s.enabled && <p className="text-sm text-base-content/70">{plural(s.checked, { one: "# serial number checked", other: "# serial numbers checked" })}.</p>}
        {toggle.isError && <div className="alert alert-soft alert-error">{toggle.error.message}</div>}
      </div>
    </section>
  );
}

/** eBay listings ("On eBay now" on things' pages): on once the server admin saves an eBay keyset. */
function EbayListings() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ["server-ebay"], queryFn: api.ebayStatus });
  const s = status.data;
  if (!s?.available) return null;
  return (
    <section className="card" aria-labelledby="ebay-server-title">
      <div className="card-body gap-3">
        <h2 id="ebay-server-title" className="card-title flex items-center gap-2">
          <span className="icon-[tabler--building-store] size-5 text-primary" />
          <Trans>eBay listings</Trans>
          <HelpLink page="hosting/server-admin.html#ebay-listings" label={t`eBay listings`} />
        </h2>
        <p className="text-sm text-base-content/70">
          <Trans>On a thing's page, and beside a listing the AI drafts, shows what the same thing is listed for on eBay right now — a few listings and
          the range of asking prices, found by its barcode or its brand and model number. Those are the only things sent, to the eBay of the household's
          country. Answers are kept in memory for an hour and never saved; nothing from eBay is written to a thing.</Trans>
        </p>
        <OptionalKey
          intro={
            <Trans>It needs a free keyset from the eBay Developers Program (developer.ebay.com): the Production App ID and Cert ID, pasted with a space
            between them. In the keyset's Alerts & Notifications, turn on "Exempted from Marketplace Account Deletion" (Ferret keeps no eBay data) —
            eBay switches off keysets that neither do that nor receive its notifications.</Trans>
          }
          hint={s.hint}
          label={t`eBay App ID and Cert ID`}
          removeQuestion={t`Remove the eBay keys? Things' pages won't show eBay listings.`}
          save={api.setEbayKey}
          onSaved={(data) => qc.setQueryData(["server-ebay"], data)}
        />
      </div>
    </section>
  );
}

/** ENERGY STAR look-ups: off until switched on, because things' brands and models (or barcodes) are sent to the EPA's open data. */
function EnergyStarLookups() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ["server-energy-star"], queryFn: api.energyStarStatus });
  const toggle = useMutation({ mutationFn: api.setEnergyStar, onSuccess: (data) => qc.setQueryData(["server-energy-star"], data) });
  const s = status.data;
  if (!s?.available) return null;
  return (
    <section className="card" aria-labelledby="energy-title">
      <div className="card-body gap-3">
        <h2 id="energy-title" className="card-title flex items-center gap-2">
          <span className="icon-[tabler--bolt] size-5 text-primary" />
          <Trans>ENERGY STAR look-ups</Trans>
          <HelpLink page="hosting/server-admin.html#energy-star-look-ups" label={t`ENERGY STAR look-ups`} />
        </h2>
        <p className="text-sm text-base-content/70">
          <Trans>Shows an appliance's certified energy use on its page — a fridge's, washer's, furnace's or TV's kWh a year and how it compares with the
          US standard — from ENERGY STAR's list of certified products (data.energystar.gov). Free, no key. A thing's brand and model number (or its
          barcode) are sent, once for the whole server; nothing else is.</Trans>
        </p>
        <label className="flex cursor-pointer items-center gap-3">
          <input type="checkbox" className="switch switch-primary" checked={s.enabled} disabled={toggle.isPending} onChange={(e) => toggle.mutate(e.target.checked)} />
          <span>{s.enabled ? t`On` : t`Off`}</span>
        </label>
        {s.enabled && <p className="text-sm text-base-content/70">{plural(s.kept, { one: "# thing looked up", other: "# things looked up" })}.</p>}
        {toggle.isError && <div className="alert alert-soft alert-error">{toggle.error.message}</div>}
        {s.enabled && s.electricity?.available && (
          <OptionalKey
            intro={
              <Trans>Electricity prices (optional, US): with a free key from the US Energy Information Administration (eia.gov/opendata), each card also
              says what that energy costs a year at the average home rate in the thing's state. Prices are fetched once a month; nothing about anyone is
              sent.</Trans>
            }
            hint={s.electricity.hint}
            label={t`EIA API key`}
            removeQuestion={t`Remove the EIA key? The cards won't show what energy costs.`}
            save={api.setElectricityKey}
            onSaved={(data) => qc.setQueryData(["server-energy-star"], data)}
          />
        )}
      </div>
    </section>
  );
}

/** Music look-ups (MusicBrainz): off until switched on, because a barcode scanned with "Scan music" is sent to MusicBrainz. */
function MusicLookups() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ["server-music"], queryFn: api.musicLookupStatus });
  const toggle = useMutation({
    mutationFn: api.setMusicLookups,
    onSuccess: (data) => {
      qc.setQueryData(["server-music"], data);
      void qc.invalidateQueries({ queryKey: ["me"] }); // + Add's "Scan music" tile
    },
  });
  const s = status.data;
  if (!s) return null;
  return (
    <section className="card" aria-labelledby="music-title">
      <div className="card-body gap-3">
        <h2 id="music-title" className="card-title flex items-center gap-2">
          <span className="icon-[tabler--vinyl] size-5 text-primary" />
          <Trans>Music look-ups</Trans>
          <HelpLink page="guide/adding-things.html#music" label={t`Music look-ups`} />
        </h2>
        <p className="text-sm text-base-content/70">
          <Trans>Adds "Scan music" to + Add: scan a shelf of CDs or records one after another, and each barcode is asked of MusicBrainz
          (musicbrainz.org) for the album, artist, format, year and cover — once for the whole server, free, and not counted against any lookup
          allowance. Only the barcode is sent.</Trans>
        </p>
        <label className="flex cursor-pointer items-center gap-3">
          <input type="checkbox" className="switch switch-primary" checked={s.enabled} disabled={toggle.isPending || !s.available} onChange={(e) => toggle.mutate(e.target.checked)} />
          <span>{s.enabled ? t`On` : t`Off`}</span>
        </label>
        {s.enabled && <p className="text-sm text-base-content/70">{plural(s.releases, { one: "# record found", other: "# records found" })}.</p>}
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
        {s && (
          <p className="text-sm text-base-content/70">
            <Trans>A backup opens only with FILES_KEY: keep it, or a key file, somewhere safe — <a href={`${settingsHref("server")}?part=access`} className="link link-primary tap">Access → Keys</a>.</Trans>
          </p>
        )}
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

/** The newest copies shown; older ones fold away under a line that says how many. */
const RECENT_COPIES = 3;

function Snapshots({ data, loading, error }: { data?: BackupSnapshot[]; loading: boolean; error?: string }) {
  return (
    <div className="space-y-2">
      <h3 className="font-medium"><Trans>Copies kept</Trans></h3>
      {loading && <span className="loading loading-spinner text-primary" />}
      {error && <div className="alert alert-soft alert-error">{error}</div>}
      {data && data.length === 0 && <p className="text-sm text-base-content/70"><Trans>None yet.</Trans></p>}
      {data && data.length > 0 && (
        <ul className="divide-y divide-base-content/10">
          {data.slice(0, RECENT_COPIES).map((snap) => (
            <SnapshotRow key={snap.name} snap={snap} />
          ))}
        </ul>
      )}
      {data && data.length > RECENT_COPIES && (
        <details className="group">
          <summary className="tap flex cursor-pointer list-none items-center gap-1 text-sm font-medium text-primary">
            <span className="icon-[tabler--chevron-right] size-4 transition-transform group-open:rotate-90" />
            {plural(data.length - RECENT_COPIES, { one: "# older copy", other: "# older copies" })}
          </summary>
          <ul className="divide-y divide-base-content/10">
            {data.slice(RECENT_COPIES).map((snap) => (
              <SnapshotRow key={snap.name} snap={snap} />
            ))}
          </ul>
        </details>
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
/** The secrets Ferret needs (FILES_KEY above all) and the key file: on Access, apart from Backups, which links here. */
function KeysCard() {
  const status = useQuery({ queryKey: ["backup"], queryFn: api.backupStatus });
  const s = status.data;
  if (!s) return null;
  return (
    <section className="card" aria-label={t`Keys`}>
      <div className="card-body gap-3">
        <FilesKey keyId={s.keyId} keyFile={s.keyFile} folder={s.where} commandLine={!s.elsewhere} />
        {s.enabled && <BackupSigningKey />}
      </div>
    </section>
  );
}

/** The server's signing key: each backup's manifest is signed with it, so a backup can be checked without FILES_KEY. */
function BackupSigningKey() {
  const key = useQuery({ queryKey: ["backup", "signing-key"], queryFn: api.backupSigningKey, staleTime: Infinity });
  return (
    <div className="flex flex-col gap-2 border-t border-base-content/10 pt-3">
      <h3 className="font-semibold"><Trans>Backup signing key</Trans></h3>
      <p className="text-sm text-base-content/70">
        <Trans>
          Every backup is signed with this key, and the backup folder has a copy of it. With the ferret command-line tool or ssh-keygen, anyone can check a backup is whole and unchanged
          — without FILES_KEY. Compare the fingerprint with this one.
        </Trans>
      </p>
      {key.data && <KeyDetails signingKey={key.data} />}
      {key.isError && <p className="text-sm text-error">{key.error.message}</p>}
    </div>
  );
}

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
      <h2 className="card-title flex items-center gap-2">
        <span className="icon-[tabler--key] size-5 text-primary" />
        <Trans>Keys</Trans>
      </h2>
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
