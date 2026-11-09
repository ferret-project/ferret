import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { activity } from "../src/db/schema";
import { FakeAi, FakeDocuments, pdf, photo, setup } from "./helpers";

const receipt = (over: Record<string, unknown> = {}) => ({
  description: "Home Depot receipt for a DeWalt drill kit.",
  text: "",
  name: "Drill kit",
  brand: "DEWALT",
  model: "DCD771C2",
  serialNumber: null,
  barcode: null,
  purchaseDate: "2026-03-14",
  purchasePrice: 129,
  returnDays: null,
  returnBy: "2099-04-13",
  warrantyMonths: 36,
  warrantyProvider: "DeWalt",
  maintenance: [{ task: "Clean the vents", every: 6, unit: "month" }],
  sure: ["brand", "model", "purchaseDate", "purchasePrice", "returnBy", "warrantyMonths"],
  ...over,
});

async function household(reply = receipt()) {
  const chat = new FakeAi([reply]);
  const ctx = await setup({ chat, documents: new FakeDocuments(["THE HOME DEPOT\nDEWALT DRILL KIT 129.00"]) });
  const pat = await ctx.user("pat");
  const settings = (aiFill: Record<string, boolean | null>) =>
    pat.as("/api/v1/household/settings", { method: "PUT", body: JSON.stringify({ aiFill }) });
  return { ...ctx, pat, settings, chat };
}

const item = async (pat: { as: (u: string, i?: RequestInit) => Response | Promise<Response> }, id: string) =>
  (await (await pat.as(`/api/v1/items/${id}`)).json()) as Record<string, unknown> & { aiFilled: Record<string, { value: unknown; from: string }> | null };

