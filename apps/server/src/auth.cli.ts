// Used only by `pnpm auth:schema` to (re)generate the Drizzle schema for Better Auth's tables.
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { createAuth } from "./auth";
import { loadConfig } from "./config";
import * as schema from "./db/schema";

const db = drizzle(createClient({ url: ":memory:" }), { schema });
export const auth = createAuth(db, loadConfig({ AUTH_SECRET: "x".repeat(32), FILES_KEY: btoa("x".repeat(32)) }));
