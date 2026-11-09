import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFileSync } from "node:fs";

let storageState;
let householdId;
let propertyId;
const email = "localization@example.invalid";
const password = "Browser-test-password-2026";

test.beforeAll(async ({ request }) => {
  const signup = await request.post("/api/auth/sign-up/email", { data: { name: "Nyelvi teszt", email, password }, headers: { Origin: "http://127.0.0.1:15173" } });
  expect(signup.ok()).toBeTruthy();
  const signin = await request.post("/api/auth/sign-in/email", { data: { email, password }, headers: { Origin: "http://127.0.0.1:15173" } });
  expect(signin.ok(), await signin.text()).toBeTruthy();
  const household = await request.post("/api/auth/organization/create", { data: { name: "Tesztotthon", slug: "localization-test" }, headers: { Origin: "http://127.0.0.1:15173" } });
  expect(household.ok(), await household.text()).toBeTruthy();
  const home = await household.json();
  householdId = home.id;
  expect((await request.post("/api/auth/organization/set-active", { data: { organizationId: home.id }, headers: { Origin: "http://127.0.0.1:15173" } })).ok()).toBeTruthy();
  expect((await request.put("/api/v1/household/settings", { data: { currency: "HUF", language: "hu" } })).ok()).toBeTruthy();
  expect((await request.put("/api/v1/language", { data: { language: "hu" } })).ok()).toBeTruthy();
  const property = await request.post("/api/v1/properties", { data: { name: "Back", type: "home" } });
  expect(property.ok()).toBeTruthy();
  propertyId = (await property.json()).id;
  const item = await request.post("/api/v1/items", { data: { name: "Akkus fúró", quantity: 2, valueCents: 123450 } });
  expect(item.ok()).toBeTruthy();
  storageState = await request.storageState();
});

test("signed-out selector updates real React copy, HTML lang and persisted preference at mobile width", async ({ page }) => {
  await page.goto("/");
  const selector = page.locator('select[aria-label="Language"]');
  await expect(selector).toBeVisible();
  await selector.selectOption("hu");
  await expect(page.locator("html")).toHaveAttribute("lang", "hu");
  await expect(page.getByRole("heading", { name: "Üdv újra!" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Bejelentkezés", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Üdv újra!" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  const accessibility = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(accessibility.violations).toEqual([]);
  await page.screenshot({ path: test.info().outputPath("hungarian-sign-in-mobile.png"), fullPage: true });
  await page.getByRole("combobox", { name: "Nyelv", exact: true }).selectOption("en");
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
});

test("account selection round-trips to the server and survives a fresh browser context", async ({ browser }) => {
  const context = await browser.newContext({ storageState, viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await page.goto("/#/settings");
  await expect(page.getByRole("heading", { name: "Beállítások", exact: true })).toBeVisible();
  const selector = page.getByRole("combobox", { name: "Nyelv", exact: true });
  await expect(selector).toHaveValue("hu");
  await selector.selectOption("en");
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
  expect((await (await context.request.get("/api/v1/language")).json()).language).toBe("en");
  await page.getByRole("combobox", { name: "Language", exact: true }).selectOption("hu");
  await expect(page.getByRole("heading", { name: "Beállítások", exact: true })).toBeVisible();
  expect((await (await context.request.get("/api/v1/language")).json()).language).toBe("hu");
  expect((await (await context.request.get("/api/v1/household/settings")).json()).currency).toBe("HUF");
  const state = await context.storageState();
  await context.close();
  const fresh = await browser.newContext({ storageState: { cookies: state.cookies, origins: [] } });
  const freshPage = await fresh.newPage();
  await freshPage.goto("/#/settings");
  await expect(freshPage.locator("html")).toHaveAttribute("lang", "hu");
  await fresh.close();
});

test("Hungarian screens render without crashes or horizontal overflow on mobile and desktop", async ({ browser }) => {
  const context = await browser.newContext({ storageState });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const route of ["", "items", "places", "maintenance", "shopping", "report", "settings", "settings/notifications", "settings/security"]) {
      await page.goto(`/#/${route}`);
      await expect(page.locator("html")).toHaveAttribute("lang", "hu");
      await expect(page.locator("main")).toBeVisible();
      await page.waitForTimeout(150);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `overflow: ${route} at ${width}px`).toBeTruthy();
    }
  }
  await page.goto("/#/items");
  await expect(page.getByText("Akkus fúró", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/Ft/).first()).toBeVisible();
  await page.goto("/#/places");
  await expect(page.getByText("Back", { exact: true }).first()).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  // The app animates desktop sidebar padding for 200 ms after crossing its breakpoint.
  await page.waitForTimeout(350);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: test.info().outputPath("hungarian-places-mobile.png"), fullPage: true });
  expect(errors).toEqual([]);
  await context.close();
});

