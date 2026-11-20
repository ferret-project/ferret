/**
 * "Scan cards" (+ Add, when the server admin switched card look-ups on): Pokémon cards (TCGdex) and Magic cards
 * (Scryfall), one after another. A card has no barcode, so each is photographed — the vision model reads its name and
 * number in the background (POST /cards/read, polled) while the next is taken — or typed ("Pikachu 025/165"). Check
 * the list (the right printing, the finish you have, how many), then save them all: each becomes a thing with the
 * card's picture as its photo and, if ticked, today's market price as its value. Nothing is added until Save; the list
 * survives a reload (sessionStorage).
 */
import type { CardGame, CardInfo } from "@ferret/shared";
import { formatMoney } from "@ferret/shared/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { CategoryPicker, flattenCategories, useCategories } from "./Catalog";
import { useCollections } from "./Collections";
import { PlacePicker } from "./Combobox";
import { HelpLink } from "./HelpLink";
import { TopBar } from "./Nav";
import { CardPicture, cardLine, cardPrice, priceText } from "./Cards";
import { api } from "./lib/api";
import { useCanEdit } from "./lib/auth";
import { currentCurrency } from "./lib/money";
import { photoCopies } from "./lib/photo-copies";
import { addedHref, categoryHref, collectionHref, placeHref, tagHref } from "./lib/route";
import { randomId } from "./lib/secure-context";
import { t, ph, plural } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";

// not translated
const GAME_NAMES: Record<CardGame, string> = { pokemon: "Pokémon", magic: "Magic: The Gathering" };
/** What goes in a card thing's brand: the game. */
// not translated
const GAME_BRANDS: Record<CardGame, string> = { pokemon: "Pokémon TCG", magic: "Magic: The Gathering" };
/** How long to wait for a photo's reading before giving up on it. */
const WAIT_MS = 3 * 60_000;
const EVERY_MS = 2500;

type Row = {
  key: string;
  game: CardGame;
  status: "reading" | "ready" | "failed";
  runId?: string;
  startedAt: number;
  error?: string | null;
  /** The name read off the photo, when no card matched it. */
  readName?: string | null;
  candidates: CardInfo[];
  pick: number;
  finish: string | null;
  quantity: number;
  keep: boolean;
};

const storeKey = (householdId: string) => `ferret:card-scan:${householdId}`;

function loadRows(householdId: string): Row[] {
  try {
    const raw = sessionStorage.getItem(storeKey(householdId));
    return raw ? (JSON.parse(raw) as Row[]) : [];
  } catch {
    return [];
  }
}

function saveRows(householdId: string, rows: Row[]) {
  try {
    if (rows.length) sessionStorage.setItem(storeKey(householdId), JSON.stringify(rows));
    else sessionStorage.removeItem(storeKey(householdId));
  } catch {
    // Private mode: the list just won't survive a reload.
  }
}

function useGame(games: CardGame[]) {
  const [game, setGame] = useState<CardGame>(() => {
    try {
      const saved = localStorage.getItem("ferret.cardGame") as CardGame | null;
      if (saved && games.includes(saved)) return saved;
    } catch {
      // no storage
    }
    return games[0] ?? "pokemon";
  });
  useEffect(() => {
    if (games.length && !games.includes(game)) setGame(games[0]!);
  }, [games, game]);
  const pick = (g: CardGame) => {
    setGame(g);
    try {
      localStorage.setItem("ferret.cardGame", g);
    } catch {
      // no storage
    }
  };
  return [game, pick] as const;
}

