/**
 * Places: every property (home, cabin, storage unit…) with its rooms, closets and
 * shelves as a tree. Add, rename, move (inside another location) and remove empty ones;
 * tap a location to see what's kept there. Property cards follow FlyonUI's card
 * pattern; the add/rename dialogs reuse the "Dashboard Modal 14" form layout.
 */
import { StarterTasksDialog } from "./StarterTasks";
import { BarSearch } from "./Nav";
import type { LocationNode, PlacesTree, PropertyInput } from "@ferret/shared";
import { propertyTypes } from "@ferret/shared/utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { api } from "./lib/api";
import { useCanEdit } from "./lib/auth";
import { PlacePicker } from "./Combobox";
import { countLabel, findLocation, placesKey, usePlaces } from "./lib/places";
import { missingHref, placeHref, propertyHref } from "./lib/route";
import { DialogActions, Modal } from "./Modal";
import { currencySymbol, toCents, centsToInput } from "./lib/money";
import { t, ph, plural, msg } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { MessageDescriptor } from "@lingui/core";

type Property = PlacesTree["properties"][number];

/** What the open dialog is doing. */
type Dialog =
  | { kind: "property"; property?: Property }
  | { kind: "location"; property: Property; parentId?: string; location?: LocationNode }
  | { kind: "starter"; propertyId: string };

export const PROPERTY_TYPES: Record<(typeof propertyTypes)[number], { label: MessageDescriptor; icon: string }> = {
  home: { label: msg`Home`, icon: "icon-[tabler--home]" },
  vacation: { label: msg`Vacation home`, icon: "icon-[tabler--beach]" },
  rental: { label: msg`Rental`, icon: "icon-[tabler--building]" },
  storage: { label: msg`Storage unit`, icon: "icon-[tabler--building-warehouse]" },
  vehicle: { label: msg`Vehicle`, icon: "icon-[tabler--car]" },
  other: { label: msg`Other`, icon: "icon-[tabler--map-pin]" },
};

