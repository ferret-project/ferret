/**
 * The dashboard: what everything is worth, maintenance and warranties to act on,
 * what's missing for an insurance claim, and recent changes (including Claude's).
 * Stat cards follow FlyonUI Pro "Statistics 6"; the rest are FlyonUI cards, lists and progress bars.
 */
import type { MissingDetail, Overview as OverviewData } from "@ferret/shared";
import { missingDetails } from "@ferret/shared/utils";
import { everyText } from "./lib/words";
import { useQuery } from "@tanstack/react-query";
import { api } from "./lib/api";
import { money } from "./lib/money";
import { useCategories, useTags } from "./Catalog";
import { CategoryDonut, WorthOverTime } from "./Charts";
import { CLAIM_STATUS } from "./Claims";
import { SetupChecklist } from "./Setup";
import { dance, isFerretDay } from "./lib/dook";
import side from "./assets/mascot/side.webp";
import { MISPLACED_HREF, REPLACEMENTS_HREF, REVIEW_HREF, reviewHref, BY_VALUE_HREF, CATEGORIES_HREF, COLLECTIONS_HREF, categoryHref, collectionHref, ITEMS_HREF, REPORT_HREF, SHOPPING_HREF, WARRANTIES_HREF, itemHref, MAINTENANCE_HREF, missingHref, placeHref, tagHref, LABELS_HREF } from "./lib/route";
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
  if (overview.isPending) return <span className="loading loading-spinner text-primary mx-auto my-12" />;
  if (overview.isError) return <div className="alert alert-soft alert-error">{overview.error.message}</div>;
  const o = overview.data;
  const soon = o.warranties.filter((w) => w.status === "expiring").length;
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
            note={o.total.itemsWithoutValue ? t`${ph({ itemsWithoutValue: o.total.itemsWithoutValue })} without a value` : t`Everything valued`}
            icon="icon-[tabler--coin]"
            tone="primary"
            href={BY_VALUE_HREF}
          />
          <Stat label={t`Things`} value={o.total.items.toLocaleString()} note={t`See them all`} icon="icon-[tabler--box]" tone="success" href={ITEMS_HREF} />
          <Stat
            label={t`Maintenance`}
            value={(o.maintenance.overdue + o.maintenance.due).toLocaleString()}
            note={o.maintenance.overdue ? t`${ph({ overdue: o.maintenance.overdue })} overdue` : t`Due in 2 weeks`}
            icon="icon-[tabler--tool]"
            tone={o.maintenance.overdue ? "warning" : "info"}
            href={MAINTENANCE_HREF}
          />
          <Stat
            label={t`Warranties`}
            value={soon.toLocaleString()}
            note={t`Ending in 60 days`}
            icon="icon-[tabler--shield-check]"
            tone={soon ? "warning" : "success"}
            href={WARRANTIES_HREF}
          />
        </div>
      </div>

      {places}
      {/* On a wide screen, the sections flow into two columns (each kept whole). */}
      <div className="flex flex-col gap-4 md:block md:columns-2 md:gap-4 md:[&>*]:mb-4 md:[&>*]:break-inside-avoid">
      {o.total.valueCents > 0 && (
        <Section
          icon="icon-[tabler--chart-area-line]"
          title={t`Worth over time`}
          aside={
            <a href={BOUGHT_HREF} className="tap link link-hover text-sm text-base-content/70">
              <Trans>by when things came in</Trans>
            </a>
          }
        >
          {/* The chart opens everything, the most recently bought first. */}
          <a href={BOUGHT_HREF} className="block rounded-field" aria-label={t`Everything, the most recently bought first`}>
            <WorthOverTime byMonth={o.byMonth} />
          </a>
        </Section>
      )}
      <Upkeep o={o} />
      {o.shopping.count > 0 && <ToBuy o={o} />}
      <Gaps o={o} />
      {o.total.items > 0 && o.tracking.nextRoom && <KeepingTrack o={o} />}
      {(o.replacements.past.items > 0 || o.replacements.years.some((y) => y.items)) && (
        <Section
          icon="icon-[tabler--hourglass]"
          title={t`Coming up for replacement`}
          aside={
            <a href={REPLACEMENTS_HREF} className="tap link link-primary link-hover text-sm">
              <Trans>See all</Trans>
            </a>
          }
        >
          <ReplacementsCard past={o.replacements.past} years={o.replacements.years} />
          <p className="text-xs text-base-content/70"><Trans>Estimates from how long things usually last.</Trans></p>
        </Section>
      )}
      {(o.warranties.length > 0 || o.openClaims.length > 0) && <Warranties o={o} />}
      <Collections householdId={householdId} />
      {o.byRoom.length > 0 && (
        <ValueBars
          icon="icon-[tabler--coins]"
          title={t`Worth, room by room`}
          groups={o.byRoom}
          href={(g) => (g.locationId ? placeHref(g.locationId) : undefined)}
          label={(name) => (o.properties > 1 ? name : name.replace(/^[^›]+› /, ""))}
          aside={o.properties > 1 && <span className="text-sm text-base-content/70">{plural(o.properties, { one: "# property", other: "# properties" })}</span>}
        />
      )}
      {o.byCategory.some((g) => g.name !== "No category" && g.valueCents > 0) && (
        <Section icon="icon-[tabler--chart-donut]" title={t`Worth, by category`}>
          <CategoryDonut
            groups={o.byCategory}
            href={(name) => {
              if (name === "No category") return missingHref("category");
              const top = (categories.data ?? []).find((c) => c.name === name);
              return top ? categoryHref(top.id) : undefined;
            }}
          />
        </Section>
      )}
      {o.mostValuable.length > 0 && <MostValuable o={o} />}
      {o.activity.length > 0 && <Activity o={o} />}
      </div>
    </>
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
  if (total === 0) {
    return (
      <Section icon="icon-[tabler--list-check]" title={t`Ready for a claim?`}>
        <p className="text-sm text-base-content/70"><Trans>Add a few things and Ferret will show what each one still needs.</Trans></p>
      </Section>
    );
  }
  const done = missingDetails.every((d) => o.missing[d] === 0);
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
      <p className="-mt-2 text-sm text-base-content/70">
        {done ? t`Every item has a photo, a value, a place and a receipt.` : t`Tap a line to see the items that still need it.`}
      </p>
      <ul className="flex flex-col gap-1">
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
      </ul>
    </Section>
  );
}

