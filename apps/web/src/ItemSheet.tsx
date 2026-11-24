/**
 * #/items/:id/sheet — everything about one thing on one page: its details, notes, links, warranties and claims,
 * maintenance and when it was done, repairs, loans, stock, photos, documents and history, each part ticked or not at
 * the top. Print it (or save it as a PDF from the print dialog), or download it as a signed ZIP — the same sheet as
 * Markdown, its files, item.json, and a signature anyone can check with the household's public key (printed at the
 * bottom of the page too). The server writes the sheet (lib/item-sheet.ts), so the page and the ZIP say the same.
 */
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { t, ph, msg } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useLingui } from "@lingui/react";
import type { MessageDescriptor } from "@lingui/core";
import { useState } from "react";
import type { ItemSheet as Sheet } from "@ferret/shared";
import { type ItemSheetPart, itemSheetParts } from "@ferret/shared/utils";
import { api } from "./lib/api";
import { TopBar } from "./Nav";
import { itemHref } from "./lib/route";
import { NotFound } from "./NotFound";
import { PawMark } from "./AuthLayout";

const PART_WORDS: Record<ItemSheetPart, MessageDescriptor> = {
  photos: msg`Photos`,
  documents: msg`Documents`,
  notes: msg`Notes`,
  links: msg`Links`,
  warranties: msg`Warranties`,
  maintenance: msg`Maintenance`,
  repairs: msg`Repairs`,
  loans: msg`Loans`,
  stock: msg`Stock`,
  history: msg`History`,
};

const today = () => new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });

export function ItemSheet({ itemId, householdId }: { itemId: string; householdId: string }) {
  const { i18n } = useLingui();
  const [parts, setParts] = useState<ItemSheetPart[]>([...itemSheetParts]);
  const sheet = useQuery({
    queryKey: ["item", householdId, itemId, "sheet", parts.join(",")],
    queryFn: () => api.itemSheet(itemId, parts),
    placeholderData: keepPreviousData,
  });
  const key = useQuery({ queryKey: ["signing-key", householdId], queryFn: api.signingKey, staleTime: Infinity });
  const toggle = (p: ItemSheetPart) => setParts((list) => (list.includes(p) ? list.filter((x) => x !== p) : itemSheetParts.filter((x) => x === p || list.includes(x))));

  if (sheet.isError && !sheet.data) return <NotFound />;
  return (
    <div className="min-h-dvh bg-base-200 print:bg-white">
      <TopBar title={sheet.data?.name ?? t`Item`} back={itemHref(itemId)} />
      <main className="mx-auto flex max-w-4xl flex-col gap-4 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] print:max-w-none print:p-0">
        <section className="card print:hidden">
          <div className="card-body gap-4 p-4 sm:p-6">
            <p className="text-sm text-base-content/70">
              <Trans>
                Everything about this thing on one page — print it, save it as a PDF from the print dialog, or download it as a signed ZIP: Markdown with its photos and documents, which anyone can check
                hasn't changed with your household's public key.
              </Trans>
            </p>
            <fieldset>
              <legend className="mb-1 text-sm font-medium"><Trans>Include</Trans></legend>
              <div className="flex flex-wrap gap-x-5">
                {itemSheetParts.map((p) => (
                  <label key={p} className="flex h-11 items-center gap-2">
                    <input type="checkbox" className="checkbox checkbox-primary" checked={parts.includes(p)} onChange={() => toggle(p)} />
                    <span className="label-text text-base">{i18n._(PART_WORDS[p])}</span>
                  </label>
                ))}
              </div>
              <p className="mt-1 text-xs text-base-content/70"><Trans>Its details (what it is, where, what it cost) are always included.</Trans></p>
            </fieldset>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn btn-wrap btn-primary" disabled={!sheet.data || sheet.isFetching} onClick={() => window.print()}>
                <span className="icon-[tabler--printer] size-5" />
                <Trans>Print or save as PDF</Trans>
              </button>
              {/* A link, not a fetch: the browser saves the ZIP as the server streams it. */}
              <a className={`btn btn-wrap btn-soft ${sheet.data ? "" : "btn-disabled"}`} href={api.itemExportUrl(itemId, parts)} download>
                <span className="icon-[tabler--file-zip] size-5" />
                <Trans>Download signed ZIP</Trans>
              </a>
            </div>
            {sheet.isError && <p className="text-sm text-error">{sheet.error.message}</p>}
          </div>
        </section>
        {!sheet.data ? <span className="loading loading-spinner text-primary mx-auto my-12" /> : <SheetPage sheet={sheet.data} fingerprint={key.data?.fingerprint} publicKey={key.data?.publicKey} />}
      </main>
    </div>
  );
}

