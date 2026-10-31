/**
 * Item templates (server: lib/templates.ts): kinds of thing a household keeps many of — coins, trading cards, dolls,
 * toys — with their own fields, and the category and tags things made from one start with. Listed and edited on the
 * Categories & tags screen; picked in the item editor (TemplatePicker), where their fields show beside the category's.
 */
import type { CategoryField, ItemTemplate } from "@ferret/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { CategoryPicker, TagInput } from "./Catalog";
import { FieldsEditor, keyedFields } from "./Fields";
import { api } from "./lib/api";
import { useCanEdit } from "./lib/auth";
import { DialogActions, Modal } from "./Modal";

export const templatesKey = (householdId: string) => ["templates", householdId];
export function useTemplates(householdId: string) {
  return useQuery({ queryKey: templatesKey(householdId), queryFn: async () => (await api.templates()).data, staleTime: 60_000 });
}

/** Template icons, spelled out in full so Tailwind generates them (the starter set's, plus a few). */
export const TEMPLATE_ICONS: Record<string, string> = {
  coin: "icon-[tabler--coin]",
  cards: "icon-[tabler--cards]",
  "mood-kid": "icon-[tabler--mood-kid]",
  "horse-toy": "icon-[tabler--horse-toy]",
  book: "icon-[tabler--book]",
  mail: "icon-[tabler--mail]",
  vinyl: "icon-[tabler--vinyl]",
  lego: "icon-[tabler--lego]",
  diamond: "icon-[tabler--diamond]",
  palette: "icon-[tabler--palette]",
  bottle: "icon-[tabler--bottle]",
  camera: "icon-[tabler--camera]",
  "device-gamepad-2": "icon-[tabler--device-gamepad-2]",
  "music": "icon-[tabler--music]",
  star: "icon-[tabler--star]",
};
export const templateIcon = (t: { icon: string | null }) => (t.icon && TEMPLATE_ICONS[t.icon]) || "icon-[tabler--template]";

