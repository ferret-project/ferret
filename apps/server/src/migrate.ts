// Apply migrations without starting the server: `pnpm db:migrate`
import path from "node:path";
import { createLocalDb, runMigrations } from "./adapters/local/db";

const dataDir = path.resolve(process.env.DATA_DIR ?? "./data");
const { db } = createLocalDb(`file:${path.join(dataDir, "ferret.db")}`);
await runMigrations(db, path.resolve("migrations"));
console.log("migrations applied");
