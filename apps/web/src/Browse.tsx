/**
 * Browsing by place: property cards on the dashboard, a property's rooms, and a
 * room's breadcrumbs and the places inside it (closets, shelves…). The items
 * kept in a room are listed by the home screen under these. Cards follow
 * FlyonUI's card pattern, with the "Statistics 6" coloured underline.
 */
import type { LocationNode, PlacesTree } from "@ferret/shared";
import { useState } from "react";
import { countLabel, findLocation } from "./lib/places";
import { placeHref, PLACES_HREF, propertyHref, missingHref } from "./lib/route";
import { money } from "./Overview";
import { PROPERTY_TYPES } from "./Places";
import { useAppearance } from "./lib/appearance";

type Property = PlacesTree["properties"][number];

/** Items and value in these locations and everything nested inside them. */
export function totals(nodes: LocationNode[]): { items: number; valueCents: number } {
  return nodes.reduce((sum, n) => ({ items: sum.items + n.totalCount, valueCents: sum.valueCents + n.totalValueCents }), {
    items: 0,
    valueCents: 0,
  });
}

const address = (p: Property) => [p.details.street, p.details.city, p.details.region].filter(Boolean).join(", ");

/** The whole address for Apple Maps (street to country), or null without a street or city — as the server's map. */
const fullAddress = (p: Property) => {
  const d = p.details;
  if (!d.street?.trim() && !d.city?.trim()) return null;
  return [d.street, d.city, [d.region, d.postalCode].filter(Boolean).join(" "), d.country].filter((s) => s?.trim()).join(", ");
};

/** Apple Maps (the app on an iPhone, the website elsewhere) at an address. */
const appleMapsUrl = (addr: string) => `https://maps.apple.com/?address=${encodeURIComponent(addr)}`;

const things = (n: number) => `${n.toLocaleString()} ${n === 1 ? "thing" : "things"}`;

/** The dashboard's "Places": one card per property, then anything not in a place yet. */
export function PropertyCards({ tree, canEdit }: { tree: PlacesTree; canEdit: boolean }) {
  if (tree.properties.length === 0) {
    return (
      <section className="card">
        <div className="card-body items-center gap-3 text-center">
          <span className="icon-[tabler--home-plus] size-10 text-primary" />
          <h2 className="text-lg font-semibold">Where do you keep things?</h2>
          <p className="max-w-sm text-sm text-base-content/70">Add your home and its rooms, then browse your things room by room.</p>
          {canEdit && (
            <a href={PLACES_HREF} className="btn btn-primary">
              <span className="icon-[tabler--plus] size-5" />
              Add your home
            </a>
          )}
        </div>
      </section>
    );
  }
  return (
    <section className="flex flex-col gap-3" aria-labelledby="places-title">
      <div className="flex flex-wrap items-center justify-between gap-x-2">
        <h2 id="places-title" className="flex items-center gap-2 font-semibold text-base-content">
          <span className="icon-[tabler--map-pin] size-5 text-primary" />
          Places
        </h2>
        {canEdit && (
          <a href={PLACES_HREF} className="tap link link-primary link-hover text-sm">
            Edit places
          </a>
        )}
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {tree.properties.map((p) => (
          <PropertyCard key={p.id} property={p} />
        ))}
      </div>
      {tree.unplacedItems > 0 && (
        <a href={missingHref("place")} className="tap link link-hover text-sm text-base-content/70">
          {things(tree.unplacedItems)} not in a place yet →
        </a>
      )}
    </section>
  );
}

function PropertyCard({ property: p }: { property: Property }) {
  const sum = totals(p.locations);
  return (
    <a
      href={propertyHref(p.id)}
      className="card relative shadow-none transition-colors after:absolute after:-bottom-[0.5px] after:h-6 after:w-full after:rounded-box after:border-b-3 after:border-primary/50 after:transition-colors hover:after:border-primary"
    >
      <div className="card-body flex-row items-center gap-4 p-4">
        <div className="avatar avatar-placeholder">
          <div className="size-12 rounded-box bg-primary/10 text-primary">
            <span className={`${PROPERTY_TYPES[p.type].icon} size-6`} />
          </div>
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-semibold text-base-content">{p.name}</h3>
          <p className="text-sm text-base-content/70">
            {p.locations.length} {p.locations.length === 1 ? "room" : "rooms"} · {things(sum.items)}
          </p>
        </div>
        <div className="text-end">
          <p className="font-semibold text-base-content">{money(sum.valueCents)}</p>
          <span className="icon-[tabler--chevron-right] size-5 text-base-content/40" />
        </div>
      </div>
    </a>
  );
}