// Mount the actual production components with their normal React Query provider, keeping browser IndexedDB and API real.
async function mountCaptureComponent(page, component, home, language) {
  await page.evaluate(async ({ component, home, language }) => {
    // Resolve Vite's exact optimized-module URLs (including cache query), avoiding duplicate context instances.
    const imports = async (file) => [...(await (await fetch(file)).text()).matchAll(/from ["']([^"']+)["']/g)].map((match) => match[1]);
    const componentImports = await imports("/src/PhotoAdd.tsx");
    const mainImports = await imports("/src/main.tsx");
    const reactModule = await import(componentImports.find((url) => /\/react\.js/.test(url)));
    const React = reactModule.default ?? reactModule;
    const domModule = await import(mainImports.find((url) => /react-dom_client/.test(url)));
    const { createRoot } = domModule.default ?? domModule;
    const { QueryClient, QueryClientProvider } = await import(componentImports.find((url) => url.includes("react-query")));
    const { setLanguage } = await import("/src/i18n.tsx");
    setLanguage(language);
    window.__captureRoot?.unmount();
    document.getElementById("root").style.display = "none";
    let target = document.getElementById("capture-regression");
    if (!target) { target = document.createElement("div"); target.id = "capture-regression"; document.body.append(target); }
    window.__captureRoot = createRoot(target);
    const Component = component === "AddFromPhotos" ? (await import("/src/PhotoAdd.tsx")).AddFromPhotos : (await import("/src/Offline.tsx"))[component];
    window.__captureRoot.render(React.createElement(QueryClientProvider, { client: new QueryClient() }, React.createElement(Component, component === "OfflineCapture" ? { home } : { householdId: home.householdId })));
  }, { component, home, language });
}

for (const language of ["en", "hu"]) test(`capture sentinels and room-scan status remain stable in ${language}`, async ({ browser }) => {
  const context = await browser.newContext({ storageState });
  const page = await context.newPage();
  expect((await context.request.put("/api/v1/language", { data: { language } })).ok()).toBeTruthy();
  await page.goto("/#/settings");
  await expect(page.locator("html")).toHaveAttribute("lang", language);
  await expect(page.locator("main")).toBeVisible();
  const roomResponse = await context.request.post("/api/v1/locations", { data: { name: `Capture room ${language}`, propertyId } });
  expect(roomResponse.ok(), await roomResponse.text()).toBeTruthy();
  const room = await roomResponse.json();
  const places = await (await context.request.get("/api/v1/places")).json();
  const home = { householdId, householdName: "User data Save", places };
  const image = { name: "capture.png", mimeType: "image/png", buffer: await page.screenshot() };
  const target = page.locator("#capture-regression");

  await mountCaptureComponent(page, "AddFromPhotos", home, language);
  const photoCreated = page.waitForResponse((r) => r.url().endsWith("/api/v1/items") && r.request().method() === "POST");
  await target.locator('input[type="file"]').setInputFiles(image);
  const photoResponse = await photoCreated;
  expect(photoResponse.request().postDataJSON()).toMatchObject({ name: "New item", origin: "photos" });
  expect((await photoResponse.json()).name).toBe("New item");

  await mountCaptureComponent(page, "OfflineCapture", home, language);
  await target.locator("#offline-place").click();
  await expect(target.getByRole("option", { name: language === "hu" ? "Nincs helyiségben" : "Not in a room", exact: true })).toBeVisible();
  await target.getByRole("option", { name: new RegExp(`Capture room ${language}`) }).click();
  await target.locator('input[type="file"][multiple]').first().setInputFiles(image);
  const catalog = JSON.parse(readFileSync(new URL(`../../../packages/shared/src/locales/${language}.json`, import.meta.url), "utf8"));
  const translate = (_language, source) => catalog[source] ?? source;
  await expect(target.getByRole("status")).toHaveText(translate(language, "Room scan saved — Ferret looks at it once there's signal, and the bell says when it's ready."));
  expect(await page.evaluate(async (householdId) => (await (await import("/src/lib/offline.ts")).listCaptures(householdId)).some((c) => c.kind === "roomscan"), householdId)).toBeTruthy();

  // Use the real offline upload path; a localized display preference must not become a stored name.
  const offlineCreated = page.waitForResponse((r) => r.url().endsWith("/api/v1/items") && r.request().method() === "POST");
  await page.evaluate(async ({ householdId, bytes }) => {
    const offline = await import("/src/lib/offline.ts");
    await offline.forgetOffline();
    await offline.addCapture({ id: crypto.randomUUID(), householdId, createdAt: Date.now(), kind: "photo", blob: new Blob([Uint8Array.from(atob(bytes), c => c.charCodeAt(0))], { type: "image/png" }), filename: "offline.png", locationId: null, note: "Save" });
    await offline.syncCaptures(householdId);
  }, { householdId, bytes: image.buffer.toString("base64") });
  const offlineResponse = await offlineCreated;
  expect(offlineResponse.request().postDataJSON()).toMatchObject({ name: "New item", notes: "Save", origin: "photos" });

  await page.evaluate(async (householdId) => {
    const offline = await import("/src/lib/offline.ts");
    await offline.forgetOffline();
    await offline.addCapture({ id: crypto.randomUUID(), householdId, createdAt: Date.now(), kind: "scan", code: "REVIEW-SCAN", mode: "add", result: { action: "unknown" } });
  }, householdId);
  await mountCaptureComponent(page, "CapturesCard", home, language);
  const scanCreated = page.waitForResponse((r) => r.url().endsWith("/api/v1/items") && r.request().method() === "POST");
  await target.getByRole("button", { name: translate(language, "Add it as a new thing"), exact: true }).click();
  const scanResponse = await scanCreated;
  expect(scanResponse.request().postDataJSON()).toMatchObject({ name: "New item", barcode: "REVIEW-SCAN", origin: "scan" });
  expect((await scanResponse.json()).name).toBe("New item");
  await context.close();
});
