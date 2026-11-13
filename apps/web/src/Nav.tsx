/**
 * Getting around, in one place:
 * - NAV_GROUPS: everything that isn't a tab, grouped (Add things / Lists / Organise / Insurance / Household) — the
 *   account menu on wide screens (MenuGroups) and the More tab's page on phones (MorePage, #/more).
 * - DesktopLinks: the main places, labelled, in the top bar on wide screens (phones have the tab bar).
 * - AddButton (top bar) and AddFab (phones): one "+ Add" for every way in — type it in, from photos, scan a barcode,
 *   walk through a room, import, blank QR labels — into the room (or category, tag) being looked at.
 * - HouseholdBadge: the household's name in the top bar: switches between households, or makes another.
 */
import type { CustomFieldValues, ItemTemplate, PlacesTree } from "@ferret/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { APPEARANCES } from "./App";
import { PlacePicker } from "./Combobox";
import { LanguageChoice } from "./Language";
import { CustomFieldInputs } from "./Catalog";
import { TemplatePicker, useTemplates } from "./Templates";
import { api } from "./lib/api";
import { useAppearance } from "./lib/appearance";
import { authClient, useCanEdit, signOut } from "./lib/auth";
import {
  type Route,
  COVERAGE_HREF,
  WARRANTIES_HREF,
  HEIRS_HREF,
  AI_FILLED_HREF,
  DUPLICATES_HREF,
  DELETED_HREF,
  IMPORT_HREF,
  ITEMS_HREF,
  LABELS_HREF,
  LOANS_HREF,
  MAINTENANCE_HREF,
  PAST_HREF,
  REVIEW_HREF,
  MISPLACED_HREF,
  PLACES_HREF,
  PROVIDERS_HREF,
  REPORT_HREF,
  SETTINGS_HREF,
  SHOPPING_HREF,
  WALKTHROUGH_HREF,
  CATEGORIES_HREF,
  COLLECTIONS_HREF,
  HOME_HREF,
  itemHref,
  walkthroughHref,
  scanRoomHref,
} from "./lib/route";
import { useRoomScanOn } from "./lib/room-scan";
import { Logo, PawMark } from "./AuthLayout";
import { AddFromPhotos } from "./PhotoAdd";
import { Modal } from "./Modal";
import { NewHouseholdDialog } from "./NewHousehold";
import { COMMAND_K, searchFromAnywhere } from "./Search";
import { navigateTo } from "./lib/navigate";
import { currencySymbol, toCents } from "./lib/money";
import { t, ph, msg } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { MessageDescriptor } from "@lingui/core";

type Link = { href: string; label: MessageDescriptor; icon: string; external?: boolean };

