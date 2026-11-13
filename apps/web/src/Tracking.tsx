/**
 * Keeping track (server: lib/sightings.ts, lib/room-reviews.ts): when each thing was last seen, "Still here" and
 * "Can't find it" on its page, room reviews (#/review: the places to check; #/review/:locationId: walk one place thing
 * by thing — still here, moved, gone, can't find it) and the things nobody can find (#/misplaced).
 */
import type { ItemListing, ReviewOutcome, RoomReview, RoomToReview } from "@ferret/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { PlacePicker } from "./Combobox";
import { GoneDialog, useRefreshAll } from "./Gone";
import { HelpLink } from "./HelpLink";
import { api } from "./lib/api";
import { useCanEdit } from "./lib/auth";
import { lastSeenText, whenAgo } from "./lib/last-scanned";
import { itemHref, MISPLACED_HREF, REVIEW_HREF, reviewHref } from "./lib/route";
import { DialogActions, Modal } from "./Modal";
import { BarSearch } from "./Nav";
import { t, ph, plural, msg } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { MessageDescriptor } from "@lingui/core";

const OUTCOMES: Record<ReviewOutcome, { label: MessageDescriptor; icon: string; badge: string }> = {
  here: { label: msg`Still here`, icon: "icon-[tabler--check]", badge: "badge-success" },
  moved: { label: msg`Moved`, icon: "icon-[tabler--arrows-move]", badge: "badge-info" },
  gone: { label: msg`Gone`, icon: "icon-[tabler--door-exit]", badge: "badge-neutral" },
  missing: { label: msg`Can't find it`, icon: "icon-[tabler--map-pin-question]", badge: "badge-warning" },
};

const formatDay = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

/** Every query that shows when things were seen or whether they're missing. */
function useRefreshTracking(householdId: string) {
  const qc = useQueryClient();
  const all = useRefreshAll(householdId);
  return () => Promise.all([all(), ...["room-review", "room-reviews", "misplaced"].map((k) => qc.invalidateQueries({ queryKey: [k, householdId] }))]);
}

/** A screen's frame: the top bar with Back, a title and its help, then the content. */
function Page({ title, back, help, children }: { title: string; back: string; help: string; children: React.ReactNode }) {
  return (
    <div className="min-h-dvh bg-base-200">
      <nav className="navbar sticky top-0 z-10 border-b border-base-300 bg-base-100/85 px-4 backdrop-blur-md">
        <div className="navbar-start w-full min-w-0 items-center gap-2">
          <a href={back} className="btn btn-text btn-sm btn-square" aria-label={t`Back`}>
            <span className="icon-[tabler--arrow-left] size-5" />
          </a>
          <h1 className="truncate text-lg font-semibold">{title}</h1>
          <HelpLink page={help} label={title} />
        </div>
        <BarSearch />
      </nav>
      <main className="mx-auto flex max-w-3xl flex-col gap-4 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">{children}</main>
    </div>
  );
}

function Thumb({ item }: { item: ItemListing }) {
  return item.photoId ? (
    <img src={api.thumbnailUrl(item.photoId)} alt="" loading="lazy" className="size-12 shrink-0 rounded-field object-cover" />
  ) : (
    <span className="flex size-12 shrink-0 items-center justify-center rounded-field bg-base-200 text-base-content/40">
      <span className={`${item.isContainer ? "icon-[tabler--package]" : "icon-[tabler--box]"} size-6`} />
    </span>
  );
}

// ── On an item's page ───────────────────────────────────────────────────────