export function CardScanScreen({ householdId, locationId, categoryId, tag, collectionId }: { householdId: string; locationId: string | null; categoryId: string | null; tag: string | null; collectionId: string | null }) {
  const canEdit = useCanEdit(householdId);
  const me = useQuery({ queryKey: ["me"], queryFn: api.me, staleTime: 60_000 });
  const back = collectionId ? collectionHref(collectionId) : locationId ? placeHref(locationId) : categoryId ? categoryHref(categoryId) : tag ? tagHref(tag) : "#/";
  const games = me.data?.features.cards ?? [];
  return (
    <div className="min-h-dvh bg-base-200">
      <TopBar title={t`Scan cards`} back={back} help={<HelpLink page="guide/adding-things.html#trading-cards" label={t`Scan cards`} />} search={false} />
      <main className="mx-auto flex max-w-3xl flex-col gap-4 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        {!canEdit ? (
          <div className="alert alert-soft alert-info"><Trans>You can look around, but not add things, in this household.</Trans></div>
        ) : me.data && !games.length ? (
          <div className="alert alert-soft alert-info"><Trans>Card look-ups aren't switched on on this server. Its admin can turn them on in Settings → Server.</Trans></div>
        ) : me.data ? (
          <Binder
            householdId={householdId}
            games={games}
            photos={Boolean(me.data.features.cardPhotos)}
            covers={me.data.features.fromWeb}
            into={{ locationId, categoryId, tag, collectionId }}
          />
        ) : (
          <span className="loading loading-spinner mx-auto my-12 text-primary" />
        )}
      </main>
    </div>
  );
}

