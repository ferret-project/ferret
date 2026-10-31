/**
 * The public demo (the server's DEMO setting, given by /auth-options): the shared account offered on the sign-in screen,
 * a note at the top of the dashboard saying what's kept and for how long, the browser's usage counts (lib/demo-counts.ts),
 * and Settings → Server → Demo for its admin.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { type DemoPart, type DemoReport, api } from "./lib/api";
import { authClient, signOut } from "./lib/auth";
import { countUsage, startCounting } from "./lib/demo-counts";

const useDemo = () => useQuery({ queryKey: ["auth-options"], queryFn: api.authOptions, staleTime: Infinity }).data?.demo;

/** Starts the browser's counts — on the demo only. */
export function DemoCounts() {
  const demo = useDemo();
  useEffect(() => {
    if (demo) startCounting();
  }, [demo]);
  return null;
}

/** "Run your own": the help's install page (counted, to see who might self-host). */
function RunYourOwn({ className = "" }: { className?: string }) {
  return (
    <a href="/docs/hosting/install.html" className={`link link-primary tap ${className}`} onClick={() => countUsage("self_host.click")}>
      Run your own Ferret
    </a>
  );
}

export type DemoOptions = NonNullable<Awaited<ReturnType<typeof api.authOptions>>["demo"]>;

/** The sign-in screen's "Try the demo": the shared account's email and password, and a button that uses them. */
export function DemoSignIn({ demo, busy, onSignIn }: { demo: DemoOptions; busy: boolean; onSignIn: () => void }) {
  if (demo.paused) {
    return (
      <div className="alert alert-soft alert-info text-sm" role="status">
        The demo is resting for now — please come back later.
      </div>
    );
  }
  return (
    <section className="card border border-primary/30 bg-primary/5 shadow-none" aria-labelledby="demo-title">
      <div className="card-body gap-3 p-4">
        <div>
          <h2 id="demo-title" className="font-semibold text-base-content">
            Try the demo
          </h2>
          <p className="text-sm text-base-content/70">
            A made-up house, shared by everyone trying Ferret — change anything you like; it starts afresh every night.
          </p>
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="text-base-content/70">Email</dt>
          <dd className="font-mono break-all select-all">{demo.email}</dd>
          <dt className="text-base-content/70">Password</dt>
          <dd className="font-mono select-all">{demo.password}</dd>
        </dl>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={onSignIn}>
          {busy ? <span className="loading loading-spinner loading-sm" /> : <span className="icon-[tabler--door-enter] size-5" />}
          Sign in to the demo
        </button>
        <p className="text-xs text-base-content/70">
          Or create your own account below: it and its households are deleted after {demo.visitorDays} days. Or{" "}
          <RunYourOwn /> at home.
        </p>
      </div>
    </section>
  );
}

/** The dashboard's note: in the shared account, that it's shared and reset; in a visitor's own, when it goes. */
export function DemoNote() {
  const demo = useDemo();
  const { data: session } = authClient.useSession();
  if (!demo || !session) return null;
  const shared = session.user.email.toLowerCase() === demo.email.toLowerCase();
  return (
    <div className="alert alert-soft alert-info flex-wrap items-start gap-3 text-sm" role="status">
      <span className="icon-[tabler--flask] mt-0.5 size-5 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1 basis-60">
        {shared ? (
          <>
            <p className="font-medium">You're in the shared demo.</p>
            <p>
              Everyone trying Ferret sees this house, and it starts afresh every night. Account settings are locked here —
              make your own account to try those too.
            </p>
          </>
        ) : (
          <p>
            This is the Ferret demo: your account and its households are deleted {demo.visitorDays} days after you made
            them.
          </p>
        )}
        <p className="mt-1">
          Like it? <RunYourOwn /> — on a computer at home, so your things never leave it.
        </p>
      </div>
      {shared && (
        <button type="button" className="btn btn-soft btn-info btn-sm btn-wrap" onClick={() => signOut()}>
          Sign out to make your own
        </button>
      )}
    </div>
  );
}

