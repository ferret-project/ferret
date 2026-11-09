import { t as translateText, withLanguage } from "./i18n";
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
    if (keys.has(f.key)) throw new HTTPException(422, { message: translateText("Two fields are called \"{v0}\"", { v0: f.key }) });
    keys.add(f.key);
    if (f.type === "choice" && !f.options?.length) throw new HTTPException(422, { message: translateText("{v0} needs its choices", { v0: f.label }) });
  }
}

async function checkCategory(v: Caller, categoryId: string | null | undefined) {
  if (!categoryId) return;
  const [found] = await v.db
    .select({ id: category.id })
    .from(category)
    .where(and(eq(category.id, categoryId), eq(category.householdId, v.householdId), isNull(category.deletedAt)));
  if (!found) throw notFound(translateText("Category"));
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
  if (!row) throw notFound(translateText("Template"));
  return view(row, 0);
}

export async function createTemplate(v: Caller, input: TemplateInput) {
  checkFields(input.fields);
  await checkCategory(v, input.categoryId);
  const [row] = await v.db
    .insert(itemTemplate)
    .values({ householdId: v.householdId, name: input.name, icon: input.icon ?? null, fields: input.fields, categoryId: input.categoryId ?? null, tags: input.tags ?? [] })
    .returning();
  await logActivity(v, "template.create", row!.id, translateText("Added template {v0}", { v0: row!.name }));
  return view(row!, 0);
}

/** Change it: things made from it are re-indexed (search reads its field names). */
export async function updateTemplate(v: Caller, id: string, input: TemplatePatch) {
  checkFields(input.fields);
  await checkCategory(v, input.categoryId);
  const [row] = await v.db.update(itemTemplate).set(input).where(templateIn(v, id)).returning();
  if (!row) throw notFound(translateText("Template"));
  if (input.fields || input.name) {
    const made = await v.db.select({ id: item.id }).from(item).where(and(itemScope(v, { gone: "include" }), eq(item.templateId, id)));
    for (const m of made) await itemChanged(v, m.id);
  }
  await logActivity(v, "template.update", row.id, translateText("Changed template {v0}", { v0: row.name }));
  return view(row, 0);
}

/** Things made from it keep their values; they just stop showing its fields' names (kept 30 days in case). */
export async function deleteTemplate(v: Caller, id: string) {
  const [row] = await v.db.update(itemTemplate).set({ deletedAt: new Date() }).where(templateIn(v, id)).returning();
  if (!row) throw notFound(translateText("Template"));
  await v.db.update(item).set({ templateId: null }).where(and(eq(item.householdId, v.householdId), eq(item.templateId, id)));
  await logActivity(v, "template.delete", id, translateText("Removed template {v0}", { v0: row.name }));
}

const grades = ["Mint", "Near mint", "Excellent", "Very good", "Good", "Fair", "Poor"];

