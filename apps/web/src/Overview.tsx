/**
 * The dashboard: what everything is worth, maintenance and warranties to act on,
 * what's missing for an insurance claim, and recent changes (including Claude's).
 * Stat cards follow FlyonUI Pro "Statistics 6"; the rest are FlyonUI cards, lists and progress bars.
 */
import type { DashboardLayout, DashboardSection, MissingDetail, Overview as OverviewData, ThingCard } from "@ferret/shared";
import { DASHBOARD_SECTIONS, DEFAULT_DASHBOARD_SIDES, type DashboardSide } from "@ferret/shared/utils";
import { missingDetails } from "@ferret/shared/utils";
import { everyText } from "./lib/words";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useEffect, useRef, useState } from "react";
import { authClient } from "./lib/auth";
import { AddFromPhotos } from "./PhotoAdd";
import { DialogActions, Modal } from "./Modal";
import { api } from "./lib/api";
import { money } from "./lib/money";
import { useCategories, useTags } from "./Catalog";
import { CategoryDonut, WorthOverTime } from "./Charts";
import { CLAIM_STATUS } from "./Claims";
import { SetupChecklist } from "./Setup";
import { dance, isFerretDay } from "./lib/dook";
import side from "./assets/mascot/side.webp";
import { WALKTHROUGH_HREF, DELETED_HREF, MISPLACED_HREF, REPLACEMENTS_HREF, REVIEW_HREF, reviewHref, BY_VALUE_HREF, CATEGORIES_HREF, COLLECTIONS_HREF, categoryHref, collectionHref, ITEMS_HREF, REPORT_HREF, SHOPPING_HREF, WARRANTIES_HREF, itemHref, MAINTENANCE_HREF, missingHref, placeHref, tagHref, LABELS_HREF } from "./lib/route";
import { useCollections } from "./Collections";
import { reviewedText } from "./Tracking";
import { ReplacementsCard } from "./Replacements";
import { t, ph, plural, msg } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { MessageDescriptor } from "@lingui/core";

const BOUGHT_HREF = `${ITEMS_HREF}?sort=bought`;

export const MISSING_LABELS: Record<MissingDetail, { label: MessageDescriptor; filter: MessageDescriptor; icon: string }> = {
  photo: { label: msg`Photo`, filter: msg`No photo yet`, icon: "icon-[tabler--camera]" },
  value: { label: msg`Value or price`, filter: msg`No value or price`, icon: "icon-[tabler--cash]" },
  place: { label: msg`Where it's kept`, filter: msg`Not in any place`, icon: "icon-[tabler--map-pin]" },
  document: { label: msg`Receipt or manual`, filter: msg`No receipt or manual`, icon: "icon-[tabler--receipt]" },
  category: { label: msg`Category`, filter: msg`No category yet`, icon: "icon-[tabler--category]" },
  serial: { label: msg`Serial number (valuable things)`, filter: msg`Valuable, no serial number`, icon: "icon-[tabler--barcode]" },
};


/**
 * The dashboard's sections, under the search box on the home screen: `places`
 * (the property cards) goes right after the stat cards.
 */
/** April 2 only (lib/dook.ts). English for everyone, on purpose: translating it would give it away. */
function FerretDay() {
  return (
    <button type="button" onClick={dance} className="alert alert-soft alert-warning flex w-full flex-row items-center gap-3 text-start">
      <img src={side} alt="" width={325} height={400} className="h-14 w-auto shrink-0" />
      <span>
        {/* not translated */}
        <span className="font-semibold">{"Happy National Ferret Day!"}</span>{" "}
        {/* not translated */}
        {"Ferrets celebrate with a war dance. Tap here, or tap the paw seven times."}
      </span>
    </button>
  );
}

export function OverviewSections({ householdId, places }: { householdId: string; places?: React.ReactNode }) {
  const overview = useQuery({ queryKey: ["overview", householdId], queryFn: api.overview });
  const categories = useCategories(householdId);
  const layout = useDashboardLayout(householdId);
  const wide = useWide();
  const [customizing, setCustomizing] = useState(false);
  if (overview.isPending) return <span className="loading loading-spinner text-primary mx-auto my-12" />;
  if (overview.isError) return <div className="alert alert-soft alert-error">{overview.error.message}</div>;
  const o = overview.data;
  const soon = o.warranties.filter((w) => w.status === "expiring").length;
  const thisMonth = o.byMonth.find((m) => m.month === new Date().toISOString().slice(0, 7))?.valueCents ?? 0;
  // Each section, or null when it has nothing to show (its key still counts for the layout).
  const sections: Record<DashboardSection, React.ReactNode> = {
    maintenance: <Upkeep o={o} />,
    shopping: o.shopping.count > 0 && <ToBuy o={o} />,
    warranties: (o.warranties.length > 0 || o.openClaims.length > 0) && <Warranties o={o} />,
    places,
    claim: <Gaps o={o} />,
    collections: <Collections householdId={householdId} />,
    tracking: <Housekeeping o={o} />,
    worth: <Worth o={o} categoryHref={(name) => {
      if (name === "No category") return missingHref("category");
      const top = (categories.data ?? []).find((c) => c.name === name);
      return top ? categoryHref(top.id) : undefined;
    }} />,
    valuable: o.mostValuable.length > 0 && <MostValuable o={o} />,
    activity: o.activity.length > 0 && <Activity o={o} />,
  };
  const shown = layout.order.filter((key) => !layout.hidden.includes(key) && sections[key]);
  return (
    <>
      {isFerretDay() && <FerretDay />}
      <SetupChecklist householdId={householdId} o={o} />
      {/* Two tiles a row (four on a wide screen), one when large text makes them too narrow (the query is in rem, so it follows text size). */}
      <div className="@container">
        <div className="grid grid-cols-1 gap-3 @2xs:grid-cols-2 @4xl:grid-cols-4 sm:gap-4">
          <Stat
            label={t`Worth`}
            value={money(o.total.valueCents)}
            note={
              thisMonth > 0
                ? t`+${ph({ amount: money(thisMonth) })} this month`
                : o.total.itemsWithoutValue
                  ? t`${ph({ itemsWithoutValue: o.total.itemsWithoutValue })} without a value`
                  : t`Everything valued`
            }
            icon="icon-[tabler--coin]"
            tone="primary"
            href={BY_VALUE_HREF}
          />
          <Stat
            label={t`Things`}
            value={o.total.items.toLocaleString()}
            note={o.locations ? plural(o.locations, { one: "In # place", other: "In # places" }) : t`See them all`}
            icon="icon-[tabler--box]"
            tone="success"
            href={ITEMS_HREF}
          />
          <Stat
            label={t`Maintenance`}
            value={(o.maintenance.overdue + o.maintenance.due).toLocaleString()}
            note={o.maintenance.overdue ? t`${ph({ overdue: o.maintenance.overdue })} overdue` : t`Due in 2 weeks`}
            icon="icon-[tabler--tool]"
            tone={o.maintenance.overdue ? "warning" : "info"}
            href={MAINTENANCE_HREF}
          />
          {/* Warranties when one's ending; otherwise the shopping list has more to say, if there's anything on it. */}
          {soon === 0 && o.shopping.count > 0 ? (
            <Stat
              label={t`To buy`}
              value={o.shopping.count.toLocaleString()}
              note={o.shopping.out ? t`${ph({ out: o.shopping.out })} run out` : t`Running low`}
              icon="icon-[tabler--shopping-cart]"
              tone={o.shopping.out ? "warning" : "info"}
              href={SHOPPING_HREF}
            />
          ) : (
            <Stat
              label={t`Warranties`}
              value={soon.toLocaleString()}
              note={soon ? t`Ending in 60 days` : o.nextWarranty ? t`Next ends ${ph({ date: formatDate(o.nextWarranty.endsOn) })}` : t`None ending soon`}
              icon="icon-[tabler--shield-check]"
              tone={soon ? "warning" : "success"}
              href={WARRANTIES_HREF}
            />
          )}
        </div>
      </div>

      {layout.arrange === "chosen" && wide ? (
        // Chosen (Advanced): a full-width section spans the page at its place in the order; the ones between sit in their columns.
        <div className="flex flex-col gap-4">
          {bands(shown, layout.sides).map((band) =>
            "wide" in band ? (
              <Fragment key={band.wide}>{sections[band.wide]}</Fragment>
            ) : (
              <div key={[...band.left, ...band.right].join()} className="grid grid-cols-2 items-start gap-4">
                {[band.left, band.right].map((column, i) => (
                  <div key={i} className="flex flex-col gap-4">
                    {column.map((key) => (
                      <Fragment key={key}>{sections[key]}</Fragment>
                    ))}
                  </div>
                ))}
              </div>
            ),
          )}
        </div>
      ) : (
        // Automatic: on a wide screen the sections flow into two columns the browser balances (each kept whole); a phone's one column is the order.
        <div className="flex flex-col gap-4 md:block md:columns-2 md:gap-4 md:[&>*]:mb-4 md:[&>*]:break-inside-avoid">
          {shown.map((key) => (
            <Fragment key={key}>{sections[key]}</Fragment>
          ))}
        </div>
      )}
      <div className="flex justify-center">
        <button type="button" className="btn btn-text btn-sm text-base-content/70" onClick={() => setCustomizing(true)}>
          <span className="icon-[tabler--adjustments-horizontal] size-4" />
          <Trans>Customize this page</Trans>
        </button>
      </div>
      {customizing && <CustomizeDialog householdId={householdId} layout={layout} onClose={() => setCustomizing(false)} />}
    </>
  );
}

