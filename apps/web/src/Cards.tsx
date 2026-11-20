/**
 * Trading cards on a thing's page and a collection's: the card's picture and today's price (Use it as its value), and
 * "Update values" for every card in a collection (lib/cards.ts on the server). Shared with Scan cards (CardScan.tsx).
 */
import type { CardInfo, CardPrice, ExchangeRates, Item } from "@ferret/shared";
import { convertCents, formatMoney } from "@ferret/shared/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Modal } from "./Modal";
import { api } from "./lib/api";
import { useRates } from "./lib/foreign-money";
import { currentCurrency, money } from "./lib/money";
import { t, ph, plural } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";

/**
 * A card's price in this finish, in the household's currency: the marketplace that prices in it (TCGplayer for
 * dollars, Cardmarket for euros), else TCGplayer's (then Cardmarket's) converted with the day's rates, keeping the
 * `original`. Null without a price for that finish, or without rates for another currency (as on the server).
 */
export function cardPrice(info: Pick<CardInfo, "prices">, finish: string | null | undefined, rates: ExchangeRates | null, currency = currentCurrency()): CardPrice | null {
  const want = (finish ?? "Normal").toLowerCase();
  const inCurrency = (c: string) => {
    const mine = info.prices.filter((p) => p.currency === c);
    if (!mine.length) return null;
    return mine.find((p) => p.finish.toLowerCase() === want) ?? (finish ? null : (mine.find((p) => p.finish === "Normal") ?? mine[0]!));
  };
  const own = inCurrency(currency);
  if (own) return own;
  for (const from of ["USD", "EUR"]) {
    const p = inCurrency(from);
    const cents = p ? convertCents(p.cents, p.currency, currency, rates) : null;
    if (p && cents != null) return { ...p, currency, cents, original: { cents: p.cents, currency: p.currency } };
  }
  return null;
}

/** "$0.76"; "≈ 3,23 zł ($0.76)" when converted. */
export const priceText = (p: CardPrice) =>
  p.original ? `≈ ${formatMoney(p.cents, p.currency, { exact: true })} (${formatMoney(p.original.cents, p.original.currency, { exact: true })})` : formatMoney(p.cents, p.currency, { exact: true });

/** "151 · 025/165 · Common" */
export const cardLine = (c: CardInfo) => [c.set, c.setTotal ? `${c.number}/${c.setTotal}` : c.number, c.rarity].filter(Boolean).join(" · ");


export function CardPicture({ card, className = "" }: { card: CardInfo | undefined; className?: string }) {
  const [broken, setBroken] = useState(false);
  return card?.image && !broken ? (
    <img src={card.image} alt="" referrerPolicy="no-referrer" loading="lazy" onError={() => setBroken(true)} className={`aspect-[63/88] rounded-[4%] bg-base-200 object-cover ${className}`} />
  ) : (
    <span className={`flex aspect-[63/88] items-center justify-center rounded-[4%] bg-base-200 text-base-content/40 ${className}`}>
      <span className="icon-[tabler--cards] size-6" />
    </span>
  );
}

