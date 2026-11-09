import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { translate, languageOf } from "@ferret/shared/i18n";
import { describeInterval, describeUsage, formatMoney } from "@ferret/shared";
import { member, userLanguage } from "../src/db/schema";
import { currentLanguage, preferredLanguage, withLanguage } from "../src/lib/i18n";
import { masterKeyId } from "../src/lib/files";
import { householdLocale } from "../src/lib/household-time";
import { dailyDigest } from "../src/jobs/remind";
import { weeklyDigest } from "../src/lib/digest";
import { jobSchedule } from "../src/jobs/schedule";
import { SECURITY_ALERT_JOB } from "../src/jobs/security-alert";
import { sendLoanReminders } from "../src/lib/loans";
import { FakeNotifier, FakePush, photo, setup } from "./helpers";

const json = async (response: Response | Promise<Response>) => (await response).json();
type Person = Awaited<ReturnType<Awaited<ReturnType<typeof setup>>["user"]>>;
const send = (person: Person, method: string, url: string, input?: object) => person.as(url, { method, ...(input ? { body: JSON.stringify(input) } : {}) });

async function who(db: Awaited<ReturnType<typeof setup>>["db"], householdId: string) {
  const [row] = await db.select({ userId: member.userId }).from(member).where(eq(member.organizationId, householdId));
  return row!.userId;
}