// ── The page's own layout, greeting and quick actions ───────────────────────

const SECTION_NAMES: Record<DashboardSection, MessageDescriptor> = {
  maintenance: msg`Maintenance`,
  shopping: msg`To buy`,
  warranties: msg`Warranties to act on`,
  places: msg`Places`,
  claim: msg`Ready for a claim?`,
  collections: msg`Collections`,
  tracking: msg`Keeping track`,
  worth: msg`Worth`,
  valuable: msg`Most valuable`,
  activity: msg`Recent changes`,
};

/** A screen wide enough for two columns (Tailwind's md, 48rem — so large text counts too). */
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

type Band = { wide: DashboardSection } | { left: DashboardSection[]; right: DashboardSection[] };

/** Chosen sides as rows: each full-width section on its own, the ones between it in two columns. */
function bands(order: DashboardSection[], sides: DashboardLayout["sides"]): Band[] {
  const out: Band[] = [];
  for (const key of order) {
    const side = sides[key] ?? DEFAULT_DASHBOARD_SIDES[key];
    if (side === "wide") {
      out.push({ wide: key });
      continue;
    }
    let last = out.at(-1);
    if (!last || "wide" in last) out.push((last = { left: [], right: [] }));
    last[side].push(key);
  }
  return out;
}

/** This person's layout (GET /dashboard-layout); Ferret's until it's loaded. */
function useDashboardLayout(householdId: string): DashboardLayout {
  const q = useQuery({ queryKey: ["dashboard-layout", householdId], queryFn: api.dashboardLayout, staleTime: 5 * 60_000 });
  return q.data ?? { order: [...DASHBOARD_SECTIONS], hidden: [], arrange: "auto", sides: {} };
}

/** Customize this page: each section shown or hidden, moved up or down. Each person's own, per household. */
function CustomizeDialog({ householdId, layout, onClose }: { householdId: string; layout: DashboardLayout; onClose: () => void }) {
  const qc = useQueryClient();
  const [order, setOrder] = useState(layout.order);
  const [hidden, setHidden] = useState(new Set(layout.hidden));
  const [arrange, setArrange] = useState(layout.arrange);
  const [sides, setSides] = useState(layout.sides);
  const [advanced, setAdvanced] = useState(layout.arrange === "chosen");
  const save = useMutation({
    mutationFn: (next: DashboardLayout | null) => api.setDashboardLayout(next),
    onSuccess: (saved) => {
      qc.setQueryData(["dashboard-layout", householdId], saved);
      onClose();
    },
  });
  const move = (i: number, by: number) => {
    const next = [...order];
    const [key] = next.splice(i, 1);
    next.splice(i + by, 0, key!);
    setOrder(next);
  };
  return (
    <Modal id="customize-dashboard" title={t`Customize this page`} onClose={onClose}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate({ order, hidden: [...hidden], arrange, sides });
        }}
      >
        <p className="text-sm text-base-content/70">
          <Trans>Choose what's on your dashboard and in what order. Only you see it this way.</Trans>
        </p>
        <ul className="flex flex-col gap-1">
          {order.map((key, i) => (
            <li key={key} className="flex items-center gap-2 rounded-field px-1 py-1 hover:bg-base-200">
              <label className="flex min-h-11 flex-1 cursor-pointer items-center gap-3">
                <input
                  type="checkbox"
                  className="checkbox checkbox-primary"
                  checked={!hidden.has(key)}
                  onChange={(e) => {
                    const next = new Set(hidden);
                    if (e.target.checked) next.delete(key);
                    else next.add(key);
                    setHidden(next);
                  }}
                />
                <span className={hidden.has(key) ? "text-base-content/70" : "text-base-content"}>{t(SECTION_NAMES[key])}</span>
              </label>
              {arrange === "chosen" && (
                <select
                  className="select select-sm w-auto"
                  aria-label={t`Where ${ph({ name: t(SECTION_NAMES[key]) })} goes`}
                  value={sides[key] ?? DEFAULT_DASHBOARD_SIDES[key]}
                  onChange={(e) => setSides({ ...sides, [key]: e.target.value as DashboardSide })}
                >
                  <option value="left">{t`Left`}</option>
                  <option value="right">{t`Right`}</option>
                  <option value="wide">{t`Full width`}</option>
                </select>
              )}
              <button type="button" className="btn btn-text btn-square btn-sm" disabled={i === 0} aria-label={t`Move ${ph({ name: t(SECTION_NAMES[key]) })} up`} onClick={() => move(i, -1)}>
                <span className="icon-[tabler--arrow-up] size-4" />
              </button>
              <button type="button" className="btn btn-text btn-square btn-sm" disabled={i === order.length - 1} aria-label={t`Move ${ph({ name: t(SECTION_NAMES[key]) })} down`} onClick={() => move(i, 1)}>
                <span className="icon-[tabler--arrow-down] size-4" />
              </button>
            </li>
          ))}
        </ul>
        <p className="text-xs text-base-content/70"><Trans>Sections with nothing in them yet stay out of the way until they do.</Trans></p>
        {/* Advanced: where each goes on a wide screen. Off, Ferret balances the two columns by height. */}
        <div className="flex flex-col gap-2 border-t border-base-300 pt-3">
          <button type="button" className="tap flex items-center gap-1 self-start text-sm font-medium text-base-content" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>
            <span className={`icon-[tabler--chevron-right] size-4 transition-transform ${advanced ? "rotate-90" : ""}`} />
            <Trans>Advanced</Trans>
          </button>
          {advanced && (
            <>
              <label className="flex min-h-11 cursor-pointer items-center gap-3">
                <input type="checkbox" className="switch switch-primary" checked={arrange === "chosen"} onChange={(e) => setArrange(e.target.checked ? "chosen" : "auto")} />
                <span className="text-sm text-base-content"><Trans>Choose where each section goes</Trans></span>
              </label>
              <p className="text-xs text-base-content/70">
                {arrange === "chosen"
                  ? t`On a computer or tablet: a full-width section spans the page where it is in the list, and the ones between sit in their column. A phone shows them in the list's order.`
                  : t`Automatic: Ferret splits the sections into two columns of about the same height, so one can move to the other side as cards grow.`}
              </p>
            </>
          )}
        </div>
        {save.isError && <p className="text-sm text-error">{save.error.message}</p>}
        <DialogActions>
          <button type="button" className="btn btn-text me-auto" onClick={() => save.mutate(null)} disabled={save.isPending}>
            <Trans>Back to Ferret's</Trans>
          </button>
          <button type="button" className="btn btn-soft" onClick={onClose}>
            <Trans>Cancel</Trans>
          </button>
          <button type="submit" className="btn btn-primary" disabled={save.isPending}>
            <Trans>Save</Trans>
          </button>
        </DialogActions>
      </form>
    </Modal>
  );
}

