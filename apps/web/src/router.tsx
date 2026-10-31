/**
 * The routes: TanStack Router on hash history, so links stay `/#/…` (share links, QR labels, emailed links and the
 * server need nothing new); plain `<a href="#/…">` links work as they are, and code opens a page with `navigateTo`
 * (lib/navigate.ts). Back puts the scroll where it was (`stampEntry`). The `#/…` builders live in lib/route.ts.
 *
 * `/` (the root) is the first-load splash, then either a signed-out screen (an invitation, a share link, a borrower's
 * link, "sign in again", a password reset) or the signed-in layout (`app`: sign-in, household, the sidebar and tab
 * bar), whose children are the screens. A link that doesn't parse (a bad token, an unknown section) is `notFound()`.
 */
import type { ItemOrigin } from "@ferret/shared";
import { type MissingDetail, missingDetails } from "@ferret/shared/utils";
import {
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  notFound,
  redirect,
} from "@tanstack/react-router";
import { App, Home, ResetPasswordScreen, SignedIn, UnlockScreen } from "./App";
import { Categories } from "./Catalog";
import { Borrower, Loans } from "./Loans";
import { Coverage } from "./PayOff";
import { ItemPage } from "./ItemPage";
import { LabelLanding, PrintLabels } from "./Labels";
import { Maintenance } from "./Maintenance";
import { MorePage } from "./Nav";
import { NotFound } from "./NotFound";
import { Past } from "./Gone";
import { Places } from "./Places";
import { ProviderPage, Providers } from "./Providers";
import { useHousehold } from "./lib/household";
import { setHistory } from "./lib/navigate";
import { itemOriginList } from "./lib/origin";
import { type Route, type SettingsSection, settingsSections } from "./lib/route";

// Screens only reached here load when first opened: each route's loader fetches its code before it draws.
const ApiReference = lazyRouteComponent(() => import("./ApiReference"), "ApiReference");
const Deleted = lazyRouteComponent(() => import("./Deleted"), "Deleted");
const Import = lazyRouteComponent(() => import("./Import"), "Import");
const InviteScreen = lazyRouteComponent(() => import("./Invite"), "InviteScreen");
const Report = lazyRouteComponent(() => import("./Report"), "Report");
const Settings = lazyRouteComponent(() => import("./Settings"), "Settings");
const Shared = lazyRouteComponent(() => import("./Shared"), "Shared");
const Shopping = lazyRouteComponent(() => import("./Shopping"), "Shopping");
const Walkthrough = lazyRouteComponent(() => import("./Walkthrough"), "Walkthrough");
const RoomScanScreen = lazyRouteComponent(() => import("./RoomScan"), "RoomScanScreen");
const CollectionsScreen = lazyRouteComponent(() => import("./Collections"), "CollectionsScreen");
const CollectionScreen = lazyRouteComponent(() => import("./Collections"), "CollectionScreen");

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
  interface StaticDataRouteOption {
    /** Which screen this is, for the tab bar, the sidebar and "+ Add" (`useRouteName`, lib/route-name.ts). */
    name?: Route["name"];
  }
}

/**
 * A link's part doesn't fit (a bad token, an unknown section): the not-found screen. Checked in `loader`, not
 * `beforeLoad` — a notFound() from beforeLoad goes to the root's, outside the signed-in layout.
 */
const check = (ok: boolean) => {
  if (!ok) throw notFound();
};
const TOKEN = /^[\w-]{20,100}$/;

const rootRoute = createRootRoute({ component: App, notFoundComponent: () => <NotFound /> });