/** The usual collections, ready to use (and to change). */
export const STARTER_TEMPLATES: { name: string; icon: string; category?: string; fields: CategoryField[] }[] = [
  {
    get name() { return translateText("Coin"); },
    icon: "coin",
    get category() { return translateText("Art & collectibles"); },
    fields: [
      { key: "year", get label() { return translateText("Year"); }, type: "number" },
      { key: "mint_mark", get label() { return translateText("Mint mark"); }, type: "text" },
      { key: "denomination", get label() { return translateText("Denomination"); }, type: "text" },
      { key: "country", get label() { return translateText("Country"); }, type: "text" },
      { key: "composition", get label() { return translateText("Metal"); }, type: "text" },
      { key: "grade", get label() { return translateText("Grade"); }, type: "text" },
      { key: "graded_by", get label() { return translateText("Graded by"); }, type: "choice", options: ["Not graded", "PCGS", "NGC", "ANACS", "ICG"] },
    ],
  },
  {
    get name() { return translateText("Trading card"); },
    icon: "cards",
    get category() { return translateText("Art & collectibles"); },
    fields: [
      { key: "game", get label() { return translateText("Game or sport"); }, type: "text" },
      { key: "set", get label() { return translateText("Set"); }, type: "text" },
      { key: "card_number", get label() { return translateText("Card number"); }, type: "text" },
      { key: "subject", get label() { return translateText("Player / character"); }, type: "text" },
      { key: "year", get label() { return translateText("Year"); }, type: "number" },
      { key: "variant", get label() { return translateText("Variant / parallel"); }, type: "text" },
      { key: "graded_by", get label() { return translateText("Graded by"); }, type: "choice", options: ["Raw", "PSA", "BGS", "CGC", "SGC"] },
      { key: "grade", get label() { return translateText("Grade"); }, type: "text" },
    ],
  },
  {
    get name() { return translateText("Doll"); },
    icon: "mood-kid",
    get category() { return translateText("Art & collectibles"); },
    fields: [
      { key: "maker", get label() { return translateText("Maker"); }, type: "text" },
      { key: "line", get label() { return translateText("Line / series"); }, type: "text" },
      { key: "year", get label() { return translateText("Year"); }, type: "number" },
      { key: "edition", get label() { return translateText("Edition"); }, type: "text" },
      { key: "packaging", get label() { return translateText("Packaging"); }, type: "choice", options: ["In box, never opened", "In box, opened", "No box"] },
      { key: "condition_detail", get label() { return translateText("Condition"); }, type: "choice", options: grades },
    ],
  },
  {
    get name() { return translateText("Toy or action figure"); },
    icon: "horse-toy",
    get category() { return translateText("Art & collectibles"); },
    fields: [
      { key: "maker", get label() { return translateText("Maker"); }, type: "text" },
      { key: "line", get label() { return translateText("Line / series"); }, type: "text" },
      { key: "year", get label() { return translateText("Year"); }, type: "number" },
      { key: "complete", get label() { return translateText("Complete with accessories"); }, type: "choice", options: ["Yes", "No", "Not sure"] },
      { key: "packaging", get label() { return translateText("Packaging"); }, type: "choice", options: ["Sealed", "In box, opened", "Loose"] },
    ],
  },
  {
    get name() { return translateText("Comic book"); },
    icon: "book",
    get category() { return translateText("Art & collectibles"); },
    fields: [
      { key: "series", get label() { return translateText("Series"); }, type: "text" },
      { key: "issue", get label() { return translateText("Issue"); }, type: "text" },
      { key: "publisher", get label() { return translateText("Publisher"); }, type: "text" },
      { key: "year", get label() { return translateText("Year"); }, type: "number" },
      { key: "variant", get label() { return translateText("Cover / variant"); }, type: "text" },
      { key: "graded_by", get label() { return translateText("Graded by"); }, type: "choice", options: ["Raw", "CGC", "CBCS", "PGX"] },
      { key: "grade", get label() { return translateText("Grade"); }, type: "text" },
    ],
  },
  {
    get name() { return translateText("Stamp"); },
    icon: "mail",
    get category() { return translateText("Art & collectibles"); },
    fields: [
      { key: "country", get label() { return translateText("Country"); }, type: "text" },
      { key: "year", get label() { return translateText("Year"); }, type: "number" },
      { key: "catalog_number", get label() { return translateText("Catalogue number"); }, type: "text" },
      { key: "denomination", get label() { return translateText("Face value"); }, type: "text" },
      { key: "state", get label() { return translateText("Mint or used"); }, type: "choice", options: ["Mint, never hinged", "Mint, hinged", "Used"] },
    ],
  },
  {
    get name() { return translateText("Vinyl record"); },
    icon: "vinyl",
    get category() { return translateText("Art & collectibles"); },
    fields: [
      { key: "artist", get label() { return translateText("Artist"); }, type: "text" },
      { key: "label", get label() { return translateText("Label"); }, type: "text" },
      { key: "catalog_number", get label() { return translateText("Catalogue number"); }, type: "text" },
      { key: "year", get label() { return translateText("Year"); }, type: "number" },
      { key: "format", get label() { return translateText("Format"); }, type: "choice", options: ["LP", "EP", "7″ single", "12″ single", "Box set"] },
      { key: "pressing", get label() { return translateText("Pressing"); }, type: "text" },
    ],
  },
  {
    name: "LEGO set",
    icon: "lego",
    get category() { return translateText("Art & collectibles"); },
    fields: [
      { key: "set_number", get label() { return translateText("Set number"); }, type: "text" },
      { key: "theme", get label() { return translateText("Theme"); }, type: "text" },
      { key: "pieces", get label() { return translateText("Pieces"); }, type: "number" },
      { key: "year", get label() { return translateText("Year"); }, type: "number" },
      { key: "state", get label() { return translateText("State"); }, type: "choice", options: ["Sealed", "Built, complete", "Built, missing pieces", "In bags"] },
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
    const names = [withLanguage("en", () => t.name), withLanguage("hu", () => t.name)];
    if (names.some((name) => have.has(name.toLowerCase()))) continue;
    const categoryNames = [withLanguage("en", () => t.category), withLanguage("hu", () => t.category)];
    const categoryId = categories.find((c) => categoryNames.includes(c.name))?.id ?? null;
    const fields = t.fields.map((field) => ({ ...field, options: field.options?.map((option) => translateText(option)) }));
    await v.db.insert(itemTemplate).values({ householdId: v.householdId, name: t.name, icon: t.icon, fields, categoryId, tags: [] });
    added.push(t.name);
  }
  if (added.length) await logActivity(v, "template.create", v.householdId, translateText("Added the starter templates ({v0})", { v0: added.join(", ") }));
  return listTemplates(v);
}
