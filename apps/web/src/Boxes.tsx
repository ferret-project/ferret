/**
 * Boxes on their own page: what's inside (add, put in, take out). Boxes and
 * places show their QR label as a LabelBadge beside their name, which opens
 * LabelDialog to see, print, take off or provision one.
 */
import type { ItemListing, LabelTarget, OwnLabel } from "@ferret/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { type Choice, ItemPicker } from "./Combobox";
import { api } from "./lib/api";
import { useCanEdit } from "./lib/auth";
import { itemHref, printLabelsHref, scanRoomHref } from "./lib/route";
import { useRoomScanOn } from "./lib/room-scan";
import { QrCode, labelUrl } from "./Labels";
import { Modal } from "./Modal";
import { Scanner } from "./Scanner";
import { AddFromPhotos } from "./PhotoAdd";

export function BoxContents({ box, householdId }: { box: ItemListing; householdId: string }) {
  const qc = useQueryClient();
  const canEdit = useCanEdit(householdId);
  const roomScanOn = useRoomScanOn(householdId);
  const contents = useQuery({
    queryKey: ["items", householdId, "in", box.id],
    queryFn: () => api.listItems("", { containerItemId: box.id, limit: 200 }),
  });
  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ["items", householdId] }),
      qc.invalidateQueries({ queryKey: ["item", householdId] }),
      qc.invalidateQueries({ queryKey: ["places", householdId] }),
    ]);
  const add = useMutation({ mutationFn: (name: string) => api.createItem({ name, containerItemId: box.id }), onSuccess: refresh });
  const putIn = useMutation({ mutationFn: (id: string) => api.updateItem(id, { containerItemId: box.id }), onSuccess: refresh });
  const takeOut = useMutation({ mutationFn: (id: string) => api.updateItem(id, { containerItemId: null }), onSuccess: refresh });
  const [picked, setPicked] = useState<Choice | null>(null);
  const error = add.error ?? putIn.error ?? takeOut.error;

  function onAdd(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const name = String(new FormData(form).get("name")).trim();
    if (name) add.mutate(name, { onSuccess: () => form.reset() });
  }

  const list = contents.data?.data ?? [];
  return (
    <section className="flex flex-col gap-3" aria-labelledby="box-contents">
      <h2 id="box-contents" className="flex items-center gap-2 font-semibold text-base-content">
        <span className="icon-[tabler--package] size-5 text-primary" />
        Inside
        {list.length > 0 && <span className="badge badge-soft badge-primary badge-sm">{list.length}</span>}
      </h2>

      {canEdit && (
        <div className="card">
          <div className="card-body gap-3 p-4">
            <form className="flex flex-wrap gap-2" onSubmit={onAdd}>
              <input name="name" className="input min-w-40 flex-1" placeholder={`Add to ${box.name}…`} required />
              <button className="btn btn-primary" disabled={add.isPending}>
                Add
              </button>
              <AddFromPhotos householdId={householdId} containerItemId={box.id} />
              {roomScanOn && (
                <a href={scanRoomHref({ containerItemId: box.id })} className="btn btn-soft btn-primary btn-wrap">
                  <span className="icon-[tabler--scan-eye] size-5" />
                  Scan what's inside
                </a>
              )}
            </form>
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <ItemPicker
                  householdId={householdId}
                  id="put-in"
                  name="putIn"
                  label="Or put something already in Ferret in it"
                  value={picked}
                  onChange={setPicked}
                  exclude={[box.id, ...list.map((i) => i.id)]}
                />
              </div>
              <button
                type="button"
                className="btn btn-soft btn-primary"
                disabled={!picked || putIn.isPending}
                onClick={() => picked && putIn.mutate(picked.id, { onSuccess: () => setPicked(null) })}
              >
                Put in
              </button>
            </div>
            {error && <div className="alert alert-soft alert-error text-sm">{error.message}</div>}
          </div>
        </div>
      )}

      {list.length === 0 ? (
        <p className="text-sm text-base-content/70">Empty.</p>
      ) : (
        <ul className="card divide-y divide-base-content/10">
          {list.map((it) => (
            <li key={it.id} className="flex items-center gap-3 px-4 py-2">
              <a href={itemHref(it.id)} className="flex min-w-0 flex-1 items-center gap-3">
                {it.photoId ? (
                  <img src={api.thumbnailUrl(it.photoId)} alt="" loading="lazy" className="size-10 shrink-0 rounded-field object-cover" />
                ) : (
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-field bg-base-200 text-base-content/40">
                    <span className={`${it.isContainer ? "icon-[tabler--package]" : "icon-[tabler--box]"} size-5`} />
                  </span>
                )}
                <span className="min-w-0">
                  <span className="block truncate text-base-content">{it.name}</span>
                  <span className="block truncate text-xs text-base-content/70">
                    {it.isContainer ? `${it.contents} inside` : [it.brand, it.quantity !== 1 ? `×${it.quantity}` : null].filter(Boolean).join(" · ")}
                  </span>
                </span>
              </a>
              {canEdit && (
                <button type="button" className="btn btn-text btn-sm" disabled={takeOut.isPending} onClick={() => takeOut.mutate(it.id)}>
                  Take out
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * An item's, box's or place's QR label as a small badge beside its name ("▦ EWAWS7"), or "+ QR label" for editors when
 * it has none. An item with only a label someone brought (an asset tag) shows that. Tapping it opens LabelDialog to
 * see, print, take off or provision one — a new label, a blank one you've printed, or any sticker you already have.
 */
export function LabelBadge({
  target,
  code,
  ownLabels = [],
  name,
  householdId,
}: {
  target: LabelTarget;
  code: string | null;
  ownLabels?: OwnLabel[];
  name: string;
  householdId: string;
}) {
  const canEdit = useCanEdit(householdId);
  const [open, setOpen] = useState(false);
  const shown = code ?? ownLabels[0]?.code ?? null;
  if (!shown && !canEdit) return null;
  return (
    <>
      <button
        type="button"
        className={`tap badge badge-soft max-w-48 gap-1 font-mono ${shown ? "badge-primary" : "border border-dashed border-base-content/30 font-sans text-base-content/70"}`}
        onClick={() => setOpen(true)}
        aria-label={shown ? `Label ${shown} — show, print or change` : `Give ${name} a QR label`}
      >
        <span className={`${code ? "icon-[tabler--qrcode]" : shown ? "icon-[tabler--tag]" : "icon-[tabler--plus]"} size-4 shrink-0`} />
        <span className="truncate">{shown ?? "QR label"}</span>
      </button>
      {open && (
        <LabelDialog target={target} code={code} ownLabels={ownLabels} name={name} householdId={householdId} canEdit={canEdit} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

/** "Already on Tent" — with a link to it, when the server says which. */
function InUse({ error }: { error: Error & { details?: unknown } }) {
  const holder = error.details as { itemId?: string; name?: string } | undefined;
  return (
    <p className="text-sm text-error">
      {error.message}
      {holder?.itemId && (
        <>
          {" "}
          — <a href={itemHref(holder.itemId)} className="link tap">open {holder.name ?? "it"}</a>
        </>
      )}
    </p>
  );
}

function LabelDialog(props: {
  target: LabelTarget;
  code: string | null;
  ownLabels: OwnLabel[];
  name: string;
  householdId: string;
  canEdit: boolean;
  onClose: () => void;
}) {
  const { target, name, householdId, canEdit, onClose } = props;
  const qc = useQueryClient();
  // The label shown: the one it had, or one just made or attached here.
  const [code, setCode] = useState(props.code);
  const [own, setOwn] = useState(props.ownLabels);
  const [confirmOff, setConfirmOff] = useState(false);
  const [removing, setRemoving] = useState<OwnLabel | null>(null);
  const [scanning, setScanning] = useState(false);
  const refresh = () =>
    Promise.all([["labels"], ["items"], ["item"]].map((key) => qc.invalidateQueries({ queryKey: [...key, householdId] })));
  const make = useMutation({
    mutationFn: () => api.labelFor(target),
    onSuccess: (l) => {
      setCode(l.code);
      return refresh();
    },
  });
  const attach = useMutation({
    mutationFn: (typed: string) => api.attachLabel(typed, target),
    onSuccess: (r) => {
      if ("label" in r) setCode(r.label.code);
      else setOwn((o) => (o.some((x) => x.id === r.ownLabel.id) ? o : [...o, r.ownLabel]));
      return refresh();
    },
  });
  const takeOff = useMutation({
    mutationFn: () => api.clearLabel(code!),
    onSuccess: () => {
      setCode(null);
      setConfirmOff(false);
      return refresh();
    },
  });
  const removeOwn = useMutation({
    mutationFn: (l: OwnLabel) => api.removeOwnLabel(l.id),
    onSuccess: (_, l) => {
      setOwn((o) => o.filter((x) => x.id !== l.id));
      setRemoving(null);
      return refresh();
    },
  });

  function onAttach(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const typed = String(new FormData(form).get("code")).trim();
    if (typed) attach.mutate(typed, { onSuccess: () => form.reset() });
  }

  if (scanning) {
    return (
      <Scanner
        onClose={() => setScanning(false)}
        onResult={(scanned) => {
          setScanning(false);
          attach.mutate(scanned);
        }}
      />
    );
  }

  const forItem = Boolean(target.itemId);
  const useOne = canEdit && (
    <form className="flex flex-col gap-2" onSubmit={onAttach}>
      <label className="label-text" htmlFor="blank-code">
        {forItem ? "Use a label you already have — a blank one you've printed, or an asset tag or sticker" : "Use a blank label you've printed — type its code"}
      </label>
      <div className="flex flex-wrap gap-2">
        <input
          id="blank-code"
          name="code"
          className="input min-w-0 grow basis-40 font-mono"
          placeholder={forItem ? "e.g. 7HQ2MX or ASSET-0042" : "e.g. 7HQ2MX"}
          maxLength={500}
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          required
        />
        <button type="submit" className="btn btn-soft btn-primary" disabled={attach.isPending}>
          Use it
        </button>
        <button type="button" className="btn btn-soft" onClick={() => setScanning(true)}>
          <span className="icon-[tabler--scan] size-5" />
          Scan it
        </button>
      </div>
      {attach.isError && <InUse error={attach.error} />}
    </form>
  );

  return (
    <Modal id="qr-label" title={`Labels · ${name}`} onClose={onClose}>
      <div className="flex flex-col gap-5">
        {code ? (
          <div className="flex flex-col items-center gap-4 text-center">
            <QrCode value={labelUrl(code)} className="size-48 rounded-box border border-base-content/10 p-2" />
            <div>
              <p className="font-mono text-2xl font-bold tracking-wider text-base-content">{code}</p>
              <p className="text-sm text-base-content/70">Scan it with the camera to open {name}. Printing it again always gives the same code.</p>
            </div>
            <div className="flex flex-wrap justify-center gap-2">
              <a href={printLabelsHref([code])} className="btn btn-primary">
                <span className="icon-[tabler--printer] size-5" />
                Print
              </a>
              {canEdit && !confirmOff && (
                <button type="button" className="btn btn-text btn-error" onClick={() => setConfirmOff(true)}>
                  Take label off
                </button>
              )}
            </div>
            {confirmOff && (
              <div className="flex flex-col items-center gap-2 rounded-box bg-base-200 p-3 text-sm">
                <p>A printed {code} will stop opening {name} (it becomes a blank label you can use somewhere else).</p>
                <div className="flex gap-2">
                  <button type="button" className="btn btn-error btn-sm" disabled={takeOff.isPending} onClick={() => takeOff.mutate()}>
                    Take it off
                  </button>
                  <button type="button" className="btn btn-text btn-sm" onClick={() => setConfirmOff(false)}>
                    Keep
                  </button>
                </div>
              </div>
            )}
            {takeOff.isError && <p className="text-sm text-error">{takeOff.error.message}</p>}
          </div>
        ) : (
          <>
            <p className="text-base-content/70">
              Stick a QR label on {name}: scanning it with a phone's camera opens {name} in Ferret{target.locationId ? ", with everything kept there" : ""}.
            </p>
            {canEdit && (
              <button type="button" className="btn btn-primary" disabled={make.isPending} onClick={() => make.mutate()}>
                {make.isPending ? <span className="loading loading-spinner loading-sm" /> : <span className="icon-[tabler--qrcode] size-5" />}
                Make a new label
              </button>
            )}
            {make.isError && <p className="text-sm text-error">{make.error.message}</p>}
          </>
        )}

        {own.length > 0 && (
          <section className="flex flex-col gap-2" aria-labelledby="own-labels">
            <h3 id="own-labels" className="text-sm font-medium text-base-content">
              Its own labels
            </h3>
            <ul className="flex flex-col gap-1">
              {own.map((l) => (
                <li key={l.id} className="flex items-center gap-2 rounded-field bg-base-200 px-3 py-1">
                  <span className="icon-[tabler--tag] size-4 shrink-0 text-base-content/70" />
                  <span className="min-w-0 grow truncate font-mono text-sm">{l.code}</span>
                  {canEdit &&
                    (removing?.id === l.id ? (
                      <span className="flex shrink-0 gap-1">
                        <button type="button" className="btn btn-error btn-xs" disabled={removeOwn.isPending} onClick={() => removeOwn.mutate(l)}>
                          Take off
                        </button>
                        <button type="button" className="btn btn-text btn-xs" onClick={() => setRemoving(null)}>
                          Keep
                        </button>
                      </span>
                    ) : (
                      <button type="button" className="btn btn-text btn-xs" aria-label={`Take label ${l.code} off`} onClick={() => setRemoving(l)}>
                        Take off
                      </button>
                    ))}
                </li>
              ))}
            </ul>
            <p className="text-xs text-base-content/70">Scanning one of these opens {name} too.</p>
            {removeOwn.isError && <p className="text-sm text-error">{removeOwn.error.message}</p>}
          </section>
        )}

        {canEdit && (!code || forItem) && (
          <>
            <div className="divider my-0 text-xs text-base-content/70">{code ? "also" : "or"}</div>
            {useOne}
          </>
        )}
      </div>
    </Modal>
  );
}