// ── Signed out ──────────────────────────────────────────────────────────────
const inviteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "invite/$id",
  staticData: { name: "invite" },
  loader: () => InviteScreen.preload?.(),
  component: function Invite() {
    return <InviteScreen id={inviteRoute.useParams().id} />;
  },
});
// No account needed: a share link, and a borrower's link from a reminder email.
const sharedRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "s/$token",
  staticData: { name: "shared" },
  loader: ({ params }) => {
    check(TOKEN.test(params.token));
    return Shared.preload?.();
  },
  component: function SharedLink() {
    return <Shared token={sharedRoute.useParams().token} />;
  },
});
const borrowerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "b/$token",
  staticData: { name: "borrower" },
  loader: ({ params }) => check(TOKEN.test(params.token)),
  component: function BorrowerLink() {
    return <Borrower token={borrowerRoute.useParams().token} />;
  },
});
const unlockRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "unlock/$token",
  staticData: { name: "unlock" },
  loader: ({ params }) => check(/^[\w-]+$/.test(params.token)),
  component: function Unlock() {
    const { token } = unlockRoute.useParams();
    return <UnlockScreen key={token} token={token} />;
  },
});
const resetRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "reset-password/$token",
  staticData: { name: "reset-password" },
  loader: ({ params }) => check(/^[\w-]+$/.test(params.token)),
  component: function Reset() {
    const { token } = resetRoute.useParams();
    return <ResetPasswordScreen key={token} token={token} />;
  },
});

// ── Signed in ───────────────────────────────────────────────────────────────
const appRoute = createRoute({ getParentRoute: () => rootRoute, id: "app", component: SignedIn });
// The screens, one level in: a link that doesn't fit is not found in place of the screen, inside the layout.
const screensRoute = createRoute({ getParentRoute: () => appRoute, id: "screens", notFoundComponent: () => <NotFound /> });

/** A screen in the signed-in layout that needs only the household (`lazy`: its code, fetched before it draws). */
function screen(path: string, name: Route["name"], Screen: React.ComponentType<{ householdId: string; householdName: string }>, lazy?: { preload?: () => Promise<void> | undefined }) {
  return createRoute({
    getParentRoute: () => screensRoute,
    path,
    staticData: { name },
    loader: () => lazy?.preload?.(),
    component: function HouseholdScreen() {
      return <Screen {...useHousehold()} />;
    },
  });
}

/** The views under the home screen's search box share `Home`. */
function homeView(path: string, name: Route["name"], view: (params: Record<string, string>) => Parameters<typeof Home>[0]["view"]) {
  const route = createRoute({
    getParentRoute: () => screensRoute,
    path,
    staticData: { name },
    component: function HomeView() {
      return <Home {...useHousehold()} view={view(route.useParams() as Record<string, string>)} />;
    },
  });
  return route;
}

const homeRoutes = [
  homeView("/", "home", () => ({ name: "home" })),
  homeView("property/$id", "property", (p) => ({ name: "property", id: p.id! })),
  homeView("in/$locationId", "place", (p) => ({ name: "place", locationId: p.locationId! })),
  homeView("items", "items", () => ({ name: "items" })),
  homeView("category/$id", "category", (p) => ({ name: "category", id: p.id! })),
  homeView("tag/$name", "tag", (p) => ({ name: "tag", tag: p.name! })),
];
const missingRoute = createRoute({
  getParentRoute: () => screensRoute,
  path: "missing/$detail",
  staticData: { name: "items" },
  loader: ({ params }) => check(missingDetails.includes(params.detail as MissingDetail)),
  component: function Missing() {
    return <Home {...useHousehold()} view={{ name: "items", missing: missingRoute.useParams().detail as MissingDetail }} />;
  },
});
const addedRoute = createRoute({
  getParentRoute: () => screensRoute,
  path: "added/$origin",
  staticData: { name: "items" },
  loader: ({ params }) => check(itemOriginList.includes(params.origin as ItemOrigin)),
  component: function Added() {
    return <Home {...useHousehold()} view={{ name: "items", origin: addedRoute.useParams().origin as ItemOrigin }} />;
  },
});
// #/overview is from before the dashboard was home.
const overviewRoute = createRoute({ getParentRoute: () => screensRoute, path: "overview", beforeLoad: () => redirect({ to: "/", throw: true }) });

