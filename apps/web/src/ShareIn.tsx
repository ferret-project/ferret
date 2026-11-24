/**
 * #/share — what another app shared to Ferret (Android's and Chrome's Share menu; the manifest's share_target). The
 * service worker (public/sw.js) keeps the shared link, text and files in the "ferret-share" cache and opens the app
 * here; it becomes a new thing (named from the shared title, the link among its links, photos as photos and PDFs as
 * documents) or goes onto something already in Ferret. Done or discarded, the cache is cleared.
 *
 * `#/share?url=…&title=…&text=…` works too (no files): a bookmarklet or another tool can open it.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { type Choice, ItemPicker, PlacePicker } from "./Combobox";
import { HelpLink } from "./HelpLink";
import { siteOf } from "./Links";
import { TopBar } from "./Nav";
import { api } from "./lib/api";
import { useCanEdit } from "./lib/auth";
import { navigateTo } from "./lib/navigate";
import { HOME_HREF, itemHref } from "./lib/route";
import { t, ph, plural } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";

const CACHE = "ferret-share";

interface SharedFile {
  file: File;
  kind: "photo" | "document";
}
export interface Shared {
  title: string;
  text: string;
  url: string;
  files: SharedFile[];
}

const URL_IN_TEXT = /https?:\/\/[^\s<>"]+/i;
const PHOTO_TYPES = /^image\/(jpeg|png|webp|avif|heic|heif|gif)$/;

/**
 * Apps share in their own ways: the link in `url`, or in `text` ("Look at this https://…"), the page's name in `title`
 * or in front of the link. Out of that: one link, a name for the thing, and any other words (kept as its note).
 */
export function readShared(input: { title?: string; text?: string; url?: string }): { url: string | null; name: string; note: string } {
  const title = (input.title ?? "").trim();
  let text = (input.text ?? "").trim();
  let url = (input.url ?? "").trim();
  if (!/^https?:\/\//i.test(url)) url = "";
  if (!url) {
    const found = text.match(URL_IN_TEXT)?.[0];
    if (found) url = found.replace(/[).,;!?]+$/, "");
  }
  if (url) text = text.replace(url, "").trim();
  try {
    if (url) url = new URL(url).href;
  } catch {
    url = "";
  }
  // The text is often just the title again, or the title and a dash.
  text = text.replace(/^[\s\-–—:|]+|[\s\-–—:|]+$/g, "");
  if (title && text.startsWith(title)) text = text.slice(title.length).replace(/^[\s\-–—:|]+/, "");
  const firstLine = text.split("\n")[0]!.trim();
  const name = (title || (firstLine.length <= 120 ? firstLine : "") || "").slice(0, 200);
  const note = name === firstLine ? text.split("\n").slice(1).join("\n").trim() : text;
  return { url: url || null, name, note: note.slice(0, 2000) };
}

/** What the service worker kept; null when nothing was shared (or this browser has no service worker cache). */
async function readCache(): Promise<Shared | null> {
  if (!("caches" in window) || !(await caches.has(CACHE))) return null;
  const cache = await caches.open(CACHE);
  const list = await cache.match("/share-target/shared");
  if (!list) return null;
  const kept = (await list.json()) as { title: string; text: string; url: string; files: { at: string; name: string; type: string }[] };
  const files: SharedFile[] = [];
  for (const f of kept.files) {
    const res = await cache.match(f.at);
    if (!res) continue;
    const file = new File([await res.blob()], f.name, { type: f.type });
    if (PHOTO_TYPES.test(f.type)) files.push({ file, kind: "photo" });
    else if (f.type === "application/pdf") files.push({ file, kind: "document" });
  }
  return { title: kept.title, text: kept.text, url: kept.url, files };
}

const clearCache = () => ("caches" in window ? caches.delete(CACHE).then(() => {}) : Promise.resolve());

