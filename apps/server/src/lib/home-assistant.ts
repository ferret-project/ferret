/**
 * Home Assistant's device registry, tidied for an import (lib/imports.ts does the importing). HA lists far more than
 * things you own — services, apps, weather — and often the same thing twice (a Sonos through its own integration and
 * through HomeKit, a camera through two NVRs). Devices are folded together when they share a MAC address or serial
 * number, or (when they don't both have one) the same maker, model and name; the likely non-things are marked
 * `virtual` so the import screen leaves them unticked.
 */
import type { HaChange, HaDevice, HaRegistryView, HaSnapshot } from "@ferret/shared";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { item, location } from "../db/schema";
import type { HaRegistry } from "../ports";
import { type Caller, locationPaths } from "./inventory";

/** Integrations whose "devices" are software, a service, or another device seen again (HA's own HomeKit bridge). */
const VIRTUAL_DOMAINS = new Set([
  "hassio", "hacs", "sun", "met", "workday", "co2signal", "systemmonitor", "google_assistant", "homekit", "backup",
  "google_drive_backup", "template", "group", "derivative", "utility_meter", "forecast_solar", "openweathermap", "accuweather",
  "holiday", "moon", "season", "speedtest", "cloud", "radio_browser", "shopping_list", "local_calendar", "local_todo",
  "nest_protect_integration", "electricity_maps", "unifi_network_application", "mqtt_statestream", "spotify", "ha_mcp_tools",
]);
const VIRTUAL_MAKERS = /^(home assistant|official apps|home assistant community apps|hacs\.xyz|met\.no|python-holidays|esphome device builder)/i;
const VIRTUAL_MODELS = /(home assistant app|unifi wlan|unifi network application|^integration$|^forecast$|^service$)/i;

type RawDevice = HaRegistry["devices"][number];

const maker = (m: string | null | undefined) => (m ?? "").toLowerCase().match(/[a-z0-9]+/)?.[0] ?? "";
const squash = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** What Ferret already has from Home Assistant: things by HA device id, places by HA area (or `floor:<id>`). */
export interface HaKnown {
  items: Map<string, { id: string; name: string; brand: string | null; model: string | null; serialNumber: string | null; locationId: string | null; haSnapshot: HaSnapshot | null }>;
  places: Map<string, { id: string; propertyId: string }>;
  /** Location id → "Home › Main › Kitchen". */
  paths: Map<string, string>;
}

const NOTHING_KNOWN: HaKnown = { items: new Map(), places: new Map(), paths: new Map() };

