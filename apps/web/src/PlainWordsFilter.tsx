import { locale } from "./i18n";
import { t as translateText } from "./i18n";
/**
 * Everything's "Describe what you're looking for" (AI-2; server: lib/plain-filters.ts): plain words — "tools bought
 * last year over $100", "electronics in the garage without a receipt" — become the list's filters, from the
 * household's own categories, places and tags. They're set in the filter bar (or shown as chips here, for the ones it
 * has no control for), to change or clear; the AI never answers by itself.
 */
import type { ItemOrigin, MissingDetail } from "@ferret/shared";
import { useMutation } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { api } from "./lib/api";
import { useFeatures } from "./lib/features";
import { money } from "./lib/money";
import { MISSING_LABELS } from "./Overview";
import { ORIGIN_FILTER } from "./lib/origin";

/** Filters the bar has no control for. */
export interface ExtraFilters {
  minWorth?: string;
  maxWorth?: string;
  boughtFrom?: string;
  boughtTo?: string;
  /** Words it couldn't turn into a filter: searched for. */
  q?: string;
  missing?: MissingDetail;
  origin?: ItemOrigin;
}

const day = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString(locale(), { year: "numeric", month: "short", day: "numeric" });
const LABEL: Record<keyof ExtraFilters, (v: string) => string> = {
  minWorth: (v) => translateText("Worth over {v0}", { v0: money(Number(v)) }),
  maxWorth: (v) => translateText("Worth under {v0}", { v0: money(Number(v)) }),
  boughtFrom: (v) => translateText("Bought from {v0}", { v0: day(v) }),
  boughtTo: (v) => translateText("Bought until {v0}", { v0: day(v) }),
  q: (v) => translateText("Words: {v0}", { v0: v }),
  missing: (v) => MISSING_LABELS[v as MissingDetail]?.filter ?? v,
  origin: (v) => ORIGIN_FILTER[v as ItemOrigin] ?? v,
};

export function PlainWordsFilter(props: {
  extra: ExtraFilters;
  onExtra: (extra: ExtraFilters) => void;
  /** The filters the bar has controls for. */
  onFilters: (f: { categoryId?: string; locationId?: string; tag?: string; unscanned?: string }) => void;
}) {
  const features = useFeatures();
  const [text, setText] = useState("");
  const ask = useMutation({
    mutationFn: api.filtersFromText,
    onSuccess: ({ filters: f, query }) => {
      props.onFilters({ categoryId: f.categoryId, locationId: f.locationId, tag: f.tag, unscanned: f.unscanned });
      const extra: ExtraFilters = {};
      for (const k of ["minWorth", "maxWorth", "boughtFrom", "boughtTo"] as const) if (f[k]) extra[k] = f[k];
      if (f.missing) extra.missing = f.missing as MissingDetail;
      if (f.origin) extra.origin = f.origin as ItemOrigin;
      if (query) extra.q = query;
      props.onExtra(extra);
    },
  });
  if (!features?.textAi) return null;
  const chips = (Object.entries(props.extra) as [keyof ExtraFilters, string][]).filter(([, v]) => v);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (text.trim().length >= 3) ask.mutate(text.trim());
  };
  return (
    <div className="flex flex-col gap-2">
      <form onSubmit={submit} className="flex gap-2" role="search" aria-label={translateText("Describe what you're looking for")}>
        <label className="input min-w-0 flex-1">
          <span className="icon-[tabler--sparkles] my-auto size-5 shrink-0 text-primary" />
          <input
            className="grow"
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={translateText("Describe it: tools bought last year over $100")}
            maxLength={300}
            aria-label={translateText("Describe what you're looking for")}
          />
        </label>
        <button type="submit" className="btn btn-soft btn-primary" disabled={ask.isPending || text.trim().length < 3}>
          {ask.isPending ? <span className="loading loading-spinner loading-sm" /> : translateText("Filter")}
        </button>
      </form>
      {ask.isError && <div className="alert alert-soft alert-error text-sm">{ask.error.message}</div>}
      {chips.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {chips.map(([k, v]) => (
            <button
              key={k}
              type="button"
              className="tap badge badge-soft badge-primary gap-1"
              onClick={() => props.onExtra(Object.fromEntries(Object.entries(props.extra).filter(([key]) => key !== k)))}
              aria-label={translateText("Remove {v0}", { v0: LABEL[k](v) })}
            >
              {LABEL[k](v)}
              <span className="icon-[tabler--x] size-3.5" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
