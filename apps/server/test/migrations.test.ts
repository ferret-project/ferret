/** Migrations that change rows, run on rows as they were before (both SQLite and D1, through test/db.ts). */
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { testDbBefore } from "./db";

describe("0060: files on places and tasks (the attachment table rebuilt)", () => {
  it("keeps every file and the warranties', tasks' and suggested tasks' links to them", async () => {
    const { db, finish } = await testDbBefore("0060_files_on_places");
    await db.run(sql`insert into organization (id, name, slug, created_at) values ('h1', 'Home', 'home', 0)`);
    await db.run(sql`insert into item (id, household_id, name) values ('i1', 'h1', 'Furnace')`);
    await db.run(sql`insert into attachment (id, household_id, item_id, kind, filename, content_type, size, blob_key, analysis_status, main_at)
      values ('a1', 'h1', 'i1', 'document', 'manual.pdf', 'application/pdf', 100, 'k1', 'done', null),
             ('a2', 'h1', 'i1', 'photo', 'front.jpg', 'image/jpeg', 50, 'k2', null, 5)`);
    await db.run(sql`insert into warranty (id, household_id, item_id, ends_on, attachment_id, updated_at) values ('w1', 'h1', 'i1', '2030-01-01', 'a1', 7)`);
    await db.run(sql`insert into maintenance_task (id, household_id, item_id, title, attachment_id) values ('t1', 'h1', 'i1', 'Change filter', 'a1')`);
    await db.run(sql`insert into maintenance_task (id, household_id, title) values ('t2', 'h1', 'Clean gutters')`);
    await db.run(sql`insert into suggested_task (id, household_id, item_id, title, title_key, interval_count, interval_unit, source, attachment_id)
      values ('s1', 'h1', 'i1', 'Filter', 'filter', 3, 'month', 'manual', 'a1')`);

    await finish();

    const files = await db.all<{ id: string; item_id: string | null; property_id: string | null; analysis_status: string | null; main_at: number | null }>(
      sql`select id, item_id, property_id, analysis_status, main_at from attachment order by id`,
    );
    expect(files).toEqual([
      { id: "a1", item_id: "i1", property_id: null, analysis_status: "done", main_at: null },
      { id: "a2", item_id: "i1", property_id: null, analysis_status: null, main_at: 5 },
    ]);
    expect(await db.all(sql`select id, attachment_id, updated_at from warranty`)).toEqual([{ id: "w1", attachment_id: "a1", updated_at: 7 }]);
    expect(await db.all(sql`select id, attachment_id from maintenance_task order by id`)).toEqual([
      { id: "t1", attachment_id: "a1" },
      { id: "t2", attachment_id: null },
    ]);
    expect(await db.all(sql`select id, attachment_id from suggested_task`)).toEqual([{ id: "s1", attachment_id: "a1" }]);
    expect(await db.all(sql`select name from sqlite_master where name in ('__attachment_links', '__new_attachment')`)).toEqual([]);

    // Now: exactly one owner.
    await db.run(sql`insert into attachment (id, household_id, task_id, kind, filename, content_type, size, blob_key) values ('a3', 'h1', 't2', 'document', 'invoice.pdf', 'application/pdf', 1, 'k3')`);
    await expect(db.run(sql`insert into attachment (id, household_id, kind, filename, content_type, size, blob_key) values ('a4', 'h1', 'photo', 'x.jpg', 'image/jpeg', 1, 'k4')`)).rejects.toThrow();
    await expect(
      db.run(sql`insert into attachment (id, household_id, item_id, task_id, kind, filename, content_type, size, blob_key) values ('a5', 'h1', 'i1', 't2', 'photo', 'x.jpg', 'image/jpeg', 1, 'k5')`),
    ).rejects.toThrow();
  });
});