export const NAV_GROUPS: { title: MessageDescriptor; links: Link[] }[] = [
  {
    title: msg`Add things`,
    links: [
      { href: WALKTHROUGH_HREF, label: msg`Walk through a room`, icon: "icon-[tabler--walk]" },
      { href: IMPORT_HREF, label: msg`Import`, icon: "icon-[tabler--file-import]" },
      { href: LABELS_HREF, label: msg`QR labels`, icon: "icon-[tabler--qrcode]" },
    ],
  },
  {
    title: msg`Lists`,
    links: [
      { href: SHOPPING_HREF, label: msg`Shopping list`, icon: "icon-[tabler--shopping-cart]" },
      { href: LOANS_HREF, label: msg`Lent & borrowed`, icon: "icon-[tabler--arrows-exchange]" },
      { href: REVIEW_HREF, label: msg`Room review`, icon: "icon-[tabler--list-check]" },
      { href: MISPLACED_HREF, label: msg`Can't find`, icon: "icon-[tabler--map-pin-question]" },
      { href: PAST_HREF, label: msg`Past things`, icon: "icon-[tabler--history]" },
      { href: DELETED_HREF, label: msg`Recently deleted`, icon: "icon-[tabler--trash]" },
    ],
  },
  {
    title: msg`Organise`,
    links: [
      { href: COLLECTIONS_HREF, label: msg`Collections`, icon: "icon-[tabler--stack-2]" },
      { href: CATEGORIES_HREF, label: msg`Categories & tags`, icon: "icon-[tabler--folders]" },
      { href: PROVIDERS_HREF, label: msg`Service providers`, icon: "icon-[tabler--address-book]" },
      { href: DUPLICATES_HREF, label: msg`Possible duplicates`, icon: "icon-[tabler--copy]" },
      { href: AI_FILLED_HREF, label: msg`Filled in by AI`, icon: "icon-[tabler--sparkles]" },
    ],
  },
  {
    title: msg`Insurance`,
    links: [
      { href: REPORT_HREF, label: msg`Insurance report`, icon: "icon-[tabler--file-description]" },
      { href: COVERAGE_HREF, label: msg`Insurance coverage`, icon: "icon-[tabler--umbrella]" },
      { href: WARRANTIES_HREF, label: msg`Warranties`, icon: "icon-[tabler--shield-check]" },
      { href: HEIRS_HREF, label: msg`Personal property list`, icon: "icon-[tabler--users]" },
    ],
  },
  {
    title: msg`Household`,
    links: [
      { href: SETTINGS_HREF, label: msg`Household & settings`, icon: "icon-[tabler--settings]" },
      { href: "/docs/", label: msg`Help`, icon: "icon-[tabler--help-circle]", external: true },
    ],
  },
];

