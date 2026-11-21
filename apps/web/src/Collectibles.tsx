/**
 * LEGO sets, coins and comics from the collector catalogs (server: lib/collectibles.ts) on a thing's page: the
 * catalog's picture and details with a link back to its page there, and for a coin today's price in its grade (Use it
 * as its value). Shared with the collector scan screen (CollectibleScan.tsx).
 */
import type { CoinGrade, CollectibleInfo, CollectibleKind, CollectiblePrice, Item } from "@ferret/shared";
import { formatMoney } from "@ferret/shared/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "./lib/api";
import { t, ph, plural, msg } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { MessageDescriptor } from "@lingui/core";

// not translated (names of services)
export const CATALOG_NAMES: Record<CollectibleKind, string> = { lego: "Rebrickable", coin: "Numista", comic: "Comic Vine", video: "TMDB", game: "IGDB" };
export const KIND_ICONS: Record<CollectibleKind, string> = { lego: "icon-[tabler--lego]", coin: "icon-[tabler--coin]", comic: "icon-[tabler--book]", video: "icon-[tabler--movie]", game: "icon-[tabler--device-gamepad-2]" };
export const KIND_NAMES: Record<CollectibleKind, MessageDescriptor> = { lego: msg`LEGO sets`, coin: msg`Coins`, comic: msg`Comics`, video: msg`Movies & TV`, game: msg`Video games` };
export const KIND_HEADINGS: Record<CollectibleKind, MessageDescriptor> = { lego: msg`LEGO set`, coin: msg`Coin`, comic: msg`Comic`, video: msg`Movie or show`, game: msg`Video game` };

/** Formats a film or show is owned in (as the server reads them off a case); names of formats, not translated. */
// not translated
export const VIDEO_FORMATS = ["DVD", "Blu-ray", "4K Ultra HD", "VHS", "LaserDisc", "Digital"];

/** "Season 2", "Specials", "Whole series". */
export const seasonName = (season: number | null | undefined) => (season == null ? t`Whole series` : season === 0 ? t`Specials` : t`Season ${ph({ season })}`);

/** Numista's grades, worst to best (as in shared's coinGrades — values aren't imported from there into the web app). */
export const COIN_GRADES: CoinGrade[] = ["g", "vg", "f", "vf", "xf", "au", "unc"];
export const GRADE_NAMES: Record<CoinGrade, MessageDescriptor> = {
  g: msg`Good (G)`,
  vg: msg`Very good (VG)`,
  f: msg`Fine (F)`,
  vf: msg`Very fine (VF)`,
  xf: msg`Extremely fine (XF)`,
  au: msg`About uncirculated (AU)`,
  unc: msg`Uncirculated (UNC)`,
};

export const priceText = (p: CollectiblePrice) => formatMoney(p.cents, p.currency, { exact: true });

/** "2017 · Star Wars › Ultimate Collector Series · 7,541 pieces"; "United States · 1965–1998"; "Marvel · May 1988 · Venom". */
export function collectibleLine(c: CollectibleInfo) {
  if (c.kind === "lego") return [c.setNumber, c.year, c.theme, c.pieces ? plural(c.pieces, { one: "# piece", other: "# pieces" }) : null].filter(Boolean).join(" · ");
  if (c.kind === "game") return [c.year, c.publisher, c.platforms?.slice(0, 4).join(", ")].filter(Boolean).join(" · ");
  if (c.kind === "video")
    return [c.mediaType === "tv" ? t`TV show` : t`Film`, c.year, c.studio, c.runtimeMin ? t`${ph({ minutes: c.runtimeMin })} min` : null, c.seasonCount ? plural(c.seasonCount, { one: "# season", other: "# seasons" }) : null]
      .filter(Boolean)
      .join(" · ");
  if (c.kind === "coin") return [c.issuer, c.year ? (c.yearTo ? `${c.year}–${c.yearTo}` : String(c.year)) : null, c.coinType].filter(Boolean).join(" · ");
  return [c.publisher, c.year, c.title].filter(Boolean).join(" · ");
}

export function CollectiblePicture({ info, kind, className = "" }: { info: CollectibleInfo | undefined; kind: CollectibleKind; className?: string }) {
  const [broken, setBroken] = useState(false);
  const shape = kind === "coin" ? "aspect-square rounded-full" : kind === "comic" || kind === "video" || kind === "game" ? "aspect-[3/4] rounded" : "aspect-[4/3] rounded";
  return info?.image && !broken ? (
    <img src={info.image} alt="" referrerPolicy="no-referrer" loading="lazy" onError={() => setBroken(true)} className={`${shape} bg-base-200 ${kind === "lego" ? "object-contain" : "object-cover"} ${className}`} />
  ) : (
    <span className={`flex ${shape} items-center justify-center bg-base-200 text-base-content/40 ${className}`}>
      <span className={`${KIND_ICONS[kind]} size-6`} />
    </span>
  );
}

/** The link back to its page in the catalog (which their terms ask for, and is where the details are). */
export function CatalogLink({ info, className = "btn btn-text btn-sm" }: { info: CollectibleInfo; className?: string }) {
  if (!info.url) return null;
  return (
    <a className={className} href={info.url} target="_blank" rel="noreferrer noopener">
      <span className="icon-[tabler--external-link] size-4" />
      {t`On ${ph({ service: CATALOG_NAMES[info.kind] })}`}
    </a>
  );
}