/** "Good evening, Sam" and what needs them today, each a link — or that nothing does. */
export function Greeting({ householdId }: { householdId: string }) {
  const overview = useQuery({ queryKey: ["overview", householdId], queryFn: api.overview });
  const { data: session } = authClient.useSession();
  const o = overview.data;
  if (!o) return null;
  const soon = o.warranties.filter((w) => w.status === "expiring").length;
  const first = session?.user.name?.split(" ")[0];
  const hour = new Date().getHours();
  const hello = hour < 5 || hour >= 18 ? (first ? t`Good evening, ${first}` : t`Good evening`) : hour < 12 ? (first ? t`Good morning, ${first}` : t`Good morning`) : first ? t`Good afternoon, ${first}` : t`Good afternoon`;
  const needs: { href: string; text: string; tone: string }[] = [
    ...(o.maintenance.overdue ? [{ href: MAINTENANCE_HREF, text: plural(o.maintenance.overdue, { one: "# task overdue", other: "# tasks overdue" }), tone: "badge-error" }] : []),
    ...(o.shopping.out ? [{ href: SHOPPING_HREF, text: plural(o.shopping.out, { one: "# thing run out", other: "# things run out" }), tone: "badge-warning" }] : []),
    ...(soon ? [{ href: WARRANTIES_HREF, text: plural(soon, { one: "# warranty ending", other: "# warranties ending" }), tone: "badge-warning" }] : []),
    ...(o.tracking.misplaced ? [{ href: MISPLACED_HREF, text: plural(o.tracking.misplaced, { one: "# thing nobody can find", other: "# things nobody can find" }), tone: "badge-info" }] : []),
  ];
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <h1 className="text-xl font-semibold text-base-content">{hello}</h1>
      {needs.length ? (
        <span className="flex flex-wrap gap-2">
          {needs.map((n) => (
            <a key={n.href} href={n.href} className={`tap badge badge-soft ${n.tone}`}>
              {n.text}
            </a>
          ))}
        </span>
      ) : (
        <span className="text-sm text-base-content/70"><Trans>Nothing needs you today.</Trans></span>
      )}
    </div>
  );
}

/** A phone's shortcuts (a computer has + Add and the sidebar): scan, photos, a walkthrough, the shopping list. */
export function QuickActions({ householdId, onScan }: { householdId: string; onScan: () => void }) {
  const tile = "btn btn-soft btn-primary btn-wrap h-auto min-h-20 flex-col gap-1.5 rounded-box px-1 py-3 text-xs";
  return (
    <div className="grid grid-cols-4 gap-2 sm:hidden">
      <button type="button" className={tile} onClick={onScan}>
        <span className="icon-[tabler--barcode] size-6" />
        <Trans>Scan</Trans>
      </button>
      <AddFromPhotos householdId={householdId} className={tile} />
      <a href={WALKTHROUGH_HREF} className={tile}>
        <span className="icon-[tabler--walk] size-6" />
        <Trans>Walk through</Trans>
      </a>
      <a href={SHOPPING_HREF} className={tile}>
        <span className="icon-[tabler--shopping-cart] size-6" />
        <Trans>Shopping</Trans>
      </a>
    </div>
  );
}

const TONES = {
  primary: "after:border-primary/60 hover:after:border-primary",
  success: "after:border-success/60 hover:after:border-success",
  info: "after:border-info/60 hover:after:border-info",
  warning: "after:border-warning/60 hover:after:border-warning",
} as const;
const AVATAR_TONES = {
  primary: "bg-primary/10 text-primary",
  success: "bg-success/10 text-success",
  info: "bg-info/10 text-info",
  warning: "bg-warning/15 text-warning",
} as const;

/** A stat card from "Statistics 6": label, figure, a note, and a coloured underline. */
function Stat(props: { label: string; value: string; note: string; icon: string; tone: keyof typeof TONES; href?: string }) {
  const body = (
    <div className="card-body flex-row items-start gap-2 p-4 sm:p-5">
      <div className="min-w-0 grow">
        <p className="mb-2 text-sm text-base-content/80 sm:mb-3 sm:text-base">{props.label}</p>
        <p className="text-xl font-semibold break-words text-base-content">{props.value}</p>
        <p className="text-xs text-base-content/70 sm:text-sm">{props.note}</p>
      </div>
      <div className="avatar avatar-placeholder max-sm:hidden">
        <div className={`rounded-field size-10 ${AVATAR_TONES[props.tone]}`}>
          <span className={`${props.icon} size-6`} />
        </div>
      </div>
    </div>
  );
  const className = `card relative shadow-none after:absolute after:-bottom-[0.5px] after:h-6 after:w-full after:rounded-box after:border-b-3 after:transition-colors after:duration-200 ${TONES[props.tone]}`;
  return props.href ? (
    <a href={props.href} className={className}>
      {body}
    </a>
  ) : (
    <div className={className}>{body}</div>
  );
}

