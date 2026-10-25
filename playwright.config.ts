import { defineConfig, devices } from "@playwright/test";

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
    {
      // Android's WebView is Chromium: the same suite at phone size with touch approximates the Capacitor shell.
      name: "mobile",
      testMatch: /web\.spec\.ts/,
      use: { baseURL: "http://localhost:4173", ...devices["Pixel 7"] },
    },
    { name: "electron", testMatch: /(electron|remote|agents)\.spec\.ts/ },
  ],
  webServer: {
    command: "npm run preview",
    url: "http://localhost:4173",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
