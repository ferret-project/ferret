import type { ItemListing, SearchHit } from "@ferret/shared";
import { api } from "./lib/api";
import { itemHref } from "./lib/route";
import { loanLine } from "./Loans";
import { money } from "./lib/money";
import { t, ph } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";

/**
 * One item in the list: its photo, name, where it's kept, and how it matched a search. With `select` (choosing several,
 * Everything's Select), a tap ticks it instead of opening it.
 */
export function ItemRow(props: { item: ItemListing; hit?: SearchHit; placeFrom?: string; select?: { on: boolean; onToggle: () => void } }) {
  const { item, hit, select } = props;
  const where = item.place && props.placeFrom && item.place.startsWith(props.placeFrom)
    ? item.place.slice(props.placeFrom.length).replace(/^ › /, "")
    : item.place;
  return (
    <li className={`card ${select?.on ? "ring-2 ring-primary" : ""}`}>
      <Wrap item={item} select={select}>
        {select && (
          <input type="checkbox" className="checkbox checkbox-primary shrink-0" checked={select.on} onChange={select.onToggle} aria-label={t`Select ${ph({ name: item.name })}`} />
        )}
        {item.photoId ? (
          <img
            src={api.thumbnailUrl(item.photoId)}
            alt=""
            loading="lazy"
            className="rounded-box bg-base-300 size-14 shrink-0 object-cover"
          />
        ) : (
          <span className="rounded-box bg-base-200 text-base-content/40 flex size-14 shrink-0 items-center justify-center">
            <span className={`${item.isContainer ? "icon-[tabler--package]" : "icon-[tabler--box]"} size-6`} />
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2 font-medium">
            <span className="truncate">{item.name}</span>
            {hit?.via === "meaning" && (
              <span className="badge badge-soft badge-primary badge-sm shrink-0 gap-0.5" title={t`Matched by meaning`}>
                <span className="icon-[tabler--sparkles] size-3.5" />
                <Trans>related</Trans>
              </span>
            )}
          </span>
          {(where || item.container) && (
            <span className="text-primary flex items-center gap-1 text-sm">
              <span className={`${item.container ? "icon-[tabler--package]" : "icon-[tabler--map-pin]"} size-3.5 shrink-0`} />
              <span className="truncate">{[item.container && t`In ${ph({ name: item.container.name })}`, where].filter(Boolean).join(" · ")}</span>
            </span>
          )}
          {item.loan && (
            <span className="flex items-center gap-1 text-sm text-info">
              <span className="icon-[tabler--arrows-exchange] size-3.5 shrink-0" />
              <span className="truncate">{loanLine(item.loan)}</span>
            </span>
          )}
          <span className="text-base-content/70 block truncate text-sm">
            {[
              item.isContainer ? t`Box · ${ph({ contents: item.contents })} inside` : null,
              item.brand,
              item.valueCents != null ? money(item.valueCents, true) : null,
            ]
              .filter(Boolean)
              .join(" · ") || (where ? "" : t`No details yet`)}
          </span>
          <HitSnippet hit={hit} />
        </span>
        {!select && <span className="icon-[tabler--chevron-right] size-5 shrink-0 text-base-content/40" />}
      </Wrap>
    </li>
  );
}

const ROW = "card-body flex-row items-center gap-3 rounded-box p-3 focus-visible:outline-2 focus-visible:outline-primary";

/** The row opens the thing — or, choosing several, the whole row is the tick box's label. */
function Wrap(props: { item: ItemListing; select?: { on: boolean; onToggle: () => void }; children: React.ReactNode }) {
  if (props.select) return <label className={`${ROW} cursor-pointer has-focus-visible:outline-2 has-focus-visible:outline-primary`}>{props.children}</label>;
  return (
    <a href={itemHref(props.item.id)} data-result className={ROW}>
      {props.children}
    </a>
  );
}

/** For matches found inside a document: which one, and the passage that matched. */
export function HitSnippet({ hit }: { hit?: SearchHit }) {
  if (!hit?.snippet) return null;
  return (
    <p className="text-base-content/70 mt-1 line-clamp-2 text-xs">
      <span className="icon-[tabler--file-text] me-1 inline-block size-3.5 align-[-2px]" />
      <span className="font-medium">{hit.filename}:</span> {hit.snippet}
    </p>
  );
}
