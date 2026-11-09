import { tn } from "./i18n";
import { t as translateText } from "./i18n";
import { tr } from "./i18n";
/**
 * Everything (`#/items`): every thing you have, as a list (phones) or a table (wider screens) — filtered by where it
 * came from, its category, place or tag, or what it's missing; sorted; a page at a time. In the table, tick things to
 * move, file, tag or delete them together, and click a row to see it at a glance beside the table.
 */
import type { ItemListing, ItemOrigin, ItemSort, ItemsBulk, ItemsBulkResult, MissingDetail } from "@ferret/shared";
import { missingDetails } from "@ferret/shared/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { CategoryPicker, flattenCategories, useCategories, useTags } from "./Catalog";
import { PlacePicker } from "./Combobox";
import { ItemRow } from "./ItemRow";
import { DialogActions, Modal } from "./Modal";
import { MISSING_LABELS } from "./Overview";
import { money } from "./lib/money";
import { api } from "./lib/api";
import { type ExtraFilters, PlainWordsFilter } from "./PlainWordsFilter";
import { useCanEdit } from "./lib/auth";
import { ORIGIN_FILTER, itemOriginList } from "./lib/origin";
import { findLocation, usePlaces } from "./lib/places";
import { ITEMS_HREF, addedHref, itemHref, missingHref } from "./lib/route";
import { navigateTo } from "./lib/navigate";
import { Mascot } from "./Mascot";