describe("let AI fill in", () => {
  it("is off by default: what the model read stays a suggestion", async () => {
    const { pat, jobs } = await household();
    const { id } = await pat.addItem({ name: "Drill" });
    await pat.upload(id, pdf(), "receipt.pdf", "document");
    await jobs.drain();
    const now = await item(pat, id);
    expect(now).toMatchObject({ brand: null, model: null, purchaseDate: null, aiFilled: null });
    const s = (await (await pat.as("/api/v1/household/settings")).json()) as Record<string, unknown>;
    expect(s).toMatchObject({ aiFill: { details: false, returnBy: false, warranty: false }, aiFillChosen: [] });
  });

  it("fills only empty fields the model was sure of, marks them, logs them, and adds the warranty", async () => {
    const { pat, jobs, settings } = await household(receipt({ serialNumber: "SN-GUESS" }));
    expect((await settings({ details: true, returnBy: true, warranty: true })).status).toBe(200);
    const { id } = await pat.addItem({ name: "Drill", model: "My own model" });
    await pat.upload(id, pdf(), "receipt.pdf", "document");
    await jobs.drain();

    const now = await item(pat, id);
    expect(now).toMatchObject({ name: "Drill", brand: "DEWALT", model: "My own model", serialNumber: null, purchaseDate: "2026-03-14", purchasePriceCents: 12900, returnBy: "2099-04-13" });
    expect(Object.keys(now.aiFilled!).sort()).toEqual(["brand", "purchaseDate", "purchasePriceCents", "returnBy", "warranty"]);
    expect(now.aiFilled!.brand).toMatchObject({ value: "DEWALT", from: "receipt.pdf" });

    const warranties = ((await (await pat.as(`/api/v1/items/${id}/warranties`)).json()) as { data: { endsOn: string }[] }).data;
    expect(warranties.map((w) => w.endsOn)).toEqual(["2029-03-14"]);

    const history = ((await (await pat.as(`/api/v1/items/${id}/history`)).json()) as { data: { summary: string }[] }).data;
    expect(history.map((h) => h.summary)).toContain("Filled in by AI from receipt.pdf: brand DEWALT; bought on 2026-03-14; price paid $129.00; return by 2099-04-13");

    // The list, then: confirm one, undo two.
    const list = ((await (await pat.as("/api/v1/ai-fills")).json()) as { data: { field: string }[] }).data;
    expect(list).toHaveLength(5);
    await pat.as(`/api/v1/items/${id}/ai-fills/brand/confirm`, { method: "POST" });
    await pat.as(`/api/v1/items/${id}/ai-fills/purchasePriceCents/undo`, { method: "POST" });
    await pat.as(`/api/v1/items/${id}/ai-fills/warranty/undo`, { method: "POST" });
    const after = await item(pat, id);
    expect(after).toMatchObject({ brand: "DEWALT", purchasePriceCents: null });
    expect(Object.keys(after.aiFilled!).sort()).toEqual(["purchaseDate", "returnBy"]);
    expect(((await (await pat.as(`/api/v1/items/${id}/warranties`)).json()) as { data: unknown[] }).data).toHaveLength(0);

    // A person's edit to a field takes its mark away.
    await pat.as(`/api/v1/items/${id}`, { method: "PATCH", body: JSON.stringify({ purchaseDate: "2026-03-15" }) });
    expect(Object.keys((await item(pat, id)).aiFilled!)).toEqual(["returnBy"]);
  });

  it("never fills a field a person cleared since the file came", async () => {
    const { pat, jobs, settings } = await household();
    await settings({ details: true });
    const { id } = await pat.addItem({ name: "Drill", brand: "Old" });
    await pat.upload(id, pdf(), "receipt.pdf", "document");
    await pat.as(`/api/v1/items/${id}`, { method: "PATCH", body: JSON.stringify({ brand: null }) });
    await jobs.drain();
    expect(await item(pat, id)).toMatchObject({ brand: null, model: "DCD771C2" });
  });

  it.each([["en", "structured"], ["hu", "structured"], ["en", "legacy"], ["hu", "legacy"]])("respects intentional clearing in %s (%s) even when the analysis job uses another language", async (language, history) => {
    const { pat, jobs, settings, db } = await household();
    await settings({ details: true, returnBy: true });
    const { id } = await pat.addItem({ name: "Drill", brand: "Old", model: "Old model", returnBy: "2099-01-01", purchasePriceCents: 100 });
    await pat.upload(id, pdf(), "receipt.pdf", "document");
    await pat.as("/api/v1/language", { method: "PUT", body: JSON.stringify({ language }) });
    await pat.as(`/api/v1/items/${id}`, { method: "PATCH", body: JSON.stringify({ brand: null, model: null, returnBy: null, purchasePriceCents: null }) });
    const [edit] = await db.select().from(activity).where(and(eq(activity.itemId, id), eq(activity.action, "item.update")));
    expect(edit?.clearedFields?.sort()).toEqual(["brand", "model", "purchasePriceCents", "returnBy"]);
    await db.update(activity).set(history === "legacy" ? { clearedFields: null } : { summary: null }).where(eq(activity.id, edit!.id));
    await pat.as("/api/v1/language", { method: "PUT", body: JSON.stringify({ language: language === "hu" ? "en" : "hu" }) });
    await jobs.drain();
    expect(await item(pat, id)).toMatchObject({ brand: null, model: null, returnBy: null, purchasePriceCents: null });
  });

  it("does not interpret a user's name as a cleared-field instruction in structured history", async () => {
    const { pat, jobs, settings } = await household();
    await settings({ details: true });
    const { id } = await pat.addItem({ name: "brand removed", notes: "Old" });
    await pat.upload(id, pdf(), "receipt.pdf", "document");
    await pat.as(`/api/v1/items/${id}`, { method: "PATCH", body: JSON.stringify({ notes: "New" }) });
    await jobs.drain();
    expect(await item(pat, id)).toMatchObject({ brand: "DEWALT", name: "brand removed", notes: "New" });
  });

  it("names an unnamed New item, never a named one", async () => {
    const reply = { ...receipt(), sure: ["name", "brand"] };
    const { pat, jobs, settings } = await household(reply);
    await settings({ details: true });
    const unnamed = await pat.addItem({ name: "New item" });
    await pat.upload(unnamed.id, pdf(), "a.pdf", "document");
    await jobs.drain();
    expect((await item(pat, unnamed.id)).name).toBe("Drill kit");
  });

  it("follows the server's defaults until the household chooses", async () => {
    const { pat, jobs, settings } = await household();
    // The first account is the server admin.
    expect((await pat.as("/api/v1/server/ai-fill", { method: "PUT", body: JSON.stringify({ details: true }) })).status).toBe(200);
    const { id } = await pat.addItem({ name: "Drill" });
    await pat.upload(id, pdf(), "receipt.pdf", "document");
    await jobs.drain();
    expect((await item(pat, id)).brand).toBe("DEWALT");

    await settings({ details: false });
    const s = (await (await pat.as("/api/v1/household/settings")).json()) as Record<string, unknown>;
    expect(s).toMatchObject({ aiFill: { details: false }, aiFillDefaults: { details: true }, aiFillChosen: ["details"] });
  });

  it("puts a manual's schedules in Suggested maintenance, never adds them", async () => {
    const { pat, jobs } = await household();
    const { id } = await pat.addItem({ name: "Drill" });
    await pat.upload(id, pdf(), "manual.pdf", "document");
    await jobs.drain();
    const suggested = ((await (await pat.as("/api/v1/maintenance/suggestions")).json()) as { data: { id: string; title: string; source: string; filename: string }[] }).data;
    expect(suggested).toMatchObject([{ title: "Clean the vents", source: "manual", filename: "manual.pdf" }]);
    expect(((await (await pat.as("/api/v1/maintenance")).json()) as { data: unknown[] }).data).toHaveLength(0);

    // Adding it from the suggestion takes it off the list.
    const add = await pat.as("/api/v1/maintenance", {
      method: "POST",
      body: JSON.stringify({ title: "Clean the vents and fan", itemId: id, intervalCount: 6, intervalUnit: "month", suggestionId: suggested[0]!.id }),
    });
    expect(add.status).toBe(201);
    expect(((await (await pat.as("/api/v1/maintenance/suggestions")).json()) as { data: unknown[] }).data).toHaveLength(0);
  });

  it("remembers Not needed", async () => {
    const { pat, jobs } = await household();
    const { id } = await pat.addItem({ name: "Drill" });
    await pat.upload(id, pdf(), "manual.pdf", "document");
    await jobs.drain();
    const [s] = ((await (await pat.as(`/api/v1/maintenance/suggestions?itemId=${id}`)).json()) as { data: { id: string }[] }).data;
    expect((await pat.as(`/api/v1/maintenance/suggestions/${s!.id}/dismiss`, { method: "POST" })).status).toBe(200);
    // The same manual read again doesn't bring it back.
    await pat.upload(id, pdf("again"), "manual2.pdf", "document");
    await jobs.drain();
    expect(((await (await pat.as("/api/v1/maintenance/suggestions")).json()) as { data: unknown[] }).data).toHaveLength(0);
  });
});

describe("the model's sure list", () => {
  it("keeps only fields it gave a value for", async () => {
    const { toAnalysis } = await import("../src/jobs/analyze");
    const a = toAnalysis({ ...receipt(), brand: null, sure: ["brand", "model", "nonsense"] });
    expect(a.suggestions.sure).toEqual(["model"]);
    void photo;
  });
});
