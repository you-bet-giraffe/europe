import { test, expect } from "@playwright/test";
import { gotoApp, waitForTilesSettled } from "./fixtures";

// A screenshot baseline framed from a specific vantage point: the character at
// (257395, 258.4, 313325) with the camera just behind and above it at
// (257394, 261.6, 313340), looking at the character. Streams the terrain in
// around that spot, settles, then captures one frozen frame.
const CHARACTER: [number, number, number] = [257395, 258.4, 313325];
const CAMERA: [number, number, number] = [257394, 261.6, 313340];

test("view from (257394, 261.6, 313340) toward the character", async ({ page }) => {
  // Fine tiles here are heavy and stream in slowly; give them room to finish.
  test.setTimeout(180_000);
  await gotoApp(page);

  // Drop the player onto the spot so terrain streams in around it.
  await page.evaluate((pos) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = (window as any).__scene;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    s.meshes.find((m: any) => m.name === "player").position.set(pos[0], pos[1], pos[2]);
  }, CHARACTER);

  await waitForTilesSettled(page);

  // Place the character and frame it from the requested camera position, then
  // freeze on a single static frame so the screenshot is stable.
  await page.evaluate(({ character, camera }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = (window as any).__scene;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const player = s.meshes.find((m: any) => m.name === "player");
    const cam = s.activeCamera;
    const Vec3 = cam.position.constructor;

    s.getEngine().stopRenderLoop();
    player.position.set(character[0], character[1], character[2]);
    cam.setTarget(player.position.clone());
    cam.setPosition(new Vec3(camera[0], camera[1], camera[2]));
    s.render();
    s.render();
  }, { character: CHARACTER, camera: CAMERA });

  // The debug HUD is masked because it shows a per-frame FPS counter.
  await expect(page).toHaveScreenshot("viewpoint.png", {
    mask: [page.locator("#debug-hud")],
    maxDiffPixelRatio: 0.03,
  });
});