/**
 * A thing's picture in a dashboard list (`photos` from the overview), or a plain icon without one. `dot`: a status
 * colour (bg-error…) in its corner, for lists that say how urgent each line is.
 */
function Thumb({ photoId, icon = "icon-[tabler--box]", dot, size = "size-10" }: { photoId?: string | null; icon?: string; dot?: string; size?: string }) {
  return (
    <span className={`relative shrink-0 ${size}`}>
      {photoId ? (
        <img src={api.thumbnailUrl(photoId)} alt="" loading="lazy" className={`rounded-field bg-base-300 object-cover ${size}`} />
      ) : (
        <span className={`rounded-field bg-base-200 text-base-content/40 flex items-center justify-center ${size}`}>
          <span className={`${icon} size-5`} />
        </span>
      )}
      {dot && <span className={`absolute -end-0.5 -top-0.5 size-3 rounded-full ring-2 ring-base-100 ${dot}`} aria-hidden />}
    </span>
  );
}

const PHOTO_ROW_KEY = "ferret.photo-row";

/**
 * Recently viewed (or, by its switch, Recently added): the things this person opened lately (their own — GET /recently-viewed), as photo cards right under
 * the search box. Up to ten in a row that scrolls sideways: two in view on a phone, four, then six as the screen widens
 * (the container query is in rem, so large text keeps it two).
 */
export function RecentlyViewed({ householdId }: { householdId: string }) {
  const recent = useQuery({ queryKey: ["recently-viewed", householdId], queryFn: () => api.recentlyViewed(10) });
  const row = useRef<HTMLUListElement>(null);
  const [ends, setEnds] = useState({ start: true, end: true });
  const measure = () => {
    const el = row.current;
    if (!el) return;
    const start = el.scrollLeft <= 4;
    const end = el.scrollLeft + el.clientWidth >= el.scrollWidth - 4;
    setEnds((was) => (was.start === start && was.end === end ? was : { start, end })); // unchanged: no re-render
  };
  useEffect(measure);
  useEffect(() => {
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  });
  const page = (dir: 1 | -1) => row.current?.scrollBy({ left: dir * row.current.clientWidth * 0.9, behavior: "smooth" });
  const overview = useQuery({ queryKey: ["overview", householdId], queryFn: api.overview });
  const [chosen, setChosen] = useState<"viewed" | "added">(() => (localStorage.getItem(PHOTO_ROW_KEY) === "added" ? "added" : "viewed"));
  const viewed = recent.data?.data ?? [];
  const added = overview.data?.recentlyAdded ?? [];
  // Nothing opened yet: what was added, so the row isn't empty.
  const tab = chosen === "viewed" && !viewed.length ? "added" : chosen;
  const items = tab === "viewed" ? viewed : added;
  if (!viewed.length && !added.length) return null;
  const choose = (next: "viewed" | "added") => {
    localStorage.setItem(PHOTO_ROW_KEY, next);
    setChosen(next);
  };
  const tabs = [
    { key: "viewed" as const, label: t`Recently viewed`, icon: "icon-[tabler--eye]", show: viewed.length > 0 },
    { key: "added" as const, label: t`Recently added`, icon: "icon-[tabler--sparkles]", show: added.length > 0 },
  ].filter((x) => x.show);
  return (
    <section className="@container flex flex-col gap-3" aria-label={tabs.find((x) => x.key === tab)?.label}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1" role="tablist">
        {tabs.map((x) => (
          <button
            key={x.key}
            type="button"
            role="tab"
            aria-selected={tab === x.key}
            className={`tap flex items-center gap-2 font-semibold transition-colors ${tab === x.key ? "text-base-content" : "text-base-content/70 hover:text-base-content"}`}
            onClick={() => choose(x.key)}
          >
            <span className={`${x.icon} size-5 ${tab === x.key ? "text-primary" : ""}`} />
            {x.label}
          </button>
        ))}
      </div>
      {/* Up to ten, in a row that scrolls sideways: a swipe on a touch screen, the arrows with a mouse. */}
      <div className="relative">
        <ul ref={row} onScroll={measure} className="-mx-1 flex snap-x snap-mandatory gap-3 overflow-x-auto scroll-smooth px-1 pb-2 [scrollbar-width:thin] sm:gap-4">
          {items.map((it) => (
            <ViewedCard key={it.id} item={it} className="w-[calc(50%-0.375rem)] shrink-0 snap-start @xl:w-[calc(25%-0.75rem)] @5xl:w-[calc((100%-5rem)/6)]" />
          ))}
        </ul>
        {!ends.start && (
          <button type="button" className="btn btn-circle btn-sm absolute start-0 top-[30%] -translate-x-1/3 shadow-md [@media(hover:none)]:hidden" aria-label={t`Earlier ones`} onClick={() => page(-1)}>
            <span className="icon-[tabler--chevron-left] size-5" />
          </button>
        )}
        {!ends.end && (
          <button type="button" className="btn btn-circle btn-sm absolute end-0 top-[30%] translate-x-1/3 shadow-md [@media(hover:none)]:hidden" aria-label={t`More`} onClick={() => page(1)}>
            <span className="icon-[tabler--chevron-right] size-5" />
          </button>
        )}
      </div>
    </section>
  );
}

/**
 * One thing as a photo card: its photo, name and when. Its details (made by, collection, worth, where, box, category)
 * show over the dimmed photo on hover with a mouse; a touch screen has no hover, so it gets an (i) to tap instead.
 */
function ViewedCard({ item: it, className }: { item: ThingCard; className?: string }) {
  const [info, setInfo] = useState(false);
  const made = [it.brand, it.model].filter(Boolean).join(" · ");
  const details = (
    [
      made && ["icon-[tabler--tag]", t`Made by`, made],
      it.collection && ["icon-[tabler--stack-2]", t`Collection`, it.collection.name],
      it.graded && ["icon-[tabler--certificate]", t`Graded`, t`Graded by ${ph({ service: it.graded.by.toUpperCase() })}`],
      it.worthCents != null && ["icon-[tabler--coin]", t`Worth`, money(it.worthCents)],
      it.place && ["icon-[tabler--map-pin]", t`Where`, it.place.replace(/^[^›]+› /, "")], // the room on: the property name crowds it out
      it.container && ["icon-[tabler--package]", t`In`, it.container.name],
      it.category && ["icon-[tabler--category]", t`Category`, it.category],
    ] as const
  ).filter((d): d is [string, string, string] => Boolean(d));
  return (
    <li className={`group relative ${className ?? ""}`}>
      <a
        href={itemHref(it.id)}
        className={`card h-full overflow-hidden shadow-none transition-shadow hover:shadow-md focus-visible:outline-2 focus-visible:outline-primary ${it.disposition ? "opacity-70" : ""}`}
      >
        {it.photoId ? (
          <img src={api.thumbnailUrl(it.photoId)} alt="" loading="lazy" className="aspect-[4/3] w-full bg-base-300 object-cover" />
        ) : (
          <span className="flex aspect-[4/3] w-full items-center justify-center bg-base-200 text-base-content/40">
            <span className="icon-[tabler--box] size-10" />
          </span>
        )}
        <span className="flex flex-col gap-0.5 p-3">
          <span className="truncate font-medium text-base-content">{it.name}</span>
          <span className="truncate text-xs text-base-content/70">{ago(it.at)}</span>
        </span>
      </a>
      {details.length > 0 && (
        <>
          <div
            className={`pointer-events-none absolute inset-x-0 top-0 flex aspect-[4/3] flex-col justify-center gap-1 overflow-hidden rounded-t-box bg-black/65 p-3 pe-9 text-xs backdrop-blur-[2px] transition-opacity duration-200 [@media(hover:hover)]:group-hover:opacity-100 ${info ? "opacity-100" : "opacity-0"}`}
            aria-hidden={!info}
          >
            {details.map(([icon, label, value]) => (
              <span key={label} className="flex items-start gap-1.5 font-medium text-white [text-shadow:0_1px_2px_rgb(0_0_0/0.6)]">
                <span className={`${icon} mt-px size-4 shrink-0 text-white/85`} aria-label={label} />
                <span className="line-clamp-2 break-words">{value}</span>
              </span>
            ))}
          </div>
          <button
            type="button"
            className="btn btn-circle btn-xs absolute end-2 top-2 border-0 bg-black/55 text-white shadow-sm backdrop-blur hover:bg-black/70 [@media(hover:hover)]:hidden"
            aria-label={t`About ${ph({ name: it.name })}`}
            aria-expanded={info}
            onClick={() => setInfo(!info)}
            onBlur={() => setInfo(false)}
          >
            <span className={`${info ? "icon-[tabler--x]" : "icon-[tabler--info-small]"} size-5`} />
          </button>
        </>
      )}
    </li>
  );
}