/** "Seen 3 days ago by Sam" with "Still here" and "Can't find it" beside it (writers, while it's still here). */
export function SeenLine({ item, householdId }: { item: ItemListing; householdId: string }) {
  const canEdit = useCanEdit(householdId) && !item.disposition;
  const refresh = useRefreshTracking(householdId);
  const seen = useMutation({ mutationFn: () => api.markSeen(item.id), onSuccess: refresh });
  const missing = useMutation({ mutationFn: () => api.markMissing(item.id), onSuccess: refresh });
  const text = lastSeenText(item.lastSeen);
  // Seen just now: say so rather than offering it again.
  const justNow = item.lastSeen && Date.now() - new Date(item.lastSeen.at).getTime() < 60_000;
  if (!text && !canEdit) return null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-base-content/70">
      {text && (
        <span title={new Date(item.lastSeen!.at).toLocaleString()} className="flex items-center gap-1">
          <span className="icon-[tabler--eye] size-4 shrink-0" />
          {text}
        </span>
      )}
      {canEdit && !item.missingSince && (
        <>
          <button type="button" className="tap link link-primary link-hover" disabled={seen.isPending || Boolean(justNow)} onClick={() => seen.mutate()}>
            {justNow ? t`Marked as still here` : item.isContainer && item.contents ? t`Still here, with what's inside` : t`Still here`}
          </button>
          <button type="button" className="tap link link-hover" disabled={missing.isPending} onClick={() => missing.mutate()}>
            <Trans>Can't find it</Trans>
          </button>
        </>
      )}
      {(seen.isError || missing.isError) && <span className="w-full text-error">{(seen.error ?? missing.error)!.message}</span>}
    </div>
  );
}

/** Nobody can find it: since when, and Found it / It's lost. */
export function MissingBanner({ item, householdId }: { item: ItemListing; householdId: string }) {
  const canEdit = useCanEdit(householdId);
  const refresh = useRefreshTracking(householdId);
  const found = useMutation({ mutationFn: () => api.markSeen(item.id), onSuccess: refresh });
  const [lost, setLost] = useState(false);
  if (!item.missingSince || item.disposition) return null;
  const since = formatDay(item.missingSince);
  return (
    <div className="alert alert-soft alert-warning flex flex-wrap items-center gap-3" role="status">
      <span className="icon-[tabler--map-pin-question] size-6 shrink-0" />
      <div className="min-w-0 flex-1 basis-48">
        <p className="font-medium"><Trans>Nobody can find it (since {since})</Trans></p>
        <p className="text-sm"><Trans>It still counts as yours until it turns up or you say it's lost.</Trans></p>
      </div>
      {canEdit && (
        <div className="flex basis-full flex-wrap justify-end gap-2 sm:basis-auto">
          <button type="button" className="btn btn-primary btn-sm" disabled={found.isPending} onClick={() => found.mutate()}>
            <span className="icon-[tabler--check] size-4" />
            <Trans>Found it</Trans>
          </button>
          <button type="button" className="btn btn-soft btn-sm" onClick={() => setLost(true)}>
            <Trans>It's lost</Trans>
          </button>
        </div>
      )}
      {found.isError && <p className="w-full text-sm text-error">{found.error.message}</p>}
      {lost && <GoneDialog item={item} householdId={householdId} initial="lost" onClose={() => setLost(false)} onDone={() => void refresh()} />}
    </div>
  );
}

// ── #/misplaced ─────────────────────────────────────────────────────────────