function Binder({ householdId, games, photos, covers, into }: { householdId: string; games: CardGame[]; photos: boolean; covers: boolean; into: { locationId: string | null; categoryId: string | null; tag: string | null; collectionId: string | null } }) {
  const qc = useQueryClient();
  const [game, setGame] = useGame(games);
  const [rows, setRows] = useState<Row[]>(() => loadRows(householdId));
  useEffect(() => saveRows(householdId, rows), [householdId, rows]);
  const [place, setPlace] = useState<string | null>(into.locationId);
  const [category, setCategory] = useState<string | null>(into.categoryId);
  const [collection, setCollection] = useState<string | null>(into.collectionId);
  const [withPictures, setWithPictures] = useState(covers);
  const [withValues, setWithValues] = useState(true);
  const [saved, setSaved] = useState<number | null>(null);
  const categories = useCategories(householdId);
  const collections = useCollections(householdId);
  const camera = useRef<HTMLInputElement>(null);
  const library = useRef<HTMLInputElement>(null);

  // No category from where + Add was opened: a cards category, if the household has one.
  const guessed = useRef(Boolean(into.categoryId));
  useEffect(() => {
    if (guessed.current || !categories.data) return;
    guessed.current = true;
    const found = flattenCategories(categories.data).find((c) => /^(trading cards|cards|pok[eé]mon( cards)?|magic( cards)?|tcg)$/i.test(c.name.trim()));
    if (found) setCategory(found.id);
  }, [categories.data]);

  const update = (key: string, patch: Partial<Row> | ((r: Row) => Partial<Row>)) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...(typeof patch === "function" ? patch(r) : patch) } : r)));

  /** A card chosen: the same printing again (its best match) adds to its count instead of another row. */
  const addCard = (key: string | null, game: CardGame, candidates: CardInfo[]) => {
    const first = candidates[0];
    setSaved(null);
    setRows((rs) => {
      const same = first ? rs.find((r) => r.key !== key && r.status === "ready" && r.candidates[r.pick]?.id === first.id) : undefined;
      if (same) return rs.filter((r) => r.key !== key).map((r) => (r === same ? { ...r, quantity: r.quantity + 1 } : r));
      const ready: Partial<Row> = { status: "ready", candidates, pick: 0, finish: first?.finishes[0] ?? null, keep: Boolean(first) };
      if (key) return rs.map((r) => (r.key === key ? { ...r, ...ready } : r));
      return [{ key: randomId(), game, startedAt: Date.now(), quantity: 1, readName: null, ...ready } as Row, ...rs];
    });
  };

  // Photos being read: ask how each is getting on.
  const reading = rows.filter((r) => r.status === "reading" && r.runId);
  useEffect(() => {
    if (!reading.length) return;
    const timer = setInterval(() => {
      for (const r of reading) {
        if (Date.now() - r.startedAt > WAIT_MS) {
          update(r.key, { status: "failed", error: t`Reading took too long — try another photo, or type its name.` });
          continue;
        }
        void api
          .cardRead(r.runId!)
          .then((s) => {
            if (s.status === "failed") update(r.key, { status: "failed", error: s.error ?? null });
            else if (s.status === "done") {
              if (s.candidates?.length) addCard(r.key, s.read?.game ?? r.game, s.candidates);
              else update(r.key, { status: "failed", readName: s.read?.name ?? null, error: s.read?.name ? null : t`Couldn't read a card in that photo.` });
            }
          })
          .catch(() => {});
      }
    }, EVERY_MS);
    return () => clearInterval(timer);
  }, [reading.map((r) => r.key).join()]); // eslint-disable-line react-hooks/exhaustive-deps

  const photograph = async (files: FileList | null) => {
    for (const file of Array.from(files ?? [])) {
      const key = randomId();
      setSaved(null);
      setRows((rs) => [{ key, game, status: "reading", startedAt: Date.now(), candidates: [], pick: 0, finish: null, quantity: 1, keep: false }, ...rs]);
      try {
        const copy = (await photoCopies(file)).preview ?? file;
        const { id } = await api.startCardRead(copy, game);
        update(key, { runId: id, startedAt: Date.now() });
      } catch (err) {
        update(key, { status: "failed", error: err instanceof Error ? err.message : String(err) });
      }
    }
  };

  const toSave = rows.filter((r) => r.keep && r.status === "ready" && r.candidates[r.pick]);
  const [progress, setProgress] = useState(0);
  const save = useMutation({
    mutationFn: async () => {
      let done = 0;
      for (const r of toSave) {
        const c = r.candidates[r.pick]!;
        const price = withValues ? cardPrice(c, r.finish) : null;
        const created = await api.createItem({
          name: c.name,
          brand: GAME_BRANDS[c.game],
          model: [c.setCode, c.setTotal ? `${c.number}/${c.setTotal}` : c.number].filter(Boolean).join(" "),
          description: [c.set, c.rarity, r.finish].filter(Boolean).join(" · "),
          quantity: r.quantity,
          ...(price ? { valueCents: price.cents } : {}),
          card: { game: c.game, id: c.id, finish: r.finish },
          locationId: place ?? undefined,
          categoryId: category ?? undefined,
          collectionId: collection ?? undefined,
          ...(into.tag ? { tags: [into.tag] } : {}),
          origin: "cards",
        });
        if (withPictures && (c.imageLarge || c.image)) await api.useCardImage(created.id).catch(() => {});
        setRows((rs) => rs.filter((x) => x.key !== r.key));
        setProgress(++done);
      }
      return done;
    },
    onSettled: () => {
      for (const key of ["items", "overview", "places", "collections"]) void qc.invalidateQueries({ queryKey: [key] });
    },
    onSuccess: (n) => {
      setSaved(n);
      setProgress(0);
    },
  });

  const cards = rows.reduce((n, r) => n + (r.status === "ready" ? r.quantity : 0), 0);
  const worth = toSave.reduce((sum, r) => sum + (cardPrice(r.candidates[r.pick]!, r.finish)?.cents ?? 0) * r.quantity, 0);

  return (
    <>
      <section className="card">
        <div className="card-body gap-4">
          {games.length > 1 && (
            <div className="join w-full" role="radiogroup" aria-label={t`Which game?`}>
              {games.map((g) => (
                <button key={g} type="button" role="radio" aria-checked={game === g} className={`btn join-item flex-1 ${game === g ? "btn-primary" : "btn-soft"}`} onClick={() => setGame(g)}>
                  {GAME_NAMES[g]}
                </button>
              ))}
            </div>
          )}
          <p className="text-base-content/80">
            {photos ? (
              <Trans>Photograph each card, front on and filling the photo — Ferret reads its name and number while you take the next. Or type it. Check the list, then save them all; nothing is added until you do.</Trans>
            ) : (
              <Trans>Type each card's name, and its number if you like ("Pikachu 025/165"). Check the list, then save them all; nothing is added until you do.</Trans>
            )}
          </p>
          {photos && (
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn btn-primary btn-lg flex-1" onClick={() => camera.current?.click()}>
                <span className="icon-[tabler--camera] size-6" />
                <Trans>Photograph a card</Trans>
              </button>
              <button type="button" className="btn btn-soft btn-lg" onClick={() => library.current?.click()}>
                <span className="icon-[tabler--photo] size-6" />
                <Trans>Choose photos</Trans>
              </button>
              <input
                ref={camera}
                type="file"
                accept="image/*"
                capture="environment"
                className="hidden"
                onChange={(e) => {
                  void photograph(e.target.files);
                  e.target.value = "";
                }}
              />
              <input
                ref={library}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(e) => {
                  void photograph(e.target.files);
                  e.target.value = "";
                }}
              />
            </div>
          )}
          <TypeCard game={game} onChoose={(found) => addCard(null, game, found)} />
        </div>
      </section>

      {saved != null && (
        <div className="alert alert-soft alert-success flex flex-wrap items-center gap-2" role="status">
          <span className="icon-[tabler--circle-check] size-5" />
          <span>{plural(saved, { one: "# card added.", other: "# cards added." })}</span>
          <a className="link tap" href={collection ? collectionHref(collection) : place ? placeHref(place) : addedHref("cards")}>
            <Trans>See them</Trans>
          </a>
        </div>
      )}

      {rows.length > 0 && (
        <section className="card" aria-labelledby="card-list">
          <div className="card-body gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="card-list" className="card-title flex flex-wrap items-baseline gap-x-2">
                {plural(cards, { one: "# card", other: "# cards" })}
                {worth > 0 && <span className="text-sm font-normal text-base-content/70">{t`worth about ${ph({ worth: formatMoney(worth, currentCurrency()) })}`}</span>}
              </h2>
              <button type="button" className="btn btn-text btn-sm" disabled={save.isPending} onClick={() => confirm(t`Clear the list? Nothing in it has been saved.`) && setRows([])}>
                <Trans>Clear</Trans>
              </button>
            </div>
            <ul className="divide-y divide-base-content/10">
              {rows.map((r) => (
                <CardRow key={r.key} row={r} busy={save.isPending} onChange={(patch) => update(r.key, patch)} onRemove={() => setRows((rs) => rs.filter((x) => x.key !== r.key))} onFound={(found) => addCard(r.key, r.game, found)} />
              ))}
            </ul>
          </div>
        </section>
      )}

      {rows.length > 0 && (
        <section className="card">
          <div className="card-body gap-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1">
                <span className="text-sm font-medium"><Trans>Collection</Trans></span>
                <select className="select" value={collection ?? ""} onChange={(e) => setCollection(e.target.value || null)}>
                  <option value="">{t`None`}</option>
                  {(collections.data ?? []).map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </label>
              <CategoryPicker householdId={householdId} value={category} onChange={setCategory} />
              <PlacePicker householdId={householdId} id="cards-place" name="place" label={t`Where are they?`} value={place} onChange={setPlace} noneLabel={t`No place`} />
            </div>
            <label className="flex cursor-pointer items-center gap-3 text-sm">
              <input type="checkbox" className="checkbox checkbox-primary" checked={withValues} onChange={(e) => setWithValues(e.target.checked)} />
              <Trans>Use today's market price as each card's value</Trans>
            </label>
            {covers && (
              <label className="flex cursor-pointer items-center gap-3 text-sm">
                <input type="checkbox" className="checkbox checkbox-primary" checked={withPictures} onChange={(e) => setWithPictures(e.target.checked)} />
                <Trans>Add each card's picture as its photo</Trans>
              </label>
            )}
            {withValues && <p className="text-xs text-base-content/70"><Trans>Prices are for ungraded cards in good condition; a graded card can be worth much more.</Trans></p>}
            {save.isError && <div className="alert alert-soft alert-error">{save.error.message}</div>}
            <button type="button" className="btn btn-primary btn-wrap" disabled={!toSave.length || save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? (
                <>
                  <span className="loading loading-spinner loading-sm" />
                  {t`Saving ${ph({ done: progress + 1 })} of ${ph({ total: toSave.length + progress })}…`}
                </>
              ) : (
                plural(toSave.length, { one: "Save # card", other: "Save # cards" })
              )}
            </button>
          </div>
        </section>
      )}
    </>
  );
}

