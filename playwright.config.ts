import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "tests/browser",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [["list"], ["junit", { outputFile: "test-results/browser.xml" }]],
  use: {
    baseURL: "http://localhost:3000",
    ...(process.env.PLAYWRIGHT_CHANNEL
      ? { channel: process.env.PLAYWRIGHT_CHANNEL }
      : {}),
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 1000 },
      },
    },
  ],
  webServer: [
    {
      command: "node --import tsx tests/support/browser-server.ts",
      url: "http://127.0.0.1:3000/__test/ready",
      timeout: 120_000,
      reuseExistingServer: false,
      env: { NODE_ENV: "test" },
    },
  ],
});
