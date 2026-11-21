/**
 * LEGO sets, coins and comics from the collector catalogs (+ Add, when the server admin saved the catalog's key):
 * Rebrickable, Numista and Comic Vine. Each one is photographed — the vision model reads a box's set number, a coin's
 * country and year, a cover's series and issue in the background (POST /collectibles/read, polled) while the next is
 * taken — or typed. Check the list (the right one, a coin's year and grade, how many), then save them all: each
 * becomes a thing with the catalog's picture as its photo, its details in a matching template's fields, a link back to
 * the catalog, and a coin's estimate as its value if ticked. Nothing is added until Save; the list survives a reload.
 */
import type { CoinGrade, CoinIssuer, CollectibleInfo, CollectibleKind, ItemTemplate } from "@ferret/shared";
import { formatMoney } from "@ferret/shared/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { CategoryPicker, flattenCategories, useCategories } from "./Catalog";
import { useCollections } from "./Collections";
import { CATALOG_NAMES, CatalogLink, CoinChoice, CollectiblePicture, GRADE_NAMES, KIND_ICONS, KIND_NAMES, RecordCondition, VIDEO_FORMATS, collectibleLine, priceFor, priceSays, priceText, seasonName } from "./Collectibles";
import { PlacePicker } from "./Combobox";
import { HelpLink } from "./HelpLink";
import { TopBar } from "./Nav";
import { useTemplates } from "./Templates";
import { api } from "./lib/api";
import { useCanEdit } from "./lib/auth";
import { currentCurrency } from "./lib/money";
import { photoCopies } from "./lib/photo-copies";
import { addedHref, categoryHref, collectHref, collectionHref, placeHref, tagHref } from "./lib/route";
import { randomId } from "./lib/secure-context";
import { t, ph, plural } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";

/** How long to wait for a photo's reading before giving up on it. */
const WAIT_MS = 3 * 60_000;
const EVERY_MS = 2500;
/** A category for each kind, if the household has one by a usual name. */
const CATEGORY_NAMES: Record<CollectibleKind, RegExp> = { lego: /^(lego|lego sets?|building sets?)$/i, coin: /^(coins?|coin collection|numismatics)$/i, comic: /^(comics?|comic books?)$/i, video: /^(movies?|films?|dvds?|blu-?rays?|movies (&|and) (tv|shows))$/i, game: /^(video ?games?|games|gaming)$/i, record: /^(music|records?|vinyl|cds?|records (&|and) cds)$/i };
/** A template for each kind: one with this field (the starter "LEGO set", "Coin", "Comic book" have them). */
const TEMPLATE_FIELD: Partial<Record<CollectibleKind, string>> = { lego: "set_number", coin: "denomination", comic: "series", record: "artist" };

type Row = {
  key: string;
  status: "reading" | "ready" | "failed";
  runId?: string;
  startedAt: number;
  error?: string | null;
  /** What was read off the photo, when nothing matched it. */
  readQuery?: string | null;
  candidates: CollectibleInfo[];
  pick: number;
  quantity: number;
  keep: boolean;
  issue?: string | null;
  grade?: CoinGrade | null;
  format?: string | null;
  season?: number | null;
  condition?: string | null;
};

/** What reading a photo (or the words typed) said beyond which one it is. */
type Hints = { format?: string | null; season?: number | null };

const storeKey = (householdId: string, kind: CollectibleKind) => `ferret:collect:${kind}:${householdId}`;

function loadRows(householdId: string, kind: CollectibleKind): Row[] {
  try {
    const raw = sessionStorage.getItem(storeKey(householdId, kind));
    return raw ? (JSON.parse(raw) as Row[]) : [];
  } catch {
    return [];
  }
}

function saveRows(householdId: string, kind: CollectibleKind, rows: Row[]) {
  try {
    if (rows.length) sessionStorage.setItem(storeKey(householdId, kind), JSON.stringify(rows));
    else sessionStorage.removeItem(storeKey(householdId, kind));
  } catch {
    // Private mode: the list just won't survive a reload.
  }
}

type Into = { locationId: string | null; categoryId: string | null; tag: string | null; collectionId: string | null };

