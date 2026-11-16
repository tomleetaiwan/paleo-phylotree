import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  use: {
    channel: "msedge",
    headless: true,
    viewport: { width: 1440, height: 1000 },
    offline: true,
    acceptDownloads: true,
    trace: "retain-on-failure"
  }
});
