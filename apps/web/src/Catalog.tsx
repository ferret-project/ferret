/**
 * Categories (what a thing is: Electronics › TV — nested, with extra fields)
 * and tags (free labels; each tag is also a collection with its own page):
 * the pickers the item editor uses, and the "Categories & tags" screen.
 * Built from FlyonUI inputs, badges, cards and the shared Modal/Combobox.
 */
import { BarSearch } from "./Nav";
import type { CategoryField, CategoryNode, CustomFieldValues, TagSummary } from "@ferret/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { type Choice, Combobox } from "./Combobox";
import { api } from "./lib/api";
import { useCanEdit } from "./lib/auth";
import { categoryHref, tagHref } from "./lib/route";
import { DialogActions, Modal } from "./Modal";
import { FieldsEditor, keyedFields } from "./Fields";
import { TemplatesSection } from "./Templates";

/** Category icons, spelled out in full so Tailwind generates them (names from the starter set). */
const ICONS: Record<string, string> = {
  fridge: "icon-[tabler--fridge]",
  "device-tv": "icon-[tabler--device-tv]",
  armchair: "icon-[tabler--armchair]",
  tool: "icon-[tabler--tool]",
  "tools-kitchen-2": "icon-[tabler--tools-kitchen-2]",
  diamond: "icon-[tabler--diamond]",
  palette: "icon-[tabler--palette]",
  shirt: "icon-[tabler--shirt]",
  bike: "icon-[tabler--bike]",
  car: "icon-[tabler--car]",
  "file-certificate": "icon-[tabler--file-certificate]",
  "christmas-tree": "icon-[tabler--christmas-tree]",
  // The starter subcategories'
  microwave: "icon-[tabler--microwave]",
  "wash-machine": "icon-[tabler--wash-machine]",
  "air-conditioning": "icon-[tabler--air-conditioning]",
  "device-laptop": "icon-[tabler--device-laptop]",
  "device-mobile": "icon-[tabler--device-mobile]",
  headphones: "icon-[tabler--headphones]",
  camera: "icon-[tabler--camera]",
  plug: "icon-[tabler--plug]",
  hammer: "icon-[tabler--hammer]",
  "plant-2": "icon-[tabler--plant-2]",
};
export const categoryIcon = (c: { icon: string | null; children?: unknown[] }) =>
  (c.icon && ICONS[c.icon]) || (c.children?.length ? "icon-[tabler--folder]" : "icon-[tabler--tag]");

/** Everything filed under a category, its subcategories included. */
export const itemsUnder = (c: CategoryNode): number => c.itemCount + c.children.reduce((n, k) => n + itemsUnder(k), 0);

/**
 * A category's subcategories as photo tiles (FlyonUI "Product Category"): a photo of something inside (else the
 * category's icon), its name and how many things — each opens its page.
 */
