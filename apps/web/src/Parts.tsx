/**
 * An item's Parts & supplies: the household's things that are parts of it (`partOfItemId` — a dust collector's bags) or
 * that its maintenance uses, with how many are left and where to buy them (its link, Amazon's cart, or a search on
 * Amazon for the part number); the parts its manuals list, to add with a tap; and Add a part. Each part is an item of its
 * own, so its stock, "keep at least" and the shopping list work as for anything else.
 */
import type { ItemListing, ItemPart, SuggestedPart } from "@ferret/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ph, plural, t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useState } from "react";
import { type Choice, ItemPicker } from "./Combobox";
import { HelpLink } from "./HelpLink";
import { asWebAddress, siteOf } from "./Links";
import { api } from "./lib/api";
import { itemHref } from "./lib/route";
import { DialogActions, Modal } from "./Modal";

/** Suggestions shown before "Show more". */
const FIRST_SUGGESTIONS = 4;

type Thing = Pick<ItemListing, "id" | "name" | "brand" | "locationId">;

/** What a part from a manual is called once added: "JET 717531 drum collection bag (5-pack)". */
function partName(thing: Thing, s: Pick<SuggestedPart, "name" | "partNumber" | "packSize">) {
  const what = s.name.charAt(0).toLowerCase() + s.name.slice(1);
  const pack = s.packSize ? ` (${s.packSize}-pack)` : "";
  return [thing.brand, s.partNumber, what].filter(Boolean).join(" ") + pack;
}

export function PartsCard({ item, householdId, canEdit }: { item: Thing; householdId: string; canEdit: boolean }) {
  const qc = useQueryClient();
  const key = ["parts", householdId, item.id];
  const parts = useQuery({ queryKey: key, queryFn: () => api.itemParts(item.id) });
  const [adding, setAdding] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: key });
    for (const k of ["shopping", "items", "attention"]) void qc.invalidateQueries({ queryKey: [k, householdId] });
  };
  const add = useMutation({
    mutationFn: (s: SuggestedPart) =>
      api.createItem({
        name: partName(item, s),
        brand: item.brand ?? undefined,
        model: s.partNumber,
        quantity: 0,
        minQuantity: 0, // "tell me when it's out": on the shopping list until some are bought
        partOfItemId: item.id,
        locationId: item.locationId ?? undefined,
      }),
    onSuccess: refresh,
  });
  const dismiss = useMutation({ mutationFn: (s: SuggestedPart) => api.dismissPart(item.id, s.attachmentId, s.partNumber), onSuccess: refresh });
  const unlink = useMutation({ mutationFn: (p: ItemPart) => api.updateItem(p.id, { partOfItemId: null }), onSuccess: refresh });

  const data = parts.data;
  if (!data) return null;
  const suggested = canEdit ? data.suggested : [];
  if (!data.parts.length && !suggested.length) {
    return canEdit ? (
      <div>
        <button type="button" className="btn btn-soft btn-secondary btn-sm" onClick={() => setAdding(true)}>
          <span className="icon-[tabler--puzzle] size-4" />
          <Trans>Add a part</Trans>
        </button>
        {adding && <AddPartDialog thing={item} householdId={householdId} onClose={() => setAdding(false)} onAdded={refresh} />}
      </div>
    ) : null;
  }
  const shown = showAll ? suggested : suggested.slice(0, FIRST_SUGGESTIONS);
  const error = add.error ?? dismiss.error ?? unlink.error;

  return (
    <section className="card" aria-labelledby="parts-title">
      <div className="card-body gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="parts-title" className="card-title flex items-center gap-2">
            <span className="icon-[tabler--puzzle] size-5 text-primary" />
            <Trans>Parts &amp; supplies</Trans>
            <HelpLink page="guide/stock.html#parts-and-supplies" label={t`Parts & supplies`} />
          </h2>
          {canEdit && (
            <button type="button" className="btn btn-soft btn-primary btn-sm" onClick={() => setAdding(true)}>
              <span className="icon-[tabler--plus] size-4" />
              <Trans>Add a part</Trans>
            </button>
          )}
        </div>
        {error && <div className="alert alert-soft alert-error text-sm">{error.message}</div>}

        {data.parts.length > 0 && (
          <ul className="divide-y divide-base-content/10">
            {data.parts.map((p) => (
              <PartRow key={p.id} part={p} canEdit={canEdit} onUnlink={() => unlink.mutate(p)} busy={unlink.isPending} />
            ))}
          </ul>
        )}

        {suggested.length > 0 && (
          <div className="flex flex-col gap-2">
            <h3 className="flex items-center gap-2 text-sm font-medium text-base-content/70">
              <span className="icon-[tabler--sparkles] size-4" />
              {plural(suggested.length, { one: "# part its manual lists", other: "# parts its manual lists" })}
            </h3>
            <ul className="flex flex-col gap-2">
              {shown.map((s) => (
                <li key={`${s.attachmentId}:${s.partNumber}`} className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-box bg-base-200/60 p-3">
                  <div className="min-w-0 flex-1 basis-48">
                    <p className="font-medium text-base-content">{s.name}</p>
                    <p className="text-sm text-base-content/70">
                      <Trans>Part no. {ph({ partNumber: s.partNumber })}</Trans>
                      {s.packSize ? t` · pack of ${ph({ packSize: s.packSize })}` : ""}
                      {` · ${s.filename}`}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <button type="button" className="btn btn-primary btn-sm" disabled={add.isPending} onClick={() => add.mutate(s)} aria-label={t`Add ${ph({ name: s.name })} as a part`}>
                      <span className="icon-[tabler--plus] size-4" />
                      <Trans>Add</Trans>
                    </button>
                    <button type="button" className="btn btn-text btn-sm" disabled={dismiss.isPending} onClick={() => dismiss.mutate(s)} aria-label={t`${ph({ name: s.name })} isn't needed`}>
                      <Trans>Not needed</Trans>
                    </button>
                  </div>
                </li>
              ))}
            </ul>
            {suggested.length > FIRST_SUGGESTIONS && (
              <button type="button" className="tap link link-hover self-start text-sm text-primary" onClick={() => setShowAll(!showAll)}>
                {showAll ? t`Show fewer` : plural(suggested.length - FIRST_SUGGESTIONS, { one: "Show # more", other: "Show # more" })}
              </button>
            )}
            <p className="text-xs text-base-content/70">
              <Trans>Added parts start at none on hand, on the shopping list until you buy some.</Trans>
            </p>
          </div>
        )}
      </div>
      {adding && <AddPartDialog thing={item} householdId={householdId} onClose={() => setAdding(false)} onAdded={refresh} />}
    </section>
  );
}