function Section({ icon, title, children, aside }: { icon: string; title: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section className="card">
      <div className="card-body gap-4 p-4 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="card-title flex items-center gap-2 text-base">
            <span className={`${icon} size-5 text-primary`} />
            {title}
          </h2>
          {aside}
        </div>
        {children}
      </div>
    </section>
  );
}

/** For an insurance claim, each thing wants a photo, a value, a place and a receipt. */
function Gaps({ o }: { o: OverviewData }) {
  const total = o.total.items;
  const [open, setOpen] = useState(false);
  if (total === 0) {
    return (
      <Section icon="icon-[tabler--list-check]" title={t`Ready for a claim?`}>
        <p className="text-sm text-base-content/70"><Trans>Add a few things and Ferret will show what each one still needs.</Trans></p>
      </Section>
    );
  }
  const done = missingDetails.every((d) => o.missing[d] === 0);
  // One score: of every detail every thing should have, how many are there.
  const score = Math.round((missingDetails.reduce((sum, d) => sum + (total - o.missing[d]), 0) / (missingDetails.length * total)) * 100);
  const worst = [...missingDetails].sort((a, b) => o.missing[b] - o.missing[a])[0]!;
  return (
    <Section
      icon="icon-[tabler--list-check]"
      title={t`Ready for a claim?`}
      aside={
        <span className="flex items-center gap-2">
          {done && <span className="badge badge-soft badge-success"><Trans>All set</Trans></span>}
          <Trans><a href={REPORT_HREF} className="tap link link-primary link-hover text-sm">
            Report
          </a></Trans>
        </span>
      }
    >
      <div className="-mt-1 flex items-center gap-4">
        <span
          className={`radial-progress shrink-0 text-sm font-semibold ${score === 100 ? "text-success" : "text-primary"}`}
          style={{ "--value": score, "--size": "4rem", "--thickness": "0.4rem" } as React.CSSProperties}
          role="progressbar"
          aria-label={t`Ready for a claim: ${score}%`}
          aria-valuenow={score}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          {score}%
        </span>
        <span className="min-w-0 flex-1 text-sm">
          {done ? (
            <span className="text-base-content/70">{t`Every item has a photo, a value, a place and a receipt.`}</span>
          ) : (
            <a href={missingHref(worst)} className="tap link link-hover text-base-content">
              {t(MISSING_LABELS[worst].filter)}: {plural(o.missing[worst], { one: "# thing", other: "# things" })}
            </a>
          )}
          {!done && (
            <button type="button" className="tap link link-primary link-hover mt-1 block text-sm" aria-expanded={open} onClick={() => setOpen(!open)}>
              {open ? t`Hide the details` : t`See all six`}
            </button>
          )}
        </span>
      </div>
      {open && <ul className="flex flex-col gap-1">
        {missingDetails.map((d) => {
          const have = total - o.missing[d];
          const percent = Math.round((have / total) * 100);
          const row = (
            <>
              <span className={`${MISSING_LABELS[d].icon} size-5 shrink-0 text-base-content/70`} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center justify-between gap-2 text-sm">
                  <span className="text-base-content">{t(MISSING_LABELS[d].label)}</span>
                  <Trans><span className="text-base-content/70">
                    {have} of {total}
                  </span></Trans>
                </span>
                <span
                  className="progress mt-1.5 h-1.5"
                  role="progressbar"
                  aria-label={t`${ph({ label: t(MISSING_LABELS[d].label) })}: ${have} of ${total}`}
                  aria-valuenow={percent}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <span className={`progress-bar ${percent === 100 ? "progress-success" : "progress-primary"}`} style={{ width: `${percent}%` }} />
                </span>
              </span>
              {o.missing[d] > 0 && <span className="icon-[tabler--chevron-right] size-4 shrink-0 text-base-content/40" />}
            </>
          );
          return (
            <li key={d}>
              {o.missing[d] > 0 ? (
                <a href={missingHref(d)} className="flex min-h-11 items-center gap-3 rounded-field px-2 py-1.5 hover:bg-base-200">
                  {row}
                </a>
              ) : (
                <div className="flex items-center gap-3 p-2">{row}</div>
              )}
            </li>
          );
        })}
      </ul>}
    </Section>
  );
}

/**
 * Keeping track: things nobody can find, things not seen in a year, and the place to review next (Tracking.tsx).
 */
