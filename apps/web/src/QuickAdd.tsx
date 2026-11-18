/**
 * + Add → Type it in: a name and whatever else you know — or, where the server has a text model, **Describe it** in a
 * sentence (typed, or said aloud where it has speech to text): "DeWalt drill, garage top shelf, bought last March for
 * $129". AI reads it into the fields (server: lib/item-from-text.ts) — places, boxes, categories and tags from the
 * household's own — and everything stays editable here; nothing is added until Add.
 */
import type { CustomFieldValues, ItemDraft, ItemInput, ItemTemplate } from "@ferret/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { CustomFieldInputs } from "./Catalog";
import { PlacePicker } from "./Combobox";
import { SpeakButton } from "./SpeakButton";
import { TemplatePicker, useTemplates } from "./Templates";
import { api } from "./lib/api";
import { useFeatures } from "./lib/features";
import type { AddContext } from "./Nav";
import { centsToInput, currencySymbol, money, toCents } from "./lib/money";
import { navigateTo } from "./lib/navigate";
import { itemHref } from "./lib/route";
import { t, ph } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";


/** What the sentence said beyond the form's own fields, shown as chips (✕ leaves one out). */
type Extra = { key: string; label: string; patch: Partial<ItemInput> };

function extrasOf(d: ItemDraft): Extra[] {
  const out: Extra[] = [];
  if (d.model) out.push({ key: "model", label: t`Model ${ph({ model: d.model })}`, patch: { model: d.model } });
  if (d.serialNumber) out.push({ key: "serial", label: t`Serial ${ph({ serial: d.serialNumber })}`, patch: { serialNumber: d.serialNumber } });
  if (d.quantity) out.push({ key: "quantity", label: t`${ph({ count: d.quantity })} of them`, patch: { quantity: d.quantity } });
  if (d.containerItemId) out.push({ key: "box", label: t`In ${ph({ box: d.box ?? "" })}`, patch: { containerItemId: d.containerItemId } });
  if (d.categoryId) out.push({ key: "category", label: d.category ?? t`Category`, patch: { categoryId: d.categoryId } });
  for (const tag of d.tags) out.push({ key: `tag:${tag}`, label: t`Tagged ${ph({ tag })}`, patch: { tags: [tag] } });
  if (d.purchaseDate) {
    const on = new Date(`${d.purchaseDate}T00:00:00`).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
    out.push({ key: "bought", label: t`Bought ${ph({ on })}`, patch: { purchaseDate: d.purchaseDate } });
  }
  if (d.purchasePriceCents != null) out.push({ key: "paid", label: t`Paid ${ph({ amount: money(d.purchasePriceCents, true) })}`, patch: { purchasePriceCents: d.purchasePriceCents } });
  if (d.description) out.push({ key: "note", label: d.description, patch: { description: d.description } });
  return out;
}