/**
 * Keeping track: things nobody can find, things not seen in a year, and the place to review next (Tracking.tsx).
 */
function KeepingTrack({ o }: { o: OverviewData }) {
  const { notSeenYear, misplaced, nextRoom } = o.tracking;
  return (
    <Section
      icon="icon-[tabler--eye-check]"
      title={t`Keeping track`}
      aside={
        <a href={REVIEW_HREF} className="tap link link-primary link-hover text-sm">
          <Trans>Room review</Trans>
        </a>
      }
    >
      {(misplaced > 0 || notSeenYear > 0) && (
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
    </Section>
  );
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
              <span className={`size-2.5 shrink-0 rounded-full ${i.quantity === 0 ? "bg-error" : "bg-warning"}`} aria-hidden />
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
                  <span
                    className={`size-2.5 shrink-0 rounded-full ${value.status === "overdue" ? "bg-error" : value.status === "due" ? "bg-warning" : "bg-primary/40"}`}
                    aria-hidden
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

/** Value per group (rooms, categories) as bars against the largest. */
function ValueBars(props: {
  icon: string;
  title: string;
  groups: OverviewData["byRoom"];
  label?: (name: string) => string;
  aside?: React.ReactNode;
  /** Where a group opens (its room), if anywhere. */
  href?: (group: OverviewData["byRoom"][number]) => string | undefined;
}) {
  const groups = props.groups.filter((g) => g.valueCents > 0 || g.items > 0).slice(0, 8);
  const max = Math.max(...groups.map((g) => g.valueCents), 1);
  return (
    <Section icon={props.icon} title={props.title} aside={props.aside}>
      <ul className="flex flex-col gap-3">
        {groups.map((g) => {
          const href = props.href?.(g);
          const body = (
            <>
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="min-w-0 truncate text-base-content">{props.label ? props.label(g.name) : g.name}</span>
                <span className="shrink-0 font-medium text-base-content">{money(g.valueCents)}</span>
              </div>
              <div className="mt-1 flex items-center gap-2">
                <span className="progress h-1.5 flex-1" aria-hidden>
                  <span className="progress-bar progress-primary" style={{ width: `${(g.valueCents / max) * 100}%` }} />
                </span>
                <span className="w-16 shrink-0 text-end text-xs text-base-content/70">
                  {plural(g.items, { one: "# item", other: "# items" })}
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
    </Section>
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
              <span className="w-5 text-center text-sm text-base-content/70">{i + 1}</span>
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

function Activity({ o }: { o: OverviewData }) {
  return (
    <Section icon="icon-[tabler--history]" title={t`Recent changes`}>
      <ul className="flex flex-col gap-3">
        {o.activity.map((a) => {
          const via = VIA[a.via] ?? VIA.web!;
          return (
            <li key={a.id} className="flex items-start gap-3">
              <span className="avatar avatar-placeholder">
                <span className={`size-8 rounded-full ${a.via === "mcp" ? "bg-accent/10 text-accent" : "bg-primary/10 text-primary"}`}>
                  {a.via === "web" ? (
                    <span className="text-sm">{(a.actorName ?? "?").slice(0, 1).toUpperCase()}</span>
                  ) : (
                    <span className={`${via.icon} size-4`} />
                  )}
                </span>
              </span>
              <span className="min-w-0 flex-1">
                {a.itemId || a.action === "label.create" ? (
                  // Blank labels made: the labels page, where unused ones can be printed again.
                  <a href={a.itemId ? itemHref(a.itemId) : LABELS_HREF} className="tap link link-hover block text-sm text-base-content">
                    {a.summary}
                  </a>
                ) : (
                  <span className="block text-sm text-base-content">{a.summary}</span>
                )}
                <span className="text-xs text-base-content/70">
                  {a.actorName ?? (a.via === "ferret" || a.action === "recall.found" ? t`Ferret` : t`Someone`)}
                  {a.via !== "web" && a.via !== "ferret" && t` via ${ph({ label: t(via.label) })}`} · {ago(a.createdAt)}
                </span>
              </span>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

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