export function CollectibleScanScreen({ householdId, kind, ...into }: { householdId: string; kind: CollectibleKind } & Into) {
  const canEdit = useCanEdit(householdId);
  const me = useQuery({ queryKey: ["me"], queryFn: api.me, staleTime: 60_000 });
  const back = into.collectionId ? collectionHref(into.collectionId) : into.locationId ? placeHref(into.locationId) : into.categoryId ? categoryHref(into.categoryId) : into.tag ? tagHref(into.tag) : "#/";
  const kinds = me.data?.features.collectibles ?? [];
  return (
    <div className="min-h-dvh bg-base-200">
      <TopBar title={t(KIND_NAMES[kind])} back={back} help={<HelpLink page="guide/adding-things.html#lego-coins-and-comics" label={t(KIND_NAMES[kind])} />} search={false} />
      <main className="mx-auto flex max-w-3xl flex-col gap-4 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        {kinds.length > 1 && (
          <nav className={`grid gap-2 ${kinds.length > 2 ? "grid-cols-2 sm:grid-cols-4" : "grid-cols-2"}`} aria-label={t`What are you adding?`}>
            {kinds.map((k) => (
              <a key={k} href={collectHref(k, into)} aria-current={k === kind ? "page" : undefined} className={`btn btn-wrap ${k === kind ? "btn-primary" : "btn-soft"}`}>
                <span className={`${KIND_ICONS[k]} size-5 max-sm:hidden`} />
                {t(KIND_NAMES[k])}
              </a>
            ))}
          </nav>
        )}
        {!canEdit ? (
          <div className="alert alert-soft alert-info"><Trans>You can look around, but not add things, in this household.</Trans></div>
        ) : me.data && !kinds.includes(kind) ? (
          <div className="alert alert-soft alert-info"><Trans>This catalog isn't switched on on this server. Its admin can add its key in Settings → Server.</Trans></div>
        ) : me.data ? (
          <Shelf key={kind} householdId={householdId} kind={kind} photos={Boolean(me.data.features.cardPhotos)} pictures={me.data.features.fromWeb} into={into} />
        ) : (
          <span className="loading loading-spinner mx-auto my-12 text-primary" />
        )}
      </main>
    </div>
  );
}

/** What a thing made from this gets in a template's fields (only the ones the template has are kept). */
function templateValues(c: CollectibleInfo, row: Row): Record<string, string | number> {
  const issue = c.issues?.find((i) => i.id === row.issue);
  const v: Record<string, string | number | null | undefined> =
    c.kind === "lego"
      ? { set_number: c.setNumber, theme: c.theme, pieces: c.pieces, year: c.year }
      : c.kind === "coin"
        ? { year: issue?.year ?? (c.yearTo ? null : c.year), mint_mark: issue?.label.split(" · ")[0]?.split(" ")[1]?.match(/^[A-Z]{1,3}$/)?.[0], denomination: c.denomination, country: c.issuer, composition: c.composition, grade: row.grade ? t(GRADE_NAMES[row.grade]) : null }
        : c.kind === "comic"
          ? { series: c.series, issue: c.issueNumber, publisher: c.publisher, year: c.year }
          : c.kind === "record"
            ? { artist: c.artist, label: c.label, year: c.year, pressing: [c.country, c.formatText].filter(Boolean).join(" · ") }
            : {};
  return Object.fromEntries(Object.entries(v).filter((e): e is [string, string | number] => e[1] != null && e[1] !== ""));
}

/** The thing's own fields: name, brand, model, description. */
function itemFields(c: CollectibleInfo, row: Row) {
  const issue = c.issues?.find((i) => i.id === row.issue);
  if (c.kind === "lego")
    return { name: c.name, brand: "LEGO" /* not translated */, model: c.setNumber ?? c.id, description: [c.year, c.theme, c.pieces ? plural(c.pieces, { one: "# piece", other: "# pieces" }) : null].filter(Boolean).join(" · ") };
  if (c.kind === "coin")
    return { name: issue ? `${c.name} (${issue.label})` : c.name, brand: c.issuer ?? null, model: null, description: [c.denomination, c.composition, c.diameterMm ? `${c.diameterMm} mm` : null, row.grade ? t(GRADE_NAMES[row.grade]) : null].filter(Boolean).join(" · ") };
  if (c.kind === "record")
    return { name: c.name, brand: c.artist ?? null, model: c.label ?? null, description: [c.formatText, c.year, c.country, row.condition].filter(Boolean).join(" · ") };
  if (c.kind === "game")
    return { name: c.name, brand: c.publisher ?? null, model: row.format ?? null, description: [c.year, c.genres?.slice(0, 3).join(", ")].filter(Boolean).join(" · ") };
  if (c.kind === "video") {
    const show = c.mediaType === "tv";
    return {
      name: show ? (row.season != null ? `${c.name} – ${seasonName(row.season)}` : c.name) : c.year ? `${c.name} (${c.year})` : c.name,
      brand: c.studio ?? null,
      model: row.format ?? null,
      description: [show ? t`TV show` : t`Film`, c.year, c.runtimeMin ? t`${ph({ minutes: c.runtimeMin })} min` : null, c.genres?.slice(0, 3).join(", ")].filter(Boolean).join(" · "),
    };
  }
  return { name: c.name, brand: c.publisher ?? null, model: c.issueNumber ? `#${c.issueNumber}` : null, description: [c.title, c.coverDate].filter(Boolean).join(" · ") };
}