/** The Categories & tags screen's Templates card. */
export function TemplatesSection({ householdId }: { householdId: string }) {
  const qc = useQueryClient();
  const templates = useTemplates(householdId);
  const canEdit = useCanEdit(householdId);
  const [editing, setEditing] = useState<{ template?: ItemTemplate } | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: templatesKey(householdId) });
  const starter = useMutation({ mutationFn: api.starterTemplates, onSuccess: refresh });
  return (
    <section className="card" aria-labelledby="templates-title">
      <div className="card-body gap-3 p-4 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="templates-title" className="card-title flex items-center gap-2 text-base">
            <span className="icon-[tabler--template] size-5 text-primary" />
            Templates
          </h2>
          {canEdit && (
            <button type="button" className="btn btn-soft btn-primary btn-sm" onClick={() => setEditing({})}>
              <span className="icon-[tabler--plus] size-4" />
              Template
            </button>
          )}
        </div>
        <p className="-mt-1 text-sm text-base-content/70">
          For things you have lots of the same kind of — coins, cards, dolls: the details to fill in for each (year, grade…),
          and the category and tags they start with. Pick one when adding or editing a thing.
        </p>
        {templates.data?.length === 0 && (
          <div className="rounded-box border border-dashed border-base-content/20 p-5 text-center">
            <p className="text-sm text-base-content/70">No templates yet. Start with ones for the usual collections, and change them as you like.</p>
            {canEdit && (
              <button type="button" className="btn btn-primary btn-sm mt-3" disabled={starter.isPending} onClick={() => starter.mutate()}>
                {starter.isPending && <span className="loading loading-spinner loading-xs" />}
                Add starter templates
              </button>
            )}
          </div>
        )}
        {starter.isError && <div className="alert alert-soft alert-error">{starter.error.message}</div>}
        {templates.data && templates.data.length > 0 && (
          <ul className="divide-y divide-base-content/10">
            {templates.data.map((t) => (
              <li key={t.id} className="flex items-center gap-3 py-2">
                <span className={`${templateIcon(t)} size-5 shrink-0 text-primary`} />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{t.name}</p>
                  <p className="truncate text-xs text-base-content/70">
                    {t.fields.map((f) => f.label).join(" · ") || "No fields yet"}
                    {t.itemCount > 0 && ` — ${t.itemCount} ${t.itemCount === 1 ? "thing" : "things"}`}
                  </p>
                </div>
                {canEdit && (
                  <button type="button" className="btn btn-text btn-sm btn-circle" aria-label={`Edit ${t.name}`} onClick={() => setEditing({ template: t })}>
                    <span className="icon-[tabler--pencil] size-4" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      {editing && <TemplateDialog householdId={householdId} template={editing.template} onClose={() => setEditing(null)} onSaved={refresh} />}
    </section>
  );
}

function TemplateDialog(props: { householdId: string; template?: ItemTemplate; onClose: () => void; onSaved: () => void }) {
  const { template, onClose, householdId } = props;
  const [fields, setFields] = useState<CategoryField[]>(template?.fields ?? []);
  const [categoryId, setCategoryId] = useState<string | null>(template?.categoryId ?? null);
  const [tags, setTags] = useState<string[]>(template?.tags ?? []);
  const [icon, setIcon] = useState<string>(template?.icon ?? "");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const save = useMutation({
    mutationFn: (name: string) => {
      const input = { name, icon: icon || null, fields: keyedFields(fields), categoryId, tags };
      return template ? api.updateTemplate(template.id, input) : api.createTemplate(input);
    },
    onSuccess: () => {
      props.onSaved();
      onClose();
    },
  });
  const remove = useMutation({
    mutationFn: () => api.deleteTemplate(template!.id),
    onSuccess: () => {
      props.onSaved();
      onClose();
    },
  });
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    save.mutate(String(new FormData(e.currentTarget).get("name")).trim());
  }
  return (
    <Modal id="template-dialog" title={template ? `Edit ${template.name}` : "New template"} onClose={onClose}>
      <form className="flex flex-col gap-6" onSubmit={onSubmit}>
        <div className="space-y-4">
          <div className="grid grid-cols-[1fr_auto] gap-3">
            <div>
              <label className="label-text" htmlFor="template-name">
                Name
              </label>
              <input id="template-name" name="name" className="input" defaultValue={template?.name} placeholder="e.g. Coin" maxLength={80} required autoFocus />
            </div>
            <div>
              <label className="label-text" htmlFor="template-icon">
                Icon
              </label>
              <div className="flex items-center gap-2">
                <span className={`${templateIcon({ icon })} size-6 text-primary`} aria-hidden />
                <select id="template-icon" className="select w-32" value={icon} onChange={(e) => setIcon(e.target.value)}>
                  <option value="">Plain</option>
                  {Object.keys(TEMPLATE_ICONS).map((k) => (
                    <option key={k} value={k}>
                      {k.replace(/-/g, " ").replace(/ \d+$/, "")}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>
          <FieldsEditor
            legend="Details to fill in"
            hint="e.g. a coin's year, mint mark and grade. They show on each thing made from it, beside its category's."
            fields={fields}
            onChange={setFields}
            max={30}
          />
          <div>
            <p className="label-text">Starts in</p>
            <CategoryPicker householdId={householdId} value={categoryId} onChange={setCategoryId} />
          </div>
          <div>
            <p className="label-text">With tags</p>
            <TagInput householdId={householdId} value={tags} onChange={setTags} />
          </div>
        </div>
        {template && (
          <div className="rounded-box bg-base-200 p-3 text-sm">
            {!confirmRemove ? (
              <button type="button" className="btn btn-text btn-error btn-sm" onClick={() => setConfirmRemove(true)}>
                Remove this template
              </button>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <span>Remove it? {template.itemCount > 0 ? `Its ${template.itemCount} things keep what's filled in.` : ""}</span>
                <button type="button" className="btn btn-error btn-sm" disabled={remove.isPending} onClick={() => remove.mutate()}>
                  Remove
                </button>
                <button type="button" className="btn btn-text btn-sm" onClick={() => setConfirmRemove(false)}>
                  Keep
                </button>
              </div>
            )}
          </div>
        )}
        {(save.isError || remove.isError) && <div className="alert alert-soft alert-error">{(save.error ?? remove.error)!.message}</div>}
        <DialogActions>
          <button type="button" className="btn btn-secondary btn-soft" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={save.isPending}>
            {save.isPending && <span className="loading loading-spinner loading-sm" />}
            {template ? "Save" : "Add template"}
          </button>
        </DialogActions>
      </form>
    </Modal>
  );
}

/** The item editor's "Made from": a template (a short list, so a plain select). */
export function TemplatePicker({ householdId, value, onChange }: { householdId: string; value: string | null; onChange: (t: ItemTemplate | null) => void }) {
  const templates = useTemplates(householdId);
  if (!templates.data?.length) return null;
  return (
    <div>
      <label className="label-text" htmlFor="item-template">
        Template
      </label>
      <select
        id="item-template"
        className="select"
        value={value ?? ""}
        onChange={(e) => onChange(templates.data!.find((t) => t.id === e.target.value) ?? null)}
      >
        <option value="">None</option>
        {templates.data.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
    </div>
  );
}

/** A thing's fields: its category's, then its template's (any key the category has already, once). */
export function mergeFields(categoryFields: CategoryField[], template: ItemTemplate | null | undefined) {
  const keys = new Set(categoryFields.map((f) => f.key));
  return [...categoryFields, ...(template?.fields ?? []).filter((f) => !keys.has(f.key))];
}