const PAGE = 50;
const SORTS: { value: ItemSort; label: string; dir: "asc" | "desc" }[] = [
  { value: "updated", get label() { return translateText("Last changed"); }, dir: "desc" },
  { value: "added", get label() { return translateText("Newest"); }, dir: "desc" },
  { value: "name", get label() { return translateText("Name"); }, dir: "asc" },
  { value: "value", get label() { return translateText("Most valuable"); }, dir: "desc" },
  { value: "bought", get label() { return translateText("Bought most recently"); }, dir: "desc" },
  { value: "scanned", get label() { return translateText("Scanned most recently"); }, dir: "desc" },
];
/** "Last scanned": not in this many months (never scanned counts). */
const UNSCANNED = [
  { value: "1", get label() { return translateText("Not in a month"); } },
  { value: "6", get label() { return translateText("Not in 6 months"); } },
  { value: "12", get label() { return translateText("Not in a year"); } },
] as const;
/** The day `months` ago, on this device's calendar. */
function monthsAgo(months: number) {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
type Layout = "list" | "table";
const LAYOUT_KEY = "ferret-everything-layout";

function storedLayout(): Layout {
  try {
    return localStorage.getItem(LAYOUT_KEY) === "list" ? "list" : "table";
  } catch {
    return "table";
  }
}

/** Wider than a phone: the table fits. */
function useWide() {
  const query = "(min-width: 48rem)";
  const [wide, setWide] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setWide(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return wide;
}

/** `sort`: the order to start in, from the address (`#/items?sort=value` — the dashboard's Worth). */
export function Everything(props: { householdId: string; missing?: MissingDetail; origin?: ItemOrigin; placeFrom?: string; sort?: string }) {
  const { householdId } = props;
  // Filters from plain words (AI-2) that the filter bar has no control for, shown as chips.
  const [extra, setExtra] = useState<ExtraFilters>({});
  const missing = props.missing ?? extra.missing;
  const origin = props.origin ?? extra.origin;
  const startSort = SORTS.find((s) => s.value === props.sort);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [locationId, setLocationId] = useState<string | null>(null);
  const [tag, setTag] = useState("");
  const [unscanned, setUnscanned] = useState("");
  const [sort, setSort] = useState<{ by: ItemSort; dir: "asc" | "desc" }>(startSort ? { by: startSort.value, dir: startSort.dir } : { by: "updated", dir: "desc" });
  const [page, setPage] = useState(0);
  const [layout, setLayoutState] = useState<Layout>(storedLayout);
  const wide = useWide();
  const table = wide && layout === "table";
  const setLayout = (l: Layout) => {
    setLayoutState(l);
    try {
      localStorage.setItem(LAYOUT_KEY, l);
    } catch {
      // Remembering it is only a convenience.
    }
  };
  const filters = {
    categoryId: categoryId ?? undefined,
    locationId: locationId ?? undefined,
    tag: tag || undefined,
    missing,
    origin,
    notScannedSince: unscanned ? monthsAgo(Number(unscanned)) : undefined,
    minWorth: extra.minWorth,
    maxWorth: extra.maxWorth,
    boughtFrom: extra.boughtFrom,
    boughtTo: extra.boughtTo,
  };
  // A new filter or order starts again at the first page.
  const filterKey = JSON.stringify([filters, sort]);
  useEffect(() => setPage(0), [filterKey]);
  const items = useQuery({
    queryKey: ["items", householdId, "everything", filters, extra.q, sort, page],
    queryFn: () => api.listItems(extra.q, { ...filters, sort: sort.by, dir: sort.dir, limit: PAGE, offset: page * PAGE }),
    placeholderData: (previous) => previous,
  });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [peek, setPeek] = useState<ItemListing | null>(null);
  // What the last bulk change did.
  const [result, setResult] = useState<ItemsBulkResult | null>(null);
  const filtered = Boolean(categoryId || locationId || tag || missing || origin || unscanned || Object.keys(extra).length);
  const total = items.data?.total ?? 0;
  const rows = items.data?.data ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-base-content">
            {missing ? MISSING_LABELS[missing].filter : origin ? ORIGIN_FILTER[origin] : translateText("Everything")}
          </h1>
          {items.data && (
            <p className="text-sm text-base-content/70" aria-live="polite">
              {total} {total === 1 ? translateText("thing") : translateText("things")}
              {items.data.valueCents ? ` · ${money(items.data.valueCents)}` : ""}
            </p>
          )}
        </div>
        {wide && (
          <div className="join" role="group" aria-label={translateText("Show as")}>
            {(["table", "list"] as const).map((l) => (
              <button
                key={l}
                type="button"
                className={`btn btn-sm join-item ${layout === l ? "btn-primary" : "btn-soft"}`}
                aria-pressed={layout === l}
                onClick={() => setLayout(l)}
              >
                <span className={`${l === "table" ? "icon-[tabler--table]" : "icon-[tabler--list]"} size-4`} />
                {l === "table" ? translateText("Table") : translateText("List")}
              </button>
            ))}
          </div>
        )}
      </div>

      <PlainWordsFilter
        extra={extra}
        onExtra={setExtra}
        onFilters={(f) => {
          setCategoryId(f.categoryId ?? null);
          setLocationId(f.locationId ?? null);
          setTag(f.tag ?? "");
          setUnscanned(f.unscanned ?? "");
        }}
      />
      <FilterBar
        householdId={householdId}
        missing={missing}
        origin={origin}
        categoryId={categoryId}
        onCategory={setCategoryId}
        locationId={locationId}
        onLocation={setLocationId}
        tag={tag}
        onTag={setTag}
        unscanned={unscanned}
        onUnscanned={setUnscanned}
        sort={sort}
        onSort={setSort}
        folded={!wide}
        onClear={
          filtered
            ? () => {
                setCategoryId(null);
                setLocationId(null);
                setTag("");
                setUnscanned("");
                setExtra({});
                if (props.missing || props.origin) navigateTo(ITEMS_HREF);
              }
            : undefined
        }
      />

      {items.isError && <div className="alert alert-soft alert-error">{items.error.message}</div>}

      {table ? (
        <>
          {selected.size > 0 && (
            <BulkBar
              householdId={householdId}
              ids={[...selected]}
              rows={rows}
              onClear={() => setSelected(new Set())}
              onDone={(r) => {
                setSelected(new Set());
                setResult(r);
              }}
            />
          )}
          {result && (
        <div className={`alert alert-soft ${result.failed.length ? "alert-warning" : "alert-success"} text-sm`} role="status">{tr("{v0} changed", { v0: result.done })}{result.failed.length > 0 && translateText(" · {v0} couldn't be: {v1}", { v0: result.failed.length, v1: [...new Set(result.failed.map((f) => f.reason))].join("; ") })}
          <button type="button" className="btn btn-text btn-xs ms-auto" onClick={() => setResult(null)} aria-label={translateText("Dismiss")}>
            <span className="icon-[tabler--x] size-4" />
          </button>
        </div>
      )}

          <ItemTable
            householdId={householdId}
            rows={rows}
            sort={sort}
            onSort={setSort}
            selected={selected}
            onSelect={setSelected}
            onPeek={setPeek}
            peeked={peek?.id}
          />
        </>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((item) => (
            <ItemRow key={item.id} item={item} placeFrom={props.placeFrom} />
          ))}
        </ul>
      )}

      {items.data && total === 0 && (
        <div className="flex flex-col items-center gap-4 py-12 text-center text-base-content/70">
          {!filtered && <Mascot pose="box" />}
          {filtered && (missing && !categoryId && !locationId && !tag ? <Mascot pose="asleep" /> : <Mascot pose="searching" />)}
          {filtered
            ? missing && !categoryId && !locationId && !tag
              ? translateText("All done — nothing is missing that.")
              : origin && !categoryId && !locationId && !tag
                ? translateText("Nothing added this way yet.")
                : translateText("Nothing matches these filters.")
            : translateText("Nothing here yet — + Add puts in your first thing.")}
        </div>
      )}

      {total > PAGE && <Pager page={page} pages={Math.ceil(total / PAGE)} total={total} onPage={setPage} />}

      {peek && table && <QuickView householdId={householdId} item={rows.find((r) => r.id === peek.id) ?? peek} onClose={() => setPeek(null)} />}
    </div>
  );
}