/** Type a card: "Pikachu 025/165" → the catalog's matches; tap one. */
function TypeCard({ game, onChoose }: { game: CardGame; onChoose: (found: CardInfo[]) => void }) {
  const [q, setQ] = useState("");
  const search = useMutation({ mutationFn: (text: string) => api.searchCards(game, text) });
  const results = search.data?.data;
  return (
    <div className="flex flex-col gap-2">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (q.trim()) search.mutate(q.trim());
        }}
      >
        <input
          className="input flex-1"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={game === "magic" ? t`e.g. Lightning Bolt M10 146` : t`e.g. Pikachu 025/165`}
          aria-label={t`Card name, and number`}
        />
        <button className="btn btn-soft btn-primary" disabled={search.isPending || !q.trim()}>
          {search.isPending ? <span className="loading loading-spinner loading-sm" /> : <span className="icon-[tabler--search] size-5" />}
          <span className="max-sm:sr-only"><Trans>Find</Trans></span>
        </button>
      </form>
      {search.isError && <p className="text-sm text-error">{search.error.message}</p>}
      {results && !results.length && <p className="text-sm text-base-content/70"><Trans>No cards by that name. Check the spelling, or leave out the number.</Trans></p>}
      {results && results.length > 0 && (
        <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
          {results.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                className="flex w-full flex-col items-center gap-1 rounded-box p-1 text-center hover:bg-base-200"
                onClick={() => {
                  onChoose([c, ...results.filter((x) => x.id !== c.id)]);
                  search.reset();
                  setQ("");
                }}
              >
                <CardPicture card={c} className="w-full" />
                <span className="line-clamp-2 text-xs">{cardLine(c)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CardRow({ row, busy, onChange, onRemove, onFound }: { row: Row; busy: boolean; onChange: (patch: Partial<Row>) => void; onRemove: () => void; onFound: (found: CardInfo[]) => void }) {
  const [choosing, setChoosing] = useState(false);
  const c = row.candidates[row.pick];
  const price = c ? cardPrice(c, row.finish) : null;
  const label = c?.name ?? row.readName ?? t`Card`;
  return (
    <li className="flex flex-col gap-2 py-3">
      <div className="flex items-start gap-3">
        <input type="checkbox" className="checkbox checkbox-primary mt-6" checked={row.keep} disabled={busy || !c} onChange={(e) => onChange({ keep: e.target.checked })} aria-label={t`Add ${ph({ card: label })}`} />
        <CardPicture card={c} className="w-16 shrink-0" />
        <div className="min-w-0 flex-1">
          {row.status === "reading" ? (
            <p className="pt-4 text-sm text-base-content/70"><span className="loading loading-spinner loading-xs me-2" /><Trans>Reading the card…</Trans></p>
          ) : c ? (
            <>
              <p className="font-medium break-words">{c.name}</p>
              <p className="text-sm text-base-content/70 break-words">{cardLine(c)}</p>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                {c.finishes.length > 1 ? (
                  <select className="select select-sm w-auto" value={row.finish ?? ""} disabled={busy} onChange={(e) => onChange({ finish: e.target.value || null })} aria-label={t`Finish`}>
                    {c.finishes.map((f) => (
                      <option key={f} value={f}>{f}</option>
                    ))}
                  </select>
                ) : (
                  row.finish && <span className="badge badge-soft">{row.finish}</span>
                )}
                <div className="join" aria-label={t`How many`}>
                  <button type="button" className="btn btn-soft btn-sm join-item" disabled={busy || row.quantity <= 1} onClick={() => onChange({ quantity: row.quantity - 1 })} aria-label={t`One fewer`}>−</button>
                  <span className="btn btn-soft btn-sm join-item pointer-events-none tabular-nums">×{row.quantity}</span>
                  <button type="button" className="btn btn-soft btn-sm join-item" disabled={busy} onClick={() => onChange({ quantity: row.quantity + 1 })} aria-label={t`One more`}>+</button>
                </div>
                {price ? <span className="text-sm font-medium">{priceText(price)}</span> : <span className="text-xs text-base-content/70"><Trans>No price</Trans></span>}
              </div>
              {row.candidates.length > 1 && (
                <button type="button" className="link tap mt-1 text-sm" onClick={() => setChoosing((v) => !v)}>
                  {choosing ? t`Done choosing` : plural(row.candidates.length - 1, { one: "Not this printing? # other", other: "Not this printing? # others" })}
                </button>
              )}
            </>
          ) : (
            <div className="flex flex-col gap-1">
              <p className="text-sm text-base-content/70">
                {row.readName ? <Trans>No card called "{ph({ name: row.readName })}" — fix the spelling and find it again.</Trans> : (row.error ?? <Trans>Couldn't read that card.</Trans>)}
              </p>
              {row.readName && <RetypeCard game={row.game} initial={row.readName} onFound={onFound} />}
            </div>
          )}
        </div>
        <button type="button" className="btn btn-text btn-circle btn-sm" disabled={busy} onClick={onRemove} aria-label={t`Remove ${ph({ card: label })} from the list`}>
          <span className="icon-[tabler--x] size-4" />
        </button>
      </div>
      {choosing && (
        <ul className="grid grid-cols-3 gap-2 ps-10 sm:grid-cols-5">
          {row.candidates.map((x, i) => (
            <li key={x.id}>
              <button
                type="button"
                className={`flex w-full flex-col items-center gap-1 rounded-box p-1 text-center ${i === row.pick ? "bg-primary/15 ring-2 ring-primary" : "hover:bg-base-200"}`}
                aria-pressed={i === row.pick}
                onClick={() => {
                  onChange({ pick: i, finish: x.finishes.includes(row.finish ?? "") ? row.finish : (x.finishes[0] ?? null) });
                  setChoosing(false);
                }}
              >
                <CardPicture card={x} className="w-full" />
                <span className="line-clamp-2 text-xs">{cardLine(x)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/** A name was read but nothing matched: fix the spelling here. */
function RetypeCard({ game, initial, onFound }: { game: CardGame; initial: string; onFound: (found: CardInfo[]) => void }) {
  const [q, setQ] = useState(initial);
  const search = useMutation({ mutationFn: (text: string) => api.searchCards(game, text), onSuccess: (r) => r.data.length && onFound(r.data) });
  return (
    <form
      className="flex gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (q.trim()) search.mutate(q.trim());
      }}
    >
      <input className="input input-sm flex-1" value={q} onChange={(e) => setQ(e.target.value)} aria-label={t`Card name, and number`} />
      <button className="btn btn-soft btn-sm" disabled={search.isPending}>
        <Trans>Find</Trans>
      </button>
      {search.data && !search.data.data.length && <span className="self-center text-xs text-base-content/70"><Trans>Still nothing</Trans></span>}
    </form>
  );
}
