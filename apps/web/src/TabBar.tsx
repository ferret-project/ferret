/**
 * The tab bar along the bottom on phones (where a thumb reaches): the main places, always one tap away.
 * Wider screens use the icons in each screen's top bar instead. The active tab has a filled icon where
 * Tabler has one. Like iOS's own, it doesn't grow with text size (px, not rem). Pages leave room for it
 * through --tabbar (index.css).
 */
import { type Route, HOME_HREF, ITEMS_HREF, MAINTENANCE_HREF, MORE_HREF, PLACES_HREF } from "./lib/route";

type Tab = { href: string; label: string; icon: string; active: string; routes: Route["name"][] };

const TABS: Tab[] = [
  { href: HOME_HREF, label: "Home", icon: "icon-[tabler--home]", active: "icon-[tabler--home-filled]", routes: ["home", "category", "tag", "label"] },
  { href: ITEMS_HREF, label: "Everything", icon: "icon-[tabler--layout-grid]", active: "icon-[tabler--layout-grid-filled]", routes: ["items", "item"] },
  { href: PLACES_HREF, label: "Places", icon: "icon-[tabler--map-pin]", active: "icon-[tabler--map-pin-filled]", routes: ["places", "property", "place", "walkthrough"] },
  { href: MAINTENANCE_HREF, label: "Maintenance", icon: "icon-[tabler--tool]", active: "icon-[tabler--tool]", routes: ["maintenance", "providers", "provider"] },
  // Everything else, grouped (Nav.tsx MorePage) — settings included.
  {
    href: MORE_HREF,
    label: "More",
    icon: "icon-[tabler--dots-circle-horizontal]",
    active: "icon-[tabler--dots-circle-horizontal]",
    routes: ["more", "settings", "api", "categories", "deleted", "shopping", "past", "loans", "coverage", "report", "labels", "import"],
  },
];

export function TabBar({ route }: { route: Route["name"] }) {
  return (
    <nav
      id="tab-bar"
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-20 border-t border-base-300 bg-base-100/85 pb-[env(safe-area-inset-bottom)] backdrop-blur-md sm:hidden print:hidden"
    >
      <ul className="grid h-[56px] grid-cols-5">
        {TABS.map((t) => {
          const on = t.routes.includes(route);
          return (
            <li key={t.href}>
              <a
                href={t.href}
                aria-current={on ? "page" : undefined}
                className={`flex h-full flex-col items-center justify-center gap-0.5 text-[11px] font-medium ${on ? "text-primary" : "text-base-content/70"}`}
              >
                <span className={`${on ? t.active : t.icon} size-[24px]`} />
                {t.label}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
