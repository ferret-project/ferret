/**
 * Item templates: a kind of thing a household keeps many of — coins, trading cards, dolls, toys — with its own fields
 * (year, mint mark, grade…) and the category and tags things made from it start with. An item made from one keeps
 * `templateId`; the template's fields show on it besides its category's, and the values are in its customFields
 * (createItem fills in the template's category and tags when they're not given). A starter set covers the usual
 * collections.
 */
import type { CategoryField, ItemTemplate, TemplateInput, TemplatePatch } from "@ferret/shared";
import { and, count, eq, isNull } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { category, item, itemTemplate } from "../db/schema";
import { type Caller, itemChanged, itemScope, logActivity, notFound } from "./inventory";

const templateIn = (v: Caller, id: string) => and(eq(itemTemplate.id, id), eq(itemTemplate.householdId, v.householdId), isNull(itemTemplate.deletedAt));

/** Field keys must be unique within a template. */
function checkFields(fields: CategoryField[] | undefined) {
  const keys = new Set<string>();
  for (const f of fields ?? []) {
    if (keys.has(f.key)) throw new HTTPException(422, { message: `Two fields are called "${f.key}"` });
    keys.add(f.key);
    if (f.type === "choice" && !f.options?.length) throw new HTTPException(422, { message: `${f.label} needs its choices` });
  }
}

async function checkCategory(v: Caller, categoryId: string | null | undefined) {
  if (!categoryId) return;
  const [found] = await v.db
    .select({ id: category.id })
    .from(category)
    .where(and(eq(category.id, categoryId), eq(category.householdId, v.householdId), isNull(category.deletedAt)));
  if (!found) throw notFound("Category");
}

export async function listTemplates(v: Caller): Promise<ItemTemplate[]> {
  const [rows, used] = await Promise.all([
    v.db.select().from(itemTemplate).where(and(eq(itemTemplate.householdId, v.householdId), isNull(itemTemplate.deletedAt))).orderBy(itemTemplate.name),
    v.db.select({ templateId: item.templateId, n: count() }).from(item).where(itemScope(v, { gone: "include" })).groupBy(item.templateId),
  ]);
  const counts = new Map(used.map((u) => [u.templateId, u.n]));
  return rows.map((r) => view(r, counts.get(r.id) ?? 0));
}

const view = (r: typeof itemTemplate.$inferSelect, itemCount: number): ItemTemplate => ({
  id: r.id,
  name: r.name,
  icon: r.icon,
  fields: r.fields ?? [],
  categoryId: r.categoryId,
  tags: r.tags ?? [],
  itemCount,
});

export async function getTemplate(v: Caller, id: string) {
  const [row] = await v.db.select().from(itemTemplate).where(templateIn(v, id));
  if (!row) throw notFound("Template");
  return view(row, 0);
}

export async function createTemplate(v: Caller, input: TemplateInput) {
  checkFields(input.fields);
  await checkCategory(v, input.categoryId);
  const [row] = await v.db
    .insert(itemTemplate)
    .values({ householdId: v.householdId, name: input.name, icon: input.icon ?? null, fields: input.fields, categoryId: input.categoryId ?? null, tags: input.tags ?? [] })
    .returning();
  await logActivity(v, "template.create", row!.id, `Added template ${row!.name}`);
  return view(row!, 0);
}

/** Change it: things made from it are re-indexed (search reads its field names). */
export async function updateTemplate(v: Caller, id: string, input: TemplatePatch) {
  checkFields(input.fields);
  await checkCategory(v, input.categoryId);
  const [row] = await v.db.update(itemTemplate).set(input).where(templateIn(v, id)).returning();
  if (!row) throw notFound("Template");
  if (input.fields || input.name) {
    const made = await v.db.select({ id: item.id }).from(item).where(and(itemScope(v, { gone: "include" }), eq(item.templateId, id)));
    for (const m of made) await itemChanged(v, m.id);
  }
  await logActivity(v, "template.update", row.id, `Changed template ${row.name}`);
  return view(row, 0);
}

/** Things made from it keep their values; they just stop showing its fields' names (kept 30 days in case). */
export async function deleteTemplate(v: Caller, id: string) {
  const [row] = await v.db.update(itemTemplate).set({ deletedAt: new Date() }).where(templateIn(v, id)).returning();
  if (!row) throw notFound("Template");
  await v.db.update(item).set({ templateId: null }).where(and(eq(item.householdId, v.householdId), eq(item.templateId, id)));
  await logActivity(v, "template.delete", id, `Removed template ${row.name}`);
}

const grades = ["Mint", "Near mint", "Excellent", "Very good", "Good", "Fair", "Poor"];

