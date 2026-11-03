import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL: "http://127.0.0.1:4187",
    locale: "en-US",
    screenshot: "only-on-failure",
    trace: "on-first-retry",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "smoke",
      testMatch: ["**/smoke.spec.ts"],
      use: {
        ...devices["Desktop Chrome"],
      },
    },
    {
      name: "p0",
      testMatch: ["**/p0.spec.ts"],
      use: {
        ...devices["Desktop Chrome"],
      },
    },
    {
      name: "moderation",
      testMatch: ["**/moderation.spec.ts"],
      use: {
        ...devices["Desktop Chrome"],
      },
    },
    {
      name: "workflows",
      testMatch: ["**/workflows.spec.ts"],
      use: {
        ...devices["Desktop Chrome"],
      },
    },
    {
      name: "notifications",
      testMatch: ["**/notifications.spec.ts"],
      use: {
        ...devices["Desktop Chrome"],
        // The bundled headless shell reports Notification.permission as denied; the full Chromium
        // build in new headless mode reports and stores notifications like a normal browser.
        channel: "chromium",
      },
    },
  ],
  webServer: {
    command: "npx vite preview --port 4187 --strictPort --host 127.0.0.1",
    cwd: ".",
    reuseExistingServer: false,
    url: "http://127.0.0.1:4187",
  },
});
