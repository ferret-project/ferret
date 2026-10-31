import type { ItemListing, SearchHit } from "@ferret/shared";
import { api } from "./lib/api";
import { itemHref } from "./lib/route";
import { loanLine } from "./Loans";
import { money } from "./Overview";

/** One item in the list: its photo, name, where it's kept, and how it matched a search. */
export function ItemRow(props: { item: ItemListing; hit?: SearchHit; placeFrom?: string }) {
  const { item, hit } = props;
  const where = item.place && props.placeFrom && item.place.startsWith(props.placeFrom)
    ? item.place.slice(props.placeFrom.length).replace(/^ › /, "")
    : item.place;
  return (
    <li className="card">
      <a href={itemHref(item.id)} data-result className="card-body flex-row items-center gap-3 rounded-box p-3 focus-visible:outline-2 focus-visible:outline-primary">
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
              <span className="badge badge-soft badge-primary badge-sm shrink-0 gap-0.5" title="Matched by meaning">
                <span className="icon-[tabler--sparkles] size-3.5" />
                related
              </span>
            )}
          </span>
          {(where || item.container) && (
            <span className="text-primary flex items-center gap-1 text-sm">
              <span className={`${item.container ? "icon-[tabler--package]" : "icon-[tabler--map-pin]"} size-3.5 shrink-0`} />
              <span className="truncate">{[item.container && `In ${item.container.name}`, where].filter(Boolean).join(" · ")}</span>
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
              item.isContainer ? `Box · ${item.contents} inside` : null,
              item.brand,
              item.valueCents != null ? money(item.valueCents, true) : null,
            ]
              .filter(Boolean)
              .join(" · ") || (where ? "" : "No details yet")}
          </span>
          <HitSnippet hit={hit} />
        </span>
        <span className="icon-[tabler--chevron-right] size-5 shrink-0 text-base-content/40" />
      </a>
    </li>
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