const itemRoute = createRoute({
  getParentRoute: () => screensRoute,
  path: "items/$id",
  staticData: { name: "item" },
  component: function Item() {
    return <ItemPage itemId={itemRoute.useParams().id} householdId={useHousehold().householdId} />;
  },
});
const settingsRoute = createRoute({
  getParentRoute: () => screensRoute,
  path: "settings",
  staticData: { name: "settings" },
  loader: () => Settings.preload?.(),
  component: function SettingsHome() {
    return <Settings section="household" {...useHousehold()} />;
  },
});
const settingsSectionRoute = createRoute({
  getParentRoute: () => screensRoute,
  path: "settings/$section",
  staticData: { name: "settings" },
  loader: ({ params }) => {
    check(settingsSections.includes(params.section as SettingsSection));
    return Settings.preload?.();
  },
  component: function SettingsSectionScreen() {
    return <Settings section={settingsSectionRoute.useParams().section as SettingsSection} {...useHousehold()} />;
  },
});
const providerRoute = createRoute({
  getParentRoute: () => screensRoute,
  path: "providers/$id",
  staticData: { name: "provider" },
  component: function Provider() {
    return <ProviderPage id={providerRoute.useParams().id} householdId={useHousehold().householdId} />;
  },
});
const labelRoute = createRoute({
  getParentRoute: () => screensRoute,
  path: "l/$code",
  staticData: { name: "label" },
  loader: ({ params }) => check(/^[0-9A-Za-z]+$/.test(params.code)),
  component: function ScannedLabel() {
    return <LabelLanding code={labelRoute.useParams().code} householdId={useHousehold().householdId} />;
  },
});
const labelsRoute = createRoute({
  getParentRoute: () => screensRoute,
  path: "labels",
  staticData: { name: "labels" },
  validateSearch: (search: Record<string, unknown>): { codes?: string } => (typeof search.codes === "string" ? { codes: search.codes } : {}),
  component: function Labels() {
    const { codes } = labelsRoute.useSearch();
    return <PrintLabels {...useHousehold()} codes={codes ? codes.split(",").filter(Boolean) : []} />;
  },
});
const walkthroughRoute = createRoute({
  getParentRoute: () => screensRoute,
  path: "walkthrough",
  staticData: { name: "walkthrough" },
  loader: () => Walkthrough.preload?.(),
  component: function WalkthroughStart() {
    return <Walkthrough householdId={useHousehold().householdId} locationId={null} step="photos" />;
  },
});
const walkthroughRoomRoute = createRoute({
  getParentRoute: () => screensRoute,
  path: "walkthrough/$locationId",
  staticData: { name: "walkthrough" },
  loader: () => Walkthrough.preload?.(),
  component: function WalkthroughRoom() {
    return <Walkthrough householdId={useHousehold().householdId} locationId={walkthroughRoomRoute.useParams().locationId} step="photos" />;
  },
});
const walkthroughReviewRoute = createRoute({
  getParentRoute: () => screensRoute,
  path: "walkthrough/$locationId/review",
  staticData: { name: "walkthrough" },
  loader: () => Walkthrough.preload?.(),
  component: function WalkthroughReview() {
    return <Walkthrough householdId={useHousehold().householdId} locationId={walkthroughReviewRoute.useParams().locationId} step="review" />;
  },
});
const roomScanRoute = createRoute({
  getParentRoute: () => screensRoute,
  path: "room-scan/$id",
  staticData: { name: "roomscan" },
  validateSearch: (search: Record<string, unknown>): { in?: string; box?: string } => ({
    ...(typeof search.in === "string" && { in: search.in }),
    ...(typeof search.box === "string" && { box: search.box }),
  }),
  loader: () => RoomScanScreen.preload?.(),
  component: function RoomScanRoute() {
    const search = roomScanRoute.useSearch();
    return <RoomScanScreen householdId={useHousehold().householdId} id={roomScanRoute.useParams().id} locationId={search.in ?? null} boxId={search.box ?? null} />;
  },
});
const collectionsRoute = createRoute({
  getParentRoute: () => screensRoute,
  path: "collections",
  staticData: { name: "collections" },
  loader: () => CollectionsScreen.preload?.(),
  component: function Collections() {
    return <CollectionsScreen householdId={useHousehold().householdId} />;
  },
});
const collectionRoute = createRoute({
  getParentRoute: () => screensRoute,
  path: "collection/$id",
  staticData: { name: "collection" },
  validateSearch: (search: Record<string, unknown>): { show?: string } => (typeof search.show === "string" ? { show: search.show } : {}),
  loader: () => CollectionScreen.preload?.(),
  component: function Collection() {
    return (
      <CollectionScreen householdId={useHousehold().householdId} id={collectionRoute.useParams().id} show={collectionRoute.useSearch().show === "wanted" ? "wanted" : "owned"} />
    );
  },
});
const importRoutes = ([
  ["import", null],
  ["import/csv", "csv"],
  ["import/home-assistant", "homeassistant"],
] as const).map(([path, source]) =>
  createRoute({
    getParentRoute: () => screensRoute,
    path,
    staticData: { name: "import" },
    loader: () => Import.preload?.(),
    component: function ImportScreen() {
      return <Import householdId={useHousehold().householdId} source={source} />;
    },
  }),
);

