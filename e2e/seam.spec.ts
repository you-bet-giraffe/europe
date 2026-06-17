import { test, expect } from "@playwright/test";
import { gotoApp, waitForTilesSettled } from "./fixtures";

// Demonstrates a known bug: adjacent terrain tiles don't share their edge
// geometry, so thin T-junction cracks open along the seams between world tiles.
// At a grazing view the background shows straight through them as white lines.
// Reproduces at a seam near scene-space (253429, 0.8, 309882), framed by the
// camera at (253505, 23.5, 309956) — the same transforms used to spot it by eye.
//
// The test renders that view with the skybox removed and a vivid magenta clear
// colour, then counts magenta pixels that appear *below* the terrain silhouette
// in each column — i.e. background visible through a hole, not the open sky
// above the horizon. A seamless terrain leaks zero such pixels.
//
// Marked test.fail() because the gaps are still present: this keeps the suite
// green while documenting the defect, and will turn into a hard failure (an
// unexpected pass) once tiles are stitched/skirted — at which point drop the
// test.fail() so it guards against regressions.
test("no background shows through world-tile seams", async ({ page }) => {
  test.fail();
  await gotoApp(page);

  // Drop the player onto the seam so terrain streams in around it.
  await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = (window as any).__scene;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    s.meshes.find((m: any) => m.name === "player").position.set(253429, 0.8, 309882);
  });
  await waitForTilesSettled(page);

  const r = await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = (window as any).__scene;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const player = s.meshes.find((m: any) => m.name === "player");
    const cam = s.activeCamera;
    const Vec3 = cam.position.constructor;

    // Freeze and frame the seam exactly.
    s.getEngine().stopRenderLoop();
    player.position.set(253429, 0.8, 309882);
    cam.setTarget(player.position.clone());
    cam.setPosition(new Vec3(253505, 23.5, 309956));

    // Replace the sky with magenta so any gap between tiles is unmistakable
    // (no scene colour resembles it).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    s.meshes.forEach((m: any) => { if (m.name === "skybox") m.setEnabled(false); });
    s.autoClear = true;
    s.clearColor.set(1, 0, 1, 1);
    s.fogEnabled = false;
    s.render();
    s.render();

    // Read the framebuffer back through a 2D canvas (the debug HUD is a separate
    // DOM overlay, so it isn't in here).
    const canvas = s.getEngine().getRenderingCanvas();
    const copy = document.createElement("canvas");
    copy.width = canvas.width;
    copy.height = canvas.height;
    const ctx = copy.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    ctx.drawImage(canvas, 0, 0);
    const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const isMagenta = (x: number, y: number) => {
      const i = (y * width + x) * 4;
      return data[i] > 150 && data[i + 2] > 150 && data[i + 1] < 110;
    };

    // Per column: once we've passed the topmost terrain pixel, any magenta is
    // background leaking through a hole. Magenta above that point is open sky and
    // is ignored, so an uneven (hilly) horizon doesn't trip the count.
    let holes = 0;
    let magentaTotal = 0;
    let terrainTotal = 0;
    for (let x = 0; x < width; x++) {
      let seenTerrain = false;
      for (let y = 0; y < height; y++) {
        if (isMagenta(x, y)) {
          magentaTotal++;
          if (seenTerrain) holes++;
        } else {
          terrainTotal++;
          seenTerrain = true;
        }
      }
    }
    return { holes, magentaTotal, terrainTotal };
  });

  // Sanity: the scene rendered and the readback worked (sky and terrain present).
  expect(r.magentaTotal, "magenta sky should be visible (readback worked)").toBeGreaterThan(20000);
  expect(r.terrainTotal, "terrain should be visible").toBeGreaterThan(20000);

  // The demonstration: a seamless terrain leaks no background through its seams.
  expect(r.holes, "background pixels visible through tile seams").toBe(0);
});
