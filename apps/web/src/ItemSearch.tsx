/**
 * Search inside one item, on its page: the top bar's search (and `/`, ⌘K) open it here instead of going home. It finds
 * the passages of the item's documents (by section), its photos' text, warranties and notes that have the words, offers
 * "Ask about this item" (answered from those), and carries the words to a search of everything.
 */
import type { ItemPassage } from "@ferret/shared";
import { useQuery } from "@tanstack/react-query";
import { ph, plural, t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useEffect, useRef, useState } from "react";
import { AskFerret } from "./Ask";
import { api } from "./lib/api";
import { usePlan } from "./PlanUsage";
import { ITEM_SEARCH_EVENT } from "./Search";


const SOURCE_ICON: Record<ItemPassage["source"], string> = {
  document: "icon-[tabler--file-text]",
  photo: "icon-[tabler--photo]",
  warranty: "icon-[tabler--shield-check]",
  item: "icon-[tabler--notes]",
};

function useDebounced<T>(value: T, ms: number) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

/** The snippet with its matched words marked. */
function Marked({ text, marks }: { text: string; marks: [number, number][] }) {
  const parts: React.ReactNode[] = [];
  let at = 0;
  marks.forEach(([start, end], i) => {
    if (start > at) parts.push(text.slice(at, start));
    parts.push(
      <mark key={i} className="rounded-sm bg-warning/30 px-0.5 text-base-content">
        {text.slice(start, end)}
      </mark>,
    );
    at = end;
  });
  parts.push(text.slice(at));
  return <>{parts}</>;
}

function Passage({ passage }: { passage: ItemPassage }) {
  const where = passage.source === "item" ? (passage.label === "Notes" ? t`Notes` : t`Description`) : passage.label;
  return (
    <li>
      <details className="group rounded-box border border-base-content/10 bg-base-100">
        <summary className="flex cursor-pointer list-none gap-3 p-3 [&::-webkit-details-marker]:hidden">
          <span className={`${SOURCE_ICON[passage.source]} text-primary mt-0.5 size-5 shrink-0`} />
          <span className="min-w-0 flex-1">
            <span className="text-base-content/70 block truncate text-xs">
              {where}
              {passage.heading && ` › ${passage.heading}`}
            </span>
            <span className="text-base-content block text-sm break-words group-open:hidden">
              <Marked text={passage.snippet} marks={passage.marks} />
            </span>
          </span>
          <span className="icon-[tabler--chevron-down] text-base-content/40 size-4 shrink-0 transition-transform group-open:rotate-180" />
        </summary>
        <div className="flex flex-col gap-2 px-3 pb-3 ps-11">
          <p className="text-base-content text-sm break-words whitespace-pre-line">{passage.text}</p>
          {passage.attachmentId && passage.source !== "item" && (
            <a href={api.attachmentUrl(passage.attachmentId)} target="_blank" rel="noreferrer" className="tap link link-primary self-start text-sm">
              {passage.source === "photo" ? <Trans>Open the photo</Trans> : <Trans>Open the document</Trans>}
            </a>
          )}
        </div>
      </details>
    </li>
  );
}

export function ItemSearch({ itemId, itemName, householdId, onClose }: { itemId: string; itemName: string; householdId: string; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const q = useDebounced(query.trim(), 250);
  const found = useQuery({ queryKey: ["item-find", householdId, itemId, q], queryFn: () => api.findInItem(itemId, q), enabled: q.length > 0, placeholderData: (previous) => previous });
  const aiAllowed = usePlan(householdId).data?.plan?.limits.ai ?? true;

  useEffect(() => {
    input.current?.focus();
    // Asked again while open (the bar's search, ⌘K): back to the box.
    const again = () => input.current?.focus();
    window.addEventListener(ITEM_SEARCH_EVENT, again);
    return () => window.removeEventListener(ITEM_SEARCH_EVENT, again);
  }, []);

  const result = q ? found.data : undefined;
  return (
    <section className="card border border-primary/20" aria-label={t`Search ${ph({ name: itemName })}`}>
      <div className="card-body gap-3 p-4">
        <div className="flex items-center gap-2">
          <label className="input grow items-center gap-3">
            <span className="icon-[tabler--search] text-base-content/70 size-5 shrink-0" />
            <input
              ref={input}
              type="search"
              className="grow [&::-webkit-search-cancel-button]:hidden"
              enterKeyHint="search"
              autoComplete="off"
              spellCheck={false}
              placeholder={t`Search its documents, warranties and notes…`}
              aria-label={t`Search this item`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Escape") return;
                e.preventDefault();
                if (query) setQuery("");
                else onClose();
              }}
            />
            {q && found.isFetching && <span className="loading loading-spinner loading-sm text-base-content/70 shrink-0" aria-label={t`Searching`} />}
          </label>
          <button type="button" className="btn btn-text btn-circle" aria-label={t`Close search`} onClick={onClose}>
            <span className="icon-[tabler--x] size-5" />
          </button>
        </div>

        {q && found.isError && <p className="text-error text-sm">{found.error.message}</p>}
        {result && (
          <>
            <p className="text-base-content/70 text-sm" aria-live="polite">
              {result.total === 0
                ? t`Nothing in this item's documents, warranties or notes says “${ph({ q })}”.`
                : plural(result.total, { one: "# passage", other: "# passages" })}
            </p>
            {result.passages.length > 0 && (
              <ul className="flex flex-col gap-2">
                {result.passages.map((p, i) => (
                  <Passage key={`${p.attachmentId ?? p.warrantyId ?? p.label}:${i}`} passage={p} />
                ))}
              </ul>
            )}
          </>
        )}

        {q.length >= 3 && aiAllowed && <AskFerret key={q} question={q} itemId={itemId} />}
        {q && (
          <a href={`#/?q=${encodeURIComponent(q)}`} className="tap link link-hover text-primary self-start text-sm">
            <Trans>Search everything for “{q}”</Trans>
          </a>
        )}
      </div>
    </section>
  );
}