describe("English and Hungarian localization", () => {
  it("falls back to English and interpolates values once, without interpreting their contents", () => {
    expect(languageOf("hu-HU")).toBe("hu");
    expect(languageOf("de-DE")).toBe("en");
    expect(translate("hu", "Save")).toBe("Mentés");
    expect(translate("hu", "New source message {v0}", { v0: "<script>{v1}</script>" })).toBe("New source message <script>{v1}</script>");
    expect(translate("en", "{v0} selected", { v0: 0 })).toBe("0 selected");
    expect(translate("hu", "s")).toBe("");
  });

  it("keeps concurrent asynchronous request/job languages isolated", async () => {
    const results = await Promise.all(["en", "hu"].map((language) => withLanguage(language as "en" | "hu", async () => {
      await new Promise((resolve) => setTimeout(resolve, language === "en" ? 10 : 1));
      return currentLanguage();
    })));
    expect(results).toEqual(["en", "hu"]);
    expect(currentLanguage()).toBe("en");
  });

  it("formats Hungarian units and HUF without converting stored amounts", () => {
    expect(describeInterval(3, "month", "hu")).toBe("3 havonta");
    expect(describeUsage(1500, "hours", "hu")).toBe(`${(1500).toLocaleString("hu-HU")} óra`);
    // ICU/CLDR versions can differ in HUF decimal/grouping defaults; never force punctuation or convert the amount.
    expect(formatMoney(123450, "HUF", { exact: true, locale: "hu-HU" })).toContain("Ft");
    expect(formatMoney(123450, "HUF", { exact: true, locale: "en-US" })).toContain("1,23");
  });

  it("persists personal and household preferences, checks roles, and rejects unsupported languages", async () => {
    const { user, db } = await setup();
    const person = await user("nyelv");
    const id = await who(db, person.householdId);
    expect(await json(person.as("/api/v1/language"))).toMatchObject({ language: "en", personal: false });
    await send(person, "PUT", "/api/v1/household/settings", { language: "hu", currency: "HUF" });
    expect(await preferredLanguage(db, id, person.householdId)).toBe("hu");
    expect((await send(person, "PUT", "/api/v1/language", { language: "en" })).status).toBe(200);
    expect(await preferredLanguage(db, id, person.householdId)).toBe("en");
    expect((await send(person, "PUT", "/api/v1/language", { language: "xx" })).status).toBe(422);
    expect(await json(person.as("/api/v1/household/settings"))).toMatchObject({ language: "hu", currency: "HUF" });
    await db.update(member).set({ role: "viewer" }).where(eq(member.organizationId, person.householdId));
    expect((await send(person, "PUT", "/api/v1/household/settings", { language: "en" })).status).toBe(403);
    expect((await send(person, "PUT", "/api/v1/language", { language: "hu" })).status).toBe(200);
  });

  it("localizes validation and auth errors without changing codes, IDs, enum values, headers or encryption", async () => {
    const { user, app, config } = await setup();
    const person = await user("adat");
    await send(person, "PUT", "/api/v1/language", { language: "hu" });
    const invalid = await send(person, "POST", "/api/v1/items", { name: "", quantity: -1 });
    expect(invalid.status).toBe(422);
    const error = await invalid.json() as { error: { code: string; message: string; details: { message: string }[] } };
    expect(error.error).toMatchObject({ code: "http_422", message: "Érvénytelen adatok" });
    expect(error.error.details[0]!.message).not.toContain("Too small");
    const item = await person.addItem({ name: "Back", condition: "good", quantity: 2, valueCents: 123450 });
    expect(await json(person.as(`/api/v1/items/${item.id}`))).toMatchObject({ id: item.id, name: "Back", condition: "good", quantity: 2, valueCents: 123450 });
    const csv = await person.as("/api/v1/export/items.csv");
    expect(csv.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    const bytes = await photo();
    const attachment = await person.upload(item.id, bytes, "test.jpg");
    const download = await person.as(`/api/v1/attachments/${attachment.id}/content`);
    expect(download.status).toBe(200);
    expect(download.headers.get("Cache-Control")).toBe("private, max-age=86400");
    const englishKey = await withLanguage("en", () => masterKeyId(config.FILES_KEY));
    const hungarianKey = await withLanguage("hu", () => masterKeyId(config.FILES_KEY));
    expect(hungarianKey).toBe(englishKey);
    const login = await app.request("/api/auth/sign-in/email", { method: "POST", headers: { "Content-Type": "application/json", "Accept-Language": "hu", Origin: config.PUBLIC_URL }, body: JSON.stringify({ email: "adat@example.com", password: "wrong-password" }) });
    expect(login.status).toBe(401);
    expect(await login.json()).toMatchObject({ code: "INVALID_EMAIL_OR_PASSWORD", message: "Hibás e-mail-cím vagy jelszó" });
  });

  it("uses the persisted personal language in push tests and scheduled security messages", async () => {
    const push = new FakePush();
    const s = await setup({ push });
    const person = await s.user("ertesites");
    const userId = await who(s.db, person.householdId);
    await send(person, "PUT", "/api/v1/language", { language: "hu" });
    expect((await send(person, "POST", "/api/v1/push/subscribe", { endpoint: "https://fcm.googleapis.com/localization-test", keys: { p256dh: "test", auth: "test" } })).status).toBe(204);
    await send(person, "POST", "/api/v1/push/test");
    expect(push.sent[0]?.title).toBe("A Ferret emlékeztetői be vannak kapcsolva");
    const schedule = jobSchedule({ deps: s.deps, files: s.files, auth: s.auth, config: s.config, jobs: s.jobs });
    await schedule.handlers[SECURITY_ALERT_JOB]!({ userId, failures: 5, ipAddress: "192.0.2.1" }, { lastAttempt: false } as never);
    expect(push.sent.at(-1)?.title).toBe("Valaki a Ferret-jelszavaddal próbálkozik");
    expect(push.sent.at(-1)?.body).toContain("192.0.2.1");
    expect(push.sent.at(-1)?.url).toContain("/#/settings/security");
  });

  it("builds daily and weekly digests outside a browser in the recipient's language", async () => {
    const s = await setup();
    const person = await s.user("osszefoglalo");
    const userId = await who(s.db, person.householdId);
    await send(person, "PUT", "/api/v1/language", { language: "hu" });
    expect((await send(person, "POST", "/api/v1/maintenance", { title: "Szűrőcsere", dueOn: "2020-01-01" })).status).toBe(201);
    const caller = { deps: s.deps, db: s.db, householdId: person.householdId, userId, ...(await householdLocale(s.db, person.householdId)), via: "web" as const };
    const daily = await dailyDigest(caller, "https://ferret.example");
    expect(daily?.title).toBe("Elmaradt karbantartás");
    expect(daily?.short).toContain("Szűrőcsere");
    const weekly = await weeklyDigest(caller, "https://ferret.example");
    expect(weekly?.title).toContain("Heti Ferret-összefoglaló");
    expect(weekly?.body).toContain("Karbantartás");
    await send(person, "PUT", "/api/v1/language", { language: "en" });
    expect((await dailyDigest(caller, "https://ferret.example"))?.title).toBe("Overdue maintenance");
  });

  it("uses the household's language for an external borrower's reminder", async () => {
    const notifier = new FakeNotifier();
    const s = await setup({ notifier, mailUrl: "mailto://localization-test" });
    const person = await s.user("kolcson");
    await send(person, "PUT", "/api/v1/household/settings", { language: "hu" });
    const item = await person.addItem({ name: "Létra" });
    const loan = await send(person, "POST", `/api/v1/items/${item.id}/loans`, { direction: "lent", person: "Samu", email: "borrower@example.invalid", since: "2020-01-01", remindEvery: "week" });
    expect(loan.status).toBe(201);
    await sendLoanReminders({ ...s.deps, files: s.files, mailUrl: "mailto://localization-test", appUrl: "https://ferret.example", on: "2099-01-01" });
    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0]?.title).toContain("Létra");
    expect(notifier.sent[0]?.body).toContain("Samu");
    expect(notifier.sent[0]?.body).not.toContain("lent you");
  });
});
