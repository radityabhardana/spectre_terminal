import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  retries: 0,
  reporter: "line",
  use: {
    baseURL: "http://127.0.0.1:8790",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node e2e/server.js",
    url: "http://127.0.0.1:8790",
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ENABLE_LIVE_TRADING: "false",
      WEB_HOST: "127.0.0.1",
      WEB_PORT: "8790",
    },
  },
  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1000 } },
    },
    {
      name: "mobile",
      use: { ...devices["iPhone 13"], browserName: "chromium" },
    },
  ],
});
