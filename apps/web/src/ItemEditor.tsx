/**
 * Edit an item: every field, and where it's kept. Layout adapted from FlyonUI Pro
 * "Dashboard Modal 10" (update product): header bar, two-column field grid,
 * description, and Delete on the left of the footer.
 */
import type { CustomFieldValues, ItemListing, ItemPatch } from "@ferret/shared";
import { itemConditions } from "@ferret/shared/utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { api } from "./lib/api";
import { CategoryPicker, CustomFieldInputs, flattenCategories, TagInput, useCategories } from "./Catalog";
import { mergeFields, TemplatePicker, useTemplates } from "./Templates";
import { CollectionFields } from "./Collections";
import { type Choice, ItemPicker, PlacePicker } from "./Combobox";
import { usePlaces } from "./lib/places";
import { DialogActions, Modal } from "./Modal";
import { type LinkDraft, LinksInput, linksToSave } from "./Links";
import { GoneDialog } from "./Gone";
import { navigateTo } from "./lib/navigate";

export function ItemEditor({ item, householdId, onClose }: { item: ItemListing; householdId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const places = usePlaces(householdId);
  const save = useMutation({
    mutationFn: (patch: ItemPatch) => api.updateItem(item.id, patch),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["item", householdId, item.id] }),
        qc.invalidateQueries({ queryKey: ["items", householdId] }),
        qc.invalidateQueries({ queryKey: ["places", householdId] }),
        qc.invalidateQueries({ queryKey: ["categories", householdId] }),
        qc.invalidateQueries({ queryKey: ["tags", householdId] }),
        qc.invalidateQueries({ queryKey: ["overview", householdId] }),
        qc.invalidateQueries({ queryKey: ["attention", householdId] }),
      ]);
      onClose();
    },
  });
  const remove = useMutation({
    mutationFn: () => api.deleteItem(item.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["items", householdId] });
      void qc.invalidateQueries({ queryKey: ["places", householdId] });
      void qc.invalidateQueries({ queryKey: ["trash", householdId] });
      navigateTo("#/");
    },
  });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [going, setGoing] = useState(false);
  const [keptIn, setKeptIn] = useState<string | null>(item.locationId ?? null);
  const [box, setBox] = useState<Choice | null>(item.container ? { id: item.container.id, label: item.container.name } : null);
  const [isBox, setIsBox] = useState(item.isContainer);
  const [categoryId, setCategoryId] = useState<string | null>(item.categoryId ?? null);
  const [tags, setTags] = useState<string[]>(item.tags ?? []);
  const [custom, setCustom] = useState<CustomFieldValues>(item.customFields ?? {});
  const [links, setLinks] = useState<LinkDraft[]>((item.links ?? []).map((l) => ({ url: l.url, label: l.label ?? "" })));
  const [linkError, setLinkError] = useState(false);
  const categories = useCategories(householdId);
  const templates = useTemplates(householdId);
  const [templateId, setTemplateId] = useState<string | null>(item.templateId ?? null);
  const [inCollection, setInCollection] = useState({ collectionId: item.collectionId ?? null, wanted: item.wanted ?? false });
  // The chosen category's extra fields (its parents' included), then the template's.
  const fields = mergeFields(
    flattenCategories(categories.data ?? []).find((c) => c.id === categoryId)?.allFields ?? [],
    templates.data?.find((t) => t.id === templateId),
  );

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const text = (name: string) => String(f.get(name) ?? "").trim() || null;
    const savedLinks = linksToSave(links);
    setLinkError(!savedLinks);
    if (!savedLinks) return;
    save.mutate({
      name: String(f.get("name")).trim(),
      brand: text("brand"),
      model: text("model"),
      serialNumber: text("serialNumber"),
      barcode: text("barcode"),
      quantity: Math.max(0, Number.parseInt(String(f.get("quantity")), 10) || 0),
      condition: (text("condition") as ItemPatch["condition"]) ?? null,
      purchaseDate: text("purchaseDate"),
      purchasePriceCents: toCents(f.get("purchasePrice")),
      valueCents: toCents(f.get("value")),
      // In a box, it's wherever the box is (the server keeps that in step).
      ...(box ? { containerItemId: box.id } : { containerItemId: null, locationId: text("locationId") }),
      isContainer: isBox,
      favorite: f.get("favorite") === "on",
      categoryId,
      templateId,
      ...inCollection,
      tags,
      // Only the current category's and template's fields (a changed one drops the old ones).
      customFields: Object.fromEntries(Object.entries(custom).filter(([k]) => fields.some((field) => field.key === k))),
      heir: text("heir"),
      description: text("description"),
      notes: text("notes"),
      links: savedLinks,
    });
  }

  const busy = save.isPending || remove.isPending;
  return (
    <Modal id="edit-item" title={`Edit ${item.name}`} onClose={onClose}>
      <form className="flex flex-col gap-6" onSubmit={onSubmit}>
        <div className="space-y-4">
          <Field label="Name" name="name" defaultValue={item.name} required autoFocus maxLength={200} />

          <ItemPicker
            householdId={householdId}
            id="item-box"
            name="containerItemId"
            label="In a box"
            value={box}
            onChange={setBox}
            noneLabel="Not in a box"
            boxes
            exclude={[item.id]}
          />
          <div>
            {box ? (
              <p className="text-sm text-base-content/70">It's wherever the box is{item.container?.id === box.id && item.place ? ` (${item.place})` : ""}.</p>
            ) : (
              <PlacePicker
                householdId={householdId}
                id="item-locationId"
                name="locationId"
                label="Kept in"
                value={keptIn}
                onChange={setKeptIn}
                noneLabel="No particular place"
              />
            )}
            {places.data && places.data.properties.every((p) => p.locations.length === 0) && (
              <p className="helper-text">
                No rooms yet — add them under <a className="link link-primary" href="#/places">Places</a>.
              </p>
            )}
          </div>

          <TemplatePicker
            householdId={householdId}
            value={templateId}
            onChange={(t) => {
              setTemplateId(t?.id ?? null);
              // A template's category and tags, where the thing has none yet.
              if (t?.categoryId && !categoryId) setCategoryId(t.categoryId);
              if (t?.tags.length && !tags.length) setTags(t.tags);
            }}
          />
          <CategoryPicker householdId={householdId} value={categoryId} onChange={setCategoryId} />
          <CustomFieldInputs fields={fields} values={custom} onChange={setCustom} />
          <CollectionFields householdId={householdId} {...inCollection} onChange={setInCollection} />
          <TagInput householdId={householdId} value={tags} onChange={setTags} />

          <div className="grid grid-cols-2 gap-4">
            <Field label="Brand" name="brand" defaultValue={item.brand} maxLength={120} />
            <Field label="Model" name="model" defaultValue={item.model} maxLength={120} />
            <Field label="Serial number" name="serialNumber" defaultValue={item.serialNumber} maxLength={120} />
            <Field label="Barcode" name="barcode" defaultValue={item.barcode} maxLength={64} inputMode="numeric" />
          </div>

          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Field label="Bought on" name="purchaseDate" type="date" defaultValue={item.purchaseDate} />
            <Money label="Paid" name="purchasePrice" cents={item.purchasePriceCents} />
            <Money label="Worth now" name="value" cents={item.valueCents} />
            <Field label="Quantity" name="quantity" type="number" min={0} defaultValue={String(item.quantity)} inputMode="numeric" />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label-text" htmlFor="item-condition">
                Condition
              </label>
              <select id="item-condition" name="condition" className="select" defaultValue={item.condition ?? ""}>
                <option value="">Not recorded</option>
                {itemConditions.map((c) => (
                  <option key={c} value={c}>
                    {c[0]!.toUpperCase() + c.slice(1)}
                  </option>
                ))}
              </select>
            </div>
            <Field label="Goes to (heir)" name="heir" defaultValue={item.heir} maxLength={120} placeholder="e.g. Sam" />
          </div>

          <div>
            <label className="label-text" htmlFor="item-description">
              Description
            </label>
            <textarea id="item-description" name="description" className="textarea" rows={2} defaultValue={item.description ?? ""} maxLength={5000} />
          </div>
          <div>
            <label className="label-text" htmlFor="item-notes">
              Notes
            </label>
            <textarea id="item-notes" name="notes" className="textarea" rows={3} defaultValue={item.notes ?? ""} maxLength={10000} />
          </div>
          <div>
            <LinksInput value={links} onChange={setLinks} />
            {linkError && <p className="mt-1 text-sm text-error">Fix or remove the link that isn't a web address.</p>}
          </div>

          <label className="flex min-h-11 items-center gap-3">
            <input type="checkbox" name="favorite" className="switch switch-primary" defaultChecked={item.favorite} />
            <span className="label-text text-base">Favourite</span>
          </label>
          <label className="flex min-h-11 items-start gap-3">
            <input type="checkbox" className="switch switch-primary mt-0.5" checked={isBox} onChange={(e) => setIsBox(e.target.checked)} />
            <span>
              <span className="label-text block text-base">This is a box, bin or case</span>
              <span className="text-sm text-base-content/70">Other things can go in it, and it can have a QR label.</span>
            </span>
          </label>
        </div>

        {(save.isError || remove.isError) && (
          <div className="alert alert-soft alert-error">{save.error?.message ?? remove.error?.message}</div>
        )}

        {/* Removing is kept apart from Save, at the end of the form. */}
        <div className="flex flex-wrap items-center gap-3 border-t border-base-300 pt-4">
          {confirmDelete ? (
            <>
              <span className="text-sm text-base-content/80">Remove it? (Kept 30 days in Recently deleted.)</span>
              <button type="button" className="btn btn-error btn-sm" disabled={busy} onClick={() => remove.mutate()}>
                Remove
              </button>
              <button type="button" className="btn btn-text btn-sm" onClick={() => setConfirmDelete(false)}>
                Keep
              </button>
            </>
          ) : (
            <>
              {!item.disposition && (
                <button type="button" className="btn btn-text" onClick={() => setGoing(true)}>
                  <span className="icon-[tabler--history] size-5" />
                  No longer have it?
                </button>
              )}
              <button type="button" className="btn btn-text btn-error" onClick={() => setConfirmDelete(true)}>
                <span className="icon-[tabler--trash] size-5" />
                Remove item
              </button>
            </>
          )}
        </div>
        {going && <GoneDialog item={item} householdId={householdId} onClose={() => setGoing(false)} onDone={onClose} />}

        <DialogActions>
          <button type="button" className="btn btn-secondary btn-soft" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {save.isPending && <span className="loading loading-spinner loading-sm" />}
            Save
          </button>
        </DialogActions>
      </form>
    </Modal>
  );
}

type InputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, "defaultValue"> & {
  label: string;
  name: string;
  defaultValue?: string | null;
};

function Field({ label, name, defaultValue, ...props }: InputProps) {
  return (
    <div>
      <label className="label-text" htmlFor={`item-${name}`}>
        {label}
      </label>
      <input id={`item-${name}`} name={name} className="input" defaultValue={defaultValue ?? ""} {...props} />
    </div>
  );
}

/** Dollars in the form, cents in the API. */
function Money({ label, name, cents }: { label: string; name: string; cents: number | null | undefined }) {
  return (
    <div>
      <label className="label-text" htmlFor={`item-${name}`}>
        {label}
      </label>
      <div className="input">
        <span className="my-auto me-1 text-base-content/70">$</span>
        <input
          id={`item-${name}`}
          name={name}
          className="grow"
          inputMode="decimal"
          pattern="[0-9]*[.,]?[0-9]{0,2}"
          defaultValue={cents != null ? (cents / 100).toFixed(2) : ""}
        />
      </div>
    </div>
  );
}

function toCents(value: FormDataEntryValue | null) {
  const n = Number.parseFloat(String(value ?? "").replace(",", "."));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}
