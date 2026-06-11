import { defineConfig } from "@playwright/test";

// E2E / visual tests for the Empires client. Tests load the app in ?test mode
// (WebGL2, no network, scene exposed) and assert against the live Babylon scene,
// plus a small number of tolerant screenshot baselines.
//
// Determinism note: screenshot baselines are GPU/driver dependent. They're
// generated on whatever machine runs `npm run test:update`. For CI, regenerate
// them inside the CI container (or pin a software renderer) rather than reusing
// a developer's local baselines.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1, // one shared dev server + GPU; keep runs serial and stable
  retries: process.env.CI ? 2 : 0,
  reporter: [["list"]],
  timeout: 60_000,
  expect: {
    timeout: 15_000,
    toHaveScreenshot: { maxDiffPixelRatio: 0.03 },
  },
  use: {
    baseURL: "http://localhost:5173",
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    screenshot: "only-on-failure",
    trace: "on-first-retry",
  },
  // Use the installed Google Chrome rather than Playwright's bundled
  // chromium-headless-shell: the latter stalls Babylon's Draco/glTF streaming
  // (terrain never fully loads), while real Chrome streams the scene to
  // completion. Requires Chrome to be installed.
  projects: [{ name: "chrome", use: { browserName: "chromium", channel: "chrome" } }],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:5173",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
