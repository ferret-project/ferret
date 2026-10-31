import { describe, expect, it } from "vitest";
import { item } from "../src/db/schema";
import { inList } from "../src/lib/sql";
import { setup } from "./helpers";

describe("inList", () => {
  it("matches a list of any length with one bound value (some SQLite databases allow 100 a query)", async () => {
    const { user, db } = await setup();
    const ann = await user("ann");
    const a = await ann.addItem({ name: "Drill" });
    const b = await ann.addItem({ name: "Saw" });
    const ids = [a.id, ...Array.from({ length: 250 }, (_, i) => `missing-${i}`), b.id];

    const found = await db.select({ name: item.name }).from(item).where(inList(item.id, ids)).orderBy(item.name);
    expect(found.map((r) => r.name)).toEqual(["Drill", "Saw"]);
    const query = db.select({ id: item.id }).from(item).where(inList(item.id, ids)).toSQL();
    expect(query.params).toHaveLength(1);
    // Nothing to match: no rows, and no SQL error.
    expect(await db.select().from(item).where(inList(item.id, []))).toEqual([]);
  });
});
