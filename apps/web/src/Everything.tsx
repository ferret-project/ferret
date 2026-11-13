/**
 * Everything (`#/items`): every thing you have, as a list (phones) or a table (wider screens) — filtered by where it
 * came from, its category, place or tag, or what it's missing; sorted; a page at a time. In the table, tick things to
 * move, file, tag or delete them together, and click a row to see it at a glance beside the table.
 */
import type { FoldedCategory, ItemListing, ItemOrigin, ItemSort, ItemsBulk, ItemsBulkResult, MissingDetail } from "@ferret/shared";
import { missingDetails } from "@ferret/shared/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { CategoryPicker, flattenCategories, useCategories, useTags } from "./Catalog";
import { PlacePicker } from "./Combobox";
import { FolderRow, FolderThumb } from "./Folder";
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
import { t, ph, plural, msg } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { MessageDescriptor } from "@lingui/core";

const PAGE = 50;
const SORTS: { value: ItemSort; label: MessageDescriptor; dir: "asc" | "desc" }[] = [
  { value: "updated", label: msg`Last changed`, dir: "desc" },
  { value: "added", label: msg`Newest`, dir: "desc" },
  { value: "name", label: msg`Name`, dir: "asc" },
  { value: "value", label: msg`Most valuable`, dir: "desc" },
  { value: "bought", label: msg`Bought most recently`, dir: "desc" },
  { value: "scanned", label: msg`Scanned most recently`, dir: "desc" },
  { value: "seen", label: msg`Not seen the longest`, dir: "asc" },
];
/** "Last seen": not in this many months (scanned, "Still here", a room review — never seen counts, once it's that old). */
const UNSCANNED = [
  { value: "1", label: msg`Not in a month` },
  { value: "6", label: msg`Not in 6 months` },
  { value: "12", label: msg`Not in a year` },
] as const;
/** The day `months` ago, on this device's calendar. */
function monthsAgo(months: number) {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
type Layout = "list" | "table";
const LAYOUT_KEY = "ferret-everything-layout";
const FOLD_KEY = "ferret-everything-fold";

function storedFold(): boolean {
  try {
    return localStorage.getItem(FOLD_KEY) === "on";
  } catch {
    return false;
  }
}

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

/**
 * `sort`: the order to start in, from the address (`#/items?sort=value` — the dashboard's Worth); `unseen`: months
 * not seen (`#/items?unseen=12` — the dashboard's "not seen in a year").
 */
export function Everything(props: { householdId: string; missing?: MissingDetail; origin?: ItemOrigin; placeFrom?: string; sort?: string; unseen?: string }) {
  const { householdId } = props;
  // Filters from plain words (AI-2) that the filter bar has no control for, shown as chips.
  const [extra, setExtra] = useState<ExtraFilters>({});
  const missing = props.missing ?? extra.missing;
  const origin = props.origin ?? extra.origin;
  const startSort = SORTS.find((s) => s.value === props.sort);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [locationId, setLocationId] = useState<string | null>(null);
  const [tag, setTag] = useState("");
  const [unscanned, setUnscanned] = useState(UNSCANNED.some((u) => u.value === props.unseen) ? props.unseen! : "");
  const [sort, setSort] = useState<{ by: ItemSort; dir: "asc" | "desc" }>(startSort ? { by: startSort.value, dir: startSort.dir } : { by: "updated", dir: "desc" });
  const [page, setPage] = useState(0);
  const [layout, setLayoutState] = useState<Layout>(storedLayout);
  // Fold big categories (ten or more things) into one row each — per device, like the layout.
  const [fold, setFoldState] = useState(storedFold);
  const setFold = (on: boolean) => {
    setFoldState(on);
    try {
      localStorage.setItem(FOLD_KEY, on ? "on" : "off");
    } catch {
      // Remembering it is only a convenience.
    }
  };
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
    notSeenSince: unscanned ? monthsAgo(Number(unscanned)) : undefined,
    minWorth: extra.minWorth,
    maxWorth: extra.maxWorth,
    boughtFrom: extra.boughtFrom,
    boughtTo: extra.boughtTo,
  };
  // A new filter or order starts again at the first page.
  const filterKey = JSON.stringify([filters, sort, fold]);
  useEffect(() => setPage(0), [filterKey]);
  const items = useQuery({
    queryKey: ["items", householdId, "everything", filters, extra.q, sort, fold, page],
    queryFn: () => api.listItems(extra.q, { ...filters, fold, sort: sort.by, dir: sort.dir, limit: PAGE, offset: page * PAGE }),
    placeholderData: (previous) => previous,
  });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [peek, setPeek] = useState<ItemListing | null>(null);
  // What the last bulk change did.
  const [result, setResult] = useState<ItemsBulkResult | null>(null);
  const filtered = Boolean(categoryId || locationId || tag || missing || origin || unscanned || Object.keys(extra).length);
  const total = items.data?.total ?? 0;
  const rows = items.data?.data ?? [];
  const folded = items.data?.folded ?? [];
  // Folded, a category is one row to page through.
  const pageRows = items.data?.rows ?? total;
  const openFolder = (g: FoldedCategory) => setCategoryId(g.categoryId);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-base-content">
            {missing ? t(MISSING_LABELS[missing].filter) : origin ? t(ORIGIN_FILTER[origin]) : t`Everything`}
          </h1>
          {items.data && (
            <p className="text-sm text-base-content/70" aria-live="polite">
              {plural(total, { one: "# thing", other: "# things" })}
              {items.data.valueCents ? ` · ${money(items.data.valueCents)}` : ""}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={`btn btn-sm ${fold ? "btn-primary" : "btn-soft"}`}
          aria-pressed={fold}
          title={t`Show each category with ten or more things as one row`}
          onClick={() => setFold(!fold)}
        >
          <span className="icon-[tabler--folders] size-4" />
          <Trans>Fold big categories</Trans>
        </button>
        {wide && (
          <div className="join" role="group" aria-label={t`Show as`}>
            {(["table", "list"] as const).map((l) => (
              <button
                key={l}
                type="button"
                className={`btn btn-sm join-item ${layout === l ? "btn-primary" : "btn-soft"}`}
                aria-pressed={layout === l}
                onClick={() => setLayout(l)}
              >
                <span className={`${l === "table" ? "icon-[tabler--table]" : "icon-[tabler--list]"} size-4`} />
                {l === "table" ? t`Table` : t`List`}
              </button>
            ))}
          </div>
        )}
        </div>
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
        <div className={`alert alert-soft ${result.failed.length ? "alert-warning" : "alert-success"} text-sm`} role="status">
          {result.failed.length > 0
            ? t`${ph({ done: result.done })} changed · ${ph({ failed: result.failed.length })} couldn't be: ${ph({ reasons: [...new Set(result.failed.map((f) => f.reason))].join("; ") })}`
            : t`${ph({ done: result.done })} changed`}
          <button type="button" className="btn btn-text btn-xs ms-auto" onClick={() => setResult(null)} aria-label={t`Dismiss`}>
            <span className="icon-[tabler--x] size-4" />
          </button>
        </div>
      )}

          <ItemTable
            householdId={householdId}
            folded={folded}
            onFolder={openFolder}
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
          {folded.map((g) => (
            <FolderRow key={g.categoryId} folder={g} onOpen={() => openFolder(g)} />
          ))}
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
              ? t`All done — nothing is missing that.`
              : origin && !categoryId && !locationId && !tag
                ? t`Nothing added this way yet.`
                : t`Nothing matches these filters.`
            : t`Nothing here yet — + Add puts in your first thing.`}
        </div>
      )}

      {pageRows > PAGE && <Pager page={page} pages={Math.ceil(pageRows / PAGE)} total={total} onPage={setPage} />}

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
          <Trans>Filter and sort</Trans>
          {active > 0 && <span className="badge badge-primary badge-sm">{active}</span>}
        </button>
        {props.onClear && (
          <button type="button" className="btn btn-text btn-sm" onClick={props.onClear}>
            <Trans>Clear filters</Trans>
          </button>
        )}
      </div>
    );
  }
  return (
    <section className="card" aria-label={t`Filters`}>
      <div className="card-body grid grid-cols-1 gap-3 p-3 @container sm:p-4">
        <div className="grid grid-cols-1 gap-3 @lg:grid-cols-3 @5xl:grid-cols-7">
          <Field label={t`Where from`} id="filter-origin">
            <select
              id="filter-origin"
              className="select"
              value={props.origin ?? ""}
              // Missing and where-from are links (the dashboard opens them), so they live in the address.
              onChange={(e) => navigateTo(e.target.value ? addedHref(e.target.value as ItemOrigin) : ITEMS_HREF)}
            >
              <option value="">{t`Anywhere`}</option>
              {itemOriginList.map((o) => (
                <option key={o} value={o}>
                  {t(ORIGIN_FILTER[o])}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t`Missing`} id="filter-missing">
            <select
              id="filter-missing"
              className="select"
              value={props.missing ?? ""}
              onChange={(e) => navigateTo(e.target.value ? missingHref(e.target.value as MissingDetail) : ITEMS_HREF)}
            >
              <option value="">{t`Anything`}</option>
              {missingDetails.map((d) => (
                <option key={d} value={d}>
                  {t(MISSING_LABELS[d].filter)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t`Category`} id="filter-category">
            <select
              id="filter-category"
              className="select"
              value={props.categoryId ?? ""}
              onChange={(e) => props.onCategory(e.target.value || null)}
              disabled={!categories.data?.length}
            >
              <option value="">{t`Any category`}</option>
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
            label={t`Place`}
            noneLabel={t`Anywhere`}
            value={props.locationId}
            onChange={props.onLocation}
          />
          <Field label={t`Tag`} id="filter-tag">
            <select id="filter-tag" className="select" value={props.tag} onChange={(e) => props.onTag(e.target.value)} disabled={!tags.data?.length}>
              <option value="">{t`Any tag`}</option>
              {(tags.data ?? []).map((tag) => (
                <option key={tag.id} value={tag.name}>
                  {tag.name} ({tag.items})
                </option>
              ))}
            </select>
          </Field>
          <Field label={t`Last seen`} id="filter-scanned">
            <select id="filter-scanned" className="select" value={props.unscanned} onChange={(e) => props.onUnscanned(e.target.value)}>
              <option value="">{t`Any time`}</option>
              {UNSCANNED.map((u) => (
                <option key={u.value} value={u.value}>
                  {t(u.label)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t`Order`} id="filter-sort">
            <select
              id="filter-sort"
              className="select"
              value={sortValue}
              onChange={(e) => {
                const s = SORTS.find((x) => x.value === e.target.value)!;
                props.onSort({ by: s.value, dir: s.dir });
              }}
            >
              {!sortValue && <option value="">{t`As in the table`}</option>}
              {SORTS.map((s) => (
                <option key={s.value} value={s.value}>
                  {t(s.label)}
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
                <Trans>Done</Trans>
              </button>
            )}
            {props.onClear && (
              <button type="button" className="btn btn-text btn-sm" onClick={props.onClear}>
                <span className="icon-[tabler--filter-off] size-4" />
                <Trans>Clear filters</Trans>
              </button>
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

const COLUMNS: { key: string; label: MessageDescriptor; sort?: ItemSort; firstDir?: "asc" | "desc"; className?: string }[] = [
  { key: "name", label: msg`Name`, sort: "name", firstDir: "asc" },
  { key: "place", label: msg`Where` },
  { key: "category", label: msg`Category`, className: "max-lg:hidden" },
  { key: "brand", label: msg`Brand`, className: "max-xl:hidden" },
  { key: "value", label: msg`Value`, sort: "value", firstDir: "desc", className: "text-end" },
  { key: "bought", label: msg`Bought`, sort: "bought", firstDir: "desc", className: "max-lg:hidden" },
];

/** The table: sortable headings, a tick box per row (and one for the page), a click opens the quick view. */
function ItemTable(props: {
  householdId: string;
  /** Big categories folded into one row each, before the things. */
  folded: FoldedCategory[];
  onFolder: (folder: FoldedCategory) => void;
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
                  aria-label={t`Select everything on this page`}
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
                      {t(c.label)}
                      <span
                        className={`size-4 ${active ? (props.sort.dir === "asc" ? "icon-[tabler--arrow-up]" : "icon-[tabler--arrow-down]") : "icon-[tabler--arrows-sort] text-base-content/40"}`}
                      />
                    </button>
                  ) : (
                    t(c.label)
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {props.folded.map((g) => (
            <tr key={g.categoryId} className="cursor-pointer hover:bg-base-200" onClick={() => props.onFolder(g)}>
              {canEdit && <td />}
              <td>
                <div className="flex items-center gap-3">
                  <FolderThumb folder={g} className="size-10" />
                  <div className="min-w-0">
                    <button type="button" className="link link-hover font-medium text-base-content text-start" onClick={(e) => (e.stopPropagation(), props.onFolder(g))}>
                      {g.name}
                    </button>
                    <p className="text-xs text-base-content/70">{plural(g.count, { one: "# thing", other: "# things" })}</p>
                  </div>
                </div>
              </td>
              <td />
              <td className="max-w-48 truncate text-base-content/80 max-lg:hidden">{g.path}</td>
              <td className="max-xl:hidden" />
              <td className="text-end tabular-nums">{g.valueCents ? money(g.valueCents) : ""}</td>
              <td className="max-lg:hidden" />
            </tr>
          ))}
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
                    aria-label={t`Select ${ph({ name: item.name })}`}
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
                        {[item.isContainer && t`Box · ${ph({ contents: item.contents })} inside`, item.loan && (item.loan.direction === "lent" ? t`Lent to ${ph({ person: item.loan.person })}` : t`Borrowed from ${ph({ person: item.loan.person })}`)]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                    )}
                  </div>
                </div>
              </td>
              <td className="max-w-64 truncate text-base-content/80" title={item.place ?? undefined}>
                {[item.container && t`In ${ph({ box: item.container.name })}`, item.place].filter(Boolean).join(" · ") || <span className="text-base-content/70">—</span>}
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
    <nav className="flex flex-wrap items-center justify-between gap-3" aria-label={t`Pages`}>
      <Trans><span className="text-sm text-base-content/70">
        {from}–{to} of {ph({ total: props.total })}
      </span></Trans>
      <div className="flex gap-2">
        <button type="button" className="btn btn-soft btn-sm" disabled={props.page === 0} onClick={() => go(props.page - 1)}>
          <span className="icon-[tabler--chevron-left] size-4" />
          <Trans>Previous</Trans>
        </button>
        <button type="button" className="btn btn-soft btn-sm" disabled={props.page >= props.pages - 1} onClick={() => go(props.page + 1)}>
          <Trans>Next</Trans>
          <span className="icon-[tabler--chevron-right] size-4" />
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
      <div className="sticky top-18 z-[5] flex flex-wrap items-center gap-2 rounded-box border border-primary/30 bg-base-100 p-2 shadow-sm" role="region" aria-label={t`Selected`}>
        <Trans><span className="px-2 text-sm font-medium">
          {n} selected
        </span></Trans>
        <button type="button" className="btn btn-soft btn-primary btn-sm" onClick={() => setAction("move")}>
          <span className="icon-[tabler--map-pin] size-4" />
          <Trans>Move</Trans>
        </button>
        <button type="button" className="btn btn-soft btn-primary btn-sm" onClick={() => setAction("category")}>
          <span className="icon-[tabler--category] size-4" />
          <Trans>Category</Trans>
        </button>
        <button type="button" className="btn btn-soft btn-primary btn-sm" onClick={() => setAction("tag")}>
          <span className="icon-[tabler--tag] size-4" />
          <Trans>Tag</Trans>
        </button>
        <button type="button" className="btn btn-soft btn-primary btn-sm" onClick={() => setAction("untag")}>
          <span className="icon-[tabler--tag-off] size-4" />
          <Trans>Remove tag</Trans>
        </button>
        <button type="button" className="btn btn-soft btn-error btn-sm" onClick={() => setAction("delete")}>
          <span className="icon-[tabler--trash] size-4" />
          <Trans>Delete</Trans>
        </button>
        <button type="button" className="btn btn-text btn-sm ms-auto" onClick={props.onClear}>
          <Trans>Clear</Trans>
        </button>
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

const BULK_TITLES: Record<BulkAction, MessageDescriptor> = {
  move: msg`Move to…`,
  category: msg`Set the category`,
  tag: msg`Add a tag`,
  untag: msg`Remove a tag`,
  delete: msg`Delete these?`,
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
  const things = plural(n, { one: "# thing", other: "# things" });
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
    <Modal id="bulk" title={t(BULK_TITLES[props.action])} onClose={props.onClose}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) run.mutate();
        }}
      >
        {props.action === "move" && (
          <>
            <PlacePicker householdId={props.householdId} id="bulk-place" name="locationId" label={t`Where ${things} go`} noneLabel={t`Not in any place`} value={place} onChange={setPlace} />
            <p className="text-sm text-base-content/70"><Trans>Things in a box come out of it; a box moved takes what's inside with it.</Trans></p>
          </>
        )}
        {props.action === "category" && <CategoryPicker householdId={props.householdId} value={category} onChange={setCategory} />}
        {props.action === "tag" && (
          <div>
            <label className="label-text" htmlFor="bulk-tag">
              <Trans>Tag {things}</Trans>
            </label>
            <input id="bulk-tag" className="input" list="bulk-tags" value={tag} onChange={(e) => setTag(e.target.value)} maxLength={40} autoFocus />
            <datalist id="bulk-tags">
              {(tags.data ?? []).map((tag2) => (
                <option key={tag2.id} value={tag2.name} />
              ))}
            </datalist>
          </div>
        )}
        {props.action === "untag" && (
          <div>
            <label className="label-text" htmlFor="bulk-untag">
              <Trans>Take this tag off {things}</Trans>
            </label>
            <select id="bulk-untag" className="select" value={tag} onChange={(e) => setTag(e.target.value)}>
              <option value="">{t`Choose a tag`}</option>
              {onThem.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
            {onThem.length === 0 && <p className="mt-1 text-sm text-base-content/70"><Trans>None of them has a tag.</Trans></p>}
          </div>
        )}
        {props.action === "delete" && (
          <p className="text-base-content/80">
            <Trans>{things} go to <a className="link link-primary" href="#/deleted">Recently deleted</a>, where they can be brought back for 30 days.</Trans>
          </p>
        )}
        {run.isError && <div className="alert alert-soft alert-error">{run.error.message}</div>}
        <DialogActions>
          <button type="button" className="btn btn-soft" onClick={props.onClose}>
            <Trans>Cancel</Trans>
          </button>
          <button className={`btn ${props.action === "delete" ? "btn-error" : "btn-primary"}`} disabled={!ready || run.isPending}>
            {run.isPending && <span className="loading loading-spinner loading-xs" />}
            {props.action === "delete" ? t`Delete ${things}` : props.action === "move" ? t`Move ${things}` : t`Save`}
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
      [t`Where`, [item.container && t`In ${ph({ box: item.container.name })}`, item.place].filter(Boolean).join(" · ")],
      [t`Category`, item.category],
      [t`Brand`, item.brand],
      [t`Model`, item.model],
      [t`Serial`, item.serialNumber && <span className="font-mono">{item.serialNumber}</span>],
      [t`Value`, value != null && money(value)],
      [t`Bought`, [item.purchaseDate, item.purchasePriceCents != null && money(item.purchasePriceCents)].filter(Boolean).join(" · ")],
      [t`Quantity`, item.quantity > 1 && String(item.quantity)],
      [t`Lent`, item.loan && (item.loan.direction === "lent" ? t`To ${ph({ person: item.loan.person })} since ${ph({ since: item.loan.since })}` : t`From ${ph({ person: item.loan.person })} since ${ph({ since: item.loan.since })}`)],
    ] as [string, ReactNode][]
  ).filter(([, v]) => Boolean(v));
  return createPortal(
    <aside
      className="fixed inset-y-0 end-0 z-[60] flex w-96 max-w-full flex-col border-s border-base-300 bg-base-100 shadow-xl"
      aria-label={t`${ph({ name: item.name })} at a glance`}
    >
      <div className="flex items-start gap-2 border-b border-base-300 p-4">
        <h2 className="min-w-0 flex-1 text-lg font-semibold text-base-content">{item.name}</h2>
        <button type="button" className="btn btn-circle btn-sm btn-text" aria-label={t`Close`} onClick={onClose}>
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
            {item.tags.map((tag) => (
              <span key={tag} className="badge badge-soft badge-primary">
                {tag}
              </span>
            ))}
          </div>
        )}
        {item.notes && <p className="whitespace-pre-line text-sm text-base-content/80">{item.notes}</p>}
      </div>
      <div className="flex flex-wrap gap-2 border-t border-base-300 p-4">
        <a href={itemHref(item.id)} className="btn btn-primary">
          <Trans>Open</Trans>
          <span className="icon-[tabler--arrow-right] size-4" />
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