/** The sheet as a white page that prints, with Ferret's mark and the household's public key at the bottom. */
function SheetPage({ sheet: s, fingerprint, publicKey }: { sheet: Sheet; fingerprint?: string; publicKey?: string }) {
  const field = ([label, value]: [string, string]) => (
    <div key={label} className="contents">
      <dt className="text-gray-600">{label}</dt>
      <dd className="whitespace-pre-line">{value}</dd>
    </div>
  );
  return (
    <article className="rounded-box bg-white p-6 text-black shadow-sm print:rounded-none print:p-0 print:shadow-none sm:p-10">
      <header className="flex items-start gap-4 border-b border-gray-300 pb-4">
        <div className="min-w-0 grow">
          <h1 className="text-2xl font-semibold">{s.name}</h1>
          {s.subtitle.length > 0 && <p className="mt-1 text-gray-700">{s.subtitle.join(" · ")}</p>}
        </div>
        {/* Ferret's paw and name, so a printed or saved sheet says where it came from. */}
        <span className="flex shrink-0 items-center gap-1.5 text-lg font-bold tracking-tight text-primary print:[print-color-adjust:exact]">
          <PawMark className="size-6" party={false} />
          <Trans>Ferret</Trans>
        </span>
      </header>
      {s.photos.length > 0 && (
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 print:grid-cols-3">
          {s.photos.map((p) => (
            <img key={p.id} src={api.attachmentUrl(p.id)} alt={p.description || p.filename} className="aspect-4/3 w-full break-inside-avoid rounded bg-gray-100 object-contain" />
          ))}
        </div>
      )}
      {s.sections.map((sec) => (
        <section key={sec.id} className="mt-6" aria-labelledby={`sheet-${sec.id}`}>
          <h2 id={`sheet-${sec.id}`} className="break-after-avoid border-b border-gray-200 pb-1 text-lg font-semibold">{sec.title}</h2>
          {sec.rows && sec.rows.length > 0 && <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">{sec.rows.map(field)}</dl>}
          {sec.text && <p className="mt-2 whitespace-pre-line text-sm">{sec.text}</p>}
          {sec.links && (
            <ul className="mt-2 list-disc ps-5 text-sm">
              {sec.links.map((l) => (
                <li key={l.url}>
                  {l.label}
                  {l.label !== l.url && <span className="break-all text-gray-600"> — {l.url}</span>}
                </li>
              ))}
            </ul>
          )}
          {sec.entries?.map((e, i) => (
            <div key={i} className="mt-3 break-inside-avoid">
              <h3 className="font-semibold">{e.title}</h3>
              {e.rows.length > 0 && <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-sm">{e.rows.map(field)}</dl>}
              {e.text && <p className="mt-1 whitespace-pre-line text-sm">{e.text}</p>}
              {e.lines && e.lines.length > 0 && <ul className="mt-1 list-disc ps-5 text-sm">{e.lines.map((l, j) => <li key={j}>{l}</li>)}</ul>}
            </div>
          ))}
          {sec.lines && sec.lines.length > 0 && <ul className="mt-2 list-disc ps-5 text-sm">{sec.lines.map((l, j) => <li key={j}>{l}</li>)}</ul>}
        </section>
      ))}
      {s.documents.length > 0 && (
        <section className="mt-6" aria-labelledby="sheet-documents">
          <h2 id="sheet-documents" className="border-b border-gray-200 pb-1 text-lg font-semibold"><Trans>Documents</Trans></h2>
          <ul className="mt-2 list-disc ps-5 text-sm">{s.documents.map((f) => <li key={f.id}>{f.filename}</li>)}</ul>
        </section>
      )}
      <footer className="mt-8 space-y-1 border-t border-gray-300 pt-3 text-xs text-gray-600">
        <p className="flex items-center gap-2">
          <PawMark className="size-4 shrink-0 text-primary print:[print-color-adjust:exact]" party={false} />
          <span className="break-all"><Trans>From Ferret, {ph({ date: today() })}: {ph({ url: s.url })}</Trans></span>
        </p>
        {fingerprint && publicKey && (
          <>
            <p><Trans>Household signing key: {ph({ fingerprint })}</Trans></p>
            <p className="break-all font-mono text-[0.65rem] leading-snug">{publicKey}</p>
          </>
        )}
      </footer>
    </article>
  );
}
