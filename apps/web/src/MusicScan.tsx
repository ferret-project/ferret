/**
 * "Scan music" (+ Add, when the server admin switched music look-ups on): scan a shelf or crate of CDs and records one
 * after another — each barcode asked of MusicBrainz (`?as=music`) while the camera keeps going — then check the list
 * and save them all at once: album as the name, artist as the brand, format · year · label as the description, the
 * cover as its photo. Nothing is added until Save. The list survives a reload (sessionStorage), since a crate is a lot
 * of scanning to lose.
 */
import type { BarcodeMatch, ScanCandidate } from "@ferret/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { CategoryPicker, flattenCategories, useCategories } from "./Catalog";
import { PlacePicker } from "./Combobox";
import { HelpLink } from "./HelpLink";
import { TopBar } from "./Nav";
import { Scanner } from "./Scanner";
import { useFeedback } from "./ScanSession";
import { api } from "./lib/api";
import { useCanEdit } from "./lib/auth";
import { addedHref, categoryHref, placeHref, tagHref } from "./lib/route";
import { t, ph, plural } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";

type Row = {
  code: string;
  status: "looking" | "found" | "unknown" | "error";
  match?: BarcodeMatch;
  /** The household's things with this code already. */
  have?: ScanCandidate[];
  /** For a code nobody knew: what the person typed. */
  name?: string;
  keep: boolean;
};

const storeKey = (householdId: string) => `ferret:music-scan:${householdId}`;

function loadRows(householdId: string): Row[] {
  try {
    const raw = sessionStorage.getItem(storeKey(householdId));
    const rows = raw ? (JSON.parse(raw) as Row[]) : [];
    // A look-up cut short by the reload is asked again.
    return rows.map((r) => (r.status === "looking" ? { ...r, status: "error" as const } : r));
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

export function MusicScanScreen({ householdId, locationId, categoryId, tag }: { householdId: string; locationId: string | null; categoryId: string | null; tag: string | null }) {
  const canEdit = useCanEdit(householdId);
  const me = useQuery({ queryKey: ["me"], queryFn: api.me, staleTime: 60_000 });
  const back = locationId ? placeHref(locationId) : categoryId ? categoryHref(categoryId) : tag ? tagHref(tag) : "#/";
  return (
    <div className="min-h-dvh bg-base-200">
      <TopBar title={t`Scan music`} back={back} help={<HelpLink page="guide/adding-things.html#music" label={t`Scan music`} />} search={false} />
      <main className="mx-auto flex max-w-3xl flex-col gap-4 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        {!canEdit ? (
          <div className="alert alert-soft alert-info"><Trans>You can look around, but not add things, in this household.</Trans></div>
        ) : me.data && !me.data.features.music ? (
          <div className="alert alert-soft alert-info"><Trans>Music look-ups aren't switched on on this server. Its admin can turn them on in Settings → Server.</Trans></div>
        ) : me.data ? (
          <Crate householdId={householdId} locationId={locationId} categoryId={categoryId} tag={tag} covers={me.data.features.fromWeb} />
        ) : (
          <span className="loading loading-spinner mx-auto my-12 text-primary" />
        )}
      </main>
    </div>
  );
}

