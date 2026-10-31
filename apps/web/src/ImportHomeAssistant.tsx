/**
 * Import from Home Assistant: its address and a long-lived token (used once, for this read — never stored; the
 * address is remembered on this device), then:
 * - Rooms: every HA area becomes a place — "Main › Kitchen" under its floor, or one you already have — things in it or
 *   not. A floor can be its own property (a workshop). Places remember their area, so a re-import finds them again.
 * - Devices: duplicates already folded together (server: lib/home-assistant.ts); the ticked ones become items.
 * - Run again later: new rooms and devices are offered, and what HA changed since (names, makers, rooms) is listed to
 *   take or leave; things whose device has gone from HA are listed too.
 */
import { Steps } from "./Steps";
import type { HaChange, HaDevice, HaRegistryView, ImportPlace, ImportRow, LocationNode } from "@ferret/shared";
import { useMutation } from "@tanstack/react-query";
import { type FormEvent, useMemo, useRef, useState } from "react";
import { PlacePicker } from "./Combobox";
import { type ImportPart, ImportStatus, useImportRun } from "./Import";
import { api } from "./lib/api";
import { usePlaces } from "./lib/places";
import { itemHref } from "./lib/route";

const URL_KEY = "ferret.homeAssistant.url";
const NO_AREA = "";

const remembered = () => {
  try {
    return localStorage.getItem(URL_KEY) ?? "";
  } catch {
    return "";
  }
};