/** Rooms (or the places inside a room) as tiles: name, how many things, what they're worth. */
export function PlaceTiles({ nodes, title }: { nodes: LocationNode[]; title: string }) {
  return (
    <section className="flex flex-col gap-3" aria-label={title}>
      <h2 className="font-semibold text-base-content">{title}</h2>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {nodes.map((n) => {
          const sum = totals([n]);
          return (
            <a key={n.id} href={placeHref(n.id)} className="card shadow-none transition-colors hover:bg-base-100/70">
              <div className="card-body gap-1 p-4">
                <span className={`${n.children.length ? "icon-[tabler--folder]" : "icon-[tabler--door]"} mb-1 size-6 text-primary`} />
                <h3 className="truncate font-medium text-base-content">{n.name}</h3>
                <p className="text-sm text-base-content/70">{countLabel(n)}</p>
                {sum.valueCents > 0 && <p className="text-sm font-medium text-base-content">{money(sum.valueCents)}</p>}
                {n.children.length > 0 && (
                  <p className="text-xs text-base-content/70">
                    {n.children.length} {n.children.length === 1 ? "place" : "places"} inside
                  </p>
                )}
              </div>
            </a>
          );
        })}
      </div>
    </section>
  );
}

/** The top of a property's page: what it is, and its totals. */
/**
 * A property's page header. With an address: "Open in Maps", and — when the server has an Apple Maps key
 * (`maps`) — a map picture on top (fetched by the server; the dark one in dark mode), which opens Maps too.
 */
export function PropertyHeader({ property: p, canEdit, maps }: { property: Property; canEdit: boolean; maps: boolean }) {
  const sum = totals(p.locations);
  const addr = fullAddress(p);
  const [mapFailed, setMapFailed] = useState(false);
  const { dark } = useAppearance();
  return (
    <section className="card overflow-hidden">
      {addr && maps && !mapFailed && (
        <a href={appleMapsUrl(addr)} target="_blank" rel="noreferrer" aria-label={`${p.name} in Apple Maps`} className="block bg-base-200">
          <img
            src={`/api/v1/properties/${p.id}/map${dark ? "?scheme=dark" : ""}`}
            alt={`Map of ${addr}`}
            width={600}
            height={260}
            className="aspect-[60/26] w-full object-cover"
            onError={() => setMapFailed(true)}
          />
        </a>
      )}
      <div className="card-body flex-row items-center gap-4 p-4 sm:p-6">
        <div className="avatar avatar-placeholder">
          <div className="size-14 rounded-box bg-primary/10 text-primary">
            <span className={`${PROPERTY_TYPES[p.type].icon} size-7`} />
          </div>
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-xl font-semibold text-base-content">{p.name}</h1>
          <p className="text-sm text-base-content/70">
            {PROPERTY_TYPES[p.type].label} · {things(sum.items)}, {money(sum.valueCents)} in contents
          </p>
          {address(p) && <p className="truncate text-sm text-base-content/70">{address(p)}</p>}
          {(p.details.yearBuilt || p.details.valueCents) && (
            <p className="text-sm text-base-content/70">
              {[p.details.yearBuilt && `Built ${p.details.yearBuilt}`, p.details.valueCents != null && `Valued at ${money(p.details.valueCents)}`]
                .filter(Boolean)
                .join(" · ")}
            </p>
          )}
          {addr && (
            <a href={appleMapsUrl(addr)} target="_blank" rel="noreferrer" className="btn btn-soft btn-primary btn-sm mt-2">
              <span className="icon-[tabler--map-2] size-4" />
              Open in Maps
            </a>
          )}
        </div>
        {canEdit && (
          <a href={PLACES_HREF} className="btn btn-text btn-sm btn-circle" aria-label={`Edit ${p.name}'s rooms`}>
            <span className="icon-[tabler--pencil] size-4" />
          </a>
        )}
      </div>
    </section>
  );
}

/** Property › Garage › Shelf, each a link back up. */
/** A place's trail and name; `beside` sits next to the name (its QR label badge). */
export function Breadcrumbs({ tree, locationId, beside }: { tree: PlacesTree | undefined; locationId: string; beside?: React.ReactNode }) {
  const found = findLocation(tree, locationId);
  if (!found) return null;
  const trail: LocationNode[] = [];
  const walk = (nodes: LocationNode[]): boolean =>
    nodes.some((n) => {
      trail.push(n);
      if (n.id === locationId || walk(n.children)) return true;
      trail.pop();
      return false;
    });
  walk(found.property.locations);
  const here = trail.pop()!;
  return (
    <div className="flex flex-col gap-1">
      <nav className="breadcrumbs py-0 text-sm" aria-label="Where this is">
        <ul>
          <li>
            <a href={propertyHref(found.property.id)} className="tap text-base-content/70">
              {found.property.name}
            </a>
          </li>
          {trail.flatMap((n) => [
            <Separator key={`${n.id}-sep`} />,
            <li key={n.id}>
              <a href={placeHref(n.id)} className="tap text-base-content/70">
                {n.name}
              </a>
            </li>,
          ])}
          <Separator />
          <li aria-current="page" className="text-base-content">
            {here.name}
          </li>
        </ul>
      </nav>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h1 className="text-2xl font-semibold text-base-content">{here.name}</h1>
        {beside}
      </div>
      {here.totalCount > 0 && <p className="text-sm text-base-content/70">{countLabel(here)}</p>}
    </div>
  );
}

const Separator = () => (
  <li className="breadcrumbs-separator rtl:rotate-180" aria-hidden>
    <span className="icon-[tabler--chevron-right]" />
  </li>
);