/** The groups as dropdown items (the account menu). `className` goes on each group (e.g. hidden where the sidebar shows). */
export function MenuGroups({ onPick, className = "" }: { onPick: () => void; className?: string }) {
  return (
    <>
      {NAV_GROUPS.map((g, i) => (
        <li key={g.title.id} role="none" className={`${i ? "border-t border-base-content/10 pt-1" : ""} ${className}`}>
          <p className="dropdown-title px-4 pt-1 text-xs">{t(g.title)}</p>
          <ul role="none">
            {g.links.map((l) => (
              <li key={l.href} role="none">
                <a className="dropdown-item px-3" href={l.href} role="menuitem" onClick={onPick}>
                  <span className={`${l.icon} size-5`} />
                  {t(l.label)}
                </a>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </>
  );
}

/** #/more — the More tab on phones: the account, its households (switch, or make another), every group, appearance, sign out. */
export function MorePage({ householdId }: { householdId: string }) {
  const { data: session } = authClient.useSession();
  const { data: households } = authClient.useListOrganizations();
  const { choice, set } = useAppearance();
  const [creating, setCreating] = useState(false);
  const user = session?.user;
  return (
    <div className="min-h-dvh bg-base-200">
      <nav className="navbar sticky top-0 z-10 border-b border-base-300 bg-base-100/85 backdrop-blur-md px-4">
        <h1 className="text-lg font-semibold"><Trans>More</Trans></h1>
        <BarSearch />
      </nav>
      <main className="mx-auto flex max-w-xl flex-col gap-4 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <section className="card">
          <div className="card-body flex-row items-center gap-3 p-4">
            <div className="avatar avatar-placeholder">
              <div className="w-11 rounded-full bg-primary/10 text-primary">
                <span className="text-lg">{(user?.name || user?.email || "?").slice(0, 1).toUpperCase()}</span>
              </div>
            </div>
            <div className="min-w-0">
              <p className="truncate font-semibold">{user?.name}</p>
              <p className="truncate text-sm text-base-content/70">{user?.email}</p>
            </div>
          </div>
        </section>
        {households && (
          <section className="card" aria-labelledby="more-households">
            <div className="card-body gap-1 p-2">
              <h2 id="more-households" className="px-3 pt-2 text-sm font-semibold text-base-content/70">
                <Trans>Households</Trans>
              </h2>
              {households.map((h) => (
                <button key={h.id} type="button" className="flex min-h-11 items-center gap-3 rounded-field px-3 text-start hover:bg-base-200" onClick={() => switchHousehold(h.id, householdId)}>
                  <span className={`${h.id === householdId ? "icon-[tabler--circle-check-filled] text-primary" : "icon-[tabler--circle]"} size-5`} />
                  {h.name}
                </button>
              ))}
              <button type="button" className="flex min-h-11 items-center gap-3 rounded-field px-3 text-start hover:bg-base-200" onClick={() => setCreating(true)}>
                <span className="icon-[tabler--plus] size-5 text-primary" />
                <Trans>New household…</Trans>
              </button>
            </div>
          </section>
        )}
        {creating && <NewHouseholdDialog onClose={() => setCreating(false)} />}
        {NAV_GROUPS.map((g) => (
          <section key={g.title.id} className="card" aria-label={t(g.title)}>
            <div className="card-body gap-0 p-2">
              <h2 className="px-3 pt-2 pb-1 text-sm font-semibold text-base-content/70">{t(g.title)}</h2>
              {g.links.map((l) => (
                <a key={l.href} href={l.href} className="flex min-h-11 items-center gap-3 rounded-field px-3 hover:bg-base-200">
                  <span className={`${l.icon} size-5 text-primary`} />
                  <span className="flex-1">{t(l.label)}</span>
                  <span className="icon-[tabler--chevron-right] size-4 text-base-content/40" />
                </a>
              ))}
            </div>
          </section>
        ))}
        <section className="card" aria-labelledby="more-appearance">
          <div className="card-body gap-2 p-4">
            <h2 id="more-appearance" className="text-sm font-semibold text-base-content/70">
              <Trans>Appearance</Trans>
            </h2>
            <div className="join w-full" role="radiogroup" aria-labelledby="more-appearance">
              {APPEARANCES.map((a) => (
                <button
                  key={a.value}
                  type="button"
                  role="radio"
                  aria-checked={choice === a.value}
                  className={`btn join-item grow gap-1 ${choice === a.value ? "btn-primary" : "btn-soft btn-secondary"}`}
                  onClick={() => set(a.value)}
                >
                  <span className={`${a.icon} size-4`} />
                  {t(a.label)}
                </button>
              ))}
            </div>
            <LanguageChoice />
          </div>
        </section>
        <button type="button" className="btn btn-soft btn-error" onClick={() => signOut()}>
          <span className="icon-[tabler--logout] size-5" />
          <Trans>Sign out</Trans>
        </button>
      </main>
    </div>
  );
}

export function switchHousehold(id: string, current: string) {
  if (id === current) return;
  void authClient.organization.setActive({ organizationId: id });
  navigateTo("#/");
}

/** The household's name, opening a menu: the households to switch between, and "New household…". Wide screens (phones: the More page). */
export function HouseholdBadge({
  householdName,
  householdId,
  align = "end",
  compact = false,
}: {
  householdName: string;
  householdId: string;
  align?: "start" | "end";
  /** The name's first letter only, the full name as its label and tooltip — the folded sidebar. */
  compact?: boolean;
}) {
  const { data: households } = authClient.useListOrganizations();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !(e.target as Element).closest("#household-switch")) setOpen(false);
    };
    document.addEventListener("click", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("click", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);
  if (!households) return compact ? null : <span className="badge badge-soft badge-primary hidden sm:inline-flex">{householdName}</span>;
  return (
    <div id="household-switch" className={`dropdown relative hidden sm:inline-flex ${open ? "open" : ""}`}>
      {compact ? (
        <button
          type="button"
          className="btn btn-soft btn-primary btn-square btn-sm"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={`Household: ${householdName}`}
          title={householdName}
          onClick={() => setOpen(!open)}
        >
          <span className="font-semibold" aria-hidden>
            {householdName.slice(0, 1).toUpperCase()}
          </span>
        </button>
      ) : (
        <button type="button" className="btn btn-soft btn-primary btn-sm gap-1" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
          {householdName}
          <span className="icon-[tabler--selector] size-4" />
        </button>
      )}
      {open && (
        <ul className={`dropdown-menu dropdown-open:opacity-100 absolute top-full w-60 ${align === "end" ? "end-0" : "start-0"}`} role="menu" aria-label={t`Households`}>
          {households.map((h) => (
            <li key={h.id}>
              <button type="button" className="dropdown-item" role="menuitemradio" aria-checked={h.id === householdId} onClick={() => switchHousehold(h.id, householdId)}>
                <span className={`${h.id === householdId ? "icon-[tabler--circle-check-filled] text-primary" : "icon-[tabler--circle]"} size-5`} />
                <span className="truncate">{h.name}</span>
              </button>
            </li>
          ))}
          <li className="mt-1 border-t border-base-content/10 pt-1">
            <button
              type="button"
              className="dropdown-item"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                setCreating(true);
              }}
            >
              <span className="icon-[tabler--plus] size-5" />
              <Trans>New household…</Trans>
            </button>
          </li>
        </ul>
      )}
      {creating && <NewHouseholdDialog onClose={() => setCreating(false)} />}
    </div>
  );
}

const MAIN_LINKS: (Link & { routes: Route["name"][] })[] = [
  { href: ITEMS_HREF, label: msg`Everything`, icon: "icon-[tabler--layout-grid]", routes: ["items"] },
  { href: PLACES_HREF, label: msg`Places`, icon: "icon-[tabler--map-pin]", routes: ["places", "property", "place"] },
  { href: MAINTENANCE_HREF, label: msg`Maintenance`, icon: "icon-[tabler--tool]", routes: ["maintenance"] },
];

/** The main places in the top bar on wide screens: labelled from `lg`, icons with a tooltip below that; from `xl` the sidebar has them. */
export function DesktopLinks({ route }: { route: Route["name"] }) {
  return (
    <div className="flex items-center gap-1 max-sm:hidden xl:hidden">
      {MAIN_LINKS.map((l) => {
        const on = l.routes.includes(route);
        return (
          <a key={l.href} href={l.href} className={`btn btn-text btn-sm gap-1.5 ${on ? "text-primary" : ""}`} aria-current={on ? "page" : undefined} title={t(l.label)}>
            <span className={`${l.icon} size-5`} />
            <span className="max-lg:sr-only">{t(l.label)}</span>
          </a>
        );
      })}
    </div>
  );
}

/** The sidebar folded to icons only, or open with their names — remembered on this device. */
const SIDEBAR_KEY = "ferret-sidebar";
export function useSidebarFolded() {
  const [folded, setFolded] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_KEY) === "folded";
    } catch {
      return false;
    }
  });
  const toggle = () => {
    setFolded(!folded);
    try {
      localStorage.setItem(SIDEBAR_KEY, folded ? "open" : "folded");
    } catch {
      // Remembering it is only a convenience.
    }
  };
  return [folded, toggle] as const;
}

