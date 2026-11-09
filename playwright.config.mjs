import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./apps/web/test",
  testMatch: "**/*.spec.mjs",
  workers: 1,
  timeout: 45_000,
  use: { baseURL: "http://127.0.0.1:15173", viewport: { width: 390, height: 844 }, trace: "retain-on-failure", screenshot: "only-on-failure" },
  webServer: [
    { command: "pnpm --filter @ferret/server exec tsx test/browser-server.ts", url: "http://127.0.0.1:18887/healthz", reuseExistingServer: false, timeout: 60_000 },
    { command: "pnpm --filter @ferret/web exec vite --host 127.0.0.1 --port 15173 --strictPort", url: "http://127.0.0.1:15173", env: { FERRET_API_PROXY: "http://127.0.0.1:18887" }, reuseExistingServer: false, timeout: 60_000 },
  ],
});