export function ShareIn({ householdId, search }: { householdId: string; search: { url?: string; title?: string; text?: string; failed?: string } }) {
  const qc = useQueryClient();
  const canEdit = useCanEdit(householdId);
  const fromAddress = Boolean(search.url || search.title || search.text);
  const kept = useQuery({
    queryKey: ["share-in", fromAddress ? search : "cache"],
    queryFn: async (): Promise<Shared | null> =>
      fromAddress ? { title: search.title ?? "", text: search.text ?? "", url: search.url ?? "", files: [] } : readCache(),
    staleTime: Infinity,
    gcTime: 0,
  });
  const shared = kept.data ?? null;
  const read = useMemo(() => (shared ? readShared(shared) : null), [shared]);

  const [mode, setMode] = useState<"new" | "existing">("new");
  const [name, setName] = useState("");
  const [place, setPlace] = useState<string | null>(null);
  const [item, setItem] = useState<Choice | null>(null);
  useEffect(() => {
    if (read) setName(read.name || (read.url ? siteOf(read.url) : ""));
  }, [read]);

  const previews = useMemo(() => shared?.files.map((f) => (f.kind === "photo" ? URL.createObjectURL(f.file) : null)) ?? [], [shared]);
  useEffect(() => () => previews.forEach((p) => p && URL.revokeObjectURL(p)), [previews]);

  const add = useMutation({
    mutationFn: async () => {
      if (!shared || !read) throw new Error(t`Nothing was shared`);
      let id: string;
      if (mode === "new") {
        const created = await api.createItem({
          name: name.trim() || t`New item`,
          locationId: place,
          description: read.note || null,
          links: read.url ? [{ url: read.url }] : [],
          origin: "shared",
        });
        id = created.id;
      } else {
        if (!item) throw new Error(t`Choose which thing first`);
        id = item.id;
        if (read.url) {
          const current = await api.getItem(id);
          const links = current.links ?? [];
          if (!links.some((l) => l.url === read.url)) {
            if (links.length >= 10) throw new Error(t`That thing already has 10 links — remove one first`);
            await api.updateItem(id, { links: [...links, { url: read.url }] });
          }
        }
      }
      const failed: string[] = [];
      for (const f of shared.files) {
        try {
          await api.uploadAttachment(id, f.file, f.kind, () => {});
        } catch (err) {
          failed.push(`${f.file.name}: ${(err as Error).message}`);
        }
      }
      return { id, failed };
    },
    onSuccess: async ({ id, failed }) => {
      void qc.invalidateQueries({ queryKey: ["items", householdId] });
      void qc.invalidateQueries({ queryKey: ["overview", householdId] });
      if (failed.length) return; // stays here, saying which didn't go up
      await clearCache();
      navigateTo(itemHref(id), { replace: true });
    },
  });

  const discard = async () => {
    await clearCache();
    navigateTo(HOME_HREF, { replace: true });
  };

  const empty = kept.isSuccess && (!shared || (!read?.url && !read?.name && !read?.note && shared.files.length === 0));
  const photos = shared?.files.filter((f) => f.kind === "photo").length ?? 0;
  const documents = (shared?.files.length ?? 0) - photos;

  return (
    <div className="min-h-dvh bg-base-200">
      <TopBar title={<Trans>Shared to Ferret</Trans>} back={HOME_HREF} help={<HelpLink page="guide/phone.html#share-to-ferret" label={t`Share to Ferret`} />} />
      <main className="mx-auto flex max-w-xl flex-col gap-4 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        {kept.isPending && (
          <div className="flex justify-center p-8">
            <span className="loading loading-spinner loading-lg text-primary" />
          </div>
        )}
        {search.failed && <div className="alert alert-soft alert-error text-sm"><Trans>Ferret couldn't keep what was shared. Try sharing it again.</Trans></div>}
        {empty && !search.failed && (
          <div className="card">
            <div className="card-body gap-2">
              <p><Trans>Nothing is waiting here.</Trans></p>
              <p className="text-sm text-base-content/70">
                <Trans>
                  On Android, or in Chrome on a computer, with Ferret installed: tap Share in a shop's app, a web page, your photos or a
                  PDF, and choose Ferret. It opens here, ready to add as a new thing or onto one you have.
                </Trans>
              </p>
            </div>
          </div>
        )}
        {shared && read && !empty && (
          <>
            <section className="card" aria-label={t`What was shared`}>
              <div className="card-body gap-3">
                {read.url && (
                  <p className="flex min-w-0 items-center gap-2">
                    <span className="icon-[tabler--link] size-5 shrink-0 text-primary" />
                    <a href={read.url} target="_blank" rel="noreferrer noopener" className="link link-primary truncate" title={read.url}>
                      {siteOf(read.url)}
                    </a>
                  </p>
                )}
                {read.note && <p className="whitespace-pre-line text-sm text-base-content/70">{read.note}</p>}
                {shared.files.length > 0 && (
                  <>
                    <p className="text-sm text-base-content/70">
                      {photos > 0 && documents > 0
                        ? t`${plural(photos, { one: "# photo", other: "# photos" })} and ${plural(documents, { one: "# document", other: "# documents" })}`
                        : photos > 0
                          ? plural(photos, { one: "# photo", other: "# photos" })
                          : plural(documents, { one: "# document", other: "# documents" })}
                    </p>
                    <ul className="flex flex-wrap gap-2">
                      {shared.files.map((f, i) => (
                        <li key={i} className="size-20 overflow-hidden rounded-box bg-base-200">
                          {previews[i] ? (
                            <img src={previews[i]!} alt={f.file.name} className="size-full object-cover" />
                          ) : (
                            <span className="flex size-full flex-col items-center justify-center gap-1 p-1 text-center text-xs">
                              <span className="icon-[tabler--file-type-pdf] size-7 text-primary" />
                              <span className="w-full truncate">{f.file.name}</span>
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            </section>

            {!canEdit ? (
              <div className="alert alert-soft alert-info text-sm"><Trans>You can look but not add things in this household.</Trans></div>
            ) : (
              <section className="card">
                <div className="card-body gap-3">
                  <div className="join w-full" role="radiogroup" aria-label={t`Where it goes`}>
                    {(
                      [
                        ["new", t`A new thing`],
                        ["existing", t`Something in Ferret`],
                      ] as const
                    ).map(([m, text]) => (
                      <input
                        key={m}
                        type="radio"
                        name="share-mode"
                        aria-label={text}
                        className="join-item btn btn-soft btn-primary h-auto min-h-11 flex-1 py-1"
                        checked={mode === m}
                        onChange={() => setMode(m)}
                      />
                    ))}
                  </div>
                  {mode === "new" ? (
                    <>
                      <div>
                        <label className="label-text" htmlFor="share-name">
                          <Trans>Name</Trans>
                        </label>
                        <input id="share-name" className="input" maxLength={200} value={name} placeholder={t`New item`} onChange={(e) => setName(e.target.value)} />
                      </div>
                      <PlacePicker householdId={householdId} id="share-place" name="locationId" label={t`Where it is`} value={place} onChange={setPlace} noneLabel={t`Not decided yet`} />
                    </>
                  ) : (
                    <ItemPicker householdId={householdId} id="share-item" name="itemId" label={t`Which one`} value={item} onChange={setItem} />
                  )}
                  {add.isError && <div className="alert alert-soft alert-error text-sm">{add.error.message}</div>}
                  {add.data?.failed.length ? (
                    <div className="alert alert-soft alert-warning flex-col items-start text-sm">
                      <p><Trans>Added, but some files didn't go up:</Trans></p>
                      <ul className="list-disc ps-5">
                        {add.data.failed.map((f) => (
                          <li key={f}>{f}</li>
                        ))}
                      </ul>
                      <a className="link" href={itemHref(add.data.id)} onClick={() => void clearCache()}>
                        <Trans>Open it</Trans>
                      </a>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={add.isPending || (mode === "existing" && !item)}
                      onClick={() => add.mutate()}
                    >
                      {add.isPending && <span className="loading loading-spinner loading-sm" />}
                      {mode === "new" ? t`Add it` : item ? t`Add to ${ph({ name: item.label })}` : t`Add to it`}
                    </button>
                  )}
                  <button type="button" className="btn btn-text btn-sm self-center" disabled={add.isPending} onClick={() => void discard()}>
                    <Trans>Discard</Trans>
                  </button>
                </div>
              </section>
            )}
          </>
        )}
      </main>
    </div>
  );
}