function Crate({ householdId, locationId, categoryId, tag, covers }: { householdId: string; locationId: string | null; categoryId: string | null; tag: string | null; covers: boolean }) {
  const qc = useQueryClient();
  const [rows, setRows] = useState<Row[]>(() => loadRows(householdId));
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  useEffect(() => saveRows(householdId, rows), [householdId, rows]);
  const [scanning, setScanning] = useState(false);
  const [place, setPlace] = useState<string | null>(locationId);
  const categories = useCategories(householdId);
  const [category, setCategory] = useState<string | null>(categoryId);
  // No category from where + Add was opened: a "Music" category, if the household has one.
  const guessed = useRef(Boolean(categoryId));
  useEffect(() => {
    if (guessed.current || !categories.data) return;
    guessed.current = true;
    const music = flattenCategories(categories.data).find((c) => /^(music|cds?|records|vinyl|cds & records|music & movies)$/i.test(c.name.trim()));
    if (music) setCategory(music.id);
  }, [categories.data]);
  const [withCovers, setWithCovers] = useState(covers);
  const [last, setLast] = useState<string | null>(null);
  const [saved, setSaved] = useState<number | null>(null);
  const { prepare, beep } = useFeedback();

  const update = (code: string, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.code === code ? { ...r, ...patch } : r)));

  const lookUp = async (code: string) => {
    update(code, { status: "looking" });
    try {
      const res = await api.barcode(code, "music");
      const have = res.have ?? [];
      // Already in the household: listed, but left unticked so it isn't added twice by accident.
      update(code, res.match ? { status: "found", match: res.match, have, keep: have.length === 0 } : { status: "unknown", have, keep: false });
    } catch {
      update(code, { status: "error", keep: false });
    }
  };

  const onResult = (raw: string) => {
    const code = raw.replace(/\D/g, "");
    if (code.length < 8 || code.length > 14) {
      beep(false);
      return true;
    }
    setLast(code);
    if (rowsRef.current.some((r) => r.code === code || r.code === `0${code}` || `0${r.code}` === code)) {
      beep(false); // scanned already
      return true;
    }
    beep(true);
    setSaved(null);
    setRows((rs) => [{ code, status: "looking", keep: true }, ...rs]);
    void lookUp(code);
    return true;
  };

  const toSave = rows.filter((r) => r.keep && (r.match || r.name?.trim()));
  const [progress, setProgress] = useState(0);
  const save = useMutation({
    mutationFn: async () => {
      let done = 0;
      for (const r of toSave) {
        const m = r.match;
        const created = await api.createItem({
          name: m ? m.name : r.name!.trim(),
          ...(m?.brand ? { brand: m.brand } : {}),
          ...(m?.description ? { description: m.description } : {}),
          barcode: r.code,
          locationId: place ?? undefined,
          categoryId: category ?? undefined,
          ...(tag ? { tags: [tag] } : {}),
          origin: "scan",
        });
        // The cover: downloaded by the server from the stored look-up (best effort — the thing is saved either way).
        if (withCovers && m?.images.length && m.source !== "ferret") await api.useProductPhoto(created.id, 0).catch(() => {});
        setRows((rs) => rs.filter((x) => x.code !== r.code));
        setProgress(++done);
      }
      return done;
    },
    onSettled: () => {
      for (const key of ["items", "overview", "places"]) void qc.invalidateQueries({ queryKey: [key] });
    },
    onSuccess: (n) => {
      setSaved(n);
      setProgress(0);
    },
  });

  const latest = rows.find((r) => r.code === last);
  const found = rows.filter((r) => r.status === "found").length;

  return (
    <>
      <section className="card">
        <div className="card-body gap-4">
          <p className="text-base-content/80">
            <Trans>Scan the barcode on the back of each CD or record, one after another — the camera keeps going. Ferret looks each one up on
            MusicBrainz; check the list, then save them all. Nothing is added until you do.</Trans>
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <PlacePicker householdId={householdId} id="music-place" name="place" label={t`Where are they?`} value={place} onChange={setPlace} noneLabel={t`No place`} />
            <CategoryPicker householdId={householdId} value={category} onChange={setCategory} />
          </div>
          {covers && (
            <label className="flex cursor-pointer items-center gap-3 text-sm">
              <input type="checkbox" className="checkbox checkbox-primary" checked={withCovers} onChange={(e) => setWithCovers(e.target.checked)} />
              <Trans>Add each album's cover as its photo</Trans>
            </label>
          )}
          <button
            type="button"
            className="btn btn-primary btn-lg"
            onClick={() => {
              prepare(); // sound needs a tap to start
              setScanning(true);
            }}
          >
            <span className="icon-[tabler--barcode] size-6" />
            {rows.length ? <Trans>Scan more</Trans> : <Trans>Start scanning</Trans>}
          </button>
        </div>
      </section>

      {saved != null && (
        <div className="alert alert-soft alert-success flex flex-wrap items-center gap-2" role="status">
          <span className="icon-[tabler--circle-check] size-5" />
          <span>{plural(saved, { one: "# album added.", other: "# albums added." })}</span>
          <a className="link tap" href={place ? placeHref(place) : addedHref("scan")}>
            {place ? <Trans>See them there</Trans> : <Trans>See them</Trans>}
          </a>
        </div>
      )}

      {rows.length > 0 && (
        <section className="card" aria-labelledby="music-list">
          <div className="card-body gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="music-list" className="card-title">
                {plural(rows.length, { one: "# scanned", other: "# scanned" })}
                {found < rows.length && <span className="text-sm font-normal text-base-content/70">{t`(${ph({ found })} found)`}</span>}
              </h2>
              <button type="button" className="btn btn-text btn-sm" disabled={save.isPending} onClick={() => confirm(t`Clear the list? Nothing in it has been saved.`) && setRows([])}>
                <Trans>Clear</Trans>
              </button>
            </div>
            <ul className="divide-y divide-base-content/10">
              {rows.map((r) => (
                <MusicRow key={r.code} row={r} busy={save.isPending} onChange={(patch) => update(r.code, patch)} onRetry={() => void lookUp(r.code)} onRemove={() => setRows((rs) => rs.filter((x) => x.code !== r.code))} />
              ))}
            </ul>
            {save.isError && <div className="alert alert-soft alert-error">{save.error.message}</div>}
            <button type="button" className="btn btn-primary btn-wrap" disabled={!toSave.length || save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? (
                <>
                  <span className="loading loading-spinner loading-sm" />
                  {t`Saving ${ph({ done: progress + 1 })} of ${ph({ total: toSave.length + progress })}…`}
                </>
              ) : (
                plural(toSave.length, { one: "Save # album", other: "Save # albums" })
              )}
            </button>
          </div>
        </section>
      )}

      {scanning && (
        <Scanner
          onResult={onResult}
          onClose={() => setScanning(false)}
          top={<p className="text-center text-sm font-medium text-white">{plural(rows.length, { one: "# scanned", other: "# scanned" })}</p>}
          panel={
            <div className="flex items-center gap-3 rounded-box bg-base-100 p-3 shadow-lg" aria-live="polite">
              {latest ? <Summary row={latest} /> : <p className="flex-1 text-sm text-base-content/70"><Trans>Point the camera at a CD's or record's barcode.</Trans></p>}
              <button type="button" className="btn btn-primary shrink-0" onClick={() => setScanning(false)}>
                <Trans>Done</Trans>
              </button>
            </div>
          }
        />
      )}
    </>
  );
}

