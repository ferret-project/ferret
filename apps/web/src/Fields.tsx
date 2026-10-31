/** Extra fields, as categories and item templates define them: the editor, and keys made from their names. */
import type { CategoryField } from "@ferret/shared";
import { categoryFieldTypes } from "@ferret/shared/utils";

const slug = (label: string) =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 40) || "field";

/** Keys from labels, unique within the set; existing keys stay (values are stored by key). Blank ones dropped. */
export function keyedFields(fields: CategoryField[]): CategoryField[] {
  const used = new Set<string>();
  return fields
    .filter((f) => f.label.trim())
    .map((f) => {
      let key = f.key || slug(f.label);
      while (used.has(key)) key = `${key}_2`;
      used.add(key);
      return { ...f, key, options: f.type === "choice" ? (f.options ?? []).filter(Boolean) : undefined };
    });
}

export function FieldsEditor(props: { legend: string; hint: string; fields: CategoryField[]; onChange: (fields: CategoryField[]) => void; max: number }) {
  const { fields, onChange } = props;
  const setField = (i: number, patch: Partial<CategoryField>) => onChange(fields.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  return (
    <fieldset className="space-y-3">
      <legend className="label-text">{props.legend}</legend>
      <p className="text-sm text-base-content/70">{props.hint}</p>
      {fields.map((f, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2">
          <input className="input min-w-32 flex-1" aria-label="Field name" placeholder="Field name" value={f.label} maxLength={60} onChange={(e) => setField(i, { label: e.target.value })} />
          <select className="select w-28" aria-label="Field type" value={f.type} onChange={(e) => setField(i, { type: e.target.value as CategoryField["type"] })}>
            {categoryFieldTypes.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          {f.type === "number" && (
            <input className="input w-20" aria-label="Unit" placeholder="unit" value={f.unit ?? ""} maxLength={12} onChange={(e) => setField(i, { unit: e.target.value || undefined })} />
          )}
          <button type="button" className="btn btn-text btn-sm btn-circle" aria-label={`Remove field ${f.label}`} onClick={() => onChange(fields.filter((_, j) => j !== i))}>
            <span className="icon-[tabler--x] size-4" />
          </button>
          {f.type === "choice" && (
            <input
              className="input w-full"
              aria-label="Choices"
              placeholder="Choices, separated by commas"
              value={(f.options ?? []).join(", ")}
              onChange={(e) => setField(i, { options: e.target.value.split(",").map((o) => o.trimStart()) })}
            />
          )}
        </div>
      ))}
      {fields.length < props.max && (
        <button type="button" className="btn btn-soft btn-primary btn-sm" onClick={() => onChange([...fields, { key: "", label: "", type: "text" }])}>
          <span className="icon-[tabler--plus] size-4" />
          Add a field
        </button>
      )}
    </fieldset>
  );
}