export function Places({ householdName, householdId }: { householdName: string; householdId: string }) {
  const places = usePlaces(householdId);
  const canEdit = useCanEdit(householdId);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: placesKey(householdId) });
  const removeLocation = useMutation({ mutationFn: api.deleteLocation, onSuccess: refresh });
  const removeProperty = useMutation({ mutationFn: api.deleteProperty, onSuccess: refresh });
  const removeError = removeLocation.error?.message ?? removeProperty.error?.message;

  return (
    <div className="min-h-dvh bg-base-200">
      <nav className="navbar sticky top-0 z-10 border-b border-base-300 bg-base-100/85 backdrop-blur-md px-4">
        <div className="navbar-start items-center gap-2">
          <a href="#/" className="btn btn-text btn-sm btn-square" aria-label={t`Back to your stuff`}>
            <span className="icon-[tabler--arrow-left] size-5" />
          </a>
          <h1 className="text-lg font-semibold"><Trans>Places</Trans></h1>
        </div>
        <BarSearch />
        <div className="navbar-end items-center">
          {canEdit && (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setDialog({ kind: "property" })}>
              <span className="icon-[tabler--plus] size-4" />
              <Trans>Property</Trans>
            </button>
          )}
        </div>
      </nav>

      <main className="mx-auto flex max-w-3xl flex-col gap-4 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        {places.isPending && <span className="loading loading-spinner text-primary mx-auto my-12" />}
        {places.isError && <div className="alert alert-soft alert-error">{places.error.message}</div>}
        {removeError && (
          <div className="alert alert-soft alert-warning flex items-center gap-2" role="alert">
            <span className="icon-[tabler--alert-triangle] size-5 shrink-0" />
            <span className="flex-1">{removeError}</span>
            <button
              type="button"
              className="btn btn-text btn-sm btn-circle"
              aria-label={t`Dismiss`}
              onClick={() => {
                removeLocation.reset();
                removeProperty.reset();
              }}
            >
              <span className="icon-[tabler--x] size-4" />
            </button>
          </div>
        )}

        {places.data && places.data.properties.length === 0 && (
          <div className="card">
            <div className="card-body items-center gap-3 text-center">
              <span className="icon-[tabler--home-plus] text-primary size-10" />
              <h2 className="text-lg font-semibold"><Trans>Where does {householdName} keep things?</Trans></h2>
              <p className="text-base-content/70 max-w-sm text-sm">
                <Trans>Add your home first, then its rooms, closets and shelves — so "where's the drill?" has an answer.</Trans>
              </p>
              {canEdit && (
                <button type="button" className="btn btn-primary" onClick={() => setDialog({ kind: "property" })}>
                  <span className="icon-[tabler--plus] size-5" />
                  <Trans>Add your home</Trans>
                </button>
              )}
            </div>
          </div>
        )}

        {places.data?.properties.map((p) => (
          <section key={p.id} className="card" aria-labelledby={`property-${p.id}`}>
            <div className="card-body gap-3 p-4 sm:p-6">
              <header className="flex items-center gap-3">
                <div className="avatar avatar-placeholder">
                  <div className="size-10 rounded-box bg-primary/10 text-primary">
                    <span className={`${PROPERTY_TYPES[p.type].icon} size-5`} />
                  </div>
                </div>
                <div className="min-w-0 flex-1">
                  <h2 id={`property-${p.id}`} className="truncate font-semibold text-base-content">
                    <a href={propertyHref(p.id)} className="link link-hover tap">
                      {p.name}
                    </a>
                  </h2>
                  <p className="text-base-content/70 text-sm">{t(PROPERTY_TYPES[p.type].label)}</p>
                </div>
                {canEdit && (
                  <RowActions
                    name={p.name}
                    onEdit={() => setDialog({ kind: "property", property: p })}
                    onRemove={() => removeProperty.mutate(p.id)}
                  />
                )}
              </header>

              {p.locations.length > 0 ? (
                <Tree
                  nodes={p.locations}
                  canEdit={canEdit}
                  onAdd={(parentId) => setDialog({ kind: "location", property: p, parentId })}
                  onEdit={(location) => setDialog({ kind: "location", property: p, location })}
                  onRemove={(location) => removeLocation.mutate(location.id)}
                />
              ) : (
                <p className="text-base-content/70 text-sm"><Trans>No rooms yet.</Trans></p>
              )}

              {canEdit && (
                <button
                  type="button"
                  className="btn btn-soft btn-primary btn-sm self-start"
                  onClick={() => setDialog({ kind: "location", property: p })}
                >
                  <span className="icon-[tabler--plus] size-4" />
                  <Trans>Add a room</Trans>
                </button>
              )}
            </div>
          </section>
        ))}

        {places.data && places.data.unplacedItems > 0 && (
          <p className="text-base-content/70 text-center text-sm">
            <a href={missingHref("place")} className="link tap">
              {plural(places.data.unplacedItems, { one: "# item isn't in any place yet", other: "# items aren't in any place yet" })}
            </a>{" "}
            <Trans>— set it from the item's Edit.</Trans>
          </p>
        )}
      </main>

      {dialog?.kind === "property" && (
        <PropertyDialog
          property={dialog.property}
          onClose={() => setDialog(null)}
          onSaved={(created) => {
            void refresh();
            // A new home: offer the common upkeep (gutters, smoke alarms…) to tick.
            if (created && ["home", "vacation", "rental"].includes(created.type)) setDialog({ kind: "starter", propertyId: created.id });
          }}
        />
      )}
      {dialog?.kind === "starter" && <StarterTasksDialog householdId={householdId} propertyId={dialog.propertyId} onClose={() => setDialog(null)} />}
      {dialog?.kind === "location" && (
        <LocationDialog {...dialog} householdId={householdId} onClose={() => setDialog(null)} onSaved={refresh} />
      )}
    </div>
  );
}

/** Nested locations: indented with a guide line, each with its item count and actions. */
function Tree(props: {
  nodes: LocationNode[];
  onAdd: (parentId: string) => void;
  onEdit: (location: LocationNode) => void;
  onRemove: (location: LocationNode) => void;
  canEdit: boolean;
  nested?: boolean;
}) {
  return (
    <ul className={props.nested ? "ms-4 border-s border-base-content/15 ps-2" : ""} role={props.nested ? "group" : "tree"}>
      {props.nodes.map((n) => (
        <li key={n.id} role="treeitem" aria-expanded={n.children.length ? true : undefined}>
          <div className="flex items-center gap-1 rounded-field hover:bg-base-200">
            <a href={placeHref(n.id)} className="flex min-w-0 flex-1 items-center gap-2 px-2 py-2">
              <span className={`${n.children.length ? "icon-[tabler--folder]" : "icon-[tabler--box]"} text-base-content/70 size-5 shrink-0`} />
              <span className="truncate text-base-content">{n.name}</span>
              {n.totalCount > 0 && (
                <span className="badge badge-soft badge-primary badge-sm" title={countLabel(n)}>
                  {n.totalCount === n.itemCount ? n.totalCount : t`${ph({ totalCount: n.totalCount })} (${ph({ itemCount: n.itemCount })} here)`}
                </span>
              )}
            </a>
            {props.canEdit && (
              <>
                <button
                  type="button"
                  className="btn btn-text btn-sm btn-circle"
                  aria-label={t`Add a place inside ${ph({ name: n.name })}`}
                  onClick={() => props.onAdd(n.id)}
                >
                  <span className="icon-[tabler--plus] size-4" />
                </button>
                <RowActions name={n.name} onEdit={() => props.onEdit(n)} onRemove={() => props.onRemove(n)} />
              </>
            )}
          </div>
          {n.children.length > 0 && <Tree {...props} nodes={n.children} nested />}
        </li>
      ))}
    </ul>
  );
}

