import { test, expect } from "@playwright/test";
import { gotoApp, waitForTilesSettled, freezeScene } from "./fixtures";

// Tier 2: a tolerant screenshot baseline of the spawn view. Catches genuinely
// visual regressions (sky, grass, lighting) that scene-graph queries can't.
// The debug HUD is masked because it shows a per-frame FPS counter.
test("spawn view renders sky and textured terrain", async ({ page }) => {
  await gotoApp(page);
  await waitForTilesSettled(page);
  await freezeScene(page);
  await expect(page).toHaveScreenshot("spawn-view.png", {
    mask: [page.locator("#debug-hud")],
    maxDiffPixelRatio: 0.03,
  });
});