/** Screens that belong under a sidebar link without their address starting with it. */
const UNDER: Partial<Record<Route["name"], string>> = {
  home: HOME_HREF,
  items: ITEMS_HREF,
  item: ITEMS_HREF,
  places: PLACES_HREF,
  property: PLACES_HREF,
  place: PLACES_HREF,
  maintenance: MAINTENANCE_HREF,
  categories: CATEGORIES_HREF,
  category: CATEGORIES_HREF,
  tag: CATEGORIES_HREF,
  label: LABELS_HREF,
};

/** The sidebar link for where you are: by the screen, else the link whose address the current one starts with. */
function activeHref(route: Route["name"], hash: string, links: Link[]) {
  if (UNDER[route]) return UNDER[route];
  return links.find((l) => !l.external && l.href !== HOME_HREF && (hash === l.href || hash.startsWith(`${l.href}/`) || hash.startsWith(`${l.href}?`)))?.href;
}

/**
 * The sidebar on big screens (`xl` up; FlyonUI "Dashboard Sidebar"): the main places, then the same groups as the menu.
 * Where you are is marked — its link and its group's heading. It folds to a rail of icons (names as tooltips) or opens
 * to icons with names; the screen beside it follows (`Screens`). Laptops keep the top bar's links, phones the tab bar;
 * it never prints.
 */