function Cover({ row, size }: { row: Row; size: string }) {
  const [broken, setBroken] = useState(false);
  const src = row.match?.images[0];
  return src && !broken ? (
    <img src={src} alt="" referrerPolicy="no-referrer" loading="lazy" onError={() => setBroken(true)} className={`${size} shrink-0 rounded-field bg-base-200 object-cover`} />
  ) : (
    <span className={`${size} flex shrink-0 items-center justify-center rounded-field bg-base-200 text-base-content/40`}>
      <span className="icon-[tabler--vinyl] size-6" />
    </span>
  );
}

/** The scanner's panel: the code just scanned. */
function Summary({ row }: { row: Row }) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-3">
      <Cover row={row} size="size-12" />
      <div className="min-w-0">
        {row.status === "looking" ? (
          <p className="text-sm text-base-content/70"><Trans>Looking up</Trans> <span className="font-mono">{row.code}</span>…</p>
        ) : row.match ? (
          <>
            <p className="truncate font-medium">{row.match.name}</p>
            <p className="truncate text-sm text-base-content/70">{[row.match.brand, row.match.description].filter(Boolean).join(" · ")}</p>
          </>
        ) : (
          <p className="text-sm text-base-content/70">
            <Trans>Not found — you can name it in the list.</Trans>
          </p>
        )}
      </div>
    </div>
  );
}

function MusicRow({ row, busy, onChange, onRetry, onRemove }: { row: Row; busy: boolean; onChange: (patch: Partial<Row>) => void; onRetry: () => void; onRemove: () => void }) {
  const m = row.match;
  const label = m?.name ?? row.name ?? row.code;
  return (
    <li className="flex items-start gap-3 py-3">
      <input
        type="checkbox"
        className="checkbox checkbox-primary mt-3"
        checked={row.keep}
        disabled={busy || (!m && !row.name?.trim())}
        onChange={(e) => onChange({ keep: e.target.checked })}
        aria-label={t`Add ${ph({ album: label })}`}
      />
      <Cover row={row} size="size-14" />
      <div className="min-w-0 flex-1">
        {row.status === "looking" ? (
          <p className="pt-3 text-sm text-base-content/70"><span className="loading loading-spinner loading-xs me-2" /><Trans>Looking up</Trans> <span className="font-mono">{row.code}</span>…</p>
        ) : m ? (
          <>
            <p className="font-medium break-words">{m.name}</p>
            {m.brand && <p className="text-sm break-words">{m.brand}</p>}
            {m.description && <p className="text-sm text-base-content/70 break-words">{m.description}</p>}
          </>
        ) : (
          <div className="flex flex-col gap-1">
            <p className="text-sm text-base-content/70">
              {row.status === "error" ? <Trans>Couldn't look up <span className="font-mono">{row.code}</span>.</Trans> : <Trans>MusicBrainz doesn't know <span className="font-mono">{row.code}</span>.</Trans>}
            </p>
            {row.status === "error" ? (
              <button type="button" className="btn btn-soft btn-sm self-start" onClick={onRetry}>
                <Trans>Try again</Trans>
              </button>
            ) : (
              <input
                className="input input-sm"
                placeholder={t`Album and artist`}
                aria-label={t`Name for ${ph({ code: row.code })}`}
                value={row.name ?? ""}
                disabled={busy}
                onChange={(e) => onChange({ name: e.target.value, keep: Boolean(e.target.value.trim()) })}
              />
            )}
          </div>
        )}
        {row.have && row.have.length > 0 && (
          <p className="mt-1 text-xs text-warning">
            {plural(row.have.length, { one: "You have this one already", other: "You have # of these already" })}
          </p>
        )}
      </div>
      <button type="button" className="btn btn-text btn-circle btn-sm" disabled={busy} onClick={onRemove} aria-label={t`Remove ${ph({ album: label })} from the list`}>
        <span className="icon-[tabler--x] size-4" />
      </button>
    </li>
  );
}