export function Misplaced({ householdId }: { householdId: string }) {
  const list = useQuery({ queryKey: ["misplaced", householdId], queryFn: () => api.listItems(undefined, { misplaced: true, limit: 200 }) });
  const items = list.data?.data ?? [];
  return (
    <Page title={t`Can't find`} back="#/" help="guide/room-review.html#can-t-find-it">
      {list.isPending && <span className="loading loading-spinner mx-auto my-12 text-primary" />}
      {list.isError && <div className="alert alert-soft alert-error">{list.error.message}</div>}
      {list.data && items.length === 0 && (
        <div className="card">
          <div className="card-body items-center gap-3 text-center">
            <span className="icon-[tabler--map-pin-check] size-10 text-primary" />
            <h2 className="text-lg font-semibold"><Trans>Nothing missing</Trans></h2>
            <p className="max-w-sm text-sm text-base-content/70">
              <Trans>Things marked "Can't find it" — on their page or in a room review — wait here until they turn up or you say they're lost.</Trans>
            </p>
          </div>
        </div>
      )}
      {items.length > 0 && (
        <ul className="flex flex-col gap-3">
          {items.map((it) => (
            <li key={it.id} className="card">
              <div className="card-body gap-3 p-4">
                <a href={itemHref(it.id)} className="flex min-w-0 items-center gap-3">
                  <Thumb item={it} />
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-base-content">{it.name}</span>
                    <span className="block truncate text-sm text-base-content/70">
                      {[it.place, it.missingSince ? t`missing since ${ph({ day: formatDay(it.missingSince) })}` : null].filter(Boolean).join(" · ")}
                    </span>
                  </span>
                </a>
                <MissingActions item={it} householdId={householdId} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
}

function MissingActions({ item, householdId }: { item: ItemListing; householdId: string }) {
  const canEdit = useCanEdit(householdId);
  const refresh = useRefreshTracking(householdId);
  const found = useMutation({ mutationFn: () => api.markSeen(item.id), onSuccess: refresh });
  const [lost, setLost] = useState(false);
  if (!canEdit) return null;
  return (
    <div className="flex flex-wrap justify-end gap-2">
      <button type="button" className="btn btn-soft btn-sm" onClick={() => setLost(true)}>
        <Trans>It's lost</Trans>
      </button>
      <button type="button" className="btn btn-primary btn-sm" disabled={found.isPending} onClick={() => found.mutate()}>
        <span className="icon-[tabler--check] size-4" />
        <Trans>Found it</Trans>
      </button>
      {found.isError && <p className="w-full text-sm text-error">{found.error.message}</p>}
      {lost && <GoneDialog item={item} householdId={householdId} initial="lost" onClose={() => setLost(false)} onDone={() => void refresh()} />}
    </div>
  );
}

// ── #/review ────────────────────────────────────────────────────────────────

/** "Never reviewed", "Reviewed 14 months ago", "12 checked so far". */
export function reviewedText(r: Pick<RoomToReview, "reviewedAt" | "open">) {
  if (r.open) return plural(r.open.done, { one: "Under way: # checked", other: "Under way: # checked" });
  return r.reviewedAt ? t`Reviewed ${ph({ when: whenAgo(r.reviewedAt) })}` : t`Never reviewed`;
}

export function RoomsToReview({ householdId }: { householdId: string }) {
  const rooms = useQuery({ queryKey: ["room-reviews", householdId], queryFn: api.roomsToReview });
  const list = rooms.data?.data ?? [];
  return (
    <Page title={t`Room review`} back="#/" help="guide/room-review.html">
      <p className="text-sm text-base-content/70">
        <Trans>Walk a room and check each thing: still here, moved, gone, or can't find it. Your inventory stays something you can trust — and an insurer's questions are easy to answer.</Trans>
      </p>
      {rooms.isPending && <span className="loading loading-spinner mx-auto my-12 text-primary" />}
      {rooms.isError && <div className="alert alert-soft alert-error">{rooms.error.message}</div>}
      {rooms.data && list.length === 0 && (
        <div className="alert alert-soft alert-info"><Trans>Put things in places first — then each place can be reviewed.</Trans></div>
      )}
      {list.length > 0 && (
        <ul className="card divide-y divide-base-300">
          {list.map((r) => (
            <li key={r.locationId}>
              <a href={reviewHref(r.locationId)} className="flex min-h-14 items-center gap-3 px-4 py-2 hover:bg-base-200">
                <span className={`${r.open ? "icon-[tabler--progress-check] text-primary" : r.reviewedAt ? "icon-[tabler--circle-check] text-success" : "icon-[tabler--circle-dashed] text-base-content/40"} size-6 shrink-0`} aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-base-content">{r.path}</span>
                  <span className="block truncate text-sm text-base-content/70">
                    {reviewedText(r)} · {plural(r.items, { one: "# thing", other: "# things" })}
                  </span>
                </span>
                <span className="icon-[tabler--chevron-right] size-5 shrink-0 text-base-content/40" aria-hidden />
              </a>
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
}

// ── #/review/:locationId ────────────────────────────────────────────────────

export function RoomReviewScreen({ householdId, locationId }: { householdId: string; locationId: string }) {
  const canEdit = useCanEdit(householdId);
  const qc = useQueryClient();
  const refresh = useRefreshTracking(householdId);
  const key = ["room-review", householdId, locationId];
  const review = useQuery({ queryKey: key, queryFn: () => api.roomReview(locationId) });
  const apply = (r: RoomReview) => {
    qc.setQueryData(key, r);
    void refresh();
  };
  const start = useMutation({ mutationFn: () => api.startRoomReview(locationId), onSuccess: apply });
  const finish = useMutation({ mutationFn: () => api.finishRoomReview(locationId), onSuccess: (r) => (apply(r), setFinished(true)) });
  const [finished, setFinished] = useState(false);
  const r = review.data;
  const name = r?.path.replace(/^[^›]+› /, "") ?? "";
  const done = r?.checked.length ?? 0;
  const total = done + (r?.toCheck.length ?? 0);

  return (
    <Page title={r ? t`Review ${ph({ name })}` : t`Room review`} back={REVIEW_HREF} help="guide/room-review.html">
      {review.isPending && <span className="loading loading-spinner mx-auto my-12 text-primary" />}
      {review.isError && <div className="alert alert-soft alert-error">{review.error.message}</div>}
      {(start.isError || finish.isError) && <div className="alert alert-soft alert-error">{(start.error ?? finish.error)!.message}</div>}
      {r && finished && !r.review && <Finished review={r} />}
      {r && !r.review && !finished && (
        <section className="card">
          <div className="card-body gap-3">
            <p className="text-sm text-base-content/70">{r.path}</p>
            <p>
              {plural(r.toCheck.length, { one: "# thing to check here.", other: "# things to check here." })}{" "}
              {r.reviewedAt ? t`Last reviewed ${ph({ when: whenAgo(r.reviewedAt) })}.` : t`Never reviewed.`}
            </p>
            <p className="text-sm text-base-content/70">
              <Trans>Go through them one by one. A box you can see counts for everything in it. You can stop and carry on later — so can anyone else in your household.</Trans>
            </p>
            {canEdit && r.toCheck.length > 0 && (
              <button type="button" className="btn btn-primary self-start" disabled={start.isPending} onClick={() => start.mutate()}>
                <span className="icon-[tabler--list-check] size-5" />
                <Trans>Start the review</Trans>
              </button>
            )}
          </div>
        </section>
      )}
      {r?.review && (
        <section className="card sticky top-[4.25rem] z-[5]">
          <div className="card-body gap-2 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-medium" aria-live="polite">{t`${ph({ done })} of ${ph({ total })} checked`}</p>
              {canEdit && (
                <button type="button" className={`btn btn-sm ${r.toCheck.length ? "btn-soft" : "btn-primary"}`} disabled={finish.isPending} onClick={() => finish.mutate()}>
                  {r.toCheck.length ? t`Finish now` : t`Finish the review`}
                </button>
              )}
            </div>
            <progress className="progress progress-primary w-full" value={done} max={Math.max(total, 1)} aria-label={t`Checked`} />
            {r.toCheck.length > 0 && done > 0 && <p className="text-xs text-base-content/70"><Trans>Finishing now leaves the rest unchecked.</Trans></p>}
          </div>
        </section>
      )}
      {r && (r.review || !finished) && r.toCheck.length > 0 && (
        <ul className="flex flex-col gap-3">
          {r.toCheck.map((it) => (
            <ReviewRow key={it.id} item={it} householdId={householdId} locationId={locationId} active={Boolean(r.review) && canEdit} onDone={apply} />
          ))}
        </ul>
      )}
      {r?.review && r.toCheck.length === 0 && (
        <div className="alert alert-soft alert-success flex items-center gap-3">
          <span className="icon-[tabler--circle-check] size-6 shrink-0" />
          <Trans>Everything here is checked. Finish the review to mark {name} as reviewed.</Trans>
        </div>
      )}
      {r?.review && r.checked.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold text-base-content/70"><Trans>Checked</Trans></h2>
          <ul className="flex flex-col gap-3">
            {r.checked.map((it) => (
              <ReviewRow key={it.id} item={it} outcome={it.outcome} householdId={householdId} locationId={locationId} active={canEdit} onDone={apply} />
            ))}
          </ul>
        </section>
      )}
      {r && r.inside.length > 0 && <Inside review={r} />}
    </Page>
  );
}

function Finished({ review }: { review: RoomReview }) {
  const name = review.path.replace(/^[^›]+› /, "");
  return (
    <section className="card">
      <div className="card-body items-center gap-3 text-center">
        <span className="icon-[tabler--circle-check] size-10 text-success" />
        <h2 className="text-lg font-semibold"><Trans>{name} is reviewed</Trans></h2>
        <p className="max-w-sm text-sm text-base-content/70">
          <Trans>Everything you checked now shows when it was last seen. Anything you couldn't find is on the Can't find list.</Trans>
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          <a href={MISPLACED_HREF} className="btn btn-soft btn-sm"><Trans>Can't find</Trans></a>
          <a href={REVIEW_HREF} className="btn btn-primary btn-sm"><Trans>Review another place</Trans></a>
        </div>
      </div>
    </section>
  );
}

function Inside({ review }: { review: RoomReview }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold text-base-content/70"><Trans>Places inside, each reviewed on its own</Trans></h2>
      <ul className="card divide-y divide-base-300">
        {review.inside.map((p) => (
          <li key={p.locationId}>
            <a href={reviewHref(p.locationId)} className="flex min-h-12 items-center gap-3 px-4 py-2 hover:bg-base-200">
              <span className="icon-[tabler--map-pin] size-5 shrink-0 text-base-content/40" aria-hidden />
              <span className="min-w-0 flex-1 truncate">{p.name}</span>
              <span className="text-sm text-base-content/70">{plural(p.items, { one: "# thing", other: "# things" })}</span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** One thing in a review: what it is, and Still here / Moved / Gone / Can't find it (or, once checked, what it was). */
function ReviewRow(props: { item: ItemListing; outcome?: ReviewOutcome; householdId: string; locationId: string; active: boolean; onDone: (r: RoomReview) => void }) {
  const { item: it, outcome, householdId, locationId } = props;
  const [changing, setChanging] = useState(false);
  const [moving, setMoving] = useState(false);
  const [going, setGoing] = useState(false);
  const check = useMutation({
    mutationFn: ({ result, to }: { result: ReviewOutcome; to?: string }) => api.checkInReview(locationId, it.id, result, to),
    onSuccess: (r) => {
      setChanging(false);
      setMoving(false);
      props.onDone(r);
    },
  });
  const showActions = props.active && (!outcome || changing);
  const gone = Boolean(it.disposition);
  const sub = [
    it.isContainer ? plural(it.contents, { one: "# thing inside — checked with it", other: "# things inside — checked with it" }) : null,
    !outcome ? lastSeenText(it.lastSeen, true) : null,
    outcome === "moved" ? it.place : null,
  ].filter(Boolean);
  return (
    <li className="card">
      <div className="card-body gap-3 p-3">
        <div className="flex items-center gap-3">
          <a href={itemHref(it.id)} className="flex min-w-0 flex-1 items-center gap-3">
            <Thumb item={it} />
            <span className="min-w-0">
              <span className="block truncate font-medium text-base-content">{it.name}</span>
              {sub.length > 0 && <span className="block truncate text-sm text-base-content/70">{sub.join(" · ")}</span>}
            </span>
          </a>
        </div>
        {outcome && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className={`badge badge-soft ${OUTCOMES[outcome].badge}`}>
              <span className={`${OUTCOMES[outcome].icon} size-4`} />
              {t(OUTCOMES[outcome].label)}
            </span>
            {props.active && !changing && !(outcome === "gone" && gone) && (
              <button type="button" className="btn btn-text btn-sm" onClick={() => setChanging(true)}>
                <Trans>Change</Trans>
              </button>
            )}
          </div>
        )}
        {showActions && (
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-primary btn-sm btn-wrap" disabled={check.isPending} onClick={() => check.mutate({ result: "here" })}>
              <span className="icon-[tabler--check] size-4" />
              <Trans>Still here</Trans>
            </button>
            <button type="button" className="btn btn-soft btn-sm btn-wrap" disabled={check.isPending} onClick={() => setMoving(true)}>
              <span className="icon-[tabler--arrows-move] size-4" />
              <Trans>Moved…</Trans>
            </button>
            {!gone && (
              <button type="button" className="btn btn-soft btn-sm btn-wrap" disabled={check.isPending} onClick={() => setGoing(true)}>
                <span className="icon-[tabler--door-exit] size-4" />
                <Trans>Gone…</Trans>
              </button>
            )}
            <button type="button" className="btn btn-soft btn-warning btn-sm btn-wrap" disabled={check.isPending} onClick={() => check.mutate({ result: "missing" })}>
              <span className="icon-[tabler--map-pin-question] size-4" />
              <Trans>Can't find it</Trans>
            </button>
            {changing && (
              <button type="button" className="btn btn-text btn-sm" onClick={() => setChanging(false)}>
                <Trans>Cancel</Trans>
              </button>
            )}
          </div>
        )}
        {check.isError && <p className="text-sm text-error">{check.error.message}</p>}
      </div>
      {moving && <MoveDialog item={it} householdId={householdId} busy={check.isPending} error={check.error?.message} onClose={() => setMoving(false)} onMove={(to) => check.mutate({ result: "moved", to })} />}
      {going && <GoneDialog item={it} householdId={householdId} onClose={() => setGoing(false)} onDone={() => check.mutate({ result: "gone" })} />}
    </li>
  );
}

function MoveDialog(props: { item: ItemListing; householdId: string; busy: boolean; error?: string; onClose: () => void; onMove: (to: string) => void }) {
  const [to, setTo] = useState<string | null>(null);
  return (
    <Modal id="review-move" title={t`Where is ${ph({ name: props.item.name })} now?`} onClose={props.onClose}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (to) props.onMove(to);
        }}
      >
        <PlacePicker householdId={props.householdId} id="review-move-to" name="locationId" label={t`Now kept in`} value={to} onChange={setTo} noneLabel={t`Pick a place`} />
        {props.error && <p className="text-sm text-error">{props.error}</p>}
        <DialogActions>
          <button type="button" className="btn btn-text" onClick={props.onClose}>
            <Trans>Cancel</Trans>
          </button>
          <button type="submit" className="btn btn-primary" disabled={!to || props.busy}>
            <Trans>Move it</Trans>
          </button>
        </DialogActions>
      </form>
    </Modal>
  );
}

/** On a room's page: "Review this room" and when it last was. */
export function ReviewRoomLink({ locationId, householdId }: { locationId: string; householdId: string }) {
  const rooms = useQuery({ queryKey: ["room-reviews", householdId], queryFn: api.roomsToReview });
  const room = rooms.data?.data.find((r) => r.locationId === locationId);
  if (!room) return null;
  return (
    <a href={reviewHref(locationId)} className="tap link link-hover flex items-center gap-1 text-sm text-base-content/70">
      <span className="icon-[tabler--list-check] size-4 shrink-0" />
      {room.open ? t`Carry on the room review` : t`Review this room`}
      <span className="text-base-content/70">· {reviewedText(room)}</span>
    </a>
  );
}