const routeTree = rootRoute.addChildren([
  inviteRoute,
  sharedRoute,
  borrowerRoute,
  unlockRoute,
  resetRoute,
  appRoute.addChildren([
    screensRoute.addChildren([
    ...homeRoutes,
    missingRoute,
    addedRoute,
    overviewRoute,
    itemRoute,
    settingsRoute,
    settingsSectionRoute,
    providerRoute,
    labelRoute,
    labelsRoute,
    walkthroughRoute,
    roomScanRoute,
    collectionsRoute,
    collectionRoute,
    walkthroughRoomRoute,
    walkthroughReviewRoute,
    ...importRoutes,
    screen("places", "places", Places),
    screen("categories", "categories", ({ householdId }) => <Categories householdId={householdId} />),
    screen("api", "api", () => <ApiReference />, ApiReference),
    screen("providers", "providers", ({ householdId }) => <Providers householdId={householdId} />),
    screen("report", "report", Report, Report),
    screen("maintenance", "maintenance", Maintenance),
    screen("deleted", "deleted", ({ householdId }) => <Deleted householdId={householdId} />, Deleted),
    screen("shopping", "shopping", ({ householdId }) => <Shopping householdId={householdId} />, Shopping),
    screen("past", "past", ({ householdId }) => <Past householdId={householdId} />),
    screen("loans", "loans", ({ householdId }) => <Loans householdId={householdId} />),
    screen("coverage", "coverage", ({ householdId }) => <Coverage householdId={householdId} />),
    screen("more", "more", ({ householdId }) => <MorePage householdId={householdId} />),
    // Any other address: not found, inside the signed-in layout (signed out, it's the sign-in screen).
    screen("$", "notfound", () => <NotFound />),
    ]),
  ]),
]);

/**
 * Every history entry gets a key the router can find again, so Back puts the scroll where it was. The router keys its
 * own entries; an entry made outside it (a plain `<a href="#/…">` click, the page this tab opened on) has none, and
 * would get a new one each time it's read. Stamped here first — this listener runs before the history's own — with
 * the unpatched replaceState (the history wraps the instance's), leaving the address alone.
 */
function stampEntry(index: number) {
  const key = Math.random().toString(36).slice(2, 8);
  History.prototype.replaceState.call(window.history, { key, __TSR_key: key, __TSR_index: index }, "");
}
if (!window.history.state?.__TSR_key) stampEntry(0);
window.addEventListener("popstate", () => {
  if (!window.history.state?.__TSR_key) stampEntry((history.location.state.__TSR_index ?? 0) + 1);
});
const history = createHashHistory();
setHistory(history);

export const router = createRouter({
  routeTree,
  history,
  // Search values stay plain strings (`?q=`, `?codes=`): the default would read a label code like 1E10 as a number.
  parseSearch: (search) => Object.fromEntries(new URLSearchParams(search)),
  stringifySearch: (search) => {
    const s = new URLSearchParams(search as Record<string, string>).toString();
    return s ? `?${s}` : "";
  },
  scrollRestoration: true,
});