function PartRow({ part: p, canEdit, onUnlink, busy }: { part: ItemPart; canEdit: boolean; onUnlink: () => void; busy: boolean }) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3">
      {p.photoId ? (
        <img src={api.thumbnailUrl(p.photoId)} alt="" loading="lazy" className="size-12 shrink-0 rounded-box bg-base-300 object-cover" />
      ) : (
        <span className="flex size-12 shrink-0 items-center justify-center rounded-box bg-base-200 text-base-content/40">
          <span className="icon-[tabler--puzzle] size-5" />
        </span>
      )}
      <div className="min-w-0 flex-1 basis-48">
        <a href={itemHref(p.id)} className="tap block font-medium break-words text-base-content hover:underline">
          {p.name}
        </a>
        <p className="text-sm text-base-content/70">
          {p.model && <Trans>Part no. {ph({ model: p.model })}</Trans>}
          {p.model && " · "}
          {p.low ? (
            <span className={p.quantity === 0 ? "font-medium text-error" : "text-warning"}>
              {p.quantity === 0 ? t`None left — on the shopping list` : t`${ph({ quantity: p.quantity })} left — on the shopping list`}
            </span>
          ) : (
            t`${ph({ quantity: p.quantity })} on hand`
          )}
        </p>
        {p.task && <p className="text-sm text-base-content/70"><Trans>Used by “{ph({ task: p.task })}”</Trans></p>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {p.link && (
          <a href={p.link.url} target="_blank" rel="noopener noreferrer" className="btn btn-soft btn-secondary btn-sm" title={p.link.url}>
            <span className="icon-[tabler--external-link] size-4" />
            {p.link.label || siteOf(p.link.url)}
          </a>
        )}
        {p.amazonCart && (
          <a href={p.amazonCart} target="_blank" rel="noopener noreferrer" className="btn btn-soft btn-secondary btn-sm" title={t`Puts one in your Amazon cart (Amazon asks you to sign in if you aren't)`}>
            <span className="icon-[tabler--shopping-cart-plus] size-4" />
            <Trans>Add to Amazon cart</Trans>
          </a>
        )}
        {p.amazonSearch && (
          <a href={p.amazonSearch} target="_blank" rel="noopener noreferrer" className="btn btn-soft btn-secondary btn-sm" title={t`Looks for it on Amazon by its part number — add the product's link to the part for an Add to cart button`}>
            <span className="icon-[tabler--search] size-4" />
            <Trans>Search Amazon</Trans>
          </a>
        )}
        {canEdit && !p.task && (
          <button type="button" className="btn btn-text btn-sm btn-square" disabled={busy} onClick={onUnlink} aria-label={t`${ph({ name: p.name })} isn't a part of this`} title={t`Not a part of this (the part itself stays)`}>
            <span className="icon-[tabler--unlink] size-4" />
          </button>
        )}
      </div>
    </li>
  );
}

