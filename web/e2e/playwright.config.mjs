import { defineConfig } from "@playwright/test";

// Serves the assembled site (../../_site) and runs the tests in Chromium.
export default defineConfig({
  testDir: ".",
  timeout: 180_000,
  use: { baseURL: "http://127.0.0.1:8123/" },
  webServer: {
    command: "python3 -m http.server 8123 --bind 127.0.0.1 --directory ../../_site",
    url: "http://127.0.0.1:8123/",
    reuseExistingServer: false,
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
