/**
 * An item's web links — the maker's product page, the manual online, the
 * support site: shown on the item page (opened in a new tab, nothing sent along)
 * and edited in the item editor. http(s) only; the server checks it too.
 */
import type { ItemLink } from "@ferret/shared";
import { amazonCartUrl, amazonProductOf } from "@ferret/shared/utils";
import { t, ph } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";

/** "dewalt.com" from "https://www.dewalt.com/product/…". */
export const siteOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

/** What someone typed, as a web address: "dewalt.com/dcd771" → "https://dewalt.com/dcd771". Null if it can't be one. */
export function asWebAddress(typed: string): string | null {
  const text = typed.trim();
  if (!text) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
  try {
    const url = new URL(withScheme);
    return (url.protocol === "https:" || url.protocol === "http:") && url.hostname ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * The item's links. An Amazon product page among them also offers to buy it again (one in the cart); without one, a
 * thing that's kept stocked (`search`: amazonSearchUrl) gets "Search Amazon" for its part number instead.
 */
export function ItemLinks({ links, search }: { links: ItemLink[]; search?: string | null }) {
  const product = amazonProductOf(links);
  const cart = product && amazonCartUrl(product.site, [{ asin: product.asin, quantity: 1 }]);
  return (
    <ul className="mt-2 flex flex-wrap gap-2" aria-label={t`Links`}>
      {links.map((l) => (
        <li key={l.url}>
          <a href={l.url} target="_blank" rel="noopener noreferrer" className="btn btn-soft btn-secondary btn-sm max-w-full" title={l.url}>
            <span className="icon-[tabler--external-link] size-4 shrink-0" />
            <span className="truncate">{l.label ?? siteOf(l.url)}</span>
          </a>
        </li>
      ))}
      {cart && (
        <li>
          <a href={cart} target="_blank" rel="noopener noreferrer" className="btn btn-soft btn-secondary btn-sm" title={t`Puts one in your Amazon cart (Amazon asks you to sign in if you aren't)`}>
            <span className="icon-[tabler--shopping-cart-plus] size-4 shrink-0" />
            <Trans>Add to Amazon cart</Trans>
          </a>
        </li>
      )}
      {!product && search && (
        <li>
          <a href={search} target="_blank" rel="noopener noreferrer" className="btn btn-soft btn-secondary btn-sm" title={t`Looks for it on Amazon by its part or model number — add the product's link here for an Add to cart button`}>
            <span className="icon-[tabler--search] size-4 shrink-0" />
            <Trans>Search Amazon</Trans>
          </a>
        </li>
      )}
    </ul>
  );
}

export type LinkDraft = { url: string; label: string };

/** Rows of label + address, with Add and Remove. Blank rows are dropped on save. */
export function LinksInput({ value, onChange }: { value: LinkDraft[]; onChange: (links: LinkDraft[]) => void }) {
  const set = (i: number, change: Partial<LinkDraft>) => onChange(value.map((l, j) => (j === i ? { ...l, ...change } : l)));
  return (
    <fieldset className="space-y-2">
      <legend className="label-text"><Trans>Links</Trans></legend>
      {value.map((l, i) => {
        const bad = l.url.trim() !== "" && !asWebAddress(l.url);
        return (
          <div key={i} className="flex flex-wrap items-start gap-2 sm:flex-nowrap">
            <input
              className="input sm:w-40"
              placeholder={t`Label (optional)`}
              aria-label={t`Link ${ph({ number: i + 1 })} label`}
              maxLength={80}
              value={l.label}
              onChange={(e) => set(i, { label: e.target.value })}
            />
            <div className="min-w-0 flex-1">
              <input
                className={`input ${bad ? "is-invalid" : ""}`}
                placeholder="dewalt.com/support"
                aria-label={t`Link ${ph({ number: i + 1 })} address`}
                inputMode="url"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                maxLength={2000}
                value={l.url}
                onChange={(e) => set(i, { url: e.target.value })}
              />
              {bad && <p className="mt-1 text-xs text-error"><Trans>That doesn't look like a web address.</Trans></p>}
            </div>
            <button
              type="button"
              className="btn btn-text btn-square btn-sm btn-error mt-1"
              aria-label={t`Remove link ${ph({ number: i + 1 })}`}
              onClick={() => onChange(value.filter((_, j) => j !== i))}
            >
              <span className="icon-[tabler--x] size-4" />
            </button>
          </div>
        );
      })}
      {value.length < 10 && (
        <button type="button" className="btn btn-soft btn-secondary btn-sm" onClick={() => onChange([...value, { url: "", label: "" }])}>
          <span className="icon-[tabler--link-plus] size-4" />
          <Trans>Add a link</Trans>
        </button>
      )}
    </fieldset>
  );
}

/** Drafts → what the API takes; null if any filled-in address isn't one. */
export function linksToSave(drafts: LinkDraft[]): ItemLink[] | null {
  const out: ItemLink[] = [];
  for (const d of drafts) {
    if (!d.url.trim()) continue;
    const url = asWebAddress(d.url);
    if (!url) return null;
    out.push({ url, label: d.label.trim() || null });
  }
  return out;
}
