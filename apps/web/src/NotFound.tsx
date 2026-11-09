import { t as translateText } from "./i18n";
import { tr } from "./i18n";
/**
 * "Not here": a link that goes nowhere, or a thing, place or property that's gone (deleted, or in another household).
 * Says which, and offers the ways on — home, a search, everything, Recently deleted.
 */
import { DELETED_HREF, HOME_HREF, ITEMS_HREF } from "./lib/route";
import { Mascot } from "./Mascot";

const WHAT = {
  page: { get title() { return translateText("There's no page here"); }, get body() { return translateText("The link may be mistyped, or from an older version of Ferret."); } },
  item: {
    get title() { return translateText("That thing isn't here"); },
    get body() { return translateText("It may have been deleted — Recently deleted keeps things for 30 days — or it belongs to another household."); },
  },
  place: { get title() { return translateText("That place isn't here"); }, get body() { return translateText("It may have been removed, or it belongs to another household."); } },
  property: { get title() { return translateText("That property isn't here"); }, get body() { return translateText("It may have been removed, or it belongs to another household."); } },
} as const;

export function NotFound({ what = "page", wrap = true }: { what?: keyof typeof WHAT; wrap?: boolean }) {
  const text = WHAT[what];
  const body = (
    <section className="card mx-auto w-full max-w-lg" aria-labelledby="not-found-title">
      <div className="card-body items-center gap-4 py-10 text-center">
        <Mascot pose="puzzled" className="size-36" />
        <p className="text-sm font-semibold uppercase tracking-wider text-primary">{translateText("Not found")}</p>
        <h1 id="not-found-title" className="text-2xl font-semibold text-base-content">
          {text.title}
        </h1>
        <p className="max-w-sm text-base-content/70">{text.body}</p>
        <div className="flex flex-wrap justify-center gap-2">
          <a href={HOME_HREF} className="btn btn-primary">
            <span className="icon-[tabler--home] size-5" />
            {translateText("Home")}</a>
          {what === "item" ? (
            <a href={DELETED_HREF} className="btn btn-soft btn-primary">
              <span className="icon-[tabler--trash] size-5" />
              {translateText("Recently deleted")}</a>
          ) : (
            <a href={ITEMS_HREF} className="btn btn-soft btn-primary">
              <span className="icon-[tabler--layout-grid] size-5" />
              {translateText("Everything")}</a>
          )}
        </div>
        <p className="text-sm text-base-content/70">{tr("Or search for it: press {v0} on the home screen.", { v0: <kbd className="kbd kbd-sm">/</kbd> })}</p>
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
