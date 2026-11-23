/**
 * "On eBay now" (server: lib/market.ts): what the same thing is listed for on eBay right now, by its barcode or its
 * brand and model — a handful of listings and the range of asking prices, linking to eBay. On a thing's page only when
 * asked ("Check eBay": nothing goes to eBay until then, unless someone checked within the hour); beside a drafted listing
 * straight away (selling it is why the dialog is open). eBay's terms: its listings stay in a card of their own, not mixed with anything else, and
 * are no more than an hour old here (the time is shown). Nothing from eBay is saved to the thing.
 */
import type { ItemMarketListings, MarketListing, OwnMarketListing } from "@ferret/shared";
import { formatMoney } from "@ferret/shared/utils";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { api } from "./lib/api";
import { t, plural, ph } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";

type Thing = { id: string; name: string; brand?: string | null; model?: string | null; barcode?: string | null; links?: { url: string; selling?: boolean }[] | null };

const price = (cents: number, currency: string) => formatMoney(cents, currency, { exact: true });
const time = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });

/** `ask` false: only an answer from the last hour, else `ready` — eBay isn't asked. */
export function useMarketListings(thing: Thing, ask = true, enabled = true) {
  return useQuery<ItemMarketListings>({
    // Their own listing's link is part of it: adding or changing it asks again.
    queryKey: ["item-ebay", thing.id, thing.barcode ?? null, thing.brand ?? null, thing.model ?? null, (thing.links ?? []).filter((l) => l.selling).map((l) => l.url).join(" "), ask],
    queryFn: () => api.itemEbay(thing.id, ask),
    staleTime: ask ? 30 * 60_000 : 0,
    retry: false,
    enabled,
  });
}

function Row({ l }: { l: MarketListing }) {
  const shipping = l.shippingCents === 0 ? t`free postage` : l.shippingCents != null ? t`+ ${ph({ amount: price(l.shippingCents, l.currency) })} postage` : null;
  const when = l.endsAt ? day(l.endsAt) : null;
  const auction = l.buyingOption !== "auction" ? null : when ? plural(l.bids ?? 0, { one: `# bid, ends ${when}`, other: `# bids, ends ${when}` }) : plural(l.bids ?? 0, { one: "# bid", other: "# bids" });
  return (
    <li>
      <a className="flex items-center gap-3 rounded-box p-1 hover:bg-base-200" href={l.url} target="_blank" rel="noreferrer noopener">
        {l.imageUrl ? (
          <img src={l.imageUrl} alt="" referrerPolicy="no-referrer" loading="lazy" className="size-12 shrink-0 rounded-field bg-base-200 object-contain" />
        ) : (
          <span className="flex size-12 shrink-0 items-center justify-center rounded-field bg-base-200">
            <span className="icon-[tabler--photo-off] size-5 text-base-content/40" />
          </span>
        )}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="line-clamp-2 text-sm">{l.title}</span>
          <span className="text-xs text-base-content/70">{[l.condition, auction, shipping].filter(Boolean).join(" · ")}</span>
        </span>
        <span className="shrink-0 font-semibold tabular-nums">{price(l.priceCents, l.currency)}</span>
      </a>
    </li>
  );
}

/** Their own eBay listing (a link marked as theirs): what eBay shows now, or that it's gone — with "Sold it?" on a thing's page. */
function OwnListing({ own, onSold }: { own: OwnMarketListing; onSold?: () => void }) {
  return (
    <div className="flex flex-col gap-1 rounded-box bg-base-200/60 p-2">
      <p className="flex items-center gap-2 text-sm font-medium">
        <span className="icon-[tabler--tag] size-4 text-primary" />
        <Trans>Your listing</Trans>
      </p>
      {own.status === "listed" && own.listing && (
        <ul>
          <Row l={own.listing} />
        </ul>
      )}
      {own.status === "listed" && !own.listing && (
        <a className="link link-primary tap text-sm" href={own.url} target="_blank" rel="noreferrer noopener">
          <Trans>It's on eBay now — open it there.</Trans>
        </a>
      )}
      {own.status === "gone" && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm">
            <Trans>
              It isn't on eBay any more — it sold or ended (or the link is wrong).{" "}
              <a className="link link-primary tap" href={own.url} target="_blank" rel="noreferrer noopener">
                Open the link
              </a>
            </Trans>
          </p>
          {onSold && (
            <button type="button" className="btn btn-soft btn-primary btn-sm" onClick={onSold}>
              <Trans>Sold it?</Trans>
            </button>
          )}
        </div>
      )}
      {own.status === "unavailable" && <p className="text-sm text-base-content/70"><Trans>eBay didn't answer about your listing just now.</Trans></p>}
    </div>
  );
}

/**
 * The card. `compact` drops its own border and heading size, for inside a dialog. `onRequest`: a "Check eBay" row until
 * the person taps it (a thing's page); otherwise eBay is asked as it opens. Their own listing, when a link is marked as
 * theirs, is shown either way; `onSold` offers "Sold it?" once it's gone.
 */