/** The usual collections, ready to use (and to change). */
export const STARTER_TEMPLATES: { name: string; icon: string; category?: string; fields: CategoryField[] }[] = [
  {
    name: "Coin",
    icon: "coin",
    category: "Art & collectibles",
    fields: [
      { key: "year", label: "Year", type: "number" },
      { key: "mint_mark", label: "Mint mark", type: "text" },
      { key: "denomination", label: "Denomination", type: "text" },
      { key: "country", label: "Country", type: "text" },
      { key: "composition", label: "Metal", type: "text" },
      { key: "grade", label: "Grade", type: "text" },
      { key: "graded_by", label: "Graded by", type: "choice", options: ["Not graded", "PCGS", "NGC", "ANACS", "ICG"] },
    ],
  },
  {
    name: "Trading card",
    icon: "cards",
    category: "Art & collectibles",
    fields: [
      { key: "game", label: "Game or sport", type: "text" },
      { key: "set", label: "Set", type: "text" },
      { key: "card_number", label: "Card number", type: "text" },
      { key: "subject", label: "Player / character", type: "text" },
      { key: "year", label: "Year", type: "number" },
      { key: "variant", label: "Variant / parallel", type: "text" },
      { key: "graded_by", label: "Graded by", type: "choice", options: ["Raw", "PSA", "BGS", "CGC", "SGC"] },
      { key: "grade", label: "Grade", type: "text" },
    ],
  },
  {
    name: "Doll",
    icon: "mood-kid",
    category: "Art & collectibles",
    fields: [
      { key: "maker", label: "Maker", type: "text" },
      { key: "line", label: "Line / series", type: "text" },
      { key: "year", label: "Year", type: "number" },
      { key: "edition", label: "Edition", type: "text" },
      { key: "packaging", label: "Packaging", type: "choice", options: ["In box, never opened", "In box, opened", "No box"] },
      { key: "condition_detail", label: "Condition", type: "choice", options: grades },
    ],
  },
  {
    name: "Toy or action figure",
    icon: "horse-toy",
    category: "Art & collectibles",
    fields: [
      { key: "maker", label: "Maker", type: "text" },
      { key: "line", label: "Line / series", type: "text" },
      { key: "year", label: "Year", type: "number" },
      { key: "complete", label: "Complete with accessories", type: "choice", options: ["Yes", "No", "Not sure"] },
      { key: "packaging", label: "Packaging", type: "choice", options: ["Sealed", "In box, opened", "Loose"] },
    ],
  },
  {
    name: "Comic book",
    icon: "book",
    category: "Art & collectibles",
    fields: [
      { key: "series", label: "Series", type: "text" },
      { key: "issue", label: "Issue", type: "text" },
      { key: "publisher", label: "Publisher", type: "text" },
      { key: "year", label: "Year", type: "number" },
      { key: "variant", label: "Cover / variant", type: "text" },
      { key: "graded_by", label: "Graded by", type: "choice", options: ["Raw", "CGC", "CBCS", "PGX"] },
      { key: "grade", label: "Grade", type: "text" },
    ],
  },
  {
    name: "Stamp",
    icon: "mail",
    category: "Art & collectibles",
    fields: [
      { key: "country", label: "Country", type: "text" },
      { key: "year", label: "Year", type: "number" },
      { key: "catalog_number", label: "Catalogue number", type: "text" },
      { key: "denomination", label: "Face value", type: "text" },
      { key: "state", label: "Mint or used", type: "choice", options: ["Mint, never hinged", "Mint, hinged", "Used"] },
    ],
  },
  {
    name: "Vinyl record",
    icon: "vinyl",
    category: "Art & collectibles",
    fields: [
      { key: "artist", label: "Artist", type: "text" },
      { key: "label", label: "Label", type: "text" },
      { key: "catalog_number", label: "Catalogue number", type: "text" },
      { key: "year", label: "Year", type: "number" },
      { key: "format", label: "Format", type: "choice", options: ["LP", "EP", "7″ single", "12″ single", "Box set"] },
      { key: "pressing", label: "Pressing", type: "text" },
    ],
  },
  {
    name: "LEGO set",
    icon: "lego",
    category: "Art & collectibles",
    fields: [
      { key: "set_number", label: "Set number", type: "text" },
      { key: "theme", label: "Theme", type: "text" },
      { key: "pieces", label: "Pieces", type: "number" },
      { key: "year", label: "Year", type: "number" },
      { key: "state", label: "State", type: "choice", options: ["Sealed", "Built, complete", "Built, missing pieces", "In bags"] },
    ],
  },
];

/** The starter templates a household doesn't have yet (by name), in its "Art & collectibles" category if it has one. */
export async function addStarterTemplates(v: Caller) {
  const have = new Set((await listTemplates(v)).map((t) => t.name.toLowerCase()));
  const categories = await v.db
    .select({ id: category.id, name: category.name })
    .from(category)
    .where(and(eq(category.householdId, v.householdId), isNull(category.deletedAt), isNull(category.parentId)));
  const added: string[] = [];
  for (const t of STARTER_TEMPLATES) {
    if (have.has(t.name.toLowerCase())) continue;
    const categoryId = categories.find((c) => c.name === t.category)?.id ?? null;
    await v.db.insert(itemTemplate).values({ householdId: v.householdId, name: t.name, icon: t.icon, fields: t.fields, categoryId, tags: [] });
    added.push(t.name);
  }
  if (added.length) await logActivity(v, "template.create", v.householdId, `Added the starter templates (${added.join(", ")})`);
  return listTemplates(v);
}