export function QuickAdd({ householdId, context, onDone, onBack }: { householdId: string; context: AddContext; onDone: () => void; onBack: () => void }) {
  const qc = useQueryClient();
  const features = useFeatures();
  const [place, setPlace] = useState<string | null>(context.locationId ?? null);
  const templates = useTemplates(householdId);
  const [template, setTemplate] = useState<ItemTemplate | null>(null);
  const [custom, setCustom] = useState<CustomFieldValues>({});
  const [name, setName] = useState("");
  const [brand, setBrand] = useState("");
  const [value, setValue] = useState("");
  const [box, setBox] = useState(false);
  const [words, setWords] = useState("");
  const [extras, setExtras] = useState<Extra[]>([]);
  const [filled, setFilled] = useState(false);

  const read = useMutation({
    mutationFn: (text: string) => api.itemFromText(text),
    onSuccess: (d) => {
      // What it read fills the form; anything typed by hand stays unless the sentence said otherwise.
      if (d.name) setName(d.name);
      if (d.brand) setBrand(d.brand);
      if (d.valueCents != null) setValue(centsToInput(d.valueCents));
      if (d.locationId) setPlace(d.locationId);
      if (d.containerItemId) setPlace(null);
      setBox(d.isContainer);
      setExtras(extrasOf(d));
      setFilled(true);
    },
  });
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
    const extra: Partial<ItemInput> = {};
    const tags = context.tag ? [context.tag] : [];
    for (const x of extras) {
      if (x.patch.tags) tags.push(...x.patch.tags);
      else Object.assign(extra, x.patch);
    }
    create.mutate({
      name: name.trim(),
      brand: brand.trim() || null,
      valueCents: toCents(value),
      isContainer: box,
      // In a box: the box's place is the thing's.
      locationId: extra.containerItemId ? null : place,
      // Left out, a template's category and tags apply (the server fills them in).
      ...(context.categoryId && { categoryId: context.categoryId }),
      ...extra,
      tags: [...new Set(tags)],
      ...(template && { templateId: template.id, customFields: custom }),
      ...(filled && { origin: "words" as const }),
    } as ItemInput);
  }

  const describe = (text: string) => {
    const said = text.trim();
    if (said.length >= 2) read.mutate(said);
  };

  return (
    <form className="flex flex-col gap-4" onSubmit={onSubmit}>
      {features?.textAi && (
        <div className="flex flex-col gap-2 rounded-box bg-base-200 p-3">
          <label className="label-text flex items-center gap-1" htmlFor="quick-words">
            <span className="icon-[tabler--sparkles] size-4 text-primary" />
            <Trans>Describe it, and AI fills in the rest</Trans>
          </label>
          <textarea
            id="quick-words"
            className="textarea"
            rows={2}
            maxLength={500}
            value={words}
            placeholder={t`e.g. DeWalt drill, garage top shelf, bought last March for $129`}
            onChange={(e) => setWords(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                describe(words);
              }
            }}
          />
          <div className="flex flex-wrap items-center justify-end gap-2">
            <SpeakButton
              label={t`Say it`}
              onText={(said) => {
                setWords(said);
                describe(said);
              }}
            />
            <button type="button" className="btn btn-soft btn-primary btn-sm" disabled={read.isPending || words.trim().length < 2} onClick={() => describe(words)}>
              {read.isPending ? <span className="loading loading-spinner loading-xs" /> : <span className="icon-[tabler--wand] size-4" />}
              <Trans>Fill in</Trans>
            </button>
          </div>
          {read.isError && <p className="text-sm text-error">{read.error.message}</p>}
        </div>
      )}
      <div>
        <label className="label-text" htmlFor="quick-name">
          <Trans>What is it?</Trans>
        </label>
        <input
          id="quick-name"
          name="name"
          className="input"
          required
          maxLength={200}
          autoFocus={!features?.textAi}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t`e.g. Cordless drill`}
        />
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
          <input id="quick-brand" name="brand" className="input" maxLength={120} value={brand} onChange={(e) => setBrand(e.target.value)} />
        </div>
        <div>
          <label className="label-text" htmlFor="quick-value">
            <Trans>Worth</Trans>
          </label>
          <div className="input">
            <span className="my-auto me-1 text-base-content/70">{currencySymbol()}</span>
            <input id="quick-value" name="value" className="grow" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} />
          </div>
        </div>
      </div>
      {extras.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="label-text">
            <Trans>Also from what you said</Trans>
          </p>
          <ul className="flex flex-wrap gap-2">
            {extras.map((x) => (
              <li key={x.key} className="badge badge-soft badge-primary h-auto max-w-full gap-1 py-1">
                <span className="truncate">{x.label}</span>
                <button type="button" className="tap" aria-label={t`Leave out: ${ph({ label: x.label })}`} onClick={() => setExtras((all) => all.filter((y) => y.key !== x.key))}>
                  <span className="icon-[tabler--x] size-3.5" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <label className="flex cursor-pointer items-center gap-2">
        <input type="checkbox" name="box" className="checkbox checkbox-primary" checked={box} onChange={(e) => setBox(e.target.checked)} />
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
