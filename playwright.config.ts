import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: { trace: "retain-on-failure" },
  projects: [
    {
      name: "web",
      testMatch: /web\.spec\.ts/,
      use: { baseURL: "http://localhost:4173", browserName: "chromium", viewport: { width: 1280, height: 800 } },
    },
    { name: "electron", testMatch: /electron\.spec\.ts/ },
  ],
  webServer: {
    command: "npm run preview",
    url: "http://localhost:4173",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
