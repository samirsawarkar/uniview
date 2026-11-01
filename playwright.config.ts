import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";

// Electron tests must not touch the shared default profile in AppData (locked by any other running copy).
process.env.UNIVIEW_USER_DATA ||= fileURLToPath(new URL("./test-results/electron-profile", import.meta.url));

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
    { name: "electron", testMatch: /(electron|remote|agents|agents-reload)\.spec\.ts/ },
  ],
  webServer: {
    command: "npm run preview",
    url: "http://localhost:4173",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