/** Add a part: a new one (name, part number, how many, a link), or something already in Ferret. */
function AddPartDialog({ thing, householdId, onClose, onAdded }: { thing: Thing; householdId: string; onClose: () => void; onAdded: () => void }) {
  const [existing, setExisting] = useState<Choice | null>(null);
  const [name, setName] = useState("");
  const [partNumber, setPartNumber] = useState("");
  const [onHand, setOnHand] = useState("0");
  const [link, setLink] = useState("");
  const [remind, setRemind] = useState(true);
  const url = link.trim() ? asWebAddress(link) : null;
  const save = useMutation({
    mutationFn: async () => {
      if (existing) return api.updateItem(existing.id, { partOfItemId: thing.id });
      return api.createItem({
        name: name.trim(),
        brand: thing.brand ?? undefined,
        model: partNumber.trim() || undefined,
        quantity: Math.max(0, Math.round(Number(onHand) || 0)),
        minQuantity: remind ? 0 : undefined,
        links: url ? [{ url }] : undefined,
        partOfItemId: thing.id,
        locationId: thing.locationId ?? undefined,
      });
    },
    onSuccess: () => {
      onAdded();
      onClose();
    },
  });
  const ready = existing ? true : name.trim().length > 0 && (!link.trim() || url !== null);

  return (
    <Modal id="add-part" title={t`Add a part for ${ph({ name: thing.name })}`} onClose={onClose}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) save.mutate();
        }}
      >
        <ItemPicker
          householdId={householdId}
          id="part-existing"
          name="existing"
          label={t`Something already in Ferret`}
          noneLabel={t`No — a new part`}
          value={existing}
          onChange={setExisting}
          exclude={[thing.id]}
        />
        {!existing && (
          <>
            <div>
              <label className="label-text" htmlFor="part-name"><Trans>Name</Trans></label>
              <input id="part-name" className="input" required maxLength={200} placeholder={t`Drum collection bags (5-pack)`} value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="label-text" htmlFor="part-number"><Trans>Part number</Trans></label>
                <input id="part-number" className="input" maxLength={120} placeholder="717531" value={partNumber} onChange={(e) => setPartNumber(e.target.value)} />
              </div>
              <div>
                <label className="label-text" htmlFor="part-on-hand"><Trans>How many on hand</Trans></label>
                <input id="part-on-hand" className="input" type="number" inputMode="numeric" min={0} value={onHand} onChange={(e) => setOnHand(e.target.value)} />
              </div>
            </div>
            <div>
              <label className="label-text" htmlFor="part-link"><Trans>Where to buy it (optional)</Trans></label>
              <input
                id="part-link"
                className={`input ${link.trim() && !url ? "input-error" : ""}`}
                inputMode="url"
                // not translated
                placeholder="https://…"
                value={link}
                onChange={(e) => setLink(e.target.value)}
              />
              <p className="mt-1 text-xs text-base-content/70">
                <Trans>An Amazon product page gives it an Add to cart button; without one, it can be searched for on Amazon by its part number.</Trans>
              </p>
            </div>
            <label className="flex items-start gap-3">
              <input type="checkbox" className="checkbox checkbox-primary mt-0.5" checked={remind} onChange={(e) => setRemind(e.target.checked)} />
              <span className="text-sm">
                <Trans>Put it on the shopping list when none are left</Trans>
              </span>
            </label>
          </>
        )}
        {save.isError && <div className="alert alert-soft alert-error text-sm">{save.error.message}</div>}
        <DialogActions>
          <button type="button" className="btn btn-text" onClick={onClose}><Trans>Cancel</Trans></button>
          <button type="submit" className="btn btn-primary" disabled={!ready || save.isPending}>
            {save.isPending && <span className="loading loading-spinner loading-sm" />}
            <Trans>Add part</Trans>
          </button>
        </DialogActions>
      </form>
    </Modal>
  );
}

/** On a part's own page: what it's a part of. */
export function PartOfLine({ partOfItemId, householdId }: { partOfItemId: string; householdId: string }) {
  const whole = useQuery({ queryKey: ["item", householdId, partOfItemId], queryFn: () => api.getItem(partOfItemId), retry: false });
  if (!whole.data) return null;
  return (
    <p className="text-sm text-base-content/80">
      <span className="icon-[tabler--puzzle] me-1 size-4 align-[-0.15em] text-primary" />
      <Trans>
        A part for <a href={itemHref(partOfItemId)} className="tap link link-primary">{ph({ name: whole.data.name })}</a>
      </Trans>
    </p>
  );
}