// ── Settings → Server → Demo ────────────────────────────────────────────────

const FEATURES: [event: string, label: string][] = [
  ["item.add", "Things added"],
  ["search", "Searches"],
  ["ask", "Ask Ferret"],
  ["photo.analyzed", "Photos read"],
  ["api_key.create", "API keys made"],
  ["mcp.call", "Claude (MCP) calls"],
  ["install", "Installed the app"],
  ["self_host.click", "“Run your own”"],
];

const total = (counts: DemoReport["counts"], event: string) => (counts ?? []).filter((c) => c.event === event).reduce((n, c) => n + c.n, 0);

/** The demo's admin: how it's used. Counts, not people (server lib/analytics.ts). */
export function DemoUsage() {
  const demo = useDemo();
  const [days, setDays] = useState(30);
  const report = useQuery({ queryKey: ["demo-report", days], queryFn: () => api.demoReport(days), enabled: !!demo });
  if (!demo) return null;
  const r = report.data;
  const funnel: [string, number][] = r
    ? [
        ["Visits", total(r.counts, "visit")],
        ["Tried the demo", total(r.counts, "demo.sign_in")],
        ["Made an account", total(r.counts, "demo.sign_up")],
        ["Came back a day later", total(r.counts, "return.d1")],
        ["…and a week later", total(r.counts, "return.d7")],
      ]
    : [];
  const refs = new Map<string, number>();
  for (const c of r?.counts ?? []) if (c.event === "visit") refs.set(c.ref ?? "(none)", (refs.get(c.ref ?? "(none)") ?? 0) + c.n);
  const byDay = new Map<string, Record<string, number>>();
  for (const c of r?.counts ?? []) {
    const row = byDay.get(c.day) ?? {};
    row[c.event] = (row[c.event] ?? 0) + c.n;
    byDay.set(c.day, row);
  }
  const top = Math.max(1, ...funnel.map(([, n]) => n));
  return (
    <section className="card" aria-labelledby="demo-usage-title">
      <div className="card-body gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="demo-usage-title" className="card-title flex items-center gap-2">
            <span className="icon-[tabler--flask] size-5 text-primary" aria-hidden />
            Demo
          </h2>
          <select className="select select-sm w-auto" value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Period">
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </select>
        </div>
        <p className="text-sm text-base-content/70">
          Counts of what visitors do — never who they are or what they add. Visitors&rsquo; accounts go after{" "}
          {r?.visitorDays ?? demo.visitorDays} days.
        </p>
        {report.isError && <div className="alert alert-soft alert-error text-sm">{report.error.message}</div>}
        {r && (
          <>
            <dl className="grid grid-cols-[repeat(auto-fit,minmax(6rem,1fr))] gap-3">
              <Stat label="Visitors’ accounts now" value={r.visitorAccounts} />
              <Stat label="Their households" value={r.visitorHouseholds} />
              <Stat label="AI calls today" value={`${r.ai.today} of ${r.ai.perDay}`} />
            </dl>
            {r.paused && <div className="alert alert-soft alert-warning text-sm">The demo is paused (DEMO_PAUSED).</div>}
            {r.counts === null ? (
              <div className="alert alert-soft alert-info text-sm">
                {r.countsError
                  ? `Couldn’t read the counts: ${r.countsError}`
                  : "The counts are being kept, but can’t be read back from here."}
              </div>
            ) : (
              <>
                <div>
                  <h3 className="mb-2 font-medium">From a visit to coming back</h3>
                  <ul className="space-y-2">
                    {funnel.map(([label, n]) => (
                      <li key={label} className="grid grid-cols-[minmax(0,10rem)_1fr_auto] items-center gap-3 text-sm">
                        <span>{label}</span>
                        <progress className="progress progress-primary" value={n} max={top} aria-hidden />
                        <span className="tabular-nums">{n}</span>
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <h3 className="mb-2 font-medium">What they tried</h3>
                    <ul className="divide-y divide-base-300 text-sm">
                      {FEATURES.map(([event, label]) => (
                        <li key={event} className="flex justify-between gap-3 py-1.5">
                          <span>{label}</span>
                          <span className="tabular-nums">{total(r.counts, event)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <h3 className="mb-2 font-medium">Where visits came from</h3>
                    {refs.size ? (
                      <ul className="divide-y divide-base-300 text-sm">
                        {[...refs].sort((a, b) => b[1] - a[1]).map(([ref, n]) => (
                          <li key={ref} className="flex justify-between gap-3 py-1.5">
                            <span className="font-mono">{ref}</span>
                            <span className="tabular-nums">{n}</span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-sm text-base-content/70">No visits yet. Links with ?ref= show here.</p>
                    )}
                  </div>
                </div>
                {byDay.size > 0 && (
                  <div className="overflow-x-auto">
                    <table className="table table-sm">
                      <caption className="sr-only">By day (UTC)</caption>
                      <thead>
                        <tr>
                          <th>Day (UTC)</th>
                          <th className="text-end">Visits</th>
                          <th className="text-end">Tried</th>
                          <th className="text-end">Accounts</th>
                          <th className="text-end">Things</th>
                          <th className="text-end">Searches</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[...byDay].reverse().map(([day, n]) => (
                          <tr key={day}>
                            <td className="whitespace-nowrap">{day}</td>
                            <td className="text-end tabular-nums">{n["visit"] ?? 0}</td>
                            <td className="text-end tabular-nums">{n["demo.sign_in"] ?? 0}</td>
                            <td className="text-end tabular-nums">{n["demo.sign_up"] ?? 0}</td>
                            <td className="text-end tabular-nums">{n["item.add"] ?? 0}</td>
                            <td className="text-end tabular-nums">{n["search"] ?? 0}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-box bg-base-200 p-3">
      <dt className="text-sm text-base-content/70">{label}</dt>
      <dd className="text-xl font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

// ── Turning parts off, and what the hosting has counted ──────────────────────

const PARTS: [part: DemoPart, label: string, what: string][] = [
  ["everything", "The whole demo", "Rest it: visitors see “resting”; you can still sign in and switch it back on."],
  ["signups", "New accounts", "Sign-up is closed; the shared demo account still works."],
  ["uploads", "Photos and files", "Nothing new is stored (R2)."],
  ["photos", "Reading photos", "The vision model that suggests a name, brand and model."],
  ["meaning", "Search by meaning", "Embeddings and reranking. Search by words keeps working."],
  ["chat", "Ask Ferret and the search judge", "The chat model — the most expensive AI part."],
  ["documents", "Reading documents", "PDFs and photos of receipts and manuals."],
  ["email", "Email", "Confirmations, password resets and sign-in links stop."],
];

/** Switches for the demo's parts (server lib/demo-switches.ts): stop one cost without closing the demo. */
export function DemoSwitches() {
  const demo = useDemo();
  const qc = useQueryClient();
  const current = useQuery({ queryKey: ["demo-switches"], queryFn: api.demoSwitches, enabled: !!demo });
  const save = useMutation({
    mutationFn: api.setDemoSwitches,
    onSuccess: (data) => {
      qc.setQueryData(["demo-switches"], data);
      void qc.invalidateQueries({ queryKey: ["auth-options"] });
    },
  });
  if (!demo || !current.data) return null;
  const off = new Set(save.variables ?? current.data.off);
  const flip = (part: DemoPart, on: boolean) => save.mutate([...off].filter((p) => p !== part).concat(on ? [] : [part]));
  return (
    <section className="card" aria-labelledby="demo-switches-title">
      <div className="card-body gap-3">
        <h2 id="demo-switches-title" className="card-title flex items-center gap-2">
          <span className="icon-[tabler--toggle-right] size-5 text-primary" aria-hidden />
          Parts of the demo
        </h2>
        <p className="text-sm text-base-content/70">Switch one off to stop its cost or its misuse without closing the demo. Changes reach every visitor within seconds.</p>
        <ul className="divide-y divide-base-300">
          {PARTS.map(([part, label, what]) => (
            <li key={part} className="py-2">
              <label className="flex cursor-pointer items-start justify-between gap-3">
                <span className="min-w-0">
                  <span className="block font-medium">{label}</span>
                  <span className="block text-sm text-base-content/70">{what}</span>
                </span>
                <input type="checkbox" className="switch switch-primary mt-1 shrink-0" checked={!off.has(part)} disabled={save.isPending} onChange={(e) => flip(part, e.target.checked)} aria-label={`${label}: ${off.has(part) ? "off" : "on"}`} />
              </label>
            </li>
          ))}
        </ul>
        {save.isError && <div className="alert alert-soft alert-error text-sm">{save.error.message}</div>}
      </div>
    </section>
  );
}

const number = (n: number) => Math.round(n).toLocaleString();
const bytes = (n: number) => (n < 1e6 ? `${Math.round(n / 1e3)} KB` : n < 1e9 ? `${(n / 1e6).toFixed(1)} MB` : `${(n / 1e9).toFixed(2)} GB`);

/** What the demo's hosting has used this month, against what its plan includes (the server's HostingUsage port). */
export function HostingUsageCard() {
  const demo = useDemo();
  const usage = useQuery({ queryKey: ["hosting-usage"], queryFn: api.hostingUsage, enabled: !!demo, staleTime: 5 * 60_000 });
  const u = usage.data?.usage;
  // Nothing to show where the hosting doesn't report its use.
  if (!demo || (usage.isSuccess && !u && !usage.data?.error)) return null;
  return (
    <section className="card" aria-labelledby="hosting-usage-title">
      <div className="card-body gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="hosting-usage-title" className="card-title flex items-center gap-2">
            <span className="icon-[tabler--cloud] size-5 text-primary" aria-hidden />
            {u?.title ?? "Hosting this month"}
          </h2>
          <button type="button" className="btn btn-text btn-sm" disabled={usage.isFetching} onClick={() => void usage.refetch()}>
            {usage.isFetching ? <span className="loading loading-spinner loading-xs" /> : <span className="icon-[tabler--refresh] size-4" aria-hidden />}
            Refresh
          </button>
        </div>
        {u?.note && <p className="text-sm text-base-content/70">{u.note}</p>}
        {usage.data?.error && <div className="alert alert-soft alert-warning text-sm">{usage.data.error}</div>}
        {usage.isError && <div className="alert alert-soft alert-error text-sm">{usage.error.message}</div>}
        {u && (
          <>
            <ul className="space-y-2.5">
              {u.rows.map(({ label, used, included, unit }) => {
                const show = unit === "bytes" ? bytes : number;
                return (
                  <li key={label} className="text-sm">
                    <div className="flex flex-wrap justify-between gap-x-3">
                      <span>{label}</span>
                      <span className="tabular-nums text-base-content/70">
                        {show(used)} of {show(included)} · {used / included < 0.001 && used > 0 ? "<0.1" : ((used / included) * 100).toFixed(1)}%
                      </span>
                    </div>
                    <progress className={`progress ${used / included > 0.8 ? "progress-warning" : "progress-primary"}`} value={Math.min(used, included)} max={included} aria-hidden />
                  </li>
                );
              })}
            </ul>
            {u.details && (
              <details className="text-sm">
                <summary className="cursor-pointer">{u.details.summary}</summary>
                <ul className="mt-2 divide-y divide-base-300">
                  {u.details.rows.map((r) => (
                    <li key={r.label} className="flex justify-between gap-3 py-1.5">
                      <span className="min-w-0 truncate font-mono text-xs">{r.label}</span>
                      <span className="shrink-0 tabular-nums">{r.value}</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </>
        )}
      </div>
    </section>
  );
}