function KeepingTrack({ o, track, replace }: { o: OverviewData; track: boolean; replace: boolean }) {
  const { notSeenYear, misplaced } = o.tracking;
  const nextRoom = track ? o.tracking.nextRoom : null;
  return (
    <Section
      icon="icon-[tabler--eye-check]"
      title={t`Keeping track`}
      aside={
        track && (
          <a href={REVIEW_HREF} className="tap link link-primary link-hover text-sm">
            <Trans>Room review</Trans>
          </a>
        )
      }
    >
      {track && (misplaced > 0 || notSeenYear > 0) && (
        <div className="-mt-2 flex flex-wrap gap-2">
          {misplaced > 0 && (
            <a href={MISPLACED_HREF} className="tap badge badge-soft badge-warning">
              {plural(misplaced, { one: "# nobody can find", other: "# nobody can find" })}
            </a>
          )}
          {notSeenYear > 0 && (
            <a href={`${ITEMS_HREF}?unseen=12`} className="tap badge badge-soft badge-info">
              {plural(notSeenYear, { one: "# not seen in a year", other: "# not seen in a year" })}
            </a>
          )}
        </div>
      )}
      {nextRoom && (
        <a href={reviewHref(nextRoom.locationId)} className="flex min-h-11 items-center gap-3 rounded-field px-2 py-1.5 hover:bg-base-200">
          <span className="icon-[tabler--list-check] size-5 shrink-0 text-primary" aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-base-content">{o.properties > 1 ? nextRoom.path : nextRoom.path.replace(/^[^›]+› /, "")}</span>
            <span className="block truncate text-sm text-base-content/70">
              {reviewedText(nextRoom)} · {plural(nextRoom.items, { one: "# thing", other: "# things" })}
            </span>
          </span>
          <span className="shrink-0 text-sm font-medium text-primary">{nextRoom.open ? t`Carry on` : t`Review`}</span>
        </a>
      )}
      {replace && (
        <div className={`flex flex-col gap-2 ${track ? "border-t border-base-300 pt-3" : ""}`}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="flex items-center gap-2 text-sm font-medium text-base-content">
              <span className="icon-[tabler--hourglass] size-4 text-primary" />
              <Trans>Coming up for replacement</Trans>
            </h3>
            <a href={REPLACEMENTS_HREF} className="tap link link-primary link-hover text-sm">
              <Trans>See all</Trans>
            </a>
          </div>
          <ReplacementsCard past={o.replacements.past} years={o.replacements.years} />
          <p className="text-xs text-base-content/70"><Trans>Estimates from how long things usually last.</Trans></p>
        </div>
      )}
    </Section>
  );
}

/**
 * Keeping track and Coming up for replacement in one card (each was a whole card for a line or two). Shown when either
 * has something.
 */
function Housekeeping({ o }: { o: OverviewData }) {
  const track = o.total.items > 0 && Boolean(o.tracking.nextRoom || o.tracking.misplaced > 0 || o.tracking.notSeenYear > 0);
  const replace = o.replacements.past.items > 0 || o.replacements.years.some((y) => y.items);
  if (!track && !replace) return null;
  return <KeepingTrack o={o} track={track} replace={replace} />;
}

