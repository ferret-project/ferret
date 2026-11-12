/**
 * The personal property list: things grouped by who should have them one day (`item.heir`), each with what identifies
 * it (brand, model, serial number, where it's kept, a photo) — a printable page to keep with other papers. Not a legal
 * document. It says who gets what, so only owners and admins see it (routes/export.ts).
 */
import { and, isNotNull } from "drizzle-orm";
import { item } from "../db/schema";
import { type Caller, asListing, itemScope } from "./inventory";

export type HeirItem = {
  id: string;
  name: string;
  brand: string | null;
  model: string | null;
  serialNumber: string | null;
  description: string | null;
  quantity: number;
  place: string | null;
  box: string | null;
  valueCents: number | null;
  photoId: string | null;
};
export type HeirGroup = { heir: string; items: HeirItem[]; valueCents: number };

export async function heirsList(v: Caller): Promise<{ data: HeirGroup[] }> {
  const rows = await v.db.select().from(item).where(and(itemScope(v), isNotNull(item.heir)));
  const listed = await asListing(v, rows.filter((r) => r.heir?.trim()));
  const groups = new Map<string, HeirGroup>();
  for (const r of listed) {
    const name = r.heir!.trim().replace(/\s+/g, " ");
    const key = name.toLocaleLowerCase();
    const group = groups.get(key) ?? { heir: name, items: [], valueCents: 0 };
    const each = r.valueCents ?? r.purchasePriceCents;
    const value = each == null ? null : each * Math.max(1, r.quantity);
    group.items.push({
      id: r.id,
      name: r.name,
      brand: r.brand,
      model: r.model,
      serialNumber: r.serialNumber,
      description: r.description,
      quantity: r.quantity,
      place: r.place,
      box: r.container?.name ?? null,
      valueCents: value,
      photoId: r.photoId,
    });
    group.valueCents += value ?? 0;
    groups.set(key, group);
  }
  const data = [...groups.values()].sort((a, b) => a.heir.localeCompare(b.heir));
  for (const g of data) g.items.sort((a, b) => a.name.localeCompare(b.name));
  return { data };
}