/** A set, coin or comic thing's page: which one it is, its details and link back — and for a coin, today's price offered as its value. */
export function CollectibleDetails({ item, canEdit, hasPhoto }: { item: Item; canEdit: boolean; hasPhoto: boolean }) {
  const qc = useQueryClient();
  const c = item.collectible;
  const got = useQuery({ queryKey: ["item-collectible", item.id, c?.id, c?.issue, c?.grade], queryFn: () => api.itemCollectible(item.id), enabled: Boolean(c), staleTime: 10 * 60_000 });
  const refresh = () => void qc.invalidateQueries({ queryKey: ["item", item.householdId, item.id] });
  const apply = useMutation({ mutationFn: (patch: Parameters<typeof api.updateItem>[1]) => api.updateItem(item.id, patch), onSuccess: refresh });
  const picture = useMutation({
    mutationFn: () => api.useCollectibleImage(item.id),
    onSuccess: () => {
      refresh();
      void qc.invalidateQueries({ queryKey: ["attachments"] });
    },
  });
  if (!c) return null;
  const info = got.data?.info;
  const price = got.data?.price;
  const issue = info?.issues?.find((i) => i.id === c.issue);
  return (
    <section className="card border border-primary/20" aria-labelledby="item-collectible-title">
      <div className="card-body gap-3 p-4">
        <h2 id="item-collectible-title" className="flex items-center gap-2 font-semibold text-base-content">
          <span className={`${KIND_ICONS[c.kind]} size-5 text-primary`} />
          {t(KIND_HEADINGS[c.kind])}
        </h2>
        {got.isPending && <span className="loading loading-spinner loading-sm text-primary" />}
        {got.isSuccess && !info && <p className="text-sm text-base-content/70">{t`${ph({ service: CATALOG_NAMES[c.kind] })} can't be reached right now.`}</p>}
        {info && (
          <div className="flex items-start gap-3">
            <CollectiblePicture info={info} kind={c.kind} className="w-20 shrink-0" />
            <div className="flex min-w-0 flex-col gap-1">
              <p className="font-medium break-words">{info.name}</p>
              <p className="text-sm text-base-content/80 break-words">{collectibleLine(info)}</p>
              {c.kind === "coin" && (
                <p className="text-sm text-base-content/80">
                  {[issue?.label, c.grade ? t(GRADE_NAMES[c.grade]) : null, info.composition, info.diameterMm ? `${info.diameterMm} mm` : null].filter(Boolean).join(" · ")}
                </p>
              )}
              {c.kind === "video" && (c.format || info.mediaType === "tv") && (
                <p className="text-sm text-base-content/80">{[info.mediaType === "tv" ? seasonName(c.season) : null, c.format].filter(Boolean).join(" · ")}</p>
              )}
              {c.kind === "game" && c.format && <p className="text-sm text-base-content/80">{c.format}</p>}
              {(c.kind === "video" || c.kind === "game") && info.genres?.length ? <p className="text-xs text-base-content/70">{info.genres.join(", ")}</p> : null}
              {c.kind === "coin" && c.issue && c.grade && (
                price ? (
                  <p>
                    <span className="font-medium">{priceText(price)}</span> <span className="text-sm text-base-content/70">{t`estimated value today (Numista)`}</span>
                  </p>
                ) : (
                  got.isSuccess && <p className="text-sm text-base-content/70"><Trans>Numista has no price for this coin in this grade.</Trans></p>
                )
              )}
              {c.kind === "coin" && canEdit && (!c.issue || !c.grade) && info.issues && (
                <CoinChoice info={info} issue={c.issue ?? null} grade={c.grade ?? null} busy={apply.isPending} onChange={(issue, grade) => apply.mutate({ collectible: { ...c, issue, grade } })} />
              )}
              {info.pictureBy && <p className="text-xs text-base-content/70">{t`Picture: ${ph({ by: info.pictureBy })} on Numista`}</p>}
              <div className="mt-1 flex flex-wrap gap-2">
                {canEdit && price && price.cents !== item.valueCents && (
                  <button type="button" className="btn btn-soft btn-primary btn-sm" disabled={apply.isPending} onClick={() => apply.mutate({ valueCents: price.cents })}>
                    {item.valueCents == null ? t`Use ${ph({ price: priceText(price) })} as its value` : t`Update its value to ${ph({ price: priceText(price) })}`}
                  </button>
                )}
                {canEdit && !hasPhoto && c.kind !== "coin" && (info.imageLarge || info.image) && (
                  <button type="button" className="btn btn-soft btn-sm" disabled={picture.isPending} onClick={() => picture.mutate()}>
                    <Trans>Add the catalog's picture</Trans>
                  </button>
                )}
                <CatalogLink info={info} />
              </div>
              {apply.isError && <p className="text-sm text-error">{apply.error.message}</p>}
              {picture.isError && <p className="text-sm text-error">{picture.error.message}</p>}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

/** A coin's issue (year and mint) and grade, which price it. */
export function CoinChoice({ info, issue, grade, busy, onChange }: { info: CollectibleInfo; issue: string | null; grade: CoinGrade | null; busy?: boolean; onChange: (issue: string | null, grade: CoinGrade | null) => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      {/* A coin's issues are a short list of its years and mints. */}
      <select className="select select-sm w-auto max-w-full" value={issue ?? ""} disabled={busy || !info.issues} onChange={(e) => onChange(e.target.value || null, grade)} aria-label={t`Year and mint`}>
        <option value="">{info.issues ? t`Year and mint…` : t`Loading…`}</option>
        {(info.issues ?? []).map((i) => (
          <option key={i.id} value={i.id}>{i.label}</option>
        ))}
      </select>
      <select className="select select-sm w-auto max-w-full" value={grade ?? ""} disabled={busy} onChange={(e) => onChange(issue, (e.target.value || null) as CoinGrade | null)} aria-label={t`Grade`}>
        <option value="">{t`Grade…`}</option>
        {COIN_GRADES.map((g) => (
          <option key={g} value={g}>{t(GRADE_NAMES[g])}</option>
        ))}
      </select>
    </div>
  );
}
