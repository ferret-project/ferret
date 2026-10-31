/**
 * The insurance report: a cover (totals, properties), summaries by property,
 * room and category, then every item with its photo, grouped by where it is.
 * Print it or "Save as PDF" from the browser; the CSV download has the same
 * items as a spreadsheet. Laid out for US Letter with FlyonUI tables.
 */
import { BarSearch } from "./Nav";
import type { ExportRow, PlacesTree } from "@ferret/shared";
import { today } from "@ferret/shared/utils";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "./lib/api";
import { authClient } from "./lib/auth";
import { usePlaces } from "./lib/places";
import { money } from "./Overview";
import { PROPERTY_TYPES } from "./Places";
import { HelpLink } from "./HelpLink";
import { ShareButton } from "./Shares";

type Group = { name: string; items: number; valueCents: number; unvalued: number };

function groupBy(rows: ExportRow[], key: (r: ExportRow) => string): Group[] {
  const groups = new Map<string, Group>();
  for (const r of rows) {
    const name = key(r);
    const g = groups.get(name) ?? { name, items: 0, valueCents: 0, unvalued: 0 };
    g.items++;
    if (r.totalValueCents == null) g.unvalued++;
    else g.valueCents += r.totalValueCents;
    groups.set(name, g);
  }
  return [...groups.values()].sort((a, b) => b.valueCents - a.valueCents);
}

const property = (r: ExportRow) => r.place?.split(" › ")[0] ?? "Not placed";
const room = (r: ExportRow) => r.place?.split(" › ").slice(0, 2).join(" › ") ?? "Not placed";
const longDate = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
const shortDate = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