/** What needs doing soon; the full list is on the Maintenance screen. */
/** Running low: what's run out or at/below "keep at least" — the shopping list's first few. */
function ToBuy({ o }: { o: OverviewData }) {
  const { count, out, next } = o.shopping;
  return (
    <Section
      icon="icon-[tabler--shopping-cart]"
      title={t`To buy`}
      aside={
        <a href={SHOPPING_HREF} className="tap link link-primary link-hover text-sm">
          <Trans>Shopping list</Trans>
        </a>
      }
    >
      <div className="-mt-2 flex flex-wrap gap-2">
        {out > 0 && <span className="badge badge-soft badge-error"><Trans>{out} run out</Trans></span>}
        {count > out && <span className="badge badge-soft badge-warning"><Trans>{ph({ low: count - out })} running low</Trans></span>}
      </div>
      <ul className="flex flex-col gap-1">
        {next.map((i) => (
          <li key={i.id}>
            <a href={itemHref(i.id)} className="flex min-h-11 items-center gap-3 rounded-field px-2 py-1.5 hover:bg-base-200">
              <Thumb photoId={o.photos[i.id]} icon="icon-[tabler--shopping-cart]" dot={i.quantity === 0 ? "bg-error" : "bg-warning"} />
              <span className="min-w-0 flex-1 truncate text-base-content">{i.name}</span>
              <span className="shrink-0 text-sm text-base-content/70">{i.quantity === 0 ? t`none left` : t`${ph({ quantity: i.quantity })} left`}</span>
            </a>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function Upkeep({ o }: { o: OverviewData }) {
  const { overdue, due, next } = o.maintenance;
  return (
    <Section
      icon="icon-[tabler--tool]"
      title={t`Maintenance`}
      aside={
        <a href={MAINTENANCE_HREF} className="tap link link-primary link-hover text-sm">
          {next.length ? t`See all` : t`Add tasks`}
        </a>
      }
    >
      {next.length === 0 ? (
        <p className="-mt-2 text-sm text-base-content/70"><Trans>Nothing scheduled — track filters, servicing and the like.</Trans></p>
      ) : (
        <>
          <div className="-mt-2 flex flex-wrap gap-2">
            {overdue > 0 && <span className="badge badge-soft badge-error"><Trans>{overdue} overdue</Trans></span>}
            {due > 0 && <span className="badge badge-soft badge-warning"><Trans>{due} due in 2 weeks</Trans></span>}
            {!overdue && !due && <span className="badge badge-soft badge-success"><Trans>Nothing due soon</Trans></span>}
          </div>
          <ul className="flex flex-col gap-1">
            {next.map((value) => (
              <li key={value.id}>
                <a href={MAINTENANCE_HREF} className="flex min-h-11 items-center gap-3 rounded-field px-2 py-1.5 hover:bg-base-200">
                  <Thumb
                    photoId={value.itemId ? o.photos[value.itemId] : null}
                    icon={value.itemId ? "icon-[tabler--box]" : "icon-[tabler--home]"}
                    dot={value.status === "overdue" ? "bg-error" : value.status === "due" ? "bg-warning" : undefined}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-base-content">{value.title}</span>
                    <span className="block truncate text-sm text-base-content/70">
                      {[value.itemName ?? value.place, everyText(value.intervalCount, value.intervalUnit)].filter(Boolean).join(" · ")}
                    </span>
                  </span>
                  <span className="shrink-0 text-sm text-base-content/70">{value.dueOn && formatDate(value.dueOn)}</span>
                </a>
              </li>
            ))}
          </ul>
        </>
      )}
    </Section>
  );
}

function Warranties({ o }: { o: OverviewData }) {
  return (
    <Section
      icon="icon-[tabler--shield-check]"
      title={t`Warranties to act on`}
      aside={
        <a href={WARRANTIES_HREF} className="tap link link-primary link-hover text-sm">
          <Trans>All warranties</Trans>
        </a>
      }
    >
      <ul className="flex flex-col gap-1">
        {o.warranties.map((w) => (
          <li key={w.id}>
            <a href={itemHref(w.itemId)} className="flex min-h-11 items-center gap-3 rounded-field px-2 py-1.5 hover:bg-base-200">
              <Thumb photoId={o.photos[w.itemId]} icon="icon-[tabler--shield-check]" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-base-content">{w.itemName}</span>
                <span className="block truncate text-sm text-base-content/70">
                  {w.provider ? `${w.provider} · ` : ""}
                  {w.status === "expired" ? "ended" : "ends"} {formatDate(w.endsOn)}
                </span>
              </span>
              <span className={`badge badge-soft ${w.status === "expired" ? "badge-error" : "badge-warning"}`}>
                {w.status === "expired" ? t`Ended` : daysLeft(w.endsOn)}
              </span>
            </a>
          </li>
        ))}
        {/* Claims still waiting on the provider. */}
        {o.openClaims.map((c) => (
          <li key={c.id}>
            <a href={itemHref(c.itemId)} className="flex min-h-11 items-center gap-3 rounded-field px-2 py-1.5 hover:bg-base-200">
              <span className="icon-[tabler--file-alert] size-5 shrink-0 text-base-content/70" />
              <span className="min-w-0 flex-1">
                <Trans><span className="block truncate text-base-content">{ph({ itemName: c.itemName })}: claim</span></Trans>
                <span className="block truncate text-sm text-base-content/70">
                  {[c.warrantyProvider, c.reference && `#${c.reference}`, `filed ${formatDate(c.filedOn)}`].filter(Boolean).join(" · ")}
                </span>
              </span>
              <span className={`badge badge-soft ${CLAIM_STATUS[c.status].badge}`}>{t(CLAIM_STATUS[c.status].label)}</span>
            </a>
          </li>
        ))}
      </ul>
    </Section>
  );
}

type WorthView = "time" | "room" | "category";
const WORTH_VIEW_KEY = "ferret.worth.view";

/**
 * Worth, three ways in one card — over time, room by room, by category — with a switch that's remembered (per device).
 * Only the views with something to show are offered.
 */
function Worth({ o, categoryHref: catHref }: { o: OverviewData; categoryHref: (name: string) => string | undefined }) {
  const rooms = o.byRoom.filter((g) => g.locationId && (g.valueCents > 0 || g.items > 0)); // "Not placed" has its own link under Places
  const views: { key: WorthView; label: string }[] = [
    ...(o.total.valueCents > 0 ? [{ key: "time" as const, label: t`Over time` }] : []),
    ...(rooms.length > 0 ? [{ key: "room" as const, label: t`By room` }] : []),
    ...(o.byCategory.some((g) => g.name !== "No category" && g.valueCents > 0) ? [{ key: "category" as const, label: t`By category` }] : []),
  ];
  const [chosen, setChosen] = useState<WorthView>(() => (localStorage.getItem(WORTH_VIEW_KEY) as WorthView | null) ?? "time");
  if (!views.length) return null;
  const view = views.some((v) => v.key === chosen) ? chosen : views[0]!.key;
  const choose = (key: WorthView) => {
    localStorage.setItem(WORTH_VIEW_KEY, key);
    setChosen(key);
  };
  return (
    <Section
      icon="icon-[tabler--chart-area-line]"
      title={t`Worth`}
      aside={
        views.length > 1 && (
          <div className="join" role="group" aria-label={t`Show worth`}>
            {views.map((v) => (
              <button
                key={v.key}
                type="button"
                className={`btn btn-xs join-item ${view === v.key ? "btn-primary" : "btn-soft"}`}
                aria-pressed={view === v.key}
                onClick={() => choose(v.key)}
              >
                {v.label}
              </button>
            ))}
          </div>
        )
      }
    >
      {view === "time" && (
        <>
          {/* The chart opens everything, the most recently bought first. */}
          <a href={BOUGHT_HREF} className="block rounded-field" aria-label={t`Everything, the most recently bought first`}>
            <WorthOverTime byMonth={o.byMonth} />
          </a>
          <a href={BOUGHT_HREF} className="tap link link-hover -mt-2 text-sm text-base-content/70">
            <Trans>by when things came in</Trans>
          </a>
        </>
      )}
      {view === "room" && (
        <ValueBars
          groups={rooms}
          href={(g) => (g.locationId ? placeHref(g.locationId) : undefined)}
          label={(name) => (o.properties > 1 ? name : name.replace(/^[^›]+› /, ""))}
        />
      )}
      {view === "room" && o.properties > 1 && <p className="text-sm text-base-content/70">{plural(o.properties, { one: "# property", other: "# properties" })}</p>}
      {view === "category" && <CategoryDonut groups={o.byCategory} href={catHref} />}
    </Section>
  );
}

/** Value per group (rooms) as bars against the largest; a group with things but no values says so instead of $0. */
function ValueBars(props: {
  groups: OverviewData["byRoom"];
  label?: (name: string) => string;
  /** Where a group opens (its room), if anywhere. */
  href?: (group: OverviewData["byRoom"][number]) => string | undefined;
}) {
  const groups = props.groups.slice(0, 8);
  const max = Math.max(...groups.map((g) => g.valueCents), 1);
  return (
    <ul className="flex flex-col gap-3">
      {groups.map((g) => {
        const href = props.href?.(g);
        const body = (
          <>
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="min-w-0 truncate text-base-content">{props.label ? props.label(g.name) : g.name}</span>
              {g.valueCents > 0 ? (
                <span className="shrink-0 font-medium text-base-content">{money(g.valueCents)}</span>
              ) : (
                <span className="shrink-0 text-base-content/70"><Trans>no values yet</Trans></span>
              )}
            </div>
            <div className="mt-1 flex items-center gap-2">
              <span className="progress h-1.5 flex-1" aria-hidden>
                <span className="progress-bar progress-primary" style={{ width: `${(g.valueCents / max) * 100}%` }} />
              </span>
              <span className="w-16 shrink-0 text-end text-xs text-base-content/70">
                {plural(g.items, { one: "# thing", other: "# things" })}
              </span>
            </div>
          </>
        );
        return (
          <li key={g.name}>
            {href ? (
              <a href={href} className="-mx-2 block rounded-field px-2 py-1 hover:bg-base-200">
                {body}
              </a>
            ) : (
              body
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Collections first (what's had, and how complete), then the biggest few tags — each opening its page. */
function Collections({ householdId }: { householdId: string }) {
  const tags = useTags(householdId);
  const collections = useCollections(householdId);
  const top = [...(tags.data ?? [])].filter((tag) => tag.items > 0).sort((a, b) => b.items - a.items).slice(0, 12);
  const sets = collections.data ?? [];
  return (
    <Section
      icon="icon-[tabler--stack-2]"
      title={t`Collections`}
      aside={
        <a href={sets.length ? COLLECTIONS_HREF : CATEGORIES_HREF} className="tap link link-primary link-hover text-sm">
          {sets.length ? t`All collections` : t`Categories & tags`}
        </a>
      }
    >
      {top.length === 0 && sets.length === 0 ? (
        <p className="-mt-2 text-sm text-base-content/70">
          <Trans>Start a <a href={COLLECTIONS_HREF} className="link link-primary tap">collection</a> (coins, cards, dolls), or tag things (camping,
          Christmas, Grandma's china) and each tag gathers them here.</Trans>
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {sets.length > 0 && (
            <ul className="flex flex-col gap-1">
              {sets.slice(0, 5).map((c) => (
                <li key={c.id}>
                  <a href={collectionHref(c.id)} className="flex min-h-11 items-center gap-3 rounded-field px-2 py-1.5 hover:bg-base-200">
                    <span className="min-w-0 flex-1 truncate text-base-content">{c.name}</span>
                    <span className="text-sm text-base-content/70">
                      {c.owned}
                      {c.wanted ? t` of ${ph({ total: c.owned + c.wanted })}` : ""}
                    </span>
                    {c.valueCents > 0 && <span className="font-medium text-base-content">{money(c.valueCents)}</span>}
                  </a>
                </li>
              ))}
            </ul>
          )}
          {top.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {top.map((value) => (
                <a key={value.id} href={tagHref(value.name)} className="tap badge badge-soft badge-primary badge-lg gap-1.5">
                  <span className="icon-[tabler--tag] size-3.5" />
                  {value.name}
                  <span className="text-xs opacity-70">{value.items}</span>
                </a>
              ))}
            </div>
          )}
        </div>
      )}
    </Section>
  );
}

function MostValuable({ o }: { o: OverviewData }) {
  return (
    <Section
      icon="icon-[tabler--diamond]"
      title={t`Most valuable`}
      aside={
        <a href={BY_VALUE_HREF} className="tap link link-primary link-hover text-sm">
          <Trans>See all</Trans>
        </a>
      }
    >
      <ol className="flex flex-col gap-1">
        {o.mostValuable.slice(0, 5).map((it, i) => (
          <li key={it.id}>
            <a href={itemHref(it.id)} className="flex min-h-11 items-center gap-3 rounded-field px-2 py-1.5 hover:bg-base-200">
              <span className="w-4 shrink-0 text-center text-sm text-base-content/70">{i + 1}</span>
              <Thumb photoId={o.photos[it.id]} />
              <span className="min-w-0 flex-1 truncate text-base-content">{it.name}</span>
              <span className="font-medium text-base-content">{money(it.valueCents)}</span>
            </a>
          </li>
        ))}
      </ol>
    </Section>
  );
}

export const VIA: Record<string, { label: MessageDescriptor; icon: string }> = {
  web: { label: msg`app`, icon: "icon-[tabler--user]" },
  api: { label: msg`script`, icon: "icon-[tabler--code]" },
  mcp: { label: msg`Claude`, icon: "icon-[tabler--sparkles]" },
  ferret: { label: msg`Ferret`, icon: "icon-[tabler--paw]" },
};

/** Ferret's own lines (recall checks, AI fill-in…): no person behind them — the server's split (lib/inventory.ts recentActivity). */
const byFerret = (a: OverviewData["activity"][number]) => a.via === "ferret" || a.actorName == null;

/** Recent changes: people's by default, so a busy recall check can't push them off; "Show Ferret's own" mixes those in. */
function Activity({ o }: { o: OverviewData }) {
  const [all, setAll] = useState(() => localStorage.getItem(ACTIVITY_ALL_KEY) === "1");
  const fromFerret = o.activity.filter(byFerret).length;
  const shown = foldActivity(all ? o.activity : o.activity.filter((a) => !byFerret(a))).slice(0, 8);
  const days = groupByDay(shown);
  const toggle = () => {
    localStorage.setItem(ACTIVITY_ALL_KEY, all ? "0" : "1");
    setAll(!all);
  };
  return (
    <Section
      icon="icon-[tabler--history]"
      title={t`Recent changes`}
      aside={
        fromFerret > 0 && (
          <button type="button" className="tap link link-primary link-hover text-sm" aria-pressed={all} onClick={toggle}>
            {all ? <Trans>Only people's</Trans> : <Trans>Show Ferret's own</Trans>}
          </button>
        )
      }
    >
      {shown.length === 0 && (
        <p className="-mt-2 text-sm text-base-content/70"><Trans>Nobody has changed anything lately.</Trans></p>
      )}
      {days.map(([day, lines]) => (
      <div key={day} className="flex flex-col gap-2">
      <h3 className="text-xs font-medium tracking-wide text-base-content/70 uppercase">{day}</h3>
      <ul className="flex flex-col gap-3">
        {lines.map(({ line: a, more }) => {
          const via = VIA[a.via] ?? VIA.web!;
          const photo = a.itemId ? o.photos[a.itemId] : undefined;
          return (
            <li key={a.id} className="flex items-start gap-3">
              <span className="avatar avatar-placeholder">
                <span className={`size-8 rounded-full ${a.via === "mcp" ? "bg-accent/10 text-accent" : "bg-primary/10 text-primary"}`}>
                  {a.via === "web" && a.actorName ? (
                    <span className="text-sm">{a.actorName.slice(0, 1).toUpperCase()}</span>
                  ) : (
                    <span className={`${byFerret(a) ? VIA.ferret!.icon : via.icon} size-4`} />
                  )}
                </span>
              </span>
              <span className="min-w-0 flex-1">
                {a.itemId || a.deletedItem || a.action === "label.create" ? (
                  // A thing deleted since: Recently deleted, to bring it back. Blank labels made: the labels page, where unused ones can be printed again.
                  <a href={a.itemId ? itemHref(a.itemId) : a.deletedItem ? DELETED_HREF : LABELS_HREF} className="tap link link-hover block text-sm text-base-content">
                    {a.summary}
                  </a>
                ) : (
                  <span className="block text-sm text-base-content">{a.summary}</span>
                )}
                <span className="text-xs text-base-content/70">
                  {a.actorName ?? (byFerret(a) ? t`Ferret` : t`Someone`)}
                  {a.via !== "web" && a.via !== "ferret" && t` via ${ph({ label: t(via.label) })}`} · {ago(a.createdAt)}
                  {more > 0 && <> · {plural(more, { one: "and # earlier change", other: "and # earlier changes" })}</>}
                </span>
              </span>
              {photo && a.itemId && (
                <a href={itemHref(a.itemId)} tabIndex={-1} aria-hidden>
                  <Thumb photoId={photo} />
                </a>
              )}
            </li>
          );
        })}
      </ul>
      </div>
      ))}
    </Section>
  );
}

type ActivityLine = OverviewData["activity"][number];

/**
 * Lines in a row about the same thing by the same person fold into the newest ("Removed Fridge", and 1 earlier change —
 * its adding), so trying something out doesn't fill the card.
 */
function foldActivity(lines: ActivityLine[]) {
  const out: { line: ActivityLine; more: number }[] = [];
  const subject = (a: ActivityLine) => `${a.actorName ?? ""}|${a.itemId ?? (a.deletedItem || a.entityType === "item" ? a.entityId : `${a.entityType}:${a.entityId}`)}`;
  for (const a of lines) {
    const last = out.at(-1);
    if (last && subject(last.line) === subject(a)) last.more++;
    else out.push({ line: a, more: 0 });
  }
  return out;
}

/** Folded lines under Today / Yesterday / the date (the device's own calendar). */
function groupByDay(lines: { line: ActivityLine; more: number }[]) {
  const key = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  const today = key(new Date());
  const yesterday = key(new Date(Date.now() - 86_400_000));
  const days = new Map<string, typeof lines>();
  for (const l of lines) {
    const d = new Date(l.line.createdAt);
    const k = key(d);
    const name = k === today ? t`Today` : k === yesterday ? t`Yesterday` : d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
    days.set(name, [...(days.get(name) ?? []), l]);
  }
  return [...days];
}

/** Whether Recent changes shows Ferret's own lines too (per device). */
const ACTIVITY_ALL_KEY = "ferret.activity.all";

const formatDate = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

export function daysLeft(endsOn: string) {
  const days = Math.ceil((new Date(`${endsOn}T00:00:00`).getTime() - Date.now()) / 86_400_000);
  return days <= 1 ? t`Today` : plural(days, { one: "# day", other: "# days" });
}

export function ago(iso: string) {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days < 30 ? `${days} d ago` : new Date(iso).toLocaleDateString();
}