export function Sidebar(props: { route: Route["name"]; householdName: string; householdId: string; folded: boolean; onToggle: () => void }) {
  const { route, folded } = props;
  const hash = (window.location.hash || HOME_HREF).replace(/[?&]q=.*$/, "");
  const main: Link[] = [{ href: HOME_HREF, label: msg`Home`, icon: "icon-[tabler--home]" }, ...MAIN_LINKS];
  const active = activeHref(route, hash, [...main, ...NAV_GROUPS.flatMap((g) => g.links)]);
  const item = (l: Link) => {
    const on = l.href === active;
    return (
      <li key={l.href}>
        <a
          href={l.href}
          target={l.external ? "_blank" : undefined}
          rel={l.external ? "noreferrer" : undefined}
          aria-current={on ? "page" : undefined}
          title={folded ? t(l.label) : undefined}
          className={`relative flex items-center gap-3 rounded-field py-1.5 text-sm ${folded ? "justify-center px-0" : "px-3"} ${
            on ? "bg-primary/10 font-medium text-primary" : "text-base-content/80 hover:bg-base-200 hover:text-base-content"
          }`}
        >
          {/* The marker on the edge: where you are, even folded. */}
          {on && <span className="absolute inset-y-1 start-0 w-1 rounded-full bg-primary" aria-hidden />}
          <span className={`${l.icon} size-5 shrink-0`} />
          <span className={folded ? "sr-only" : "truncate"}>{t(l.label)}</span>
          {l.external && !folded && <span className="icon-[tabler--external-link] ms-auto size-4 text-base-content/40" />}
        </a>
      </li>
    );
  };
  return (
    <aside
      className={`fixed inset-y-0 start-0 z-20 flex flex-col border-e border-base-300 bg-base-100 transition-[width] duration-200 motion-reduce:transition-none max-xl:hidden print:hidden ${folded ? "w-16" : "w-64"}`}
      aria-label={t`Main menu`}
    >
      <div className={`flex h-16 shrink-0 items-center ${folded ? "justify-center" : "px-5"}`}>
        <a href={HOME_HREF} aria-label={t`Ferret home`} className="text-primary">
          {folded ? <PawMark className="size-7" taps /> : <Logo className="text-lg" />}
        </a>
      </div>
      <div className={`pb-2 [&>*]:inline-flex ${folded ? "flex justify-center" : "px-4"}`}>
        <HouseholdBadge householdName={props.householdName} householdId={props.householdId} align="start" compact={folded} />
      </div>
      <nav className={`flex-1 overflow-y-auto pb-4 ${folded ? "px-2" : "px-3"}`}>
        <ul className="flex flex-col gap-0.5">{main.map(item)}</ul>
        {NAV_GROUPS.map((g) => {
          const here = g.links.some((l) => l.href === active);
          return (
            <div key={g.title.id} className={folded ? "mt-3 border-t border-base-content/10 pt-3" : "mt-4"}>
              <p
                className={`px-3 pb-1 text-xs font-semibold uppercase tracking-wider ${folded ? "sr-only" : ""} ${here ? "text-primary" : "text-base-content/70"}`}
              >
                {t(g.title)}
              </p>
              <ul className="flex flex-col gap-0.5">{g.links.map(item)}</ul>
            </div>
          );
        })}
      </nav>
      <div className={`shrink-0 border-t border-base-300 p-2 ${folded ? "flex justify-center" : ""}`}>
        <button
          type="button"
          className={`btn btn-text btn-sm text-base-content/70 ${folded ? "btn-square" : "w-full justify-start"}`}
          aria-expanded={!folded}
          aria-label={folded ? t`Show the menu's names` : t`Fold the menu to icons`}
          title={folded ? t`Expand` : undefined}
          onClick={props.onToggle}
        >
          <span className={`${folded ? "icon-[tabler--layout-sidebar-left-expand]" : "icon-[tabler--layout-sidebar-left-collapse]"} size-5`} />
          {!folded && t`Collapse`}
        </button>
      </div>
    </aside>
  );
}

