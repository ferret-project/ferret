/** Warranty claims. */
import { type Overview, today, type WarrantyClaim } from "@ferret/shared";
import { describe, expect, it } from "vitest";
import { setup } from "./helpers";

type User = Awaited<ReturnType<Awaited<ReturnType<typeof setup>>["user"]>>;
const json = async <T>(res: Response | Promise<Response>) => (await (await res).json()) as T;
const send = (u: User, method: string, url: string, data?: object) =>
  u.as(url, { method, ...(data ? { body: JSON.stringify(data) } : {}) });

describe("warranty claims", () => {
  it("are filed under a warranty, followed to a resolution, and counted while open", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    const washer = await ann.addItem({ name: "Washer" });
    const w = await json<{ id: string }>(send(ann, "POST", `/api/v1/items/${washer.id}/warranties`, { endsOn: "2029-01-01", provider: "Maytag" }));

    const filed = await send(ann, "POST", `/api/v1/warranties/${w.id}/claims`, { problem: "Drum won't spin", reference: "MT-55102" });
    expect(filed.status).toBe(201);
    const claim = (await filed.json()) as WarrantyClaim;
    expect(claim).toMatchObject({ itemName: "Washer", warrantyProvider: "Maytag", status: "filed", filedOn: today(), resolvedOn: null });

    const overview = await json<Overview>(ann.as("/api/v1/overview"));
    expect(overview.openClaims.map((c) => c.reference)).toEqual(["MT-55102"]);

    // Approved is still open (the repair hasn't happened); resolving closes it, dated today.
    await send(ann, "PATCH", `/api/v1/claims/${claim.id}`, { status: "approved" });
    expect((await json<{ data: WarrantyClaim[] }>(ann.as("/api/v1/claims?open=true"))).data).toHaveLength(1);
    const resolved = await json<WarrantyClaim>(
      send(ann, "PATCH", `/api/v1/claims/${claim.id}`, { status: "resolved", resolution: "Motor replaced", costCents: 0 }),
    );
    expect(resolved).toMatchObject({ status: "resolved", resolution: "Motor replaced", resolvedOn: today(), costCents: 0 });
    expect((await json<{ data: WarrantyClaim[] }>(ann.as("/api/v1/claims?open=true"))).data).toEqual([]);
    expect((await json<{ data: WarrantyClaim[] }>(ann.as(`/api/v1/claims?itemId=${washer.id}`))).data).toHaveLength(1);

    expect((await send(ann, "POST", `/api/v1/warranties/${w.id}/claims`, { problem: "" })).status).toBe(422);
    expect((await send(ann, "PATCH", `/api/v1/claims/${claim.id}`, { status: "lost" })).status).toBe(422);

    const bob = await user("bob");
    expect((await send(bob, "POST", `/api/v1/warranties/${w.id}/claims`, { problem: "x" })).status).toBe(404);
    expect((await send(bob, "PATCH", `/api/v1/claims/${claim.id}`, { status: "denied" })).status).toBe(404);
    expect((await json<{ data: unknown[] }>(bob.as("/api/v1/claims"))).data).toEqual([]);

    expect((await send(ann, "DELETE", `/api/v1/claims/${claim.id}`)).status).toBe(204);
    expect((await json<{ data: unknown[] }>(ann.as("/api/v1/claims"))).data).toEqual([]);
  });
});