export function CategoryTiles({ nodes, title }: { nodes: CategoryNode[]; title: string }) {
  return (
    <section className="flex flex-col gap-3" aria-label={title}>
      <h2 className="font-semibold text-base-content">{title}</h2>
      <ul className="grid grid-cols-2 gap-3 @container sm:grid-cols-3 lg:grid-cols-4">
        {nodes.map((c) => {
          const n = itemsUnder(c);
          return (
            <li key={c.id}>
              <a href={categoryHref(c.id)} className="card group h-full overflow-hidden focus-visible:outline-2 focus-visible:outline-primary">
                {c.photoId ? (
                  <img src={api.thumbnailUrl(c.photoId)} alt="" loading="lazy" className="aspect-4/3 w-full bg-base-300 object-cover transition-transform duration-300 group-hover:scale-105 motion-reduce:transition-none" />
                ) : (
                  <span className="flex aspect-4/3 w-full items-center justify-center bg-primary/10 text-primary">
                    <span className={`${categoryIcon(c)} size-10`} />
                  </span>
                )}
                <span className="flex flex-col gap-0.5 p-3">
                  <span className="truncate font-medium text-base-content group-hover:text-primary">{c.name}</span>
                  <span className="text-sm text-base-content/70">
                    {n} {n === 1 ? "thing" : "things"}
                    {c.children.length > 0 && ` · ${c.children.length} inside`}
                  </span>
                </span>
              </a>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export const categoriesKey = (householdId: string) => ["categories", householdId];
export const tagsKey = (householdId: string) => ["tags", householdId];

export function useCategories(householdId: string) {
  return useQuery({ queryKey: categoriesKey(householdId), queryFn: async () => (await api.categories()).data });
}
export function useTags(householdId: string) {
  return useQuery({ queryKey: tagsKey(householdId), queryFn: async () => (await api.tags()).data });
}

/** Every category flattened in tree order, with the fields it and its parents define. */
export function flattenCategories(nodes: CategoryNode[], inherited: CategoryField[] = []) {
  const out: (CategoryNode & { allFields: CategoryField[]; depth: number })[] = [];
  const walk = (list: CategoryNode[], fields: CategoryField[], depth: number) =>
    list.forEach((n) => {
      const allFields = [...fields, ...n.fields.filter((f) => !fields.some((p) => p.key === f.key))];
      out.push({ ...n, allFields, depth });
      walk(n.children, allFields, depth + 1);
    });
  walk(nodes, inherited, 0);
  return out;
}

/** Pick a category, filtered by its path as you type. */
export function CategoryPicker(props: { householdId: string; value: string | null; onChange: (id: string | null) => void }) {
  const categories = useCategories(props.householdId);
  const [query, setQuery] = useState("");
  const all: Choice[] = flattenCategories(categories.data ?? []).map((c) => ({ id: c.id, label: c.name, detail: c.path }));
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return (
    <Combobox
      id="item-categoryId"
      name="categoryId"
      label="Category"
      placeholder="What kind of thing is it?"
      noneLabel="No category"
      value={all.find((c) => c.id === props.value) ?? null}
      onChange={(c) => props.onChange(c?.id ?? null)}
      choices={all.filter((c) => words.every((w) => c.detail!.toLowerCase().includes(w)))}
      onQuery={setQuery}
      disabled={!categories.data}
      empty={all.length ? "No category matches that" : "No categories yet — add them under Categories & tags"}
    />
  );
}

/** Tags as removable chips, plus a box that suggests existing tags and makes a new one on Enter. */
export function TagInput(props: { householdId: string; value: string[]; onChange: (tags: string[]) => void }) {
  const tags = useTags(props.householdId);
  const [text, setText] = useState("");
  const has = (name: string) => props.value.some((t) => t.toLowerCase() === name.toLowerCase());
  const add = (name: string) => {
    const clean = name.trim().replace(/\s+/g, " ").slice(0, 40);
    if (clean && !has(clean)) props.onChange([...props.value, clean]);
    setText("");
  };
  const q = text.trim().toLowerCase();
  const suggestions = (tags.data ?? []).filter((t) => !has(t.name) && (!q || t.name.toLowerCase().includes(q))).slice(0, 8);
  return (
    <div>
      <label className="label-text" htmlFor="item-tags">
        Tags
      </label>
      {/* Tapping the box (around the tags) types into it, like a single input. */}
      <div
        className="input flex h-auto min-h-11 flex-wrap items-center gap-1.5 py-1.5"
        onClick={(e) => e.target === e.currentTarget && document.getElementById("item-tags")?.focus()}
      >
        {props.value.map((t) => (
          <span key={t} className="badge badge-soft badge-primary gap-1">
            {t}
            <button type="button" className="tap inline-flex" aria-label={`Remove tag ${t}`} onClick={() => props.onChange(props.value.filter((x) => x !== t))}>
              <span className="icon-[tabler--x] size-3.5" />
            </button>
          </span>
        ))}
        <input
          id="item-tags"
          className="min-w-24 grow"
          placeholder={props.value.length ? "" : "e.g. camping, Christmas"}
          value={text}
          list="item-tag-suggestions"
          autoComplete="off"
          onChange={(e) => (e.target.value.endsWith(",") ? add(e.target.value.slice(0, -1)) : setText(e.target.value))}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault(); // don't submit the form
              add(text);
            } else if (e.key === "Backspace" && !text && props.value.length) {
              props.onChange(props.value.slice(0, -1));
            }
          }}
          onBlur={() => text.trim() && add(text)}
        />
      </div>
      {suggestions.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1.5" aria-label="Existing tags">
          {suggestions.map((t) => (
            <button key={t.id} type="button" className="tap badge badge-outline badge-primary cursor-pointer gap-1" onClick={() => add(t.name)}>
              <span className="icon-[tabler--plus] size-3" />
              {t.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Inputs for a category's extra fields (its own and its parents'). */
export function CustomFieldInputs(props: { fields: CategoryField[]; values: CustomFieldValues; onChange: (values: CustomFieldValues) => void }) {
  if (!props.fields.length) return null;
  const set = (key: string, raw: string, type: CategoryField["type"]) => {
    const next = { ...props.values };
    if (raw === "") delete next[key];
    else next[key] = type === "number" ? Number(raw) : raw;
    props.onChange(next);
  };
  return (
    <div className="grid grid-cols-2 gap-4">
      {props.fields.map((f) => (
        <div key={f.key}>
          <label className="label-text" htmlFor={`field-${f.key}`}>
            {f.label}
          </label>
          {f.type === "choice" ? (
            <select id={`field-${f.key}`} className="select" value={String(props.values[f.key] ?? "")} onChange={(e) => set(f.key, e.target.value, f.type)}>
              <option value="">—</option>
              {(f.options ?? []).map((o) => (
                <option key={o}>{o}</option>
              ))}
            </select>
          ) : (
            <div className="input">
              <input
                id={`field-${f.key}`}
                className="grow"
                type={f.type === "date" ? "date" : f.type === "number" ? "number" : "text"}
                step="any"
                value={String(props.values[f.key] ?? "")}
                onChange={(e) => set(f.key, e.target.value, f.type)}
              />
              {f.unit && <span className="my-auto ms-1 text-base-content/70">{f.unit}</span>}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ── The "Categories & tags" screen ──────────────────────────────────────────
export function Categories({ householdId }: { householdId: string }) {
  const qc = useQueryClient();
  const categories = useCategories(householdId);
  const tags = useTags(householdId);
  const canEdit = useCanEdit(householdId);
  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: categoriesKey(householdId) }),
      qc.invalidateQueries({ queryKey: tagsKey(householdId) }),
      qc.invalidateQueries({ queryKey: ["items", householdId] }),
      qc.invalidateQueries({ queryKey: ["overview", householdId] }),
    ]);
  const starter = useMutation({ mutationFn: api.starterCategories, onSuccess: refresh });
  const removeCategory = useMutation({ mutationFn: api.deleteCategory, onSuccess: refresh });
  const [editing, setEditing] = useState<{ category?: CategoryNode; parentId?: string } | null>(null);
  const [tagEditing, setTagEditing] = useState<TagSummary | null>(null);

  return (
    <div className="min-h-dvh bg-base-200">
      <nav className="navbar sticky top-0 z-10 border-b border-base-300 bg-base-100/85 backdrop-blur-md px-4">
        <div className="navbar-start items-center gap-2">
          <a href="#/" className="btn btn-text btn-sm btn-square" aria-label="Back to your stuff">
            <span className="icon-[tabler--arrow-left] size-5" />
          </a>
          <h1 className="text-lg font-semibold">Categories &amp; tags</h1>
        </div>
        <BarSearch />
        <div className="navbar-end items-center">
          {canEdit && (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setEditing({})}>
              <span className="icon-[tabler--plus] size-4" />
              Category
            </button>
          )}
        </div>
      </nav>

      <main className="mx-auto flex max-w-3xl flex-col gap-4 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <section className="card" aria-labelledby="categories-title">
          <div className="card-body gap-3 p-4 sm:p-6">
            <h2 id="categories-title" className="card-title flex items-center gap-2 text-base">
              <span className="icon-[tabler--category] size-5 text-primary" />
              Categories
            </h2>
            <p className="-mt-1 text-sm text-base-content/70">What each thing is. The insurance report adds value up by the top level.</p>
            {categories.isPending && <span className="loading loading-spinner text-primary" />}
            {categories.data?.length === 0 && (
              <div className="rounded-box border border-dashed border-base-content/20 p-5 text-center">
                <p className="text-sm text-base-content/70">No categories yet. Start with a set made for home insurance, and change it as you like.</p>
                {canEdit && (
                  <button type="button" className="btn btn-primary btn-sm mt-3" disabled={starter.isPending} onClick={() => starter.mutate()}>
                    {starter.isPending && <span className="loading loading-spinner loading-xs" />}
                    Add starter categories
                  </button>
                )}
              </div>
            )}
            {(removeCategory.isError || starter.isError) && (
              <div className="alert alert-soft alert-error">{removeCategory.error?.message ?? starter.error?.message}</div>
            )}
            {categories.data && categories.data.length > 0 && (
              <CategoryTree
                nodes={categories.data}
                canEdit={canEdit}
                onAdd={(parentId) => setEditing({ parentId })}
                onEdit={(category) => setEditing({ category })}
                onRemove={(c) => window.confirm(`Remove ${c.name}? Its items and subcategories move up a level.`) && removeCategory.mutate(c.id)}
              />
            )}
          </div>
        </section>

        <TemplatesSection householdId={householdId} />

        <section className="card" aria-labelledby="tags-title">
          <div className="card-body gap-3 p-4 sm:p-6">
            <h2 id="tags-title" className="card-title flex items-center gap-2 text-base">
              <span className="icon-[tabler--tags] size-5 text-primary" />
              Tags
            </h2>
            <p className="-mt-1 text-sm text-base-content/70">
              Add tags while editing an item. Tap one to see everything with it and what it's worth. (For coins, cards and the
              like, with a want list, start a <a href="#/collections" className="link link-primary tap">collection</a>.)
            </p>
            {tags.data?.length === 0 && <p className="text-sm text-base-content/70">No tags yet.</p>}
            <ul className="flex flex-wrap gap-2">
              {tags.data?.map((t) => (
                <li key={t.id} className="flex items-center">
                  <a href={tagHref(t.name)} className="tap badge badge-soft badge-primary badge-lg gap-1.5">
                    {t.name}
                    <span className="text-xs opacity-70">{t.items}</span>
                  </a>
                  {canEdit && (
                    <button type="button" className="btn btn-text btn-xs btn-circle" aria-label={`Rename or remove ${t.name}`} onClick={() => setTagEditing(t)}>
                      <span className="icon-[tabler--pencil] size-3.5" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </section>
      </main>

      {editing && (
        <CategoryDialog householdId={householdId} {...editing} tree={categories.data ?? []} onClose={() => setEditing(null)} onSaved={refresh} />
      )}
      {tagEditing && <TagDialog tag={tagEditing} onClose={() => setTagEditing(null)} onSaved={refresh} />}
    </div>
  );
}

function CategoryTree(props: {
  nodes: CategoryNode[];
  canEdit: boolean;
  onAdd: (parentId: string) => void;
  onEdit: (c: CategoryNode) => void;
  onRemove: (c: CategoryNode) => void;
  nested?: boolean;
}) {
  return (
    <ul className={props.nested ? "ms-4 border-s border-base-content/15 ps-2" : ""} role={props.nested ? "group" : "tree"}>
      {props.nodes.map((n) => (
        <li key={n.id} role="treeitem" aria-expanded={n.children.length ? true : undefined}>
          <div className="flex items-center gap-1 rounded-field hover:bg-base-200">
            <a href={categoryHref(n.id)} className="flex min-w-0 flex-1 items-center gap-2 px-2 py-2">
              <span className={`${categoryIcon(n)} size-5 shrink-0 text-base-content/70`} />
              <span className="truncate text-base-content">{n.name}</span>
              {n.itemCount > 0 && <span className="badge badge-soft badge-primary badge-sm">{n.itemCount}</span>}
              {n.fields.length > 0 && (
                <span className="text-xs text-base-content/70" title={n.fields.map((f) => f.label).join(", ")}>
                  +{n.fields.length} {n.fields.length === 1 ? "field" : "fields"}
                </span>
              )}
            </a>
            {props.canEdit && (
              <>
                <button type="button" className="btn btn-text btn-sm btn-circle" aria-label={`Add a category inside ${n.name}`} onClick={() => props.onAdd(n.id)}>
                  <span className="icon-[tabler--plus] size-4" />
                </button>
                <button type="button" className="btn btn-text btn-sm btn-circle" aria-label={`Edit ${n.name}`} onClick={() => props.onEdit(n)}>
                  <span className="icon-[tabler--pencil] size-4" />
                </button>
                <button type="button" className="btn btn-text btn-sm btn-circle" aria-label={`Remove ${n.name}`} onClick={() => props.onRemove(n)}>
                  <span className="icon-[tabler--trash] size-4" />
                </button>
              </>
            )}
          </div>
          {n.children.length > 0 && <CategoryTree {...props} nodes={n.children} nested />}
        </li>
      ))}
    </ul>
  );
}

function CategoryDialog(props: {
  householdId: string;
  category?: CategoryNode;
  parentId?: string;
  tree: CategoryNode[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { category, onClose } = props;
  const flat = flattenCategories(props.tree);
  const parentOf = (id: string) => flat.find((c) => c.children.some((ch) => ch.id === id))?.id ?? null;
  const [parent, setParent] = useState<string | null>(category ? parentOf(category.id) : (props.parentId ?? null));
  const [fields, setFields] = useState<CategoryField[]>(category?.fields ?? []);
  const [query, setQuery] = useState("");
  // Not inside itself or anything under it.
  const inside = new Set(category ? flattenCategories([category]).map((c) => c.id) : []);
  const choices = flat.filter((c) => !inside.has(c.id)).map((c) => ({ id: c.id, label: c.name, detail: c.path }));
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const save = useMutation({
    mutationFn: (input: { name: string; parentId: string | null; fields: CategoryField[] }) =>
      category ? api.updateCategory(category.id, input) : api.createCategory(input),
    onSuccess: () => {
      props.onSaved();
      onClose();
    },
  });
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const name = String(new FormData(e.currentTarget).get("name")).trim();
    save.mutate({ name, parentId: parent, fields: keyedFields(fields) });
  }
  return (
    <Modal id="category-dialog" title={category ? `Edit ${category.name}` : "New category"} onClose={onClose}>
      <form className="flex flex-col gap-6" onSubmit={onSubmit}>
        <div className="space-y-4">
          <div>
            <label className="label-text" htmlFor="category-name">
              Name
            </label>
            <input id="category-name" name="name" className="input" defaultValue={category?.name} placeholder="e.g. Power tools" maxLength={80} required autoFocus />
          </div>
          <Combobox
            id="category-parent"
            name="parentId"
            label="Inside"
            placeholder="Top level"
            noneLabel="Top level"
            value={choices.find((c) => c.id === parent) ?? null}
            onChange={(c) => setParent(c?.id ?? null)}
            choices={choices.filter((c) => words.every((w) => c.detail.toLowerCase().includes(w)))}
            onQuery={setQuery}
          />
          <FieldsEditor
            legend="Extra fields for its items"
            hint="e.g. a TV's screen size, a painting's artist. Subcategories get these too."
            fields={fields}
            onChange={setFields}
            max={20}
          />
        </div>
        {save.isError && <div className="alert alert-soft alert-error">{save.error.message}</div>}
        <DialogActions>
          <button type="button" className="btn btn-secondary btn-soft" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={save.isPending}>
            {save.isPending && <span className="loading loading-spinner loading-sm" />}
            {category ? "Save" : "Add category"}
          </button>
        </DialogActions>
      </form>
    </Modal>
  );
}

function TagDialog(props: { tag: TagSummary; onClose: () => void; onSaved: () => void }) {
  const rename = useMutation({
    mutationFn: (name: string) => api.renameTag(props.tag.id, name),
    onSuccess: () => {
      props.onSaved();
      props.onClose();
    },
  });
  const remove = useMutation({
    mutationFn: () => api.deleteTag(props.tag.id),
    onSuccess: () => {
      props.onSaved();
      props.onClose();
    },
  });
  return (
    <Modal id="tag-dialog" onClose={props.onClose}>
      <form
        className="flex flex-col gap-6"
        onSubmit={(e) => {
          e.preventDefault();
          rename.mutate(String(new FormData(e.currentTarget).get("name")).trim());
        }}
      >
        <div className="space-y-1 text-center">
          <h3 id="tag-dialog-title" className="text-2xl font-semibold text-base-content">
            {props.tag.name}
          </h3>
          <p className="text-base-content/80">
            On {props.tag.items} {props.tag.items === 1 ? "item" : "items"}. Renaming it to another tag's name merges the two.
          </p>
        </div>
        <div>
          <label className="label-text" htmlFor="tag-name">
            Name
          </label>
          <input id="tag-name" name="name" className="input" defaultValue={props.tag.name} maxLength={40} required autoFocus />
        </div>
        {(rename.isError || remove.isError) && <div className="alert alert-soft alert-error">{rename.error?.message ?? remove.error?.message}</div>}
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="btn btn-text btn-error"
            disabled={remove.isPending}
            onClick={() => window.confirm(`Remove the tag ${props.tag.name}? The items stay.`) && remove.mutate()}
          >
            <span className="icon-[tabler--trash] size-5" />
            Remove tag
          </button>
          <div className="ms-auto flex gap-3">
            <button type="button" className="btn btn-secondary btn-soft" onClick={props.onClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={rename.isPending}>
              Save
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
