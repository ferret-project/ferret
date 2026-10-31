/** "Needs attention": the bell's list. */
import { type AttentionItem, addDays, today } from "@ferret/shared";
import { describe, expect, it } from "vitest";
import { setup } from "./helpers";

type User = Awaited<ReturnType<Awaited<ReturnType<typeof setup>>["user"]>>;
const send = (u: User, method: string, url: string, data?: object) =>
  u.as(url, { method, ...(data ? { body: JSON.stringify(data) } : {}) });
const attention = async (u: User) => ((await (await u.as("/api/v1/attention")).json()) as { data: AttentionItem[] }).data;

describe("needs attention", () => {
  it("lists what to act on now, urgent first, and drops each thing once it's dealt with", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    const furnace = await ann.addItem({ name: "Furnace" });
    const overdue = (await (await send(ann, "POST", "/api/v1/maintenance", { title: "Replace filter", itemId: furnace.id, dueOn: addDays(today(), -2) })).json()) as { id: string };
    await send(ann, "POST", "/api/v1/maintenance", { title: "Clean gutters", dueOn: addDays(today(), 3) });
    await send(ann, "POST", "/api/v1/maintenance", { title: "Service boiler", dueOn: addDays(today(), 20) }); // not yet

    const tv = await ann.addItem({ name: "TV" });
    await send(ann, "POST", `/api/v1/items/${tv.id}/warranties`, { endsOn: addDays(today(), 10), provider: "LG" });
    await send(ann, "POST", `/api/v1/items/${tv.id}/warranties`, { endsOn: addDays(today(), 50) }); // not yet
    const w = (await (await send(ann, "POST", `/api/v1/items/${tv.id}/warranties`, { endsOn: addDays(today(), 400) })).json()) as { id: string };
    await send(ann, "POST", `/api/v1/warranties/${w.id}/claims`, { problem: "Dead pixels", filedOn: addDays(today(), -20) });
    await send(ann, "POST", `/api/v1/warranties/${w.id}/claims`, { problem: "Remote", filedOn: addDays(today(), -3) }); // too recent
    await ann.addItem({ name: "New item" });

    const list = await attention(ann);
    expect(list.map((a) => [a.kind, a.severity, a.title])).toEqual([
      ["maintenance", "urgent", "Replace filter (Furnace)"],
      ["maintenance", "soon", "Clean gutters"],
      ["warranty", "soon", "TV warranty (LG)"],
      ["claim", "soon", "Claim for TV"],
      ["review", "soon", "A new item to name"],
    ]);
    expect(list[0]).toMatchObject({ detail: "2 days overdue", itemId: furnace.id });

    // Done → gone.
    await send(ann, "POST", `/api/v1/maintenance/${overdue.id}/done`, {});
    expect((await attention(ann)).map((a) => a.title)).not.toContain("Replace filter (Furnace)");

    const bob = await user("bob");
    expect(await attention(bob)).toEqual([]);
  });
});