export function Report({ householdName, householdId }: { householdName: string; householdId: string }) {
  const [propertyId, setPropertyId] = useState("");
  const [photos, setPhotos] = useState(true);
  const places = usePlaces(householdId);
  const { data: session } = authClient.useSession();
  const rows = useQuery({ queryKey: ["export", householdId, propertyId], queryFn: () => api.exportItems(propertyId || undefined) });
  const items = rows.data?.data ?? [];
  const properties = (places.data?.properties ?? []).filter((p) => !propertyId || p.id === propertyId);
  return (
    <div className="min-h-dvh bg-base-200 print:bg-white">
      <nav className="navbar sticky top-0 z-10 border-b border-base-300 bg-base-100/85 backdrop-blur-md px-4 print:hidden">
        <div className="navbar-start items-center gap-2">
          <a href="#/" className="btn btn-text btn-sm btn-square" aria-label="Back to your stuff">
            <span className="icon-[tabler--arrow-left] size-5" />
          </a>
          <h1 className="text-lg font-semibold">Insurance report</h1>
          <HelpLink page="guide/insurance-report.html" label="Insurance report" />
        </div>
        <BarSearch />
      </nav>

      <main className="mx-auto flex max-w-4xl flex-col gap-4 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] print:max-w-none print:p-0">
        <section className="card print:hidden">
          <div className="card-body gap-4 p-4 sm:p-6">
            <p className="text-sm text-base-content/70">
              Everything you own, what it's worth and the proof — for your insurer, or to keep somewhere safe. Save it as a PDF from the print
              menu (on iPhone: Share → Print, then Share again → Save to Files).
            </p>
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-0 flex-1 basis-48">
                <label className="label-text" htmlFor="report-property">
                  Property
                </label>
                <select id="report-property" className="select" value={propertyId} onChange={(e) => setPropertyId(e.target.value)}>
                  <option value="">All properties</option>
                  {places.data?.properties.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
              <label className="flex h-11 items-center gap-2">
                <input type="checkbox" className="switch switch-primary" checked={photos} onChange={(e) => setPhotos(e.target.checked)} />
                <span className="label-text text-base">Photos</span>
              </label>
            </div>
            <div className="flex flex-wrap gap-3">
              <button type="button" className="btn btn-wrap btn-primary" disabled={!rows.data} onClick={() => window.print()}>
                <span className="icon-[tabler--printer] size-5" />
                Print or save as PDF
              </button>
              <a className="btn btn-wrap btn-soft btn-primary" href={api.exportCsvUrl(propertyId || undefined)} download>
                <span className="icon-[tabler--file-spreadsheet] size-5" />
                Download spreadsheet (CSV)
              </a>
              <ShareButton
                householdId={householdId}
                target={{ kind: "report", propertyId: propertyId || null }}
                what={propertyId ? `the report for ${properties[0]?.name ?? "this property"}` : "the insurance report"}
                className="btn btn-wrap btn-soft btn-primary"
              />
            </div>
          </div>
        </section>

        {rows.isPending && <span className="loading loading-spinner text-primary mx-auto my-12" />}
        {rows.isError && <div className="alert alert-soft alert-error">{rows.error.message}</div>}

        {rows.data && (
          <ReportDocument
            title={householdName}
            preparedBy={session?.user.name ?? null}
            items={items}
            properties={properties.map((p) => ({ name: p.name, type: p.type, details: p.details }))}
            byProperty={!propertyId && properties.length > 1}
            photos={photos}
            thumbnail={api.thumbnailUrl}
          />
        )}
      </main>
    </div>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-gray-600">{label}</dt>
      <dd className="text-xl font-semibold">{value}</dd>
    </div>
  );
}

function Summary({ title, groups }: { title: string; groups: Group[] }) {
  return (
    <section className="break-inside-avoid">
      <h2 className="text-base font-semibold">{title}</h2>
      <table className="mt-1 w-full text-left text-[9.5pt]">
        <tbody>
          {groups.map((g) => (
            <tr key={g.name} className="border-t border-gray-200">
              <td className="py-1 pe-2">{g.name}</td>
              <td className="py-1 pe-2 text-end text-gray-600">{g.items}</td>
              <td className="py-1 text-end font-semibold">{money(g.valueCents)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/** The report itself (a white page that prints): the app's report and what a share link shows (Shared.tsx). */
export function ReportDocument({
  title,
  subtitle,
  preparedBy,
  items,
  properties,
  byProperty,
  photos,
  thumbnail,
  files,
  fileUrl,
}: {
  title: string;
  subtitle?: string;
  preparedBy: string | null;
  items: ExportRow[];
  properties: Pick<PlacesTree["properties"][number], "name" | "type" | "details">[];
  byProperty: boolean;
  photos: boolean;
  thumbnail: (photoId: string) => string;
  /** Shared with files: each item's photos and documents, linked. */
  files?: Record<string, { id: string; filename: string }[]>;
  fileUrl?: (id: string) => string;
}) {
  const total = items.reduce((sum, r) => sum + (r.totalValueCents ?? 0), 0);
  const withPhotos = items.filter((r) => r.photos > 0).length;
  const withReceipts = items.filter((r) => r.documents > 0).length;
  const unvalued = items.filter((r) => r.totalValueCents == null).length;
  const byPlace = items.reduce<[string, ExportRow[]][]>((list, r) => {
    const place = r.place ?? "Not in a place";
    const last = list.at(-1);
    if (last && last[0] === place) last[1].push(r);
    else list.push([place, [r]]);
    return list;
  }, []);
  return (
    <article className="rounded-box bg-white p-6 text-black shadow-sm print:rounded-none print:p-0 print:shadow-none sm:p-10">
              {/* Cover */}
              <header className="border-b border-gray-300 pb-5">
                <p className="text-sm text-gray-600">🐾 Ferret · Home inventory</p>
                <h1 className="mt-1 text-3xl font-bold">{title}</h1>
                {subtitle && <p className="mt-1 text-lg">{subtitle}</p>}
                <p className="mt-1 text-sm text-gray-600">
                  Prepared {longDate(today())}
                  {preparedBy ? ` by ${preparedBy}` : ""}
                </p>
                <dl className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-4">
                  <Figure label="Total value" value={money(total)} />
                  <Figure label="Items" value={items.length.toLocaleString()} />
                  <Figure label="With photos" value={`${withPhotos} of ${items.length}`} />
                  <Figure label="With receipts" value={`${withReceipts} of ${items.length}`} />
                </dl>
                {unvalued > 0 && (
                  <p className="mt-3 text-sm text-gray-600">
                    {unvalued} {unvalued === 1 ? "item has" : "items have"} no value or price recorded and {unvalued === 1 ? "isn't" : "aren't"} in the total.
                  </p>
                )}
              </header>
  
              {properties.length > 0 && (
                <section className="mt-6 break-inside-avoid">
                  <h2 className="text-lg font-semibold">Properties</h2>
                  <div className="mt-2 grid gap-3 sm:grid-cols-2">
                    {properties.map((p) => {
                      const d = p.details;
                      const address = [d.street, [d.city, d.region, d.postalCode].filter(Boolean).join(" "), d.country].filter(Boolean).join(", ");
                      return (
                        <div key={p.name} className="rounded-lg border border-gray-300 p-3 text-sm">
                          <p className="font-semibold">
                            {p.name} <span className="font-normal text-gray-600">· {PROPERTY_TYPES[p.type].label}</span>
                          </p>
                          {address && <p>{address}</p>}
                          {(d.yearBuilt || d.valueCents != null) && (
                            <p className="text-gray-600">
                              {[d.yearBuilt && `Built ${d.yearBuilt}`, d.valueCents != null && `Valued at ${money(d.valueCents)}`].filter(Boolean).join(" · ")}
                            </p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </section>
              )}
  
              <div className="mt-6 grid gap-6 sm:grid-cols-2 print:grid-cols-2">
                {byProperty && <Summary title="By property" groups={groupBy(items, property)} />}
                <Summary title="By room" groups={groupBy(items, room)} />
                <Summary title="By category" groups={groupBy(items, (r) => r.category?.split(" › ")[0] ?? "No category")} />
              </div>
  
              {/* Every item, grouped by where it is */}
              <section className="mt-8">
                <h2 className="text-lg font-semibold">Items</h2>
                {byPlace.map(([place, list]) => (
                  <div key={place} className="mt-4">
                    <h3 className="break-after-avoid border-b border-gray-300 pb-1 text-sm font-semibold text-gray-700">
                      {place}
                      <span className="font-normal text-gray-500">
                        {" "}
                        · {list.length} {list.length === 1 ? "item" : "items"} · {money(list.reduce((s, r) => s + (r.totalValueCents ?? 0), 0))}
                      </span>
                    </h3>
                    <table className="w-full text-left text-[9.5pt]">
                      <thead className="text-gray-500">
                        <tr>
                          {photos && <th className="w-[0.75in] py-1 font-normal" aria-label="Photo" />}
                          <th className="py-1 font-normal">Item</th>
                          <th className="py-1 font-normal max-sm:hidden print:table-cell">Bought</th>
                          <th className="py-1 text-end font-normal">Value</th>
                        </tr>
                      </thead>
                      <tbody>
                        {list.map((r) => (
                          <tr key={r.id} className="break-inside-avoid border-t border-gray-200 align-top">
                            {photos && (
                              <td className="py-1.5 pe-2">
                                {r.photoId ? (
                                  <img src={thumbnail(r.photoId)} alt="" className="h-[0.65in] w-[0.65in] rounded object-cover" />
                                ) : (
                                  <span className="block h-[0.65in] w-[0.65in] rounded bg-gray-100" />
                                )}
                              </td>
                            )}
                            <td className="py-1.5 pe-2">
                              <p className="font-semibold">
                                {r.name}
                                {r.quantity !== 1 && <span className="font-normal"> × {r.quantity}</span>}
                              </p>
                              <p className="text-gray-700">
                                {[r.brand, r.model, r.serialNumber && `S/N ${r.serialNumber}`, r.condition && `${r.condition} condition`]
                                  .filter(Boolean)
                                  .join(" · ")}
                              </p>
                              <p className="text-gray-500">
                                {[
                                  r.box && `In ${r.box}`,
                                  r.category,
                                  r.photos ? `${r.photos} ${r.photos === 1 ? "photo" : "photos"}` : null,
                                  r.documents ? `${r.documents} ${r.documents === 1 ? "receipt/document" : "receipts/documents"}` : null,
                                  r.warrantyEnds && `warranty until ${shortDate(r.warrantyEnds)}`,
                                ]
                                  .filter(Boolean)
                                  .join(" · ")}
                              </p>
                              {files?.[r.id] && fileUrl && (
                                <p className="mt-0.5 flex flex-wrap gap-x-3 print:hidden">
                                  {files[r.id]!.map((f) => (
                                    <a key={f.id} href={fileUrl(f.id)} target="_blank" rel="noreferrer" className="text-[#7a3e1d] underline">
                                      {f.filename}
                                    </a>
                                  ))}
                                </p>
                              )}
                            </td>
                            <td className="whitespace-nowrap py-1.5 pe-2 text-gray-700 max-sm:hidden print:table-cell">
                              {r.purchaseDate && <p>{shortDate(r.purchaseDate)}</p>}
                              {r.purchasePriceCents != null && <p>{money(r.purchasePriceCents)} each</p>}
                            </td>
                            <td className="whitespace-nowrap py-1.5 text-end font-semibold">
                              {r.totalValueCents != null ? money(r.totalValueCents) : <span className="font-normal text-gray-400">—</span>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))}
                {items.length === 0 && <p className="mt-2 text-sm text-gray-600">No items yet.</p>}
              </section>
  
              <footer className="mt-8 border-t border-gray-300 pt-3 text-xs text-gray-500">
                Values are the owner's records: the current value where given, otherwise the price paid, times the quantity.{" "}
                {files ? "Photos, receipts and manuals open from each item's links." : "Photos, receipts and manuals are kept in Ferret and can be provided on request."}
              </footer>
            </article>
  );
}
