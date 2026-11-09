import { describe, expect, it } from "vitest";
import { job, user as userTable } from "../src/db/schema";
import { eq } from "drizzle-orm";
import { withLanguage, jobLanguage } from "../src/lib/i18n";
import { loadSearchDoc, itemSummary } from "../src/lib/search-text";
import { jobSchedule } from "../src/jobs/schedule";
import { VERIFY_EMAIL_JOB } from "../src/lib/email-verification";
import { FakeNotifier, PASSWORD, setup } from "./helpers";

describe("i18n review regressions", () => {
  it("keeps internal search text deterministic and user content untouched", async () => {
    const s = await setup();
    const person = await s.user("index");
    const box = await person.addItem({ name: "Doboz", isContainer: true, description: "Save", notes: "Magyar saját szöveg", links: [{ label: "Kézikönyv", url: "https://example.com/manual" }] });
    await person.addItem({ name: "Tartalom", containerItemId: box.id });
    await person.as(`/api/v1/items/${box.id}/warranties`, { method: "POST", body: JSON.stringify({ endsOn: "2099-01-01", provider: "Jótállás" }) });
    const doc = (await loadSearchDoc(s.db, box.id))!;
    doc.files.push({ kind: "document", analysisStatus: "done", analysis: { description: "Saját leírás", text: "" } } as never);
    const english = withLanguage("en", () => itemSummary(doc));
    expect(withLanguage("hu", () => itemSummary(doc))).toBe(english);
    expect(english).toContain("Box holding: Tartalom");
    expect(english).toContain("Link: Kézikönyv — example.com");
    expect(english).toContain("until 2099-01-01");
    expect(english).toContain("Document: Saját leírás");
    expect(english).toContain("Save\nMagyar saját szöveg");
  });

  it("emails a newly registered unconfirmed account in the requested Hungarian language", async () => {
    const notifier = new FakeNotifier();
    const s = await setup({ notifier, mailUrl: "mailto://test" });
    await s.user("owner");
    const response = await s.app.request("/api/auth/sign-up/email", { method: "POST", headers: { "Content-Type": "application/json", Origin: s.config.PUBLIC_URL, "Accept-Language": "hu-HU" }, body: JSON.stringify({ name: "Új felhasználó", email: "uj@example.com", password: PASSWORD }) });
    expect(response.status).toBe(200);
    const [account] = await s.db.select().from(userTable).where(eq(userTable.email, "uj@example.com"));
    expect(account?.emailVerified).toBe(false);
    const queued = await s.db.select().from(job).where(eq(job.type, VERIFY_EMAIL_JOB));
    expect(queued).toHaveLength(1);
    const payload = JSON.parse(queued[0]!.payload);
    expect(payload.language).toBe("hu");
    const schedule = jobSchedule({ deps: s.deps, files: s.files, auth: s.auth, config: s.config, jobs: s.jobs });
    await schedule.handlers[VERIFY_EMAIL_JOB]!(payload, { lastAttempt: false } as never);
    expect(notifier.sent.at(-1)?.title).toBe("Erősítsd meg a Ferrethez használt e-mail-címedet");
    expect(notifier.sent.at(-1)?.body).toContain("Új felhasználó");
    expect(await jobLanguage(s.db, { email: "uj@example.com", language: "invalid" })).toBe("en");
    await s.db.insert((await import("../src/db/schema")).userLanguage).values({ userId: account!.id, language: "en" });
    expect(await jobLanguage(s.db, payload)).toBe("en");
  });

  it.each([1, 6])("fully localizes combined usage/time maintenance intervals (%s months)", async (count) => {
    const s = await setup();
    const person = await s.user("schedule");
    await person.as("/api/v1/language", { method: "PUT", body: JSON.stringify({ language: "hu" }) });
    const it = await person.addItem({ name: "Autó", usageUnit: "km" });
    await person.as(`/api/v1/items/${it.id}/usage`, { method: "POST", body: JSON.stringify({ value: 100, readOn: "2026-01-01" }) });
    const response = await person.as("/api/v1/maintenance", { method: "POST", body: JSON.stringify({ title: "Olajcsere", itemId: it.id, usageEvery: 5000, intervalCount: count, intervalUnit: "month" }) });
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(201);
    const history = await (await person.as(`/api/v1/items/${it.id}/history`)).json() as { data: { summary: string }[] };
    const text = history.data.map((entry) => entry.summary).join("\n");
    expect(text).toContain("vagy");
    expect(text).toContain(count === 1 ? "havonta" : "6 havonta");
    expect(text).not.toMatch(/\b(month|every|a month)\b/);
  });
});