export function ImportHomeAssistant({ householdId }: { householdId: string }) {
  const [url, setUrl] = useState(remembered);
  const [token, setToken] = useState("");
  const read = useMutation({
    mutationFn: () => api.homeAssistantDevices({ url: url.trim(), token: token.trim() }),
    onSuccess: () => {
      setToken(""); // not kept, even in this page
      try {
        localStorage.setItem(URL_KEY, url.trim());
      } catch {
        /* private browsing */
      }
    },
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    read.mutate();
  }

  if (read.data) return <Choose householdId={householdId} view={read.data} onBack={() => read.reset()} />;
  return (
    <>
    <HaSteps current={0} />
    <section className="card">
      <form className="card-body gap-4" onSubmit={onSubmit}>
        <p className="text-base-content/80">
          Ferret reads Home Assistant's rooms and devices once — the appliances, TVs, speakers, thermostats and network gear it knows —
          and you choose which become items. Nothing is changed in Home Assistant.
        </p>
        <div>
          <label className="label-text" htmlFor="ha-url">
            Home Assistant's address
          </label>
          <input id="ha-url" className="input" type="url" inputMode="url" required value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://homeassistant.local:8123" autoComplete="url" />
        </div>
        <div>
          <label className="label-text" htmlFor="ha-token">
            Long-lived access token
          </label>
          <input id="ha-token" className="input font-mono" type="password" required value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" spellCheck={false} />
          <p className="mt-1 text-sm text-base-content/70">
            In Home Assistant: your profile → Security → Long-lived access tokens → Create token (an administrator's). Ferret uses it for
            this one read and doesn't keep it — delete the token in Home Assistant afterwards if you like.
          </p>
        </div>
        {read.isError && <div className="alert alert-soft alert-error">{read.error.message}</div>}
        <div>
          <button type="submit" className="btn btn-primary" disabled={read.isPending}>
            {read.isPending ? <span className="loading loading-spinner loading-sm" /> : <span className="icon-[tabler--plug-connected] size-5" />}
            Read devices
          </button>
        </div>
      </form>
    </section>
    </>
  );
}

type AreaChoice = { mode: "new" } | { mode: "existing"; locationId: string | null } | { mode: "none" };
/** Where a floor's rooms go: the home, its own new property (named after the floor), or another property. */
type FloorTarget = { kind: "home" } | { kind: "own" } | { kind: "property"; id: string };

/** Areas people use for "not a room" (e.g. "ignore", "Other"): unticked to start with. */
const NOT_A_ROOM = /^(ignore|other|none|unassigned|misc)$/i;
const FIELD_NAMES: Record<HaChange["field"], string> = { name: "Name", brand: "Maker", model: "Model", serialNumber: "Serial number", area: "Room" };

const HaSteps = ({ current }: { current: number }) => (
  <Steps label="Import steps" steps={[{ label: "Connect" }, { label: "Choose rooms and things" }, { label: "Import" }]} current={current} />
);

function flatten(nodes: LocationNode[], out: LocationNode[] = []) {
  for (const n of nodes) {
    out.push(n);
    flatten(n.children, out);
  }
  return out;
}

function Choose({ householdId, view, onBack }: { householdId: string; view: HaRegistryView; onBack: () => void }) {
  const places = usePlaces(householdId);
  const properties = places.data?.properties ?? [];
  // The home: chosen, or where most rooms went last time (not a workshop that's its own property), or the first.
  const roomsIn = new Map<string, number>();
  for (const a of view.areas) {
    const pid = a.locationId ? properties.find((p) => flatten(p.locations).some((l) => l.id === a.locationId))?.id : undefined;
    if (pid) roomsIn.set(pid, (roomsIn.get(pid) ?? 0) + 1);
  }
  const usual = [...roomsIn.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const [homeId, setHomeId] = useState<string | null>(null);
  const home = properties.find((p) => p.id === homeId) ?? properties.find((p) => p.id === usual) ?? properties[0];
  const [newHome, setNewHome] = useState("Home");
  const [byFloor, setByFloor] = useState(view.floors.length > 0);
  const [floorTargets, setFloorTargets] = useState<Record<string, FloorTarget>>({});
  const [choices, setChoices] = useState<Record<string, AreaChoice>>({});
  const [picked, setPicked] = useState<Set<string>>(() => new Set(view.devices.filter((d) => !d.virtual && !d.itemId).map((d) => d.id)));
  const changed = view.devices.filter((d) => d.itemId && d.changes.length);
  const [takeChanges, setTakeChanges] = useState<Set<string>>(() => new Set(changed.flatMap((d) => d.changes.map((c) => `${d.id}:${c.field}`))));
  const [filter, setFilter] = useState("");
  const { run, progress } = useImportRun(householdId);
  const sent = useRef<string[]>([]);

  const floors = new Map(view.floors.map((f) => [f.id, f]));
  const areas = new Map(view.areas.map((a) => [a.id, a]));
  const floorTarget = (floorId: string | null): FloorTarget => {
    if (!floorId) return { kind: "home" };
    if (floorTargets[floorId]) return floorTargets[floorId]!;
    const was = floors.get(floorId)?.propertyId;
    return was && was !== home?.id ? { kind: "property", id: was } : { kind: "home" };
  };
  const targetProperty = (t: FloorTarget) => (t.kind === "home" ? home : t.kind === "property" ? properties.find((p) => p.id === t.id) : undefined);
  const existingIn = useMemo(() => new Map(properties.map((p) => [p.id, flatten(p.locations)])), [properties]);
  const choiceFor = (areaId: string): AreaChoice | "mapped" => {
    const a = areas.get(areaId)!;
    if (a.locationId) return "mapped";
    if (choices[areaId]) return choices[areaId]!;
    const prop = targetProperty(floorTarget(a.floorId));
    const match = prop ? (existingIn.get(prop.id) ?? []).filter((l) => l.name.toLowerCase() === a.name.toLowerCase()) : [];
    if (match.length === 1) return { mode: "existing", locationId: match[0]!.id };
    return NOT_A_ROOM.test(a.name) ? { mode: "none" } : { mode: "new" };
  };
  const newPath = (areaId: string) => {
    const a = areas.get(areaId)!;
    const floor = a.floorId ? floors.get(a.floorId) : undefined;
    return byFloor && floor && floorTarget(a.floorId).kind === "home" ? `${floor.name} › ${a.name}` : a.name;
  };
  const willHavePlace = (areaId: string | null) => {
    if (!areaId || !areas.has(areaId)) return false;
    const c = choiceFor(areaId);
    return c === "mapped" || c.mode === "new" || (c.mode === "existing" && Boolean(c.locationId));
  };
  const pathOf = (locationId: string | null) =>
    properties.flatMap((p) => flatten(p.locations)).find((l) => l.id === locationId)?.path ?? null;

  const real = view.devices.filter((d) => !d.virtual);
  const virtual = view.devices.filter((d) => d.virtual);
  const words = filter.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (d: HaDevice) => !words.length || words.every((w) => [d.name, d.manufacturer, d.model, d.integration].join(" ").toLowerCase().includes(w));
  const areaKey = (d: HaDevice) => (d.areaId && areas.has(d.areaId) ? d.areaId : NO_AREA);
  const level = (areaId: string) => {
    const f = areas.get(areaId)?.floorId;
    return f ? (floors.get(f)?.level ?? 0) : 99;
  };
  const byLevel = (a: string, b: string) => (a === NO_AREA ? 1 : b === NO_AREA ? -1 : level(a) - level(b) || areas.get(a)!.name.localeCompare(areas.get(b)!.name));
  const groups = new Map<string, HaDevice[]>();
  for (const d of real.filter(matches)) groups.set(areaKey(d), [...(groups.get(areaKey(d)) ?? []), d]);
  const chosen = view.devices.filter((d) => picked.has(d.id) && !d.itemId);
  const newRooms = view.areas.filter((a) => {
    const c = choiceFor(a.id);
    return c !== "mapped" && c.mode !== "none";
  });
  const takenCount = changed.reduce((n, d) => n + d.changes.filter((c) => takeChanges.has(`${d.id}:${c.field}`) && canTake(d, c)).length, 0);
  const floorsShown = [...view.floors, { id: "", name: "No floor", level: 99, propertyId: null }].filter((f) => view.areas.some((a) => (a.floorId ?? "") === f.id));

  function canTake(d: HaDevice, c: HaChange) {
    return c.field !== "area" || willHavePlace(d.areaId);
  }

  const toggle = (ids: string[], on: boolean) => {
    const next = new Set(picked);
    for (const id of ids) {
      if (on) next.add(id);
      else next.delete(id);
    }
    setPicked(next);
  };

  function rowFor(d: HaDevice): ImportRow {
    return {
      name: d.name.slice(0, 200),
      brand: d.manufacturer,
      model: d.model,
      serialNumber: d.serialNumber,
      notes: `From Home Assistant${d.integration ? ` (${d.integration})` : ""}`,
      // Its area even when that's left out (no place): remembered, so a re-import knows it hasn't moved.
      haAreaId: d.areaId,
      links: d.configurationUrl ? [{ url: d.configurationUrl, label: "Its settings page" }] : undefined,
      haDeviceId: d.id,
    };
  }

  /** Properties made as needed (the home, a floor of its own), then one part per property. */
  async function parts(): Promise<ImportPart[]> {
    const made = new Map<string, string>();
    const homeProperty = home?.id ?? (await api.createProperty({ name: newHome.trim() || "Home" })).id;
    const propertyFor = async (floorId: string | null) => {
      const t = floorTarget(floorId);
      if (t.kind === "home") return homeProperty;
      if (t.kind === "property") return t.id;
      if (!made.has(floorId!)) made.set(floorId!, (await api.createProperty({ name: floors.get(floorId!)!.name })).id);
      return made.get(floorId!)!;
    };
    const byProperty = new Map<string, ImportPart>();
    const part = (propertyId: string) => {
      if (!byProperty.has(propertyId)) byProperty.set(propertyId, { propertyId, places: [], rows: [] });
      return byProperty.get(propertyId)!;
    };
    for (const a of [...view.areas].sort((x, y) => byLevel(x.id, y.id))) {
      const c = choiceFor(a.id);
      if (c === "mapped" || c.mode === "none") continue;
      const place: ImportPlace =
        c.mode === "existing"
          ? { locationId: c.locationId, haAreaId: a.id }
          : { path: newPath(a.id), haAreaId: a.id, haFloorId: byFloor && a.floorId && floorTarget(a.floorId).kind === "home" ? a.floorId : null };
      if (c.mode === "existing" && !c.locationId) continue;
      part(await propertyFor(a.floorId)).places!.push(place);
    }
    for (const d of chosen) part(d.areaId && areas.has(d.areaId) ? await propertyFor(areas.get(d.areaId)!.floorId) : homeProperty).rows.push(rowFor(d));
    // Rows in the order they were sent, so "not imported" can name them.
    sent.current = [...byProperty.values()].flatMap((p) => p.rows.map((r) => r.name));
    return [...byProperty.values()];
  }

  /** Every changed device: the ticked fields taken, and what HA says now remembered (ticked or not). */
  async function applyChanges() {
    if (!changed.length) return 0;
    const updates = changed.map((d) => {
      const take = (f: HaChange["field"]) => d.changes.some((c) => c.field === f && takeChanges.has(`${d.id}:${f}`) && canTake(d, c));
      return {
        itemId: d.itemId!,
        ...(take("name") ? { name: d.name.slice(0, 200) } : {}),
        ...(take("brand") ? { brand: d.manufacturer } : {}),
        ...(take("model") ? { model: d.model } : {}),
        ...(take("serialNumber") ? { serialNumber: d.serialNumber } : {}),
        ...(take("area") && d.areaId ? { haAreaId: d.areaId } : {}),
        snapshot: { name: d.name.slice(0, 200), manufacturer: d.manufacturer, model: d.model, serialNumber: d.serialNumber, areaId: d.areaId },
      };
    });
    return (await api.applyHomeAssistant({ updates })).updated;
  }

  if (run.isPending || run.isSuccess) {
    return (
      <>
        <HaSteps current={run.isSuccess ? 3 : 2} />
        <ImportStatus run={run} progress={progress} describe={(n) => sent.current[n] ?? "?"} />
      </>
    );
  }

  const deviceRow = (d: HaDevice) => (
    <li key={d.id}>
      <label className={`flex items-start gap-3 py-2 ${d.itemId ? "" : "cursor-pointer"}`}>
        <input type="checkbox" className="checkbox checkbox-primary mt-1" checked={Boolean(d.itemId) || picked.has(d.id)} disabled={Boolean(d.itemId)} onChange={(e) => toggle([d.id], e.target.checked)} />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{d.name}</span>
          <span className="block truncate text-sm text-base-content/70">
            {[[d.manufacturer, d.model].filter(Boolean).join(" "), d.integration, d.alsoIds.length ? `seen ${d.alsoIds.length + 1} times in HA` : null].filter(Boolean).join(" · ") || "\u00a0"}
          </span>
        </span>
        {d.itemId && (
          <a href={itemHref(d.itemId)} className="badge badge-soft badge-success tap shrink-0">
            In Ferret
          </a>
        )}
      </label>
    </li>
  );

  const summary = [
    newRooms.length && `${newRooms.length} ${newRooms.length === 1 ? "room" : "rooms"}`,
    chosen.length && `${chosen.length} ${chosen.length === 1 ? "device" : "devices"}`,
    takenCount && `${takenCount} ${takenCount === 1 ? "change" : "changes"}`,
  ].filter(Boolean);

  return (
    <>
    <HaSteps current={1} />
    <>
      <section className="card">
        <div className="card-body gap-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <p className="min-w-0 flex-1 text-base-content/80">
              {view.areas.length} rooms and {real.length} devices in Home Assistant
              {view.hidden + virtual.length > 0 ? ` (and ${view.hidden + virtual.length} that are probably software or services)` : ""}.
            </p>
            <button type="button" className="btn btn-text btn-sm" onClick={onBack}>
              Start again
            </button>
          </div>
          {places.data && !properties.length && (
            <div>
              <label className="label-text" htmlFor="ha-new-home">
                Your home's name
              </label>
              <input id="ha-new-home" className="input" value={newHome} onChange={(e) => setNewHome(e.target.value)} maxLength={120} />
              <p className="mt-1 text-sm text-base-content/70">Ferret makes it, and the rooms go in it.</p>
            </div>
          )}
          {properties.length > 1 && (
            <div>
              <label className="label-text" htmlFor="ha-property">
                Rooms go in
              </label>
              <select id="ha-property" className="select" value={home?.id ?? ""} onChange={(e) => setHomeId(e.target.value)}>
                {properties.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          {view.floors.length > 0 && (
            <label className="flex cursor-pointer items-center gap-3">
              <input type="checkbox" className="switch switch-primary" checked={byFloor} onChange={(e) => setByFloor(e.target.checked)} />
              <span>New rooms go under their floor</span>
            </label>
          )}
        </div>
      </section>

      {(changed.length > 0 || view.removed.length > 0) && (
        <section className="card" aria-labelledby="ha-changes">
          <div className="card-body gap-3">
            <h2 id="ha-changes" className="card-title text-base">
              Changed in Home Assistant since the last import
            </h2>
            {changed.length > 0 && (
              <>
                <p className="text-sm text-base-content/70">Ticked changes are made in Ferret; unticked ones are left as they are, and not offered again.</p>
                <ul className="divide-y divide-base-content/10">
                  {changed.map((d) => (
                    <li key={d.id} className="py-2">
                      <a href={itemHref(d.itemId!)} className="link link-hover font-medium">
                        {d.changes.find((c) => c.field === "name")?.ferret ?? d.name}
                      </a>
                      <ul className="mt-1 space-y-1">
                        {d.changes.map((c) => {
                          const k = `${d.id}:${c.field}`;
                          const ok = canTake(d, c);
                          return (
                            <li key={k}>
                              <label className={`flex items-start gap-3 ${ok ? "cursor-pointer" : "opacity-70"}`}>
                                <input
                                  type="checkbox"
                                  className="checkbox checkbox-primary checkbox-sm mt-0.5"
                                  checked={ok && takeChanges.has(k)}
                                  disabled={!ok}
                                  onChange={(e) => {
                                    const next = new Set(takeChanges);
                                    if (e.target.checked) next.add(k);
                                    else next.delete(k);
                                    setTakeChanges(next);
                                  }}
                                />
                                <span className="min-w-0 text-sm">
                                  {FIELD_NAMES[c.field]}: <span className="text-base-content/70 line-through">{c.ferret ?? "none"}</span> → {c.ha ?? "none"}
                                  {!ok && <span className="block text-base-content/70">Tick its room under Rooms to move it there.</span>}
                                </span>
                              </label>
                            </li>
                          );
                        })}
                      </ul>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {view.removed.length > 0 && (
              <details className="rounded-box bg-base-200 p-3">
                <summary className="cursor-pointer font-medium">No longer in Home Assistant ({view.removed.length})</summary>
                <p className="mt-1 text-sm text-base-content/70">
                  Replaced, sold, or just taken out of Home Assistant? Open one and use Edit → No longer have it? if it's gone.
                </p>
                <ul className="mt-2 space-y-1">
                  {view.removed.map((r) => (
                    <li key={r.itemId}>
                      <a href={itemHref(r.itemId)} className="link tap">
                        {r.name}
                      </a>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        </section>
      )}

      <section className="card" aria-labelledby="ha-rooms">
        <div className="card-body gap-3">
          <h2 id="ha-rooms" className="card-title text-base">
            Rooms
          </h2>
          {floorsShown.map((f) => {
            const t = floorTarget(f.id || null);
            const targetProp = targetProperty(t);
            const list = view.areas.filter((a) => (a.floorId ?? "") === f.id).sort((x, y) => x.name.localeCompare(y.name));
            return (
              <div key={f.id || "none"}>
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-base-content/10 pb-2 pt-3">
                  <h3 className="font-semibold">{f.name}</h3>
                  {f.id && (
                    <select
                      className="select select-sm w-full sm:w-60"
                      aria-label={`Where ${f.name}'s rooms go`}
                      value={t.kind === "property" ? t.id : t.kind}
                      onChange={(e) => {
                        const v = e.target.value;
                        setFloorTargets({ ...floorTargets, [f.id]: v === "home" ? { kind: "home" } : v === "own" ? { kind: "own" } : { kind: "property", id: v } });
                      }}
                    >
                      <option value="home">In {home?.name ?? (newHome.trim() || "Home")}</option>
                      {properties
                        .filter((p) => p.id !== home?.id)
                        .map((p) => (
                          <option key={p.id} value={p.id}>
                            In {p.name}
                          </option>
                        ))}
                      <option value="own">Its own property, “{f.name}”</option>
                    </select>
                  )}
                </div>
                <ul className="divide-y divide-base-content/10">
                  {list.map((a) => {
                    const c = choiceFor(a.id);
                    const set = (next: AreaChoice) => setChoices({ ...choices, [a.id]: next });
                    const where = t.kind === "own" ? `${f.name} (new property)` : (targetProp?.name ?? (newHome.trim() || "Home"));
                    return (
                      <li key={a.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-2">
                        <div className="min-w-0 flex-1 basis-40">
                          <p className="truncate font-medium">{a.name}</p>
                          <p className="text-sm text-base-content/70">
                            {c === "mapped"
                              ? `In Ferret: ${pathOf(a.locationId) ?? "a place"}`
                              : c.mode === "new"
                                ? `New place: ${where} › ${newPath(a.id)}`
                                : c.mode === "existing"
                                  ? "Goes in a place you have"
                                  : "Not a place in Ferret"}
                          </p>
                        </div>
                        {c !== "mapped" && (
                          <select
                            className="select w-full sm:w-44"
                            aria-label={`What ${a.name} becomes`}
                            value={c.mode}
                            onChange={(e) => set(e.target.value === "existing" ? { mode: "existing", locationId: null } : { mode: e.target.value as "new" | "none" })}
                          >
                            <option value="new">A new place</option>
                            {targetProp && <option value="existing">A place I have</option>}
                            <option value="none">Leave it out</option>
                          </select>
                        )}
                        {c !== "mapped" && c.mode === "existing" && targetProp && (
                          <div className="w-full">
                            <PlacePicker
                              householdId={householdId}
                              id={`ha-area-${a.id}`}
                              name={`area-${a.id}`}
                              label="Which place"
                              value={c.locationId}
                              onChange={(locationId) => set({ mode: "existing", locationId })}
                              noneLabel="Pick a place"
                              propertyId={targetProp.id}
                            />
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>
      </section>

      <section className="card" aria-labelledby="ha-devices">
        <div className="card-body gap-3">
          <h2 id="ha-devices" className="card-title text-base">
            Devices
          </h2>
          <input className="input" type="search" placeholder="Find a device, maker or integration" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Find a device" />
          {[...groups.keys()].sort(byLevel).map((areaId) => {
            const list = groups.get(areaId)!;
            const open = list.filter((d) => !d.itemId);
            const allOn = open.length > 0 && open.every((d) => picked.has(d.id));
            return (
              <div key={areaId || "none"}>
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-base-content/10 pb-1 pt-3">
                  <h3 className="font-semibold">{areaId === NO_AREA ? "No room in Home Assistant" : areas.get(areaId)!.name}</h3>
                  {open.length > 0 && (
                    <button type="button" className="btn btn-text btn-xs" onClick={() => toggle(open.map((d) => d.id), !allOn)}>
                      {allOn ? "Untick all" : "Tick all"}
                    </button>
                  )}
                </div>
                <ul className="divide-y divide-base-content/10">{list.map(deviceRow)}</ul>
              </div>
            );
          })}
          {virtual.filter(matches).length > 0 && (
            <details className="rounded-box bg-base-200 p-3">
              <summary className="cursor-pointer font-medium">Probably not things ({virtual.filter(matches).length})</summary>
              <p className="mt-1 text-sm text-base-content/70">Apps, services, integrations and Home Assistant's own bridges. Tick any that are real.</p>
              <ul className="divide-y divide-base-content/10">{virtual.filter(matches).map(deviceRow)}</ul>
            </details>
          )}
        </div>
      </section>

      <div className="sticky bottom-[max(1rem,env(safe-area-inset-bottom))] z-10 flex flex-wrap items-center justify-end gap-3 rounded-box bg-base-100 p-3 shadow-md max-sm:bottom-20">
        {run.isError && <div className="w-full"><ImportStatus run={run} progress={progress} describe={() => ""} /></div>}
        <span className="min-w-0 flex-1 text-sm text-base-content/70">{summary.length ? summary.join(", ") : changed.length ? "No changes ticked" : "Nothing new"}</span>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!places.data || (!summary.length && !changed.length)}
          onClick={() => run.mutate({ source: "homeassistant", name: "Home Assistant", parts, then: applyChanges })}
        >
          {summary.length ? "Import" : "Done"}
        </button>
      </div>
    </>
    </>
  );
}