/** A card thing's page: which card it is, its picture, and today's price — offered as its value. */
export function CardDetails({ item, canEdit, hasPhoto }: { item: Item; canEdit: boolean; hasPhoto: boolean }) {
  const qc = useQueryClient();
  const card = useQuery({ queryKey: ["item-card", item.id, item.card?.id, item.card?.finish], queryFn: () => api.itemCard(item.id), enabled: Boolean(item.card), staleTime: 10 * 60_000 });
  const apply = useMutation({
    mutationFn: (valueCents: number) => api.updateItem(item.id, { valueCents }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["item", item.householdId, item.id] }),
  });
  const picture = useMutation({
    mutationFn: () => api.useCardImage(item.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["item", item.householdId, item.id] });
      void qc.invalidateQueries({ queryKey: ["attachments"] });
    },
  });
  const rates = useRates();
  if (!item.card) return null;
  const info = card.data?.info;
  const price = info ? cardPrice(info, item.card.finish, rates) : null;
  return (
    <section className="card border border-primary/20" aria-labelledby="item-card-title">
      <div className="card-body gap-3 p-4">
        <h2 id="item-card-title" className="flex items-center gap-2 font-semibold text-base-content">
          <span className="icon-[tabler--cards] size-5 text-primary" />
          <Trans>Trading card</Trans>
        </h2>
        {card.isPending && <span className="loading loading-spinner loading-sm text-primary" />}
        {card.isSuccess && !info && <p className="text-sm text-base-content/70"><Trans>The card catalog can't be reached right now.</Trans></p>}
        {info && (
          <div className="flex items-start gap-3">
            <CardPicture card={info} className="w-20 shrink-0" />
            <div className="flex min-w-0 flex-col gap-1">
              <p className="text-sm text-base-content/80">{cardLine(info)}{item.card.finish ? ` · ${item.card.finish}` : ""}</p>
              {price ? (
                <p>
                  <span className="font-medium">{priceText(price)}</span>{" "}
                  <span className="text-sm text-base-content/70">{t`market price today (${ph({ source: price.source })})`}</span>
                </p>
              ) : (
                <p className="text-sm text-base-content/70"><Trans>No price for this finish in your currency (the server admin can switch on exchange rates).</Trans></p>
              )}
              {info.prices.filter((p) => p !== price).length > 0 && (
                <p className="text-xs text-base-content/70">{info.prices.filter((p) => p !== price).map((p) => `${p.finish} ${priceText(p)} (${p.source})`).join(" · ")}</p>
              )}
              <div className="mt-1 flex flex-wrap gap-2">
                {canEdit && price && price.cents !== item.valueCents && (
                  <button type="button" className="btn btn-soft btn-primary btn-sm" disabled={apply.isPending} onClick={() => apply.mutate(price.cents)}>
                    {item.valueCents == null ? t`Use ${ph({ price: priceText(price) })} as its value` : t`Update its value to ${ph({ price: priceText(price) })}`}
                  </button>
                )}
                {canEdit && !hasPhoto && info.imageLarge && (
                  <button type="button" className="btn btn-soft btn-sm" disabled={picture.isPending} onClick={() => picture.mutate()}>
                    <Trans>Add the card's picture</Trans>
                  </button>
                )}
                {info.url && (
                  <a className="btn btn-text btn-sm" href={info.url} target="_blank" rel="noreferrer noopener">
                    <span className="icon-[tabler--external-link] size-4" />
                    {info.game === "magic" ? "Scryfall" : "TCGplayer" /* not translated */}
                  </a>
                )}
              </div>
              {apply.isError && <p className="text-sm text-error">{apply.error.message}</p>}
              {picture.isError && <p className="text-sm text-error">{picture.error.message}</p>}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

/** A collection's "Update values": every card beside today's price; apply the changes in one go. */
export function UpdateCardValues({ collectionId, onClose }: { collectionId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const values = useQuery({
    queryKey: ["card-values", collectionId],
    queryFn: () => api.cardValues(collectionId),
    // Prices older than a day are being fetched: look again until they're in.
    refetchInterval: (q) => ((q.state.data?.checking ?? 0) > 0 ? 3000 : false),
  });
  const changes = (values.data?.data ?? []).filter((v) => v.price && v.price.cents !== v.valueCents);
  const [done, setDone] = useState(0);
  const apply = useMutation({
    mutationFn: async () => {
      for (const v of changes) {
        await api.updateItem(v.itemId, { valueCents: v.price!.cents });
        setDone((n) => n + 1);
      }
    },
    onSettled: () => {
      for (const key of ["items", "collections", "overview", "card-values"]) void qc.invalidateQueries({ queryKey: [key] });
    },
    onSuccess: onClose,
  });
  useEffect(() => setDone(0), [collectionId]);
  const before = changes.reduce((s, v) => s + (v.valueCents ?? 0), 0);
  const after = changes.reduce((s, v) => s + v.price!.cents, 0);
  const checking = values.data?.checking ?? 0;
  return (
    <Modal id="card-values" title={t`Update values`} onClose={onClose}>
      <div className="flex flex-col gap-3">
        {values.isPending && <span className="loading loading-spinner mx-auto text-primary" />}
        {values.isError && <div className="alert alert-soft alert-error">{values.error.message}</div>}
        {checking > 0 && (
          <p className="flex items-center gap-2 text-sm text-base-content/70">
            <span className="loading loading-spinner loading-xs" />
            {plural(checking, { one: "Checking today's price of # card…", other: "Checking today's prices of # cards…" })}
          </p>
        )}
        {values.data && !values.data.data.length && <p className="text-base-content/70"><Trans>No trading cards in this collection yet.</Trans></p>}
        {values.data && values.data.data.length > 0 && !changes.length && !checking && <p className="text-base-content/70"><Trans>Every card's value already matches today's price.</Trans></p>}
        {changes.length > 0 && (
          <>
            <p className="text-sm text-base-content/80">
              {plural(changes.length, { one: "# card's price has changed:", other: "# cards' prices have changed:" })} {money(before)} → {money(after)}
            </p>
            <ul className="max-h-80 divide-y divide-base-content/10 overflow-y-auto">
              {changes.map((v) => (
                <li key={v.itemId} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <span className="min-w-0 truncate">{v.name}</span>
                  <span className="shrink-0 tabular-nums">
                    {v.valueCents == null ? "—" : money(v.valueCents)} → <span className="font-medium">{money(v.price!.cents)}</span>
                  </span>
                </li>
              ))}
            </ul>
            <p className="text-xs text-base-content/70"><Trans>Market prices for ungraded cards (TCGplayer in dollars, Cardmarket in euros).</Trans></p>
          </>
        )}
        {apply.isError && <div className="alert alert-soft alert-error">{apply.error.message}</div>}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className="btn btn-text" onClick={onClose}>
            <Trans>Cancel</Trans>
          </button>
          <button type="button" className="btn btn-primary" disabled={!changes.length || apply.isPending} onClick={() => apply.mutate()}>
            {apply.isPending ? t`Updating ${ph({ done })} of ${ph({ total: changes.length })}…` : plural(changes.length, { one: "Update # value", other: "Update # values" })}
          </button>
        </div>
      </div>
    </Modal>
  );
}
