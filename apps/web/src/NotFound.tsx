/**
 * "Not here": a link that goes nowhere, or a thing, place or property that's gone (deleted, or in another household).
 * Says which, and offers the ways on — home, a search, everything, Recently deleted.
 */
import { DELETED_HREF, HOME_HREF, ITEMS_HREF } from "./lib/route";
import { Mascot } from "./Mascot";

const WHAT = {
  page: { title: "There's no page here", body: "The link may be mistyped, or from an older version of Ferret." },
  item: {
    title: "That thing isn't here",
    body: "It may have been deleted — Recently deleted keeps things for 30 days — or it belongs to another household.",
  },
  place: { title: "That place isn't here", body: "It may have been removed, or it belongs to another household." },
  property: { title: "That property isn't here", body: "It may have been removed, or it belongs to another household." },
} as const;

export function NotFound({ what = "page", wrap = true }: { what?: keyof typeof WHAT; wrap?: boolean }) {
  const text = WHAT[what];
  const body = (
    <section className="card mx-auto w-full max-w-lg" aria-labelledby="not-found-title">
      <div className="card-body items-center gap-4 py-10 text-center">
        <Mascot pose="puzzled" className="size-36" />
        <p className="text-sm font-semibold uppercase tracking-wider text-primary">Not found</p>
        <h1 id="not-found-title" className="text-2xl font-semibold text-base-content">
          {text.title}
        </h1>
        <p className="max-w-sm text-base-content/70">{text.body}</p>
        <div className="flex flex-wrap justify-center gap-2">
          <a href={HOME_HREF} className="btn btn-primary">
            <span className="icon-[tabler--home] size-5" />
            Home
          </a>
          {what === "item" ? (
            <a href={DELETED_HREF} className="btn btn-soft btn-primary">
              <span className="icon-[tabler--trash] size-5" />
              Recently deleted
            </a>
          ) : (
            <a href={ITEMS_HREF} className="btn btn-soft btn-primary">
              <span className="icon-[tabler--layout-grid] size-5" />
              Everything
            </a>
          )}
        </div>
        <p className="text-sm text-base-content/70">
          Or search for it: press <kbd className="kbd kbd-sm">/</kbd> on the home screen.
        </p>
      </div>
    </section>
  );
  if (!wrap) return body;
  return (
    <main className="flex min-h-dvh items-center bg-base-200 p-4">
      {body}
    </main>
  );
}