/** What to show: where it came from, its category, place or tag, what it's missing — and the order. */
function FilterBar(props: {
  householdId: string;
  missing?: MissingDetail;
  origin?: ItemOrigin;
  categoryId: string | null;
  onCategory: (id: string | null) => void;
  locationId: string | null;
  onLocation: (id: string | null) => void;
  tag: string;
  onTag: (tag: string) => void;
  /** "Last scanned": not in this many months ("" = any). */
  unscanned: string;
  onUnscanned: (months: string) => void;
  sort: { by: ItemSort; dir: "asc" | "desc" };
  onSort: (sort: { by: ItemSort; dir: "asc" | "desc" }) => void;
  onClear?: () => void;
  /** Phones: behind a button until opened. */
  folded?: boolean;
}) {
  const categories = useCategories(props.householdId);
  const tags = useTags(props.householdId);
  const [open, setOpen] = useState(false);
  const sortValue = SORTS.find((s) => s.value === props.sort.by && s.dir === props.sort.dir)?.value ?? "";
  const active = [props.origin, props.missing, props.categoryId, props.locationId, props.tag, props.unscanned].filter(Boolean).length;
  if (props.folded && !open) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn-soft btn-primary btn-sm" aria-expanded={false} onClick={() => setOpen(true)}>
          <span className="icon-[tabler--adjustments-horizontal] size-4" />
          {translateText("Filter and sort")}{active > 0 && <span className="badge badge-primary badge-sm">{active}</span>}
        </button>
        {props.onClear && (
          <button type="button" className="btn btn-text btn-sm" onClick={props.onClear}>
            {translateText("Clear filters")}</button>
        )}
      </div>
    );
  }
  return (
    <section className="card" aria-label={translateText("Filters")}>
      <div className="card-body grid grid-cols-1 gap-3 p-3 @container sm:p-4">
        <div className="grid grid-cols-1 gap-3 @lg:grid-cols-3 @5xl:grid-cols-7">
          <Field label={translateText("Where from")} id="filter-origin">
            <select
              id="filter-origin"
              className="select"
              value={props.origin ?? ""}
              // Missing and where-from are links (the dashboard opens them), so they live in the address.
              onChange={(e) => navigateTo(e.target.value ? addedHref(e.target.value as ItemOrigin) : ITEMS_HREF)}
            >
              <option value="">{translateText("Anywhere")}</option>
              {itemOriginList.map((o) => (
                <option key={o} value={o}>
                  {ORIGIN_FILTER[o]}
                </option>
              ))}
            </select>
          </Field>
          <Field label={translateText("Missing")} id="filter-missing">
            <select
              id="filter-missing"
              className="select"
              value={props.missing ?? ""}
              onChange={(e) => navigateTo(e.target.value ? missingHref(e.target.value as MissingDetail) : ITEMS_HREF)}
            >
              <option value="">{translateText("Anything")}</option>
              {missingDetails.map((d) => (
                <option key={d} value={d}>
                  {MISSING_LABELS[d].filter}
                </option>
              ))}
            </select>
          </Field>
          <Field label={translateText("Category")} id="filter-category">
            <select
              id="filter-category"
              className="select"
              value={props.categoryId ?? ""}
              onChange={(e) => props.onCategory(e.target.value || null)}
              disabled={!categories.data?.length}
            >
              <option value="">{translateText("Any category")}</option>
              {flattenCategories(categories.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {" ".repeat(c.depth)}
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <PlacePicker
            householdId={props.householdId}
            id="filter-place"
            name="locationId"
            label={translateText("Place")}
            noneLabel={translateText("Anywhere")}
            value={props.locationId}
            onChange={props.onLocation}
          />
          <Field label={translateText("Tag")} id="filter-tag">
            <select id="filter-tag" className="select" value={props.tag} onChange={(e) => props.onTag(e.target.value)} disabled={!tags.data?.length}>
              <option value="">{translateText("Any tag")}</option>
              {(tags.data ?? []).map((t) => (
                <option key={t.id} value={t.name}>
                  {t.name} ({t.items})
                </option>
              ))}
            </select>
          </Field>
          <Field label={translateText("Last scanned")} id="filter-scanned">
            <select id="filter-scanned" className="select" value={props.unscanned} onChange={(e) => props.onUnscanned(e.target.value)}>
              <option value="">{translateText("Any time")}</option>
              {UNSCANNED.map((u) => (
                <option key={u.value} value={u.value}>
                  {u.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label={translateText("Order")} id="filter-sort">
            <select
              id="filter-sort"
              className="select"
              value={sortValue}
              onChange={(e) => {
                const s = SORTS.find((x) => x.value === e.target.value)!;
                props.onSort({ by: s.value, dir: s.dir });
              }}
            >
              {!sortValue && <option value="">{translateText("As in the table")}</option>}
              {SORTS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {(props.onClear || props.folded) && (
          <div className="flex flex-wrap gap-2">
            {props.folded && (
              <button type="button" className="btn btn-soft btn-primary btn-sm" aria-expanded onClick={() => setOpen(false)}>
                <span className="icon-[tabler--chevron-up] size-4" />
                {translateText("Done")}</button>
            )}
            {props.onClear && (
              <button type="button" className="btn btn-text btn-sm" onClick={props.onClear}>
                <span className="icon-[tabler--filter-off] size-4" />
                {translateText("Clear filters")}</button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function Field(props: { label: string; id: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <label className="label-text" htmlFor={props.id}>
        {props.label}
      </label>
      {props.children}
    </div>
  );
}

const COLUMNS: { key: string; label: string; sort?: ItemSort; firstDir?: "asc" | "desc"; className?: string }[] = [
  { key: "name", get label() { return translateText("Name"); }, sort: "name", firstDir: "asc" },
  { key: "place", get label() { return translateText("Where"); } },
  { key: "category", get label() { return translateText("Category"); }, get className() { return "max-lg:hidden"; } },
  { key: "brand", get label() { return translateText("Brand"); }, get className() { return "max-xl:hidden"; } },
  { key: "value", get label() { return translateText("Value"); }, sort: "value", firstDir: "desc", className: "text-end" },
  { key: "bought", get label() { return translateText("Bought"); }, sort: "bought", firstDir: "desc", get className() { return "max-lg:hidden"; } },
];

/** The table: sortable headings, a tick box per row (and one for the page), a click opens the quick view. */
function ItemTable(props: {
  householdId: string;
  rows: ItemListing[];
  sort: { by: ItemSort; dir: "asc" | "desc" };
  onSort: (sort: { by: ItemSort; dir: "asc" | "desc" }) => void;
  selected: Set<string>;
  onSelect: (s: Set<string>) => void;
  onPeek: (item: ItemListing) => void;
  peeked?: string;
}) {
  const canEdit = useCanEdit(props.householdId);
  const { rows, selected } = props;
  const all = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const some = rows.some((r) => selected.has(r.id));
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    props.onSelect(next);
  };
  return (
    <div className="card overflow-x-auto">
      <table className="table">
        <thead>
          <tr>
            {canEdit && (
              <th className="w-10">
                <input
                  type="checkbox"
                  className="checkbox checkbox-primary checkbox-sm"
                  aria-label={translateText("Select everything on this page")}
                  checked={all}
                  ref={(el) => {
                    if (el) el.indeterminate = some && !all;
                  }}
                  onChange={() => {
                    const next = new Set(selected);
                    for (const r of rows) all ? next.delete(r.id) : next.add(r.id);
                    props.onSelect(next);
                  }}
                />
              </th>
            )}
            {COLUMNS.map((c) => {
              const active = c.sort && props.sort.by === c.sort;
              return (
                <th
                  key={c.key}
                  className={`normal-case ${c.className ?? ""}`}
                  aria-sort={active ? (props.sort.dir === "asc" ? "ascending" : "descending") : undefined}
                >
                  {c.sort ? (
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 font-semibold hover:text-primary"
                      onClick={() =>
                        props.onSort({
                          by: c.sort!,
                          dir: active ? (props.sort.dir === "asc" ? "desc" : "asc") : c.firstDir!,
                        })
                      }
                    >
                      {c.label}
                      <span
                        className={`size-4 ${active ? (props.sort.dir === "asc" ? "icon-[tabler--arrow-up]" : "icon-[tabler--arrow-down]") : "icon-[tabler--arrows-sort] text-base-content/40"}`}
                      />
                    </button>
                  ) : (
                    c.label
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((item) => (
            <tr
              key={item.id}
              className={`cursor-pointer hover:bg-base-200 ${props.peeked === item.id ? "bg-primary/10" : selected.has(item.id) ? "bg-base-200" : ""}`}
              onClick={() => props.onPeek(item)}
            >
              {canEdit && (
                <td onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    className="checkbox checkbox-primary checkbox-sm"
                    aria-label={translateText("Select {v0}", { v0: item.name })}
                    checked={selected.has(item.id)}
                    onChange={() => toggle(item.id)}
                  />
                </td>
              )}
              <td>
                <div className="flex items-center gap-3">
                  <Thumb item={item} className="size-10" />
                  <div className="min-w-0">
                    {/* The name opens the item; the rest of the row opens the quick view. */}
                    <a href={itemHref(item.id)} className="link link-hover font-medium text-base-content" onClick={(e) => e.stopPropagation()}>
                      {item.name}
                    </a>
                    {(item.isContainer || item.loan) && (
                      <p className="text-xs text-base-content/70">
                        {[item.isContainer && translateText("Box · {v0} inside", { v0: item.contents }), item.loan && (item.loan.direction === "lent" ? translateText("Lent to {v0}", { v0: item.loan.person }) : translateText("Borrowed from {v0}", { v0: item.loan.person }))]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                    )}
                  </div>
                </div>
              </td>
              <td className="max-w-64 truncate text-base-content/80" title={item.place ?? undefined}>
                {[item.container && translateText("In {v0}", { v0: item.container.name }), item.place].filter(Boolean).join(" · ") || <span className="text-base-content/70">—</span>}
              </td>
              <td className="max-w-48 truncate text-base-content/80 max-lg:hidden">{item.category ?? ""}</td>
              <td className="text-base-content/80 max-xl:hidden">{item.brand ?? ""}</td>
              <td className="text-end tabular-nums">{valueOf(item) != null ? money(valueOf(item)!) : ""}</td>
              <td className="tabular-nums text-base-content/80 max-lg:hidden">{item.purchaseDate ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const valueOf = (item: ItemListing) => item.valueCents ?? item.purchasePriceCents ?? null;

function Thumb({ item, className }: { item: ItemListing; className: string }) {
  return item.photoId ? (
    <img src={api.thumbnailUrl(item.photoId)} alt="" loading="lazy" className={`rounded-box bg-base-300 shrink-0 object-cover ${className}`} />
  ) : (
    <span className={`rounded-box bg-base-200 text-base-content/40 flex shrink-0 items-center justify-center ${className}`}>
      <span className={`${item.isContainer ? "icon-[tabler--package]" : "icon-[tabler--box]"} size-5`} />
    </span>
  );
}

function Pager(props: { page: number; pages: number; total: number; onPage: (p: number) => void }) {
  const from = props.page * PAGE + 1;
  const to = Math.min(props.total, (props.page + 1) * PAGE);
  const go = (p: number) => {
    props.onPage(p);
    window.scrollTo({ top: 0 });
  };
  return (
    <nav className="flex flex-wrap items-center justify-between gap-3" aria-label={translateText("Pages")}>
      <span className="text-sm text-base-content/70">{tr("{v0}–{v1} of {v2}", { v0: from, v1: to, v2: props.total })}</span>
      <div className="flex gap-2">
        <button type="button" className="btn btn-soft btn-sm" disabled={props.page === 0} onClick={() => go(props.page - 1)}>
          <span className="icon-[tabler--chevron-left] size-4" />
          {translateText("Previous")}</button>
        <button type="button" className="btn btn-soft btn-sm" disabled={props.page >= props.pages - 1} onClick={() => go(props.page + 1)}>
          {translateText("Next")}<span className="icon-[tabler--chevron-right] size-4" />
        </button>
      </div>
    </nav>
  );
}

type BulkAction = "move" | "category" | "tag" | "untag" | "delete";

/** What to do with the ticked things. */
function BulkBar(props: { householdId: string; ids: string[]; rows: ItemListing[]; onClear: () => void; onDone: (r: ItemsBulkResult) => void }) {
  const [action, setAction] = useState<BulkAction | null>(null);
  const n = props.ids.length;
  return (
    <>
      <div className="sticky top-18 z-[5] flex flex-wrap items-center gap-2 rounded-box border border-primary/30 bg-base-100 p-2 shadow-sm" role="region" aria-label={translateText("Selected")}>
        <span className="px-2 text-sm font-medium">{tr("{v0} selected", { v0: n })}</span>
        <button type="button" className="btn btn-soft btn-primary btn-sm" onClick={() => setAction("move")}>
          <span className="icon-[tabler--map-pin] size-4" />
          {translateText("Move")}</button>
        <button type="button" className="btn btn-soft btn-primary btn-sm" onClick={() => setAction("category")}>
          <span className="icon-[tabler--category] size-4" />
          {translateText("Category")}</button>
        <button type="button" className="btn btn-soft btn-primary btn-sm" onClick={() => setAction("tag")}>
          <span className="icon-[tabler--tag] size-4" />
          {translateText("Tag")}</button>
        <button type="button" className="btn btn-soft btn-primary btn-sm" onClick={() => setAction("untag")}>
          <span className="icon-[tabler--tag-off] size-4" />
          {translateText("Remove tag")}</button>
        <button type="button" className="btn btn-soft btn-error btn-sm" onClick={() => setAction("delete")}>
          <span className="icon-[tabler--trash] size-4" />
          {translateText("Delete")}</button>
        <button type="button" className="btn btn-text btn-sm ms-auto" onClick={props.onClear}>
          {translateText("Clear")}</button>
      </div>
      {action && (
        <BulkDialog
          householdId={props.householdId}
          action={action}
          ids={props.ids}
          rows={props.rows}
          onClose={() => setAction(null)}
          onDone={(r) => {
            setAction(null);
            props.onDone(r);
          }}
        />
      )}
    </>
  );
}

const BULK_TITLES: Record<BulkAction, string> = {
  get move() { return translateText("Move to…"); },
  get category() { return translateText("Set the category"); },
  get tag() { return translateText("Add a tag"); },
  get untag() { return translateText("Remove a tag"); },
  get delete() { return translateText("Delete these?"); },
};

function BulkDialog(props: {
  householdId: string;
  action: BulkAction;
  ids: string[];
  rows: ItemListing[];
  onClose: () => void;
  onDone: (r: ItemsBulkResult) => void;
}) {
  const qc = useQueryClient();
  const tags = useTags(props.householdId);
  const [place, setPlace] = useState<string | null>(null);
  const [category, setCategory] = useState<string | null>(null);
  const [tag, setTag] = useState("");
  const n = props.ids.length;
  const things = tn(n, "{count} thing", "{count} things");
  // Removing: the tags the ticked things on this page have.
  const onThem = [...new Set(props.rows.filter((r) => props.ids.includes(r.id)).flatMap((r) => r.tags))].sort((a, b) => a.localeCompare(b));
  const run = useMutation({
    mutationFn: () => {
      const ids = props.ids;
      const input: ItemsBulk =
        props.action === "move"
          ? { action: "move", ids, locationId: place }
          : props.action === "category"
            ? { action: "category", ids, categoryId: category }
            : props.action === "delete"
              ? { action: "delete", ids }
              : { action: props.action, ids, tag: tag.trim() };
      return api.bulkItems(input);
    },
    onSuccess: async (r) => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["items", props.householdId] }),
        qc.invalidateQueries({ queryKey: ["places", props.householdId] }),
        qc.invalidateQueries({ queryKey: ["overview", props.householdId] }),
        qc.invalidateQueries({ queryKey: ["tags"] }),
      ]);
      props.onDone(r);
    },
  });
  const ready = props.action === "tag" || props.action === "untag" ? Boolean(tag.trim()) : true;
  return (
    <Modal id="bulk" title={BULK_TITLES[props.action]} onClose={props.onClose}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) run.mutate();
        }}
      >
        {props.action === "move" && (
          <>
            <PlacePicker householdId={props.householdId} id="bulk-place" name="locationId" label={translateText("Where {v0} go", { v0: things })} noneLabel={translateText("Not in any place")} value={place} onChange={setPlace} />
            <p className="text-sm text-base-content/70">{translateText("Things in a box come out of it; a box moved takes what's inside with it.")}</p>
          </>
        )}
        {props.action === "category" && <CategoryPicker householdId={props.householdId} value={category} onChange={setCategory} />}
        {props.action === "tag" && (
          <div>
            <label className="label-text" htmlFor="bulk-tag">{tr("Tag {v0}", { v0: things })}</label>
            <input id="bulk-tag" className="input" list="bulk-tags" value={tag} onChange={(e) => setTag(e.target.value)} maxLength={40} autoFocus />
            <datalist id="bulk-tags">
              {(tags.data ?? []).map((t) => (
                <option key={t.id} value={t.name} />
              ))}
            </datalist>
          </div>
        )}
        {props.action === "untag" && (
          <div>
            <label className="label-text" htmlFor="bulk-untag">{tr("Take this tag off {v0}", { v0: things })}</label>
            <select id="bulk-untag" className="select" value={tag} onChange={(e) => setTag(e.target.value)}>
              <option value="">{translateText("Choose a tag")}</option>
              {onThem.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            {onThem.length === 0 && <p className="mt-1 text-sm text-base-content/70">{translateText("None of them has a tag.")}</p>}
          </div>
        )}
        {props.action === "delete" && (
          <p className="text-base-content/80">{tr("{v0} go to {v1}, where they can be brought back for 30 days.", { v0: things, v1: <a className="link link-primary" href="#/deleted">{translateText("Recently deleted")}</a> })}</p>
        )}
        {run.isError && <div className="alert alert-soft alert-error">{run.error.message}</div>}
        <DialogActions>
          <button type="button" className="btn btn-soft" onClick={props.onClose}>
            {translateText("Cancel")}</button>
          <button className={`btn ${props.action === "delete" ? "btn-error" : "btn-primary"}`} disabled={!ready || run.isPending}>
            {run.isPending && <span className="loading loading-spinner loading-xs" />}
            {props.action === "delete" ? translateText("Delete {v0}", { v0: things }) : props.action === "move" ? translateText("Move {v0}", { v0: things }) : translateText("Save")}
          </button>
        </DialogActions>
      </form>
    </Modal>
  );
}

/** A thing at a glance, beside the table: its photo and details, without leaving the list. */
function QuickView(props: { householdId: string; item: ItemListing; onClose: () => void }) {
  const { item, onClose } = props;
  const places = usePlaces(props.householdId);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector('[role="dialog"][aria-modal="true"]')) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const value = valueOf(item);
  const room = item.locationId ? findLocation(places.data, item.locationId) : undefined;
  const facts: [string, ReactNode][] = (
    [
      [translateText("Where"), [item.container && translateText("In {v0}", { v0: item.container.name }), item.place].filter(Boolean).join(" · ")],
      [translateText("Category"), item.category],
      [translateText("Brand"), item.brand],
      [translateText("Model"), item.model],
      [translateText("Serial"), item.serialNumber && <span className="font-mono">{item.serialNumber}</span>],
      [translateText("Value"), value != null && money(value)],
      [translateText("Bought"), [item.purchaseDate, item.purchasePriceCents != null && money(item.purchasePriceCents)].filter(Boolean).join(" · ")],
      [translateText("Quantity"), item.quantity > 1 && String(item.quantity)],
      [translateText("Lent"), item.loan && (item.loan.direction === "lent" ? translateText("To {v0} since {v1}", { v0: item.loan.person, v1: item.loan.since }) : translateText("From {v0} since {v1}", { v0: item.loan.person, v1: item.loan.since }))],
    ] as [string, ReactNode][]
  ).filter(([, v]) => Boolean(v));
  return createPortal(
    <aside
      className="fixed inset-y-0 end-0 z-[60] flex w-96 max-w-full flex-col border-s border-base-300 bg-base-100 shadow-xl"
      aria-label={translateText("{v0} at a glance", { v0: item.name })}
    >
      <div className="flex items-start gap-2 border-b border-base-300 p-4">
        <h2 className="min-w-0 flex-1 text-lg font-semibold text-base-content">{item.name}</h2>
        <button type="button" className="btn btn-circle btn-sm btn-text" aria-label={translateText("Close")} onClick={onClose}>
          <span className="icon-[tabler--x] size-4" />
        </button>
      </div>
      <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-4">
        {item.photoId ? (
          <img src={api.attachmentUrl(item.photoId)} alt={item.name} className="aspect-4/3 w-full rounded-box bg-base-300 object-cover" />
        ) : (
          <div className="flex aspect-4/3 w-full items-center justify-center rounded-box bg-base-200 text-base-content/40">
            <span className={`${item.isContainer ? "icon-[tabler--package]" : "icon-[tabler--photo-off]"} size-10`} />
          </div>
        )}
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          {facts.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-base-content/70">{k}</dt>
              <dd className="min-w-0 break-words text-base-content">{v}</dd>
            </div>
          ))}
        </dl>
        {item.tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {item.tags.map((t) => (
              <span key={t} className="badge badge-soft badge-primary">
                {t}
              </span>
            ))}
          </div>
        )}
        {item.notes && <p className="whitespace-pre-line text-sm text-base-content/80">{item.notes}</p>}
      </div>
      <div className="flex flex-wrap gap-2 border-t border-base-300 p-4">
        <a href={itemHref(item.id)} className="btn btn-primary">
          {translateText("Open")}<span className="icon-[tabler--arrow-right] size-4" />
        </a>
        {room && (
          <a href={`#/in/${encodeURIComponent(item.locationId!)}`} className="btn btn-soft btn-primary">
            <span className="icon-[tabler--map-pin] size-4" />
            {room.node.name}
          </a>
        )}
      </div>
    </aside>,
    document.body,
  );
}
