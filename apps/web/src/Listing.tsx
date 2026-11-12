/**
 * Listing text for selling (server: lib/listing.ts): the AI drafts a title, a description and a suggested asking price
 * from the item's details and photos, for the person to edit and copy into any marketplace. Nothing is saved or posted.
 * Offered on an item's page (writers, when the server has a text model) and from GoneDialog's "Sold it".
 */
import type { ItemListing } from "@ferret/shared";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "./lib/api";
import { useCanEdit } from "./lib/auth";
import { useFeatures } from "./lib/features";
import { money } from "./lib/money";
import { copyText } from "./lib/secure-context";
import { DialogActions, Modal } from "./Modal";
import { t, ph } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";

/** Whether this person, on this server, can have a listing drafted for it. */
export function useCanDraftListing(item: ItemListing, householdId: string) {
  const canEdit = useCanEdit(householdId);
  const features = useFeatures();
  return Boolean(canEdit && features?.textAi && !item.isContainer && !item.wanted);
}

/** "Write a listing to sell it" — a small text button that opens the draft. */
export function ListingButton({ item, householdId, className = "btn btn-text btn-sm" }: { item: ItemListing; householdId: string; className?: string }) {
  const [open, setOpen] = useState(false);
  if (!useCanDraftListing(item, householdId)) return null;
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)}>
        <span className="icon-[tabler--speakerphone] size-4 text-primary" />
        <Trans>Write a listing to sell it</Trans>
      </button>
      {open && <ListingDialog item={item} onClose={() => setOpen(false)} />}
    </>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-text btn-sm"
      disabled={!text}
      onClick={async () => {
        await copyText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
    >
      <span className={`${copied ? "icon-[tabler--copy-check] text-success" : "icon-[tabler--copy]"} size-4`} />
      {copied ? t`Copied` : label}
    </button>
  );
}

export function ListingDialog({ item, onClose }: { item: ItemListing; onClose: () => void }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [price, setPrice] = useState("");
  const draft = useMutation({
    mutationFn: () => api.draftListing(item.id),
    onSuccess: (d) => {
      setTitle(d.title);
      setDescription(d.description);
      setPrice(d.priceCents != null ? money(d.priceCents, true) : "");
    },
  });
  // Ask once on opening; "Try again" asks for another.
  useEffect(() => draft.mutate(), []); // eslint-disable-line react-hooks/exhaustive-deps
  const all = [title, price && t`Price: ${price}`, description].filter(Boolean).join("\n\n");
  return (
    <Modal id="item-listing" title={t`A listing for ${ph({ name: item.name })}`} onClose={onClose}>
      <div className="flex flex-col gap-4">
        {draft.isPending && (
          <p className="flex items-center gap-2 text-sm text-base-content/70">
            <span className="loading loading-spinner loading-sm" /> <Trans>Writing a draft…</Trans>
          </p>
        )}
        {draft.isError && <div className="alert alert-soft alert-error">{draft.error.message}</div>}
        {draft.data && (
          <>
            <div>
              <div className="flex flex-wrap items-end justify-between gap-2">
                <label className="label-text" htmlFor="listing-title">
                  <Trans>Title</Trans>
                </label>
                <CopyButton text={title} label={t`Copy`} />
              </div>
              <input id="listing-title" className="input" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
            </div>
            <div>
              <div className="flex flex-wrap items-end justify-between gap-2">
                <label className="label-text" htmlFor="listing-description">
                  <Trans>Description</Trans>
                </label>
                <CopyButton text={description} label={t`Copy`} />
              </div>
              <textarea id="listing-description" className="textarea min-h-36" value={description} onChange={(e) => setDescription(e.target.value)} />
            </div>
            <div>
              <div className="flex flex-wrap items-end justify-between gap-2">
                <label className="label-text" htmlFor="listing-price">
                  <Trans>Asking price</Trans>
                </label>
                <CopyButton text={price} label={t`Copy`} />
              </div>
              <input id="listing-price" className="input" value={price} onChange={(e) => setPrice(e.target.value)} />
              {draft.data.priceReasoning && <p className="mt-1 text-sm text-base-content/70">{draft.data.priceReasoning}</p>}
            </div>
            <p className="text-sm text-base-content/70">
              <Trans>A draft from the AI — check it against the thing itself and change what's wrong. Nothing is saved or posted; copy it into the marketplace you use.</Trans>
            </p>
          </>
        )}
        <DialogActions>
          <button type="button" className="btn btn-secondary btn-soft" disabled={draft.isPending} onClick={() => draft.mutate()}>
            <Trans>Try again</Trans>
          </button>
          <CopyAll text={all} />
        </DialogActions>
      </div>
    </Modal>
  );
}

function CopyAll({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-primary"
      disabled={!text}
      onClick={async () => {
        await copyText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
    >
      <span className={`${copied ? "icon-[tabler--copy-check]" : "icon-[tabler--copy]"} size-5`} />
      {copied ? t`Copied` : t`Copy it all`}
    </button>
  );
}
