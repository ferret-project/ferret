/**
 * What a share link opens (#/s/:token, from /s/<token>) — no account: the report as it is now (ReportDocument), with
 * each item's photos and documents linked when they're shared, a spreadsheet download and Print. Server:
 * lib/shares.ts. Expired or turned-off links say so.
 */
import { useQuery } from "@tanstack/react-query";
import { api } from "./lib/api";
import { Logo } from "./AuthLayout";
import { ReportDocument } from "./Report";

const longDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });

export function Shared({ token }: { token: string }) {
  const view = useQuery({ queryKey: ["shared", token], queryFn: () => api.shared(token), retry: false, staleTime: Infinity });
  const v = view.data;
  return (
    <div className="min-h-dvh bg-base-200 print:bg-white">
      <nav className="navbar border-b border-base-300 bg-base-100 px-4 print:hidden">
        <div className="navbar-start items-center gap-2">
          <Logo className="text-lg text-primary" />
        </div>
      </nav>
      <main className="mx-auto flex max-w-4xl flex-col gap-4 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] print:max-w-none print:p-0">
        {view.isPending && <span className="loading loading-spinner text-primary mx-auto my-12" />}
        {view.isError && (
          <div className="card">
            <div className="card-body items-center gap-3 text-center">
              <span className="icon-[tabler--link-off] size-10 text-base-content/70" />
              <h1 className="text-lg font-semibold">{view.error.message}</h1>
              <p className="max-w-sm text-sm text-base-content/70">Shared links work for a while, then stop. Ask whoever sent it for a new one.</p>
            </div>
          </div>
        )}
        {v && (
          <>
            <section className="card print:hidden">
              <div className="card-body gap-3 p-4 sm:p-6">
                <p className="text-sm text-base-content/80">
                  <span className="font-medium">{v.sharedBy ?? "Someone"}</span> shared this from {v.household}'s home inventory
                  {v.label ? ` — ${v.label}` : ""}. It's read-only, and the link works until {longDate(v.expiresAt)}.
                </p>
                <div className="flex flex-wrap gap-3">
                  <button type="button" className="btn btn-wrap btn-primary" onClick={() => window.print()}>
                    <span className="icon-[tabler--printer] size-5" />
                    Print or save as PDF
                  </button>
                  <a className="btn btn-wrap btn-soft btn-primary" href={api.sharedCsvUrl(token)} download>
                    <span className="icon-[tabler--file-spreadsheet] size-5" />
                    Download spreadsheet (CSV)
                  </a>
                </div>
              </div>
            </section>
            <ReportDocument
              title={v.household}
              subtitle={v.title}
              preparedBy={v.sharedBy}
              items={v.rows}
              properties={v.properties}
              byProperty={v.properties.length > 1}
              photos={v.includeFiles}
              thumbnail={(id) => api.sharedThumbnailUrl(token, id)}
              files={v.includeFiles ? v.files : undefined}
              fileUrl={(id) => api.sharedFileUrl(token, id)}
            />
          </>
        )}
      </main>
    </div>
  );
}