export function MarketListingsCard({ thing, compact = false, onRequest = false, onSold }: { thing: Thing; compact?: boolean; onRequest?: boolean; onSold?: () => void }) {
  const [asked, setAsked] = useState(!onRequest);
  const peek = useMarketListings(thing, false, !asked);
  const full = useMarketListings(thing, true, asked);
  // Checked within the hour: the answer from memory, shown as it was.
  const s = asked ? full.data : peek.data;
  const shown = (asked && full.isPending ? peek.data : s) ?? null;
  const own = shown?.own ? <OwnListing own={shown.own} onSold={onSold} /> : null;
  const box = (body: ReactNode, title: ReactNode) => (
    <section className={compact ? "flex flex-col gap-2 rounded-box border border-base-content/10 p-3" : "card border border-base-content/10"} aria-labelledby="ebay-title">
      <div className={compact ? "flex flex-col gap-2" : "card-body gap-2 p-4"}>
        <h2 id="ebay-title" className="flex items-center gap-2 font-semibold text-base-content">
          <span className="icon-[tabler--building-store] size-5 text-primary" />
          {title}
        </h2>
        {body}
      </div>
    </section>
  );
  if (asked && full.isPending) {
    const checking = (
      <div className="flex items-center gap-2 text-sm text-base-content/70">
        <span className="loading loading-spinner loading-sm" />
        <Trans>Checking eBay…</Trans>
      </div>
    );
    return own ? box(<>{own}{checking}</>, <Trans>On eBay</Trans>) : <div className="rounded-box border border-base-content/10 px-4 py-3">{checking}</div>;
  }
  if (!s || s.status === "off") return null;
  if (s.status === "none") return own ? box(own, <Trans>On eBay</Trans>) : null;
  if (s.status === "ready") {
    const row = (
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-sm">
          {!own && <span className="icon-[tabler--building-store] size-5 text-primary" />}
          {own ? <Trans>See what others are asking for it on eBay.</Trans> : <Trans>See what it's listed for on eBay right now.</Trans>}
        </span>
        <button type="button" className="btn btn-soft btn-primary btn-sm" onClick={() => setAsked(true)}>
          <Trans>Check eBay</Trans>
        </button>
      </div>
    );
    return own ? box(<>{own}{row}</>, <Trans>On eBay</Trans>) : <div className="rounded-box border border-base-content/10 px-4 py-2">{row}</div>;
  }
  const listings = s.listings ?? [];
  return (
    <section className={compact ? "flex flex-col gap-2 rounded-box border border-base-content/10 p-3" : "card border border-base-content/10"} aria-labelledby="ebay-title">
      <div className={compact ? "flex flex-col gap-2" : "card-body gap-2 p-4"}>
        <h2 id="ebay-title" className="flex items-center gap-2 font-semibold text-base-content">
          <span className="icon-[tabler--building-store] size-5 text-primary" />
          <Trans>On eBay now</Trans>
        </h2>
        {own}
        {s.status === "unavailable" && <p className="text-sm text-base-content/70"><Trans>eBay didn't answer just now — try again in a while.</Trans></p>}
        {s.status === "found" && listings.length === 0 && (
          <p className="text-sm text-base-content/70">
            {s.by === "barcode" ? <Trans>Nothing with this barcode is listed on eBay right now.</Trans> : <Trans>Nothing matching its brand and model is listed on eBay right now.</Trans>}
          </p>
        )}
        {s.status === "found" && listings.length > 0 && (
          <>
            {s.range && (
              <p className="text-sm">
                {s.range.lowCents === s.range.highCents ? (
                  <Trans>Asking {ph({ price: price(s.range.lowCents, s.range.currency) })}.</Trans>
                ) : (
                  <Trans>
                    Asking {ph({ low: price(s.range.lowCents, s.range.currency) })} to {ph({ high: price(s.range.highCents, s.range.currency) })} across the{" "}
                    {ph({ n: s.range.of })} closest listings.
                  </Trans>
                )}
              </p>
            )}
            <ul className="flex flex-col gap-1">
              {listings.map((l) => (
                <Row key={l.url} l={l} />
              ))}
            </ul>
          </>
        )}
        {s.status === "found" && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-base-content/70">
              {s.by === "barcode" ? <Trans>Found by its barcode.</Trans> : <Trans>Found by its brand and model.</Trans>}{" "}
              <Trans>These are asking prices, not what things sold for. Listings from eBay as of {ph({ when: time(s.checkedAt!) })}.</Trans>
            </p>
            {s.searchUrl && (
              <a className="btn btn-text btn-sm" href={s.searchUrl} target="_blank" rel="noreferrer noopener">
                <span className="icon-[tabler--external-link] size-4" />
                {(s.total ?? 0) > listings.length ? plural(s.total ?? 0, { one: "See # on eBay", other: "See all # on eBay" }) : t`Search eBay`}
              </a>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
