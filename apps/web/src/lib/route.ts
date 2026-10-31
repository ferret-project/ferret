import type { ItemOrigin } from "@ferret/shared";
import type { MissingDetail } from "@ferret/shared/utils";

/**
 * The app's addresses, all `#/…` (TanStack Router on hash history — router.tsx has the routes):
 * #/ (the dashboard), #/property/:id (its rooms), #/in/:locationId (a room: what's inside),
 * #/items (everything), #/missing/:detail (items missing a photo, value…), #/added/:origin (added by Claude…), #/items/:id,
 * #/category/:id, #/tag/:name (a tag is a collection), #/categories (edit them, and tags),
 * #/places (edit the tree), #/import[/csv|/home-assistant] (bring things in), #/loans (lent and borrowed),
 * #/s/:token (a share link) and #/b/:token (a borrower's reminder link) — both signed out too, #/maintenance, #/deleted (recently deleted), #/settings[/notifications|/security|/api] (household, reminders, sign-in, API keys),
 * #/providers[/:id] (service providers), #/l/:code (a scanned QR label), #/labels[?codes=A,B] (print labels), #/report (insurance report),
 * #/invite/:id (an invitation link — works signed out too), #/unlock/:token (a "sign in again" link) and
 * #/reset-password/:token (an emailed password-reset link), both signed out. A trailing `?q=` is a search kept in
 * the address (Search.tsx).
 *
 * `Route` names the screens (`useRouteName`, lib/route-name.ts) and describes the home screen's views.
 */
export type Route =
  | { name: "home" }
  | { name: "property"; id: string }
  | { name: "place"; locationId: string }
  | { name: "items"; missing?: MissingDetail; origin?: ItemOrigin }
  | { name: "category"; id: string }
  | { name: "tag"; tag: string }
  | { name: "categories" }
  | { name: "report" }
  | { name: "providers" }
  | { name: "api" }
  | { name: "provider"; id: string }
  | { name: "maintenance" }
  | { name: "deleted" }
  | { name: "shopping" }
  | { name: "past" }
  | { name: "walkthrough"; locationId: string | null; step: "photos" | "review" }
  | { name: "roomscan"; id: string }
  | { name: "collections" }
  | { name: "collection"; id: string }
  | { name: "import"; source: "csv" | "homeassistant" | null }
  | { name: "shared"; token: string }
  | { name: "borrower"; token: string }
  | { name: "loans" }
  | { name: "coverage" }
  | { name: "more" }
  | { name: "item"; id: string }
  | { name: "places" }
  | { name: "settings"; section: SettingsSection }
  | { name: "invite"; id: string }
  | { name: "unlock"; token: string }
  | { name: "reset-password"; token: string }
  | { name: "label"; code: string }
  | { name: "labels"; codes: string[] }
  /** A link that matches nothing. */
  | { name: "notfound" };

export const HOME_HREF = "#/";
export const ITEMS_HREF = "#/items";
export const itemHref = (id: string) => `#/items/${encodeURIComponent(id)}`;
export const propertyHref = (id: string) => `#/property/${encodeURIComponent(id)}`;
/** A room (or shelf…): what's inside it, and everything kept there. */
export const placeHref = (locationId: string) => `#/in/${encodeURIComponent(locationId)}`;
export const PLACES_HREF = "#/places";
export const CATEGORIES_HREF = "#/categories";
export const LABELS_HREF = "#/labels";
/** The insurance report (print or save as PDF) and CSV download. */
export const REPORT_HREF = "#/report";
export const PROVIDERS_HREF = "#/providers";
/** The REST API reference. */
export const API_HREF = "#/api";
export const providerHref = (id: string) => `#/providers/${encodeURIComponent(id)}`;
/** The print page for these labels (none: blank labels). */
export const printLabelsHref = (codes: string[]) => `${LABELS_HREF}?codes=${codes.map(encodeURIComponent).join(",")}`;
export const categoryHref = (id: string) => `#/category/${encodeURIComponent(id)}`;
/** A tag's items: a collection. */
export const tagHref = (name: string) => `#/tag/${encodeURIComponent(name)}`;
export const MAINTENANCE_HREF = "#/maintenance";
/** Recently deleted: 30 days to restore. */
export const DELETED_HREF = "#/deleted";
/** The shopping list: what's run out or running low (Shopping.tsx). */
export const SHOPPING_HREF = "#/shopping";
/** Things you no longer have: sold, given away, thrown out, lost, stolen (Gone.tsx). */
export const PAST_HREF = "#/past";
/** Room-by-room walkthrough: photograph a room's things, then review them (Walkthrough.tsx). */
export const WALKTHROUGH_HREF = "#/walkthrough";
export const walkthroughHref = (locationId: string, step: "photos" | "review" = "photos") =>
  `${WALKTHROUGH_HREF}/${encodeURIComponent(locationId)}${step === "review" ? "/review" : ""}`;
/** Collections: coins, dolls, cards — each with its want list (Collections.tsx). */
export const COLLECTIONS_HREF = "#/collections";
export const collectionHref = (id: string, view?: "wanted") => `#/collection/${encodeURIComponent(id)}${view ? `?show=${view}` : ""}`;
/** Photograph a room (or a box): the vision model lists what's in it, to review (RoomScan.tsx). "new" starts one. */
export const roomScanHref = (id: string) => `#/room-scan/${encodeURIComponent(id)}`;
export const scanRoomHref = (at: { locationId?: string | null; containerItemId?: string | null } = {}) =>
  `#/room-scan/new${at.locationId ? `?in=${encodeURIComponent(at.locationId)}` : at.containerItemId ? `?box=${encodeURIComponent(at.containerItemId)}` : ""}`;
/** Phones: the More tab — everything that isn't a tab, grouped (Nav.tsx). */
export const MORE_HREF = "#/more";
/** Insurance limits next to what things are worth (PayOff.tsx). */
export const COVERAGE_HREF = "#/coverage";
/** Lent and borrowed things (Loans.tsx). */
export const LOANS_HREF = "#/loans";
/** Importing: a spreadsheet, or Home Assistant's devices (Import.tsx). */
export const IMPORT_HREF = "#/import";
export const importHref = (source: "csv" | "homeassistant") => `${IMPORT_HREF}/${source === "csv" ? "csv" : "home-assistant"}`;
export const missingHref = (detail: MissingDetail) => `#/missing/${detail}`;
/** Everything added one way: `#/added/claude` — what Claude added. */
export const addedHref = (origin: ItemOrigin) => `#/added/${origin}`;
export const SETTINGS_HREF = "#/settings";
export const settingsSections = ["household", "plan", "notifications", "security", "api", "server"] as const;
export type SettingsSection = (typeof settingsSections)[number];
export const settingsHref = (section: SettingsSection) => (section === "household" ? SETTINGS_HREF : `${SETTINGS_HREF}/${section}`);