function chooseTemplate(kind: CollectibleKind, templates: ItemTemplate[] | undefined, collectionTemplateId: string | null | undefined) {
  const field = TEMPLATE_FIELD[kind];
  if (!field) return null;
  const fits = (tpl: ItemTemplate) => tpl.fields.some((f) => f.key === field);
  const theirs = templates?.find((tpl) => tpl.id === collectionTemplateId);
  if (theirs && fits(theirs)) return theirs;
  return templates?.find(fits) ?? null;
}

function Shelf({ householdId, kind, photos, pictures, into }: { householdId: string; kind: CollectibleKind; photos: boolean; pictures: boolean; into: Into }) {
  const qc = useQueryClient();
  const [rows, setRows] = useState<Row[]>(() => loadRows(householdId, kind));
  useEffect(() => saveRows(householdId, kind, rows), [householdId, kind, rows]);
  const [place, setPlace] = useState<string | null>(into.locationId);
  const [category, setCategory] = useState<string | null>(into.categoryId);
  const [collection, setCollection] = useState<string | null>(into.collectionId);
  const [withPictures, setWithPictures] = useState(pictures);
  const [withValues, setWithValues] = useState(true);
  const [saved, setSaved] = useState<number | null>(null);
  const categories = useCategories(householdId);
  const collections = useCollections(householdId);
  const templates = useTemplates(householdId);
  const camera = useRef<HTMLInputElement>(null);
  const library = useRef<HTMLInputElement>(null);

  // No category from where + Add was opened: one by a usual name, if the household has it.
  const guessed = useRef(Boolean(into.categoryId));
  useEffect(() => {
    if (guessed.current || !categories.data) return;
    guessed.current = true;
    const found = flattenCategories(categories.data).find((c) => CATEGORY_NAMES[kind].test(c.name.trim()));
    if (found) setCategory(found.id);
  }, [categories.data, kind]);

  const update = (key: string, patch: Partial<Row> | ((r: Row) => Partial<Row>)) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...(typeof patch === "function" ? patch(r) : patch) } : r)));

  /** One chosen: the same set or comic again adds to its count instead of another row (a coin may differ by year and grade, a film by format). */
  const addFound = (key: string | null, candidates: CollectibleInfo[], hints: Hints = {}) => {
    const first = candidates[0];
    setSaved(null);
    setRows((rs) => {
      const same = first && (kind === "lego" || kind === "comic") ? rs.find((r) => r.key !== key && r.status === "ready" && r.candidates[r.pick]?.id === first.id) : undefined;
      if (same) return rs.filter((r) => r.key !== key).map((r) => (r === same ? { ...r, quantity: r.quantity + 1 } : r));
      const ready: Partial<Row> = { status: "ready", candidates, pick: 0, keep: Boolean(first), issue: null, grade: null, format: kind === "game" ? platformOf(first, hints.format) : (hints.format ?? null), season: first?.mediaType === "tv" ? (hints.season ?? null) : null };
      if (key) return rs.map((r) => (r.key === key ? { ...r, ...ready } : r));
      return [{ key: randomId(), startedAt: Date.now(), quantity: 1, readQuery: null, ...ready } as Row, ...rs];
    });
  };

  // Photos being read: ask how each is getting on.
  const reading = rows.filter((r) => r.status === "reading" && r.runId);
  useEffect(() => {
    if (!reading.length) return;
    const timer = setInterval(() => {
      for (const r of reading) {
        if (Date.now() - r.startedAt > WAIT_MS) {
          update(r.key, { status: "failed", error: t`Reading took too long — try another photo, or type it.` });
          continue;
        }
        void api
          .collectibleRead(r.runId!)
          .then((s) => {
            if (s.status === "failed") update(r.key, { status: "failed", error: s.error ?? null });
            else if (s.status === "done") {
              if (s.candidates?.length) addFound(r.key, s.candidates, { format: s.read?.format, season: s.read?.season });
              else update(r.key, { status: "failed", readQuery: s.read?.query ?? null, error: s.read?.query ? null : t`Couldn't read anything to look up in that photo.` });
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
      setRows((rs) => [{ key, status: "reading", startedAt: Date.now(), candidates: [], pick: 0, quantity: 1, keep: false }, ...rs]);
      try {
        const copy = (await photoCopies(file)).preview ?? file;
        const { id } = await api.startCollectibleRead(copy, kind);
        update(key, { runId: id, startedAt: Date.now() });
      } catch (err) {
        update(key, { status: "failed", error: err instanceof Error ? err.message : String(err) });
      }
    }
  };

  /** A coin's estimate in its year and grade, a record's price for its condition (fetched by its row; asked again here if it wasn't). */
  const coinPrice = async (r: Row) => {
    const c = r.candidates[r.pick];
    if (!c || !((kind === "coin" && r.issue && r.grade) || kind === "record")) return null;
    const prices = await qc.query({ queryKey: ["catalog-prices", kind, c.id, r.issue ?? null], queryFn: async () => (await api.catalogPrices(kind, c.id, r.issue)).data, staleTime: 10 * 60_000 }).catch(() => []);
    return priceFor({ kind, grade: r.grade, condition: r.condition }, prices);
  };

  const toSave = rows.filter((r) => r.keep && r.status === "ready" && r.candidates[r.pick]);
  const [progress, setProgress] = useState(0);
  const save = useMutation({
    mutationFn: async () => {
      const template = chooseTemplate(kind, templates.data, collections.data?.find((c) => c.id === collection)?.templateId);
      let done = 0;
      for (const r of toSave) {
        const picked = r.candidates[r.pick]!;
        // A coin's details (its issues), a film's (runtime, studio) come from asking for it; sets and comics are whole from the search.
        const c = kind === "coin" || kind === "video" || kind === "record" ? await qc.query({ queryKey: ["collectible", kind, picked.id], queryFn: () => api.collectible(kind, picked.id), staleTime: 10 * 60_000 }).catch(() => picked) : picked;
        const price = withValues ? await coinPrice(r) : null;
        const values = templateValues(c, r);
        const fields = template ? Object.fromEntries(Object.entries(values).filter(([k]) => template.fields.some((f) => f.key === k))) : {};
        const created = await api.createItem({
          ...itemFields(c, r),
          quantity: r.quantity,
          ...(price ? { valueCents: price.cents } : {}),
          ...(template ? { templateId: template.id, customFields: fields } : {}),
          collectible: { kind, id: c.id, ...(kind === "coin" ? { issue: r.issue ?? null, grade: r.grade ?? null } : {}), ...(kind === "video" ? { format: r.format ?? null, season: c.mediaType === "tv" ? (r.season ?? null) : null } : {}), ...(kind === "game" ? { format: r.format ?? null } : {}), ...(kind === "record" ? { condition: r.condition ?? null } : {}) },
          links: c.url ? [{ url: c.url, label: t`On ${ph({ service: CATALOG_NAMES[kind] })}` }] : undefined,
          locationId: place ?? undefined,
          categoryId: category ?? undefined,
          collectionId: collection ?? undefined,
          ...(into.tag ? { tags: [into.tag] } : {}),
          origin: "collector",
        });
        if (withPictures && kind !== "coin" && (c.imageLarge || c.image)) await api.useCollectibleImage(created.id).catch(() => {});
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

  const count = rows.reduce((n, r) => n + (r.status === "ready" ? r.quantity : 0), 0);
  const howMany =
    kind === "record"
      ? plural(count, { one: "# record", other: "# records" })
      : kind === "game"
      ? plural(count, { one: "# game", other: "# games" })
      : kind === "lego"
      ? plural(count, { one: "# set", other: "# sets" })
      : kind === "coin"
        ? plural(count, { one: "# coin", other: "# coins" })
        : kind === "comic"
          ? plural(count, { one: "# comic", other: "# comics" })
          : plural(count, { one: "# film or show", other: "# films and shows" });

  return (
    <>
      <section className="card">
        <div className="card-body gap-4">
          <p className="text-base-content/80">
            {kind === "lego" ? (
              <Trans>Photograph each box (or its instructions) so the set number shows, or type the number or name. Sets come from Rebrickable.</Trans>
            ) : kind === "coin" ? (
              <Trans>Photograph each coin, or type its country, year and name. Coins come from Numista, with an estimate for each year and grade.</Trans>
            ) : kind === "record" ? (
              <Trans>Photograph each sleeve or case (the back, with its catalogue number, finds the exact pressing best), or type its barcode, or the artist and title. Records come from Discogs.</Trans>
            ) : kind === "game" ? (
              <Trans>Photograph each case, or type the title. Games come from IGDB; choose the console each one is for.</Trans>
            ) : kind === "comic" ? (
              <Trans>Photograph each cover, or type the series and issue number. Comics come from Comic Vine.</Trans>
            ) : (
              <Trans>Photograph each case, or type the title (and the year, or a show's season). Films and shows come from TMDB.</Trans>
            )}{" "}
            <Trans>Check the list, then save them all; nothing is added until you do.</Trans>
          </p>
          {photos && (
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn btn-primary btn-lg btn-wrap flex-1" onClick={() => camera.current?.click()}>
                <span className="icon-[tabler--camera] size-6" />
                {kind === "lego" ? t`Photograph a box` : kind === "coin" ? t`Photograph a coin` : kind === "comic" ? t`Photograph a cover` : kind === "record" ? t`Photograph a sleeve` : t`Photograph a case`}
              </button>
              <button type="button" className="btn btn-soft btn-lg" onClick={() => library.current?.click()}>
                <span className="icon-[tabler--photo] size-6" />
                <Trans>Choose photos</Trans>
              </button>
              <input ref={camera} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => (void photograph(e.target.files), (e.target.value = ""))} />
              <input ref={library} type="file" accept="image/*" multiple className="hidden" onChange={(e) => (void photograph(e.target.files), (e.target.value = ""))} />
            </div>
          )}
          <TypeIt kind={kind} onChoose={(found, hints) => addFound(null, found, hints)} />
        </div>
      </section>

      {saved != null && (
        <div className="alert alert-soft alert-success flex flex-wrap items-center gap-2" role="status">
          <span className="icon-[tabler--circle-check] size-5" />
          <span>{plural(saved, { one: "# thing added.", other: "# things added." })}</span>
          <a className="link tap" href={collection ? collectionHref(collection) : place ? placeHref(place) : addedHref("collector")}>
            <Trans>See them</Trans>
          </a>
        </div>
      )}

      {rows.length > 0 && (
        <section className="card" aria-labelledby="collect-list">
          <div className="card-body gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="collect-list" className="card-title">{howMany}</h2>
              <button type="button" className="btn btn-text btn-sm" disabled={save.isPending} onClick={() => confirm(t`Clear the list? Nothing in it has been saved.`) && setRows([])}>
                <Trans>Clear</Trans>
              </button>
            </div>
            <ul className="divide-y divide-base-content/10">
              {rows.map((r) => (
                <FoundRow key={r.key} kind={kind} row={r} busy={save.isPending} onChange={(patch) => update(r.key, patch)} onRemove={() => setRows((rs) => rs.filter((x) => x.key !== r.key))} onFound={(found) => addFound(r.key, found)} />
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
              <PlacePicker householdId={householdId} id="collect-place" name="place" label={t`Where are they?`} value={place} onChange={setPlace} noneLabel={t`No place`} />
            </div>
            {(kind === "coin" || kind === "record") && (
              <label className="flex cursor-pointer items-center gap-3 text-sm">
                <input type="checkbox" className="checkbox checkbox-primary" checked={withValues} onChange={(e) => setWithValues(e.target.checked)} />
                {kind === "coin" ? (
                  <Trans>Use Numista's estimate as each coin's value (once its year and grade are chosen)</Trans>
                ) : (
                  <Trans>Use Discogs' price as each record's value (for its condition, or the lowest for sale now)</Trans>
                )}
              </label>
            )}
            {pictures && kind !== "coin" && (
              <label className="flex cursor-pointer items-center gap-3 text-sm">
                <input type="checkbox" className="checkbox checkbox-primary" checked={withPictures} onChange={(e) => setWithPictures(e.target.checked)} />
                <Trans>Add the catalog's picture as each one's photo</Trans>
              </label>
            )}
            {save.isError && <div className="alert alert-soft alert-error">{save.error.message}</div>}
            <button type="button" className="btn btn-primary btn-wrap" disabled={!toSave.length || save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? (
                <>
                  <span className="loading loading-spinner loading-sm" />
                  {t`Saving ${ph({ done: progress + 1 })} of ${ph({ total: toSave.length + progress })}…`}
                </>
              ) : (
                plural(toSave.length, { one: "Save # thing", other: "Save # things" })
              )}
            </button>
          </div>
        </section>
      )}
    </>
  );
}

function rememberedIssuer(): CoinIssuer | null {
  try {
    const raw = localStorage.getItem("ferret.coinIssuer");
    return raw ? (JSON.parse(raw) as CoinIssuer) : null;
  } catch {
    return null;
  }
}

/** Type it: a set number or name, a coin's words (with its country and year), a comic's series and number → matches; tap one. */
function TypeIt({ kind, onChoose }: { kind: CollectibleKind; onChoose: (found: CollectibleInfo[], hints?: Hints) => void }) {
  const [q, setQ] = useState("");
  const [year, setYear] = useState("");
  const [issuer, setIssuer] = useState<CoinIssuer | null>(() => (kind === "coin" ? rememberedIssuer() : null));
  const search = useMutation({ mutationFn: (text: string) => api.searchCollectibles({ kind, q: text, issuer: issuer?.code, year: year ? Number(year) : null }) });
  const results = search.data?.data;
  const pickIssuer = (i: CoinIssuer | null) => {
    setIssuer(i);
    try {
      if (i) localStorage.setItem("ferret.coinIssuer", JSON.stringify(i));
      else localStorage.removeItem("ferret.coinIssuer");
    } catch {
      // no storage
    }
  };
  const placeholder =
    kind === "lego" ? t`Set number or name, e.g. 75192` : kind === "coin" ? t`e.g. Washington quarter` : kind === "comic" ? t`Series and issue, e.g. Amazing Spider-Man 300` : kind === "game" ? t`Title, e.g. Mario Kart 8 Deluxe` : kind === "record" ? t`Barcode, or artist and title` : t`Title, e.g. Breaking Bad season 2`;
  return (
    <div className="flex flex-col gap-2">
      {kind === "coin" && (
        <div className="flex flex-wrap gap-2">
          <IssuerPicker value={issuer} onChange={pickIssuer} />
          <input className="input w-28" inputMode="numeric" value={year} onChange={(e) => setYear(e.target.value.replace(/[^\d-]/g, "").slice(0, 5))} placeholder={t`Year`} aria-label={t`Year`} />
        </div>
      )}
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (q.trim() || issuer) search.mutate(q.trim());
        }}
      >
        <input className="input flex-1" value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder} aria-label={t`What to look up`} />
        <button className="btn btn-soft btn-primary" disabled={search.isPending || !(q.trim() || (kind === "coin" && issuer))}>
          {search.isPending ? <span className="loading loading-spinner loading-sm" /> : <span className="icon-[tabler--search] size-5" />}
          <span className="max-sm:sr-only"><Trans>Find</Trans></span>
        </button>
      </form>
      {search.isError && <p className="text-sm text-error">{search.error.message}</p>}
      {results && !results.length && <p className="text-sm text-base-content/70">{kind === "coin" ? t`No coins found. Try fewer words, another year, or pick the country.` : t`Nothing found. Check the spelling, or try fewer words.`}</p>}
      {results && results.length > 0 && (
        <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
          {results.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                className="flex w-full flex-col items-center gap-1 rounded-box p-1 text-center hover:bg-base-200"
                onClick={() => {
                  // "Breaking Bad season 2": that season, chosen.
                  const season = q.match(/\b(?:season|series|s)\s*(\d{1,2})\s*$/i);
                  onChoose([c, ...results.filter((x) => x.id !== c.id)], season ? { season: Number(season[1]) } : {});
                  search.reset();
                  setQ("");
                }}
              >
                <CollectiblePicture info={c} kind={kind} className="w-full" />
                <span className="line-clamp-2 text-xs font-medium">{c.name}</span>
                <span className="line-clamp-2 text-xs text-base-content/70">{collectibleLine(c)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A coin's country (or other issuer): type to filter Numista's list. */
function IssuerPicker({ value, onChange }: { value: CoinIssuer | null; onChange: (i: CoinIssuer | null) => void }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setTyped(q.trim()), 250);
    return () => clearTimeout(timer);
  }, [q]);
  const found = useQuery({ queryKey: ["coin-issuers", typed], queryFn: async () => (await api.coinIssuers(typed)).data, enabled: typed.length > 1, staleTime: 60 * 60_000 });
  if (value)
    return (
      <span className="badge badge-soft badge-primary badge-lg h-auto min-h-10 gap-2 py-1">
        <span className="icon-[tabler--flag] size-4" />
        {value.name}
        {value.parent && value.parent !== value.name ? <span className="text-xs opacity-70">({value.parent})</span> : null}
        <button type="button" className="btn btn-text btn-circle btn-xs" onClick={() => onChange(null)} aria-label={t`Any country`}>
          <span className="icon-[tabler--x] size-4" />
        </button>
      </span>
    );
  return (
    <div className="relative min-w-0 flex-1">
      <input
        className="input w-full"
        value={q}
        onChange={(e) => (setQ(e.target.value), setOpen(true))}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder={t`Country (any)`}
        aria-label={t`Country`}
        role="combobox"
        aria-expanded={open && Boolean(found.data?.length)}
        aria-controls="coin-issuers"
      />
      {open && found.data && found.data.length > 0 && (
        <ul id="coin-issuers" role="listbox" className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-box bg-base-100 p-1 shadow-lg">
          {found.data.map((i) => (
            <li key={i.code} role="option" aria-selected={false}>
              <button type="button" className="w-full rounded-field px-3 py-2 text-start hover:bg-base-200" onMouseDown={(e) => e.preventDefault()} onClick={() => (onChange(i), setQ(""), setOpen(false))}>
                {i.name}
                {i.parent ? <span className="text-sm text-base-content/70"> · {i.parent}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FoundRow({ kind, row, busy, onChange, onRemove, onFound }: { kind: CollectibleKind; row: Row; busy: boolean; onChange: (patch: Partial<Row>) => void; onRemove: () => void; onFound: (found: CollectibleInfo[]) => void }) {
  const [choosing, setChoosing] = useState(false);
  const c = row.candidates[row.pick];
  const label = c?.name ?? row.readQuery ?? t`This one`;
  return (
    <li className="flex flex-col gap-2 py-3">
      <div className="flex items-start gap-3">
        <input type="checkbox" className="checkbox checkbox-primary mt-6" checked={row.keep} disabled={busy || !c} onChange={(e) => onChange({ keep: e.target.checked })} aria-label={t`Add ${ph({ thing: label })}`} />
        <CollectiblePicture info={c} kind={kind} className="w-16 shrink-0" />
        <div className="min-w-0 flex-1">
          {row.status === "reading" ? (
            <p className="pt-4 text-sm text-base-content/70"><span className="loading loading-spinner loading-xs me-2" /><Trans>Reading the photo…</Trans></p>
          ) : c ? (
            <>
              <p className="font-medium break-words">{c.name}</p>
              <p className="text-sm text-base-content/70 break-words">{collectibleLine(c)}</p>
              {kind === "coin" && <CoinRowChoice coin={c} row={row} busy={busy} onChange={onChange} />}
              {kind === "video" && <VideoRowChoice video={c} row={row} busy={busy} onChange={onChange} />}
              {kind === "game" && <PlatformChoice game={c} row={row} busy={busy} onChange={onChange} />}
              {kind === "record" && <RecordRowChoice record={c} row={row} busy={busy} onChange={onChange} />}
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <div className="join" aria-label={t`How many`}>
                  <button type="button" className="btn btn-soft btn-sm join-item" disabled={busy || row.quantity <= 1} onClick={() => onChange({ quantity: row.quantity - 1 })} aria-label={t`One fewer`}>−</button>
                  <span className="btn btn-soft btn-sm join-item pointer-events-none tabular-nums">×{row.quantity}</span>
                  <button type="button" className="btn btn-soft btn-sm join-item" disabled={busy} onClick={() => onChange({ quantity: row.quantity + 1 })} aria-label={t`One more`}>+</button>
                </div>
                <CatalogLink info={c} className="link tap text-sm" />
              </div>
              {row.candidates.length > 1 && (
                <button type="button" className="link tap mt-1 text-sm" onClick={() => setChoosing((v) => !v)}>
                  {choosing ? t`Done choosing` : plural(row.candidates.length - 1, { one: "Not this one? # other", other: "Not this one? # others" })}
                </button>
              )}
            </>
          ) : (
            <div className="flex flex-col gap-1">
              <p className="text-sm text-base-content/70">
                {row.readQuery ? <Trans>Nothing found for "{ph({ words: row.readQuery })}" — fix the words and look again.</Trans> : (row.error ?? <Trans>Couldn't read that photo.</Trans>)}
              </p>
              {row.readQuery && <Retype kind={kind} initial={row.readQuery} onFound={onFound} />}
            </div>
          )}
        </div>
        <button type="button" className="btn btn-text btn-circle btn-sm" disabled={busy} onClick={onRemove} aria-label={t`Remove ${ph({ thing: label })} from the list`}>
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
                  onChange({ pick: i, issue: null, grade: null, season: x.mediaType === "tv" ? row.season : null, ...(kind === "game" ? { format: platformOf(x, row.format) } : {}) });
                  setChoosing(false);
                }}
              >
                <CollectiblePicture info={x} kind={kind} className="w-full" />
                <span className="line-clamp-2 text-xs">{x.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/** A coin in the list: its year and mint, its grade, and Numista's estimate for them. */
function CoinRowChoice({ coin, row, busy, onChange }: { coin: CollectibleInfo; row: Row; busy: boolean; onChange: (patch: Partial<Row>) => void }) {
  const detail = useQuery({ queryKey: ["collectible", "coin", coin.id], queryFn: () => api.collectible("coin", coin.id), staleTime: 10 * 60_000 });
  const prices = useQuery({ queryKey: ["catalog-prices", "coin", coin.id, row.issue ?? null], queryFn: async () => (await api.catalogPrices("coin", coin.id, row.issue)).data, enabled: Boolean(row.issue), staleTime: 10 * 60_000 });
  // A coin struck in one year only: that year, chosen.
  const only = detail.data?.issues?.length === 1 ? detail.data.issues[0]!.id : null;
  useEffect(() => {
    if (only && !row.issue) onChange({ issue: only });
  }, [only]); // eslint-disable-line react-hooks/exhaustive-deps
  const price = priceFor({ kind: "coin", grade: row.grade }, prices.data);
  return (
    <div className="mt-1 flex flex-col gap-1">
      <CoinChoice info={detail.data ?? coin} issue={row.issue ?? null} grade={row.grade ?? null} busy={busy || detail.isPending} onChange={(issue, grade) => onChange({ issue, grade })} />
      {detail.isError && <p className="text-xs text-error">{detail.error.message}</p>}
      {row.issue && row.grade && prices.data && (
        price ? <span className="text-sm font-medium">{t`About ${ph({ price: priceText(price) })}`}</span> : <span className="text-xs text-base-content/70"><Trans>No estimate for this grade</Trans></span>
      )}
      {row.issue && !row.grade && prices.data && prices.data.length > 0 && (
        <span className="text-xs text-base-content/70">
          {prices.data.map((p) => `${p.grade?.toUpperCase()} ${formatMoney(p.cents, p.currency || currentCurrency(), { exact: true })}`).join(" · ")}
        </span>
      )}
    </div>
  );
}

/**
 * The game's platform matching what was read off its case ("Switch" → "Nintendo Switch"); the only one if it has one;
 * else what was read as it is, or none.
 */
function platformOf(game: CollectibleInfo | undefined, read: string | null | undefined) {
  const platforms = game?.platforms ?? [];
  const r = read?.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (r) {
    const found = platforms.find((p) => {
      const q = p.toLowerCase().replace(/[^a-z0-9]/g, "");
      return q === r || q.includes(r) || r.includes(q);
    });
    if (found) return found;
  }
  return platforms.length === 1 ? platforms[0]! : (read ?? null);
}

/** A record in the list: its condition, and Discogs' price for it (or the lowest for sale now). */
function RecordRowChoice({ record, row, busy, onChange }: { record: CollectibleInfo; row: Row; busy: boolean; onChange: (patch: Partial<Row>) => void }) {
  const prices = useQuery({ queryKey: ["catalog-prices", "record", record.id, null], queryFn: async () => (await api.catalogPrices("record", record.id)).data, staleTime: 10 * 60_000 });
  const price = priceFor({ kind: "record", condition: row.condition }, prices.data);
  return (
    <div className="mt-1 flex flex-col gap-1">
      <RecordCondition value={row.condition ?? null} busy={busy} onChange={(condition) => onChange({ condition })} />
      {price ? (
        <span className="text-sm">
          <span className="font-medium">{priceText(price)}</span> <span className="text-base-content/70">{priceSays(price)}</span>
        </span>
      ) : (
        prices.isSuccess && <span className="text-xs text-base-content/70"><Trans>No copies for sale on Discogs right now</Trans></span>
      )}
    </div>
  );
}

/** A game in the list: the console the copy is for. */
function PlatformChoice({ game, row, busy, onChange }: { game: CollectibleInfo; row: Row; busy: boolean; onChange: (patch: Partial<Row>) => void }) {
  const options = [...new Set([...(game.platforms ?? []), ...(row.format ? [row.format] : [])])];
  if (!options.length) return null;
  return (
    <div className="mt-1">
      {/* A game's platforms: a handful. */}
      <select className="select select-sm w-auto max-w-full" value={row.format ?? ""} disabled={busy} onChange={(e) => onChange({ format: e.target.value || null })} aria-label={t`Platform`}>
        <option value="">{t`Platform…`}</option>
        {options.map((p) => (
          <option key={p} value={p}>{p}</option>
        ))}
      </select>
    </div>
  );
}

/** A film or show in the list: the format owned, and a show's season (or the whole series). */
function VideoRowChoice({ video, row, busy, onChange }: { video: CollectibleInfo; row: Row; busy: boolean; onChange: (patch: Partial<Row>) => void }) {
  const show = video.mediaType === "tv";
  const detail = useQuery({ queryKey: ["collectible", "video", video.id], queryFn: () => api.collectible("video", video.id), enabled: show, staleTime: 10 * 60_000 });
  return (
    <div className="mt-1 flex flex-wrap gap-2">
      <select className="select select-sm w-auto max-w-full" value={row.format ?? ""} disabled={busy} onChange={(e) => onChange({ format: e.target.value || null })} aria-label={t`Format`}>
        <option value="">{t`Format…`}</option>
        {VIDEO_FORMATS.map((f) => (
          <option key={f} value={f}>{f}</option>
        ))}
      </select>
      {show && (
        <select className="select select-sm w-auto max-w-full" value={row.season ?? ""} disabled={busy || detail.isPending} onChange={(e) => onChange({ season: e.target.value === "" ? null : Number(e.target.value) })} aria-label={t`Season`}>
          <option value="">{seasonName(null)}</option>
          {(detail.data?.seasons ?? (row.season != null ? [{ number: row.season, name: "" }] : [])).map((x) => (
            <option key={x.number} value={x.number}>{seasonName(x.number)}</option>
          ))}
        </select>
      )}
    </div>
  );
}

/** Words were read but nothing matched: fix them here. */
function Retype({ kind, initial, onFound }: { kind: CollectibleKind; initial: string; onFound: (found: CollectibleInfo[]) => void }) {
  const [q, setQ] = useState(initial);
  const search = useMutation({ mutationFn: (text: string) => api.searchCollectibles({ kind, q: text }), onSuccess: (r) => r.data.length && onFound(r.data) });
  return (
    <form
      className="flex gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (q.trim()) search.mutate(q.trim());
      }}
    >
      <input className="input input-sm flex-1" value={q} onChange={(e) => setQ(e.target.value)} aria-label={t`What to look up`} />
      <button className="btn btn-soft btn-sm" disabled={search.isPending}>
        <Trans>Find</Trans>
      </button>
      {search.data && !search.data.data.length && <span className="self-center text-xs text-base-content/70"><Trans>Still nothing</Trans></span>}
    </form>
  );
}
