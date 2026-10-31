/** HomeKit / Matter pairing codes on items: sealed, shown on request (not to viewers or keys), found by scanning, never looked up. */
import type { PairingCodeSummary, ScanResult } from "@ferret/shared";
import { unzipSync } from "fflate";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { activity, member, pairingCode } from "../src/db/schema";
import { FakeProducts, setup } from "./helpers";

type User = Awaited<ReturnType<Awaited<ReturnType<typeof setup>>["user"]>>;
const json = async <T>(res: Response | Promise<Response>) => (await (await res).json()) as T;
const send = (u: User, method: string, url: string, data?: object) => u.as(url, { method, ...(data ? { body: JSON.stringify(data) } : {}) });
const HOMEKIT = "X-HM://00U90Q99FMI2D"; // 822-04-003, a shower system
const MATTER = "MT:Y.K9042C00KA0648G00"; // 3497-011-2332

describe("pairing codes", () => {
  it("are saved sealed, listed without the code, and shown on request (logged)", async () => {
    const { db, user } = await setup();
    const ann = await user("ann");
    const shower = await ann.addItem({ name: "Moen shower" });
    const added = await json<PairingCodeSummary>(send(ann, "POST", `/api/v1/items/${shower.id}/pairing`, { code: HOMEKIT, label: "Main bath" }));
    expect(added).toMatchObject({ kind: "homekit", label: "Main bath", category: "Shower system", hasQr: true });
    await send(ann, "POST", `/api/v1/items/${shower.id}/pairing`, { code: "3497 011 2332" });

    const listed = await json<{ data: PairingCodeSummary[] }>(ann.as(`/api/v1/items/${shower.id}/pairing`));
    expect(listed.data.map((p) => [p.kind, p.hasQr])).toEqual([["homekit", true], ["matter", false]]);
    // The whole code and the QR's payload: three digits alone turn up in ids and timestamps by chance.
    expect(JSON.stringify(listed)).not.toContain("822-04-003");
    expect(JSON.stringify(listed)).not.toContain("00U90Q99FMI2D");

    const [row] = await db.select().from(pairingCode).where(eq(pairingCode.id, added.id));
    // (The sealed text is random base64, so "822" alone would turn up now and then.)
    expect(row!.sealed).not.toContain("822-04-003");
    expect(row!.sealed).not.toContain("X-HM");
    expect(row!.sealed).not.toContain("00U90Q99FMI2D");

    expect(await json(send(ann, "POST", `/api/v1/items/${shower.id}/pairing/${added.id}/reveal`))).toEqual({
      code: "822-04-003",
      payload: HOMEKIT,
      details: { setupId: "MI2D", categoryNumber: 30, flags: 10, version: 0 },
    });
    const log = await db.select({ summary: activity.summary }).from(activity).where(eq(activity.entityId, shower.id));
    expect(log.map((a) => a.summary)).toContain("Showed the HomeKit code for Moen shower");

    expect((await send(ann, "DELETE", `/api/v1/items/${shower.id}/pairing/${added.id}`)).status).toBe(204);
    expect((await json<{ data: unknown[] }>(ann.as(`/api/v1/items/${shower.id}/pairing`))).data).toHaveLength(1);
  });

  it("refuses what isn't a code, and the same code twice", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    const lock = await ann.addItem({ name: "Back door lock" });
    const other = await ann.addItem({ name: "Something else" });
    expect((await send(ann, "POST", `/api/v1/items/${lock.id}/pairing`, { code: "hello" })).status).toBe(422);
    expect((await send(ann, "POST", `/api/v1/items/${lock.id}/pairing`, { code: "3497-011-2333" })).status).toBe(422); // check digit
    await send(ann, "POST", `/api/v1/items/${lock.id}/pairing`, { code: MATTER });
    expect(await json(send(ann, "POST", `/api/v1/items/${lock.id}/pairing`, { code: MATTER }))).toMatchObject({ error: { message: "That code is already saved here" } });
    expect(await json(send(ann, "POST", `/api/v1/items/${other.id}/pairing`, { code: MATTER }))).toMatchObject({ error: { message: "That code is already saved on Back door lock" } });
    expect((await send(ann, "PUT", `/api/v1/items/${lock.id}/stock-rules`, { code: MATTER, behaviour: "use" })).status).toBe(422);
  });

  it("are shown to editors only — not viewers, not API keys, not other households", async () => {
    const { db, user } = await setup();
    const ann = await user("ann");
    const bob = await user("bob");
    const lock = await ann.addItem({ name: "Back door lock" });
    const p = await json<PairingCodeSummary>(send(ann, "POST", `/api/v1/items/${lock.id}/pairing`, { code: HOMEKIT }));
    const reveal = `/api/v1/items/${lock.id}/pairing/${p.id}/reveal`;

    expect((await send(bob, "POST", reveal)).status).toBe(404);
    const bobId = (await db.query.user.findFirst({ where: (u, { eq }) => eq(u.name, "bob") }))!.id;
    await db.insert(member).values({ id: crypto.randomUUID(), organizationId: ann.householdId, userId: bobId, role: "viewer", createdAt: new Date() });
    const asViewer = (url: string, init: RequestInit = {}) => bob.as(url, { ...init, headers: { "X-Household-Id": ann.householdId } });
    expect((await json<{ data: unknown[] }>(asViewer(`/api/v1/items/${lock.id}/pairing`))).data).toHaveLength(1); // can see there is one
    expect((await asViewer(reveal, { method: "POST" })).status).toBe(403);

    const key = await json<{ key: string }>(send(ann, "POST", "/api/v1/api-keys", { name: "script" }));
    expect((await ann.as(reveal, { method: "POST", headers: { Cookie: "", Authorization: `Bearer ${key.key}` } })).status).toBe(403);
  });

  it("scanning a pairing QR opens its item, or asks which item it's for — and never reaches the barcode lookup", async () => {
    const products = new FakeProducts({});
    const { user, jobs } = await setup({ products });
    const ann = await user("ann");
    const scan = (code: string) => json<ScanResult>(send(ann, "POST", "/api/v1/scan", { code }));
    expect(await scan(MATTER)).toEqual({ action: "pairing", kind: "matter", category: null });
    expect(await scan(HOMEKIT)).toEqual({ action: "pairing", kind: "homekit", category: "Shower system" });

    const shower = await ann.addItem({ name: "Moen shower" });
    await send(ann, "POST", `/api/v1/items/${shower.id}/pairing`, { code: HOMEKIT });
    expect(await scan(HOMEKIT.toLowerCase())).toMatchObject({ action: "open", item: { id: shower.id } });

    // Typed into the barcode field or looked up: not a barcode.
    expect(await json(ann.as(`/api/v1/barcodes/${encodeURIComponent(MATTER)}`))).toMatchObject({ match: null });
    await ann.addItem({ name: "Oops", barcode: MATTER });
    await jobs.drain();
    expect(products.calls).toEqual([]);
  });

  it("are in Download everything", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    const lock = await ann.addItem({ name: "Back door lock" });
    await send(ann, "POST", `/api/v1/items/${lock.id}/pairing`, { code: MATTER, label: "Back door" });
    const zip = unzipSync(new Uint8Array(await (await ann.as("/api/v1/export/everything.zip")).arrayBuffer()));
    const data = JSON.parse(new TextDecoder().decode(zip[Object.keys(zip).find((n) => n.endsWith("ferret.json"))!]!)) as { items: { pairingCodes: unknown[] }[] };
    expect(data.items[0]!.pairingCodes).toEqual([{ kind: "Matter", label: "Back door", category: null, code: "3497-011-2332", qr: MATTER }]);
  });
});
