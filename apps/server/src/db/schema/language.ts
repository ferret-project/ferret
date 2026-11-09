import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { organization, user } from "./auth";

/** Separate preferences avoid changing Better Auth's generated schema. */
export const userLanguage = sqliteTable("user_language", {
  userId: text("user_id").primaryKey().references(() => user.id, { onDelete: "cascade" }),
  language: text("language", { enum: ["en", "hu"] }).notNull().default("en"),
});
export const householdLanguage = sqliteTable("household_language", {
  householdId: text("household_id").primaryKey().references(() => organization.id, { onDelete: "cascade" }),
  language: text("language", { enum: ["en", "hu"] }).notNull().default("en"),
});
