import { addMonths, today, warrantyStatus } from "@ferret/shared";
import { describe, expect, it } from "vitest";
import { toAnalysis } from "../src/jobs/analyze";
import { FakeAi, pdf, setup } from "./helpers";

const inMonths = (n: number) => addMonths(today(), n);

describe("warranty dates", () => {
  it("adds months, clamping to the end of the month", () => {
    expect(addMonths("2025-06-02", 12)).toBe("2026-06-02");
    expect(addMonths("2025-01-31", 1)).toBe("2025-02-28");
    expect(addMonths("2024-01-31", 1)).toBe("2024-02-29");
    expect(addMonths("2025-11-15", 3)).toBe("2026-02-15");
  });

  it("knows active, expiring and expired", () => {
    expect(warrantyStatus("2026-06-02", "2025-12-01")).toBe("active");
    expect(warrantyStatus("2026-06-02", "2026-05-01")).toBe("expiring"); // within 60 days
    expect(warrantyStatus("2026-06-02", "2026-06-02")).toBe("expiring"); // last day still covered
    expect(warrantyStatus("2026-06-02", "2026-06-03")).toBe("expired");
  });
});

describe("warranties", () => {
  async function withItem() {
    const env = await setup();
    const pat = await env.user("pat");
    const mixer = await pat.addItem({ name: "Stand mixer", brand: "KitchenAid" });
    const add = (body: Record<string, unknown>, itemId = mixer.id) =>
      pat.as(`/api/v1/items/${itemId}/warranties`, { method: "POST", body: JSON.stringify(body) });
    return { ...env, pat, mixer, add };
  }

  it("adds, lists with status, updates and removes", async () => {
    const { pat, mixer, add } = await withItem();
    const res = await add({ provider: "KitchenAid", startsOn: inMonths(-6), endsOn: inMonths(6), coverage: "Parts and labor" });
    expect(res.status).toBe(201);
    const w = (await res.json()) as { id: string; status: string };
    expect(w).toMatchObject({ itemId: mixer.id, status: "active", provider: "KitchenAid" });

    const list = (await (await pat.as(`/api/v1/items/${mixer.id}/warranties`)).json()) as { data: { status: string }[] };
    expect(list.data).toHaveLength(1);

    const moved = await pat.as(`/api/v1/warranties/${w.id}`, { method: "PATCH", body: JSON.stringify({ endsOn: inMonths(-1) }) });
    expect(((await moved.json()) as { status: string }).status).toBe("expired");

    expect((await pat.as(`/api/v1/warranties/${w.id}`, { method: "DELETE" })).status).toBe(204);
    expect(((await (await pat.as(`/api/v1/items/${mixer.id}/warranties`)).json()) as { data: unknown[] }).data).toEqual([]);
  });

  it("filters the household's warranties by status, soonest first", async () => {
    const { pat, add } = await withItem();
    const drill = await pat.addItem({ name: "Drill" });
    const tv = await pat.addItem({ name: "TV" });
    await add({ endsOn: inMonths(12) });
    await add({ endsOn: inMonths(1) }, drill.id);
    await add({ endsOn: inMonths(-2) }, tv.id);

    const names = async (status?: string) =>
      ((await (await pat.as(`/api/v1/warranties${status ? `?status=${status}` : ""}`)).json()) as { data: { itemName: string }[] }).data.map(
        (w) => w.itemName,
      );
    expect(await names()).toEqual(["TV", "Drill", "Stand mixer"]);
    expect(await names("active")).toEqual(["Drill", "Stand mixer"]); // expiring still counts as covered
    expect(await names("expiring")).toEqual(["Drill"]);
    expect(await names("expired")).toEqual(["TV"]);
  });

  it("validates dates and source documents", async () => {
    const { pat, mixer, add } = await withItem();
    expect((await add({ startsOn: "2026-01-01", endsOn: "2025-01-01" })).status).toBe(422);
    expect((await add({ endsOn: "next year" })).status).toBe(422);

    const other = await pat.addItem({ name: "Drill" });
    const { id: docId } = await pat.upload(other.id, pdf(), "drill-receipt.pdf", "document");
    expect((await add({ endsOn: inMonths(6), attachmentId: docId })).status).toBe(422); // not this item's
    const { id: own } = await pat.upload(mixer.id, pdf(), "mixer-warranty.pdf", "document");
    expect((await add({ endsOn: inMonths(6), attachmentId: own })).status).toBe(201);
  });

  it("keeps households apart", async () => {
    const { user, add } = await withItem();
    const created = (await (await add({ endsOn: inMonths(6) })).json()) as { id: string };
    const sam = await user("sam");
    expect(((await (await sam.as("/api/v1/warranties")).json()) as { data: unknown[] }).data).toEqual([]);
    expect((await sam.as(`/api/v1/warranties/${created.id}`, { method: "DELETE" })).status).toBe(404);
  });

  it("makes warranties searchable", async () => {
    const { pat, mixer, add } = await withItem();
    await add({ provider: "Geek Squad", endsOn: inMonths(6) });
    expect((await pat.search("geek squad")).data.map((r) => r.id)).toEqual([mixer.id]);
  });

  it("gives Ask Ferret every warranty on file, with today's date", async () => {
    const ai = new FakeAi([{ answer: "The stand mixer, until next year.", found: true, sources: [2] }]); // [1] is the expired TV (soonest first)
    const env = await setup({ ai });
    const pat = await env.user("pat");
    const mixer = await pat.addItem({ name: "Stand mixer" });
    const tv = await pat.addItem({ name: "TV" });
    await pat.as(`/api/v1/items/${mixer.id}/warranties`, { method: "POST", body: JSON.stringify({ provider: "KitchenAid", endsOn: inMonths(8) }) });
    await pat.as(`/api/v1/items/${tv.id}/warranties`, { method: "POST", body: JSON.stringify({ endsOn: inMonths(-3) }) });

    // Nothing in the question names an item — the warranty list is what answers it.
    const res = await pat.as("/api/v1/ask", { method: "POST", body: JSON.stringify({ question: "what's still under warranty?" }) });
    const body = (await res.json()) as { citations: { itemName: string }[] };
    expect(body.citations.map((c) => c.itemName)).toEqual(["Stand mixer"]);
    const prompt = ai.calls.at(-1)!.prompt;
    expect(prompt).toContain(`Today is ${today()}.`);
    expect(prompt).toMatch(/Warranty on file for TV: until \S+ — expired\./);
    expect(prompt).toMatch(/Warranty on file for Stand mixer, from KitchenAid: until \S+ — active\./);
  });

  it("reads warranty terms from documents", () => {
    const a = toAnalysis({ description: "Warranty card.", text: "", warrantyMonths: 12, warrantyProvider: "KitchenAid" });
    expect(a.suggestions).toEqual({ warrantyMonths: 12, warrantyProvider: "KitchenAid" });
    expect(toAnalysis({ description: "", text: "", warrantyMonths: 0 }).suggestions).toEqual({});
  });
});