/** The registry → what the import screen shows, with what changed in HA since things were imported. */
export function tidyRegistry(reg: HaRegistry, known: HaKnown = NOTHING_KNOWN): HaRegistryView {
  const entries = new Map(reg.configEntries.map((e) => [e.entry_id, e]));
  const areaIds = new Set(reg.areas.map((a) => a.area_id));
  const areaName = new Map(reg.areas.map((a) => [a.area_id, a.name]));
  const shown = reg.devices.filter((d) => !d.disabled_by && d.entry_type !== "service");
  const domainOf = (d: RawDevice) => entries.get(d.primary_config_entry ?? d.config_entries?.[0] ?? "");
  const isVirtual = (d: RawDevice) => {
    const domain = domainOf(d)?.domain;
    if (domain && VIRTUAL_DOMAINS.has(domain)) return true;
    if (!d.manufacturer && !d.model) return true;
    return VIRTUAL_MAKERS.test(d.manufacturer ?? "") || VIRTUAL_MODELS.test(d.model ?? "");
  };

  // Union-find over the devices shown.
  const parent = shown.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const macs = shown.map((d) => new Set((d.connections ?? []).filter(([t]) => t === "mac").map(([, v]) => v.toLowerCase())));
  const union = (a: number, b: number) => {
    const [ra, rb] = [find(a), find(b)];
    if (ra === rb) return;
    parent[rb] = ra;
    for (const m of macs[rb]!) macs[ra]!.add(m);
  };
  const byKey = new Map<string, number>();
  const join = (k: string, i: number) => {
    const j = byKey.get(k);
    if (j === undefined) byKey.set(k, i);
    else union(j, i);
  };
  shown.forEach((d, i) => {
    for (const m of macs[i]!) join(`mac:${m}`, i);
    if (d.serial_number?.trim()) join(`sn:${maker(d.manufacturer)}:${squash(d.serial_number)}`, i);
  });
  // Same maker, model and name: the same thing — unless both have MAC addresses, and they differ.
  const byName = new Map<string, number[]>();
  shown.forEach((d, i) => {
    // HA's own name, not the one someone gave it: renaming one copy mustn't split it from the other.
    const name = squash(d.name || d.name_by_user);
    if (!name) return;
    const k = `${maker(d.manufacturer)}:${squash(d.model)}:${name}`;
    byName.set(k, [...(byName.get(k) ?? []), i]);
  });
  for (const group of byName.values()) {
    for (let x = 1; x < group.length; x++) {
      for (let y = 0; y < x; y++) {
        const [a, b] = [find(group[y]!), find(group[x]!)];
        if (a !== b && (!macs[a]!.size || !macs[b]!.size)) union(a, b);
      }
    }
  }

  const clusters = new Map<number, number[]>();
  shown.forEach((_, i) => clusters.set(find(i), [...(clusters.get(find(i)) ?? []), i]));
  const rank = (d: RawDevice) =>
    (d.area_id && areaIds.has(d.area_id) && d.area_id !== "ignore" ? 16 : 0) +
    (d.name_by_user ? 8 : 0) +
    (d.name && squash(d.name) !== squash(d.model) ? 4 : 0) + // "Back Left" over a camera called "AI Pro"
    (d.serial_number ? 2 : 0) +
    (isVirtual(d) ? 0 : 1);

  const devices: HaDevice[] = [...clusters.values()].map((members) => {
    const ds = members.map((i) => shown[i]!).sort((a, b) => rank(b) - rank(a));
    const lead = ds[0]!;
    const pick = <K extends keyof RawDevice>(k: K) => ds.map((d) => d[k]).find((v) => v != null && v !== "") ?? null;
    const entry = domainOf(lead);
    const area = ds.map((d) => d.area_id).find((a) => a && areaIds.has(a)) ?? null;
    const config = pick("configuration_url");
    const ids = ds.map((d) => d.id);
    const device = {
      id: lead.id,
      name: (lead.name_by_user || lead.name || lead.model || "Device").trim(),
      manufacturer: (pick("manufacturer") as string | null)?.trim() || null,
      model: ((pick("model") as string | null) || (pick("model_id") as string | null))?.trim() || null,
      serialNumber: (pick("serial_number") as string | null)?.trim() || null,
      areaId: area,
    };
    const had = ids.map((id) => known.items.get(id)).find(Boolean);
    return {
      ...device,
      integration: entry?.title ?? entry?.domain ?? null,
      configurationUrl: typeof config === "string" && /^https?:\/\//i.test(config) ? config : null,
      virtual: ds.every(isVirtual),
      itemId: had?.id ?? null,
      alsoIds: ids.slice(1),
      changes: had?.haSnapshot ? changesSince(device, had, had.haSnapshot) : [],
    };
  });

  /** Only what HA changed since the last import, and only where Ferret doesn't already agree. */
  function changesSince(now: HaSnapshot, had: NonNullable<ReturnType<HaKnown["items"]["get"]>>, then: HaSnapshot): HaChange[] {
    const out: HaChange[] = [];
    const text = (field: HaChange["field"], ha: string | null, before: string | null, ferret: string | null) => {
      if ((ha ?? "") !== (before ?? "") && (ha ?? "") !== (ferret ?? "")) out.push({ field, ferret, ha });
    };
    text("name", now.name, then.name, had.name);
    text("brand", now.manufacturer, then.manufacturer, had.brand);
    text("model", now.model, then.model, had.model);
    text("serialNumber", now.serialNumber, then.serialNumber, had.serialNumber);
    if ((now.areaId ?? "") !== (then.areaId ?? "")) {
      const place = now.areaId ? known.places.get(now.areaId) : undefined;
      if (!place || place.id !== had.locationId) {
        out.push({ field: "area", ferret: had.locationId ? (known.paths.get(had.locationId) ?? null) : null, ha: now.areaId ? (areaName.get(now.areaId) ?? null) : null });
      }
    }
    return out;
  }
  devices.sort((a, b) => Number(a.virtual) - Number(b.virtual) || a.name.localeCompare(b.name));
  const allIds = new Set(reg.devices.map((d) => d.id));
  const floorProperty = (floorId: string) =>
    known.places.get(`floor:${floorId}`)?.propertyId ??
    reg.areas.filter((a) => a.floor_id === floorId).map((a) => known.places.get(a.area_id)?.propertyId).find(Boolean) ??
    null;
  return {
    floors: reg.floors
      .map((f) => ({ id: f.floor_id, name: f.name, level: f.level ?? null, propertyId: floorProperty(f.floor_id) }))
      .sort((a, b) => (a.level ?? 0) - (b.level ?? 0)),
    areas: reg.areas
      .map((a) => ({ id: a.area_id, name: a.name, floorId: a.floor_id ?? null, locationId: known.places.get(a.area_id)?.id ?? null }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    devices,
    hidden: reg.devices.length - shown.length,
    removed: [...known.items.entries()].filter(([ha]) => !allIds.has(ha)).map(([, it]) => ({ itemId: it.id, name: it.name })),
  };
}

/** Read the household's Home Assistant (its address and token come with the request; neither is kept). */
export async function homeAssistantDevices(v: Caller, url: string, token: string): Promise<HaRegistryView> {
  if (!v.deps.homeAssistant) throw new Error("Home Assistant import isn't available on this server");
  const reg = await v.deps.homeAssistant.registry(url, token);
  const [rows, places, paths] = await Promise.all([
    v.db
      .select({ id: item.id, ha: item.haDeviceId, name: item.name, brand: item.brand, model: item.model, serialNumber: item.serialNumber, locationId: item.locationId, haSnapshot: item.haSnapshot })
      .from(item)
      .where(and(eq(item.householdId, v.householdId), isNull(item.deletedAt), isNotNull(item.haDeviceId))),
    v.db
      .select({ id: location.id, propertyId: location.propertyId, ha: location.haAreaId })
      .from(location)
      .where(and(eq(location.householdId, v.householdId), isNull(location.deletedAt), isNotNull(location.haAreaId))),
    locationPaths(v),
  ]);
  return tidyRegistry(reg, {
    items: new Map(rows.map(({ ha, ...r }) => [ha!, r])),
    places: new Map(places.map((p) => [p.ha!, { id: p.id, propertyId: p.propertyId }])),
    paths,
  });
}
