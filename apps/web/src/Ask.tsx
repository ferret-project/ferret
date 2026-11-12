/**
 * Ask Ferret: a button that asks, and the answer with its sources — about the whole inventory (the home search), or
 * about one item (its page's search: answered from its own documents and details).
 */
import { useMutation } from "@tanstack/react-query";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { api } from "./lib/api";
import { itemHref } from "./lib/route";

/** For questions: a button that asks Ferret, and the answer with its sources. */
export function AskFerret({ question, itemId }: { question: string; itemId?: string }) {
  const ask = useMutation({ mutationFn: () => (itemId ? api.askItem(itemId, question) : api.ask(question)) });
  if (ask.isIdle) {
    return (
      <button type="button" className="btn btn-soft btn-primary self-start" onClick={() => ask.mutate()}>
        <span className="icon-[tabler--sparkles] size-5" />
        {itemId ? <Trans>Ask about this item</Trans> : <Trans>Ask Ferret</Trans>}
      </button>
    );
  }
  return (
    <section className="card border border-primary/20" aria-live="polite" aria-label={t`Ferret's answer`}>
      <div className="card-body gap-2 p-4">
        <h2 className="text-base-content/70 flex items-center gap-2 text-sm font-medium">
          <span className="icon-[tabler--sparkles] text-primary size-4" />
          <Trans>Ferret</Trans>
        </h2>
        {ask.isPending && (
          <p className="text-base-content/70 flex items-center gap-2">
            <span className="loading loading-dots loading-sm" /> {itemId ? <Trans>Reading its documents…</Trans> : <Trans>Looking through your things…</Trans>}
          </p>
        )}
        {ask.isError && (
          <div className="flex items-center gap-2">
            <p className="text-error flex-1 text-sm">{ask.error.message}</p>
            <button type="button" className="btn btn-text btn-sm" onClick={() => ask.mutate()}>
              <Trans>Try again</Trans>
            </button>
          </div>
        )}
        {ask.data && (
          <>
            <p className={ask.data.found ? "text-base-content" : "text-base-content/70"}>{ask.data.answer}</p>
            {ask.data.citations.length > 0 && (
              <ul className="flex flex-wrap gap-2">
                {ask.data.citations.map((c) => (
                  <li key={`${c.itemId}:${c.attachmentId ?? ""}`}>
                    <a
                      href={c.attachmentId ? api.attachmentUrl(c.attachmentId) : itemHref(c.itemId)}
                      {...(c.attachmentId ? { target: "_blank", rel: "noreferrer" } : {})}
                      className="badge badge-soft badge-primary gap-1"
                    >
                      <span className={`${c.attachmentId ? "icon-[tabler--file-text]" : "icon-[tabler--box]"} size-3.5`} />
                      {c.attachmentId ? c.filename : c.itemName}
                    </a>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-base-content/70 text-xs">
              {itemId ? <Trans>Answered by AI from this item's documents and details — check the sources.</Trans> : <Trans>Answered by AI from your inventory — check the sources.</Trans>}
            </p>
          </>
        )}
      </div>
    </section>
  );
}
