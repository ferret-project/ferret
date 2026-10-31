/** SQL helpers that work the same on every SQLite Ferret runs on (libSQL, and others with tighter limits). */
import { type AnyColumn, type SQL, sql } from "drizzle-orm";

/**
 * `column IN (values)`, with the whole list bound as one value (a JSON array, read back by `json_each`) instead of one
 * parameter per entry: some SQLite databases allow only 100 bound parameters a query, and a household can have more rooms, things or files
 * than that. Use it for any list that grows with the household; a short fixed list can stay `inArray`.
 */
export const inList = (column: AnyColumn | SQL, values: readonly (string | number)[]): SQL =>
  values.length ? sql`${column} in (select value from json_each(${JSON.stringify(values)}))` : sql`0`;