/** Rename/move and remove, with the remove confirmed inline (like the API key rows). */
function RowActions({ name, onEdit, onRemove }: { name: string; onEdit: () => void; onRemove: () => void }) {
  const [confirming, setConfirming] = useState(false);
  if (confirming) {
    return (
      <span className="flex items-center gap-1">
        <button
          type="button"
          className="btn btn-error btn-xs"
          onClick={() => {
            setConfirming(false);
            onRemove();
          }}
        >
          <Trans>Remove</Trans>
        </button>
        <button type="button" className="btn btn-text btn-xs" onClick={() => setConfirming(false)}>
          <Trans>Keep</Trans>
        </button>
      </span>
    );
  }
  return (
    <>
      <button type="button" className="btn btn-text btn-sm btn-circle" aria-label={t`Rename or move ${name}`} onClick={onEdit}>
        <span className="icon-[tabler--pencil] size-4" />
      </button>
      <button type="button" className="btn btn-text btn-sm btn-circle" aria-label={t`Remove ${name}`} onClick={() => setConfirming(true)}>
        <span className="icon-[tabler--trash] size-4" />
      </button>
    </>
  );
}

function PropertyDialog({ property, onClose, onSaved }: { property?: Property; onClose: () => void; onSaved: (created?: { id: string; type: Property["type"] }) => void }) {
  const d = property?.details;
  const save = useMutation({
    mutationFn: async (input: PropertyInput) => (property ? (await api.updateProperty(property.id, input), null) : { id: (await api.createProperty(input)).id, type: input.type }),
    onSuccess: (created) => {
      onClose();
      onSaved(created ?? undefined);
    },
  });
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const text = (name: string) => String(f.get(name) ?? "").trim() || null;
    const year = Number.parseInt(String(f.get("yearBuilt") || ""), 10);
    save.mutate({
      name: String(f.get("name")).trim(),
      type: String(f.get("type")) as Property["type"],
      street: text("street"),
      city: text("city"),
      region: text("region"),
      postalCode: text("postalCode"),
      country: text("country"),
      yearBuilt: Number.isFinite(year) ? year : null,
      valueCents: toCents(f.get("value")),
      notes: text("notes"),
    });
  }
  const field = (name: keyof NonNullable<typeof d>, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <div>
      <label className="label-text" htmlFor={`property-${name}`}>
        {label}
      </label>
      <input id={`property-${name}`} name={name} className="input" defaultValue={(d?.[name] as string | number | null | undefined) ?? ""} {...props} />
    </div>
  );
  return (
    <Modal id="property-dialog" title={property ? t`Edit ${ph({ name: property.name })}` : t`Add a property`} onClose={onClose}>
      <form className="flex flex-col gap-6" onSubmit={onSubmit}>
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="label-text" htmlFor="property-name">
                <Trans>Name</Trans>
              </label>
              <input id="property-name" name="name" className="input" placeholder={t`e.g. Highland House`} defaultValue={property?.name} maxLength={120} required autoFocus />
            </div>
            <div>
              <label className="label-text" htmlFor="property-type">
                <Trans>Kind</Trans>
              </label>
              <select id="property-type" name="type" className="select" defaultValue={property?.type ?? "home"}>
                {propertyTypes.map((type) => (
                  <option key={type} value={type}>
                    {t(PROPERTY_TYPES[type].label)}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {field("street", t`Street address`, { autoComplete: "street-address", maxLength: 200 })}
          <div className="grid grid-cols-2 gap-4">
            {field("city", t`City`, { autoComplete: "address-level2", maxLength: 120 })}
            {field("region", t`State / region`, { autoComplete: "address-level1", maxLength: 120 })}
            {field("postalCode", t`ZIP / postal code`, { autoComplete: "postal-code", maxLength: 20 })}
            {field("country", t`Country`, { autoComplete: "country-name", maxLength: 80 })}
          </div>
          <div className="grid grid-cols-2 gap-4">
            {field("yearBuilt", t`Year built`, { type: "number", min: 1600, max: 2200, inputMode: "numeric" })}
            <div>
              <label className="label-text" htmlFor="property-value">
                <Trans>Worth</Trans>
              </label>
              <div className="input">
                <span className="my-auto me-1 text-base-content/70">{currencySymbol()}</span>
                <input
                  id="property-value"
                  name="value"
                  className="grow"
                  inputMode="decimal"
                  defaultValue={centsToInput(d?.valueCents, true)}
                  placeholder={t`for insurance`}
                />
              </div>
            </div>
          </div>
          <div>
            <label className="label-text" htmlFor="property-notes">
              <Trans>Notes</Trans>
            </label>
            <textarea id="property-notes" name="notes" className="textarea" rows={2} defaultValue={d?.notes ?? ""} maxLength={5000} placeholder={t`Policy number, gate code, who has keys…`} />
          </div>
        </div>
        <DialogFooter error={save.error?.message} busy={save.isPending} submit={property ? t`Save` : t`Add property`} onCancel={onClose} />
      </form>
    </Modal>
  );
}

function LocationDialog(props: {
  property: Property;
  parentId?: string;
  location?: LocationNode;
  householdId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { property, location, onClose } = props;
  // Moving: anywhere in the same property except inside itself.
  const [parent, setParent] = useState<string | null>(
    (location ? parentOf(property.locations, location.id) : props.parentId) ?? null,
  );
  const save = useMutation({
    mutationFn: (input: { name: string; parentId: string | null }) =>
      location ? api.updateLocation(location.id, input) : api.createLocation({ ...input, propertyId: property.id }),
    onSuccess: () => {
      props.onSaved();
      onClose();
    },
  });
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    save.mutate({ name: String(f.get("name")).trim(), parentId: String(f.get("parentId")) || null });
  }
  const parentName = props.parentId ? findLocation({ properties: [property], unplacedItems: 0, maps: false }, props.parentId)?.node.name : undefined;
  return (
    <Modal id="location-dialog" onClose={onClose}>
      <form className="flex flex-col gap-6" onSubmit={onSubmit}>
        <DialogHeading
          id="location-dialog"
          title={location ? t`Edit ${ph({ name: location.name })}` : parentName ? t`Add a place in ${parentName}` : t`Add a room to ${ph({ name: property.name })}`}
          subtitle={t`Rooms, closets, shelves, boxes — as fine as you like`}
        />
        <div className="space-y-4">
          <div>
            <label className="label-text" htmlFor="location-name">
              <Trans>Name</Trans>
            </label>
            <input
              id="location-name"
              name="name"
              className="input"
              placeholder={parent ? t`e.g. Top shelf` : t`e.g. Garage`}
              defaultValue={location?.name}
              maxLength={120}
              required
              autoFocus
            />
          </div>
          <PlacePicker
            householdId={props.householdId}
            id="location-parent"
            name="parentId"
            label={t`Inside`}
            value={parent}
            onChange={setParent}
            noneLabel={t`${ph({ property: property.name })} (a room)`}
            propertyId={property.id}
            skip={location?.id}
          />
        </div>
        <DialogFooter error={save.error?.message} busy={save.isPending} submit={location ? t`Save` : t`Add`} onCancel={onClose} />
      </form>
    </Modal>
  );
}

function parentOf(nodes: LocationNode[], id: string, parent?: string): string | undefined {
  for (const n of nodes) {
    if (n.id === id) return parent;
    const found = parentOf(n.children, id, n.id);
    if (found) return found;
  }
}

function DialogHeading({ id, title, subtitle }: { id: string; title: string; subtitle: string }) {
  return (
    <div className="space-y-1 text-center">
      <h3 id={`${id}-title`} className="text-2xl font-semibold text-base-content">
        {title}
      </h3>
      <p className="text-base-content/80">{subtitle}</p>
    </div>
  );
}

function DialogFooter({ error, busy, submit, onCancel }: { error?: string; busy: boolean; submit: string; onCancel: () => void }) {
  return (
    <>
      {error && <div className="alert alert-soft alert-error">{error}</div>}
      <DialogActions>
        <button type="button" className="btn btn-secondary btn-soft" onClick={onCancel}>
          <Trans>Cancel</Trans>
        </button>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy && <span className="loading loading-spinner loading-sm" />}
          {submit}
        </button>
      </DialogActions>
    </>
  );
}