// ── + Add ───────────────────────────────────────────────────────────────────

/** Open the scanner on the home screen: true = to add things (a code you already have offers "add 1"). */
let scanOnMount: { adding: boolean } | null = null;
const SCAN_EVENT = "ferret:scan";
const HOME_VIEWS: Route["name"][] = ["home", "property", "place", "items", "category", "tag"];

/** "Scan a barcode" from anywhere: the scanner lives on the home screens. `adding`: from + Add. */
export function requestScan(route: Route["name"], adding = false) {
  if (HOME_VIEWS.includes(route)) window.dispatchEvent(new CustomEvent(SCAN_EVENT, { detail: { adding } }));
  else {
    scanOnMount = { adding };
    navigateTo("#/");
  }
}

/**
 * Search and scan in the top bar of the screens that don't have the search box (an item, maintenance, shopping…):
 * a field-shaped button (an icon on a phone) that goes home with the cursor in the search, and the scanner.
 */
/** `onSearch`: the screen searches in itself (an item's page: inside that item) instead of going home. */
export function BarSearch({ onSearch }: { onSearch?: () => void } = {}) {
  const search = onSearch ?? searchFromAnywhere;
  const label = onSearch ? t`Search this item` : t`Search your stuff`;
  return (
    <div className="ms-auto flex shrink-0 items-center gap-1 print:hidden">
      <button
        type="button"
        className="input input-sm w-56 cursor-text items-center gap-2 text-base-content/70 max-md:hidden"
        onClick={search}
        aria-label={label}
      >
        <span className="icon-[tabler--search] size-4 shrink-0" />
        <span className="grow text-start">{onSearch ? t`Search this item…` : t`Search…`}</span>
        <kbd className="kbd kbd-sm border-base-content/15 bg-base-200 font-sans text-base-content/70 pointer-coarse:hidden">{COMMAND_K}</kbd>
      </button>
      <button type="button" className="btn btn-text btn-circle md:hidden" onClick={search} aria-label={label}>
        <span className="icon-[tabler--search] size-5" />
      </button>
      <button type="button" className="btn btn-text btn-circle" onClick={() => requestScan("more")} aria-label={t`Scan a barcode`} title={t`Scan a barcode`}>
        <span className="icon-[tabler--barcode] size-5" />
      </button>
    </div>
  );
}

/** For the home screens: open the scanner when + Add (or a top bar's scan button) asks. */
export function useScanRequests(open: (adding: boolean) => void) {
  useEffect(() => {
    if (scanOnMount) {
      open(scanOnMount.adding);
      scanOnMount = null;
    }
    const onScan = (e: Event) => open(Boolean((e as CustomEvent<{ adding?: boolean }>).detail?.adding));
    window.addEventListener(SCAN_EVENT, onScan);
    return () => window.removeEventListener(SCAN_EVENT, onScan);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
}

/** What's being looked at, so new things go there. */
export interface AddContext {
  locationId?: string;
  categoryId?: string;
  tag?: string;
  /** "Garage", "Tools", "Christmas" — for the sheet's title. */
  name?: string;
}

/** The top bar's "+ Add" (wide screens). */
export function AddButton({ householdId, route, context }: { householdId: string; route: Route["name"]; context: AddContext }) {
  const canEdit = useCanEdit(householdId);
  const [open, setOpen] = useState(false);
  if (!canEdit) return null;
  return (
    <>
      <button type="button" className="btn btn-primary btn-sm max-sm:hidden" onClick={() => setOpen(true)}>
        <span className="icon-[tabler--plus] size-4" />
        <Trans>Add</Trans>
      </button>
      {open && <AddSheet householdId={householdId} route={route} context={context} onClose={() => setOpen(false)} />}
    </>
  );
}

/** The phone's "+": floating above the tab bar, bottom right, where a thumb reaches. */
export function AddFab({ householdId, route, context }: { householdId: string; route: Route["name"]; context: AddContext }) {
  const canEdit = useCanEdit(householdId);
  const [open, setOpen] = useState(false);
  if (!canEdit) return null;
  return (
    <>
      <button
        type="button"
        className="btn btn-primary btn-circle btn-lg fixed end-4 z-20 shadow-lg sm:hidden print:hidden"
        style={{ bottom: "calc(56px + env(safe-area-inset-bottom) + 16px)" }}
        aria-label={t`Add something`}
        onClick={() => setOpen(true)}
      >
        <span className="icon-[tabler--plus] size-7" />
      </button>
      {open && <AddSheet householdId={householdId} route={route} context={context} onClose={() => setOpen(false)} />}
    </>
  );
}

function AddSheet({ householdId, route, context, onClose }: { householdId: string; route: Route["name"]; context: AddContext; onClose: () => void }) {
  const [typing, setTyping] = useState(false);
  // Opening an item (one photo added) or another screen closes the sheet.
  const page = useRouterState({ select: (s) => s.location.pathname });
  const openedOn = useRef(page);
  useEffect(() => {
    if (page !== openedOn.current) onClose();
  }, [page, onClose]);
  const roomScan = useRoomScanOn(householdId);
  const PHOTOS = (
    <AddFromPhotos
                householdId={householdId}
                locationId={context.locationId ?? null}
                categoryId={context.categoryId ?? null}
                tags={context.tag ? [context.tag] : []}
                className="btn btn-soft btn-primary btn-wrap h-auto min-h-24 flex-col gap-2 rounded-box px-2 py-3 text-sm"
              />
  );
  const options: { icon: string; label: string; detail: string; onClick?: () => void; href?: string }[] = [
    { icon: "icon-[tabler--keyboard]", label: t`Type it in`, detail: t`A name, and whatever else you know`, onClick: () => setTyping(true) },
    { icon: "icon-[tabler--barcode]", label: t`Scan a barcode`, detail: t`Ferret looks it up`, onClick: () => (onClose(), requestScan(route, true)) },
    ...(roomScan
      ? [
          {
            icon: "icon-[tabler--scan-eye]",
            label: t`Scan a room`,
            detail: t`One photo of a room: Ferret lists what's in it`,
            href: scanRoomHref({ locationId: context.locationId }),
          },
        ]
      : []),
    {
      icon: "icon-[tabler--walk]",
      label: t`Walk through a room`,
      detail: t`Photograph a room's things, then name them`,
      href: context.locationId ? walkthroughHref(context.locationId) : WALKTHROUGH_HREF,
    },
    { icon: "icon-[tabler--file-import]", label: t`Import`, detail: t`A spreadsheet, or Home Assistant`, href: IMPORT_HREF },
    { icon: "icon-[tabler--qrcode]", label: t`Blank QR labels`, detail: t`To stick on boxes as you pack`, href: LABELS_HREF },
  ];
  return (
    <Modal id="add-sheet" title={context.name ? (typing ? t`Add to ${ph({ place: context.name })}` : t`Add something to ${ph({ place: context.name })}`) : typing ? t`Add` : t`Add something`} onClose={onClose}>
      {typing ? (
        <QuickAdd householdId={householdId} context={context} onDone={onClose} onBack={() => setTyping(false)} />
      ) : (
        // FlyonUI's app-grid dropdown (Dashboard Dropdown 14): tiles three across, icon over label.
        <div className="grid grid-cols-3 gap-2">
          {options.map((o, i) => {
            const tile = (
              <>
                <span className={`${o.icon} size-6`} />
                <span>{o.label}</span>
              </>
            );
            const cls = "btn btn-soft btn-wrap h-auto min-h-24 flex-col gap-2 rounded-box px-2 py-3 text-sm";
            const el = o.href ? (
              <a key={o.label} href={o.href} className={cls} title={o.detail}>
                {tile}
              </a>
            ) : (
              <button key={o.label} type="button" className={cls} title={o.detail} onClick={o.onClick}>
                {tile}
              </button>
            );
            // Photos second, after "Type it in".
            return i === 0 ? [el, <span key="photos" className="contents">{PHOTOS}</span>] : el;
          })}
        </div>
      )}
    </Modal>
  );
}

function QuickAdd({ householdId, context, onDone, onBack }: { householdId: string; context: AddContext; onDone: () => void; onBack: () => void }) {
  const qc = useQueryClient();
  const [place, setPlace] = useState<string | null>(context.locationId ?? null);
  const templates = useTemplates(householdId);
  const [template, setTemplate] = useState<ItemTemplate | null>(null);
  const [custom, setCustom] = useState<CustomFieldValues>({});
  const create = useMutation({
    mutationFn: api.createItem,
    onSuccess: async (made) => {
      for (const k of ["items", "places", "overview"]) await qc.invalidateQueries({ queryKey: [k, householdId] });
      onDone();
      navigateTo(itemHref(made.id));
    },
  });
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);

    create.mutate({
      name: String(f.get("name")).trim(),
      brand: String(f.get("brand") || "").trim() || null,
      valueCents: toCents(f.get("value")),
      isContainer: f.get("box") === "on",
      locationId: place,
      // Left out, a template's category and tags apply (the server fills them in).
      ...(context.categoryId && { categoryId: context.categoryId }),
      tags: context.tag ? [context.tag] : [],
      ...(template && { templateId: template.id, customFields: custom }),
    });
  }
  return (
    <form className="flex flex-col gap-4" onSubmit={onSubmit}>
      <div>
        <label className="label-text" htmlFor="quick-name">
          <Trans>What is it?</Trans>
        </label>
        <input id="quick-name" name="name" className="input" required maxLength={200} autoFocus placeholder={t`e.g. Cordless drill`} />
      </div>
      <PlacePicker householdId={householdId} id="quick-place" name="place" label={t`Where is it?`} value={place} onChange={setPlace} noneLabel={t`Not in a place yet`} />
      {Boolean(templates.data?.length) && (
        <TemplatePicker
          householdId={householdId}
          value={template?.id ?? null}
          onChange={(tpl) => {
            setTemplate(tpl);
            setCustom({});
          }}
        />
      )}
      {template && <CustomFieldInputs fields={template.fields} values={custom} onChange={setCustom} />}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="label-text" htmlFor="quick-brand">
            <Trans>Brand</Trans>
          </label>
          <input id="quick-brand" name="brand" className="input" maxLength={120} />
        </div>
        <div>
          <label className="label-text" htmlFor="quick-value">
            <Trans>Worth</Trans>
          </label>
          <div className="input">
            <span className="my-auto me-1 text-base-content/70">{currencySymbol()}</span>
            <input id="quick-value" name="value" className="grow" inputMode="decimal" />
          </div>
        </div>
      </div>
      <label className="flex cursor-pointer items-center gap-2">
        <input type="checkbox" name="box" className="checkbox checkbox-primary" />
        <Trans>It's a box (other things go in it)</Trans>
      </label>
      {create.isError && <div className="alert alert-soft alert-error">{create.error.message}</div>}
      <div className="flex flex-wrap justify-between gap-2">
        <button type="button" className="btn btn-text" onClick={onBack}>
          <Trans>Other ways</Trans>
        </button>
        <button type="submit" className="btn btn-primary" disabled={create.isPending}>
          {create.isPending && <span className="loading loading-spinner loading-sm" />}
          <Trans>Add</Trans>
        </button>
      </div>
    </form>
  );
}

export type { PlacesTree };
