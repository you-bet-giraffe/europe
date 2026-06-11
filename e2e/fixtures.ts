import { type Page, expect } from "@playwright/test";

// A snapshot of the live Babylon scene, read from the page in ?test mode.
export interface SceneState {
  ready: boolean;
  terrainMeshCount: number;
  sampleHasNormals: boolean;
  sampleHasUVs: boolean;
  sampleHasDiffuseTexture: boolean;
  playerY: number | null;
  ground: number | null;
  skyboxActive: boolean;
  tilesLoading: number;
  characterLoaded: boolean;
  characterAnimating: boolean;
  fps: number;
}

// Pull scene facts out of window.__scene + the debug HUD. Uses Babylon's string
// attribute kinds ("normal"/"position"/"uv") so it needs no module import.
export async function readState(page: Page): Promise<SceneState> {
  return page.evaluate(() => {
    const empty: SceneState = {
      ready: false, terrainMeshCount: 0, sampleHasNormals: false, sampleHasUVs: false,
      sampleHasDiffuseTexture: false, playerY: null, ground: null, skyboxActive: false,
      tilesLoading: -1, characterLoaded: false, characterAnimating: false, fps: 0,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = (window as any).__scene;
    if (!s) return empty;

    // Terrain meshes are the ones sharing the "terrain" material — this excludes
    // the player, skybox, and character meshes regardless of their names.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const terrain = s.meshes.filter((m: any) => m.material?.name === "terrain");
    const sample = terrain[0];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const player = s.meshes.find((m: any) => m.name === "player");

    const hud = document.getElementById("debug-hud")?.textContent ?? "";
    const gm = hud.match(/ground: (null|[-\d.]+)/);
    const ground = gm ? (gm[1] === "null" ? null : parseFloat(gm[1])) : null;
    const lm = hud.match(/(\d+) loading/);
    const tilesLoading = lm ? parseInt(lm[1], 10) : -1;

    const active = s.getActiveMeshes?.();
    let skyboxActive = false;
    if (active) for (let i = 0; i < active.length; i++) if (active.data[i].name === "skybox") skyboxActive = true;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const characterLoaded = s.transformNodes.some((n: any) => n.name === "playerCharacter");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const characterAnimating = s.animationGroups.some((g: any) => g.isPlaying);

    return {
      ready: true,
      terrainMeshCount: terrain.length,
      sampleHasNormals: sample ? !!sample.getVerticesData("normal") : false,
      sampleHasUVs: sample ? !!sample.getVerticesData("uv") : false,
      sampleHasDiffuseTexture: sample?.material ? !!sample.material.diffuseTexture : false,
      playerY: player ? player.position.y : null,
      ground,
      skyboxActive,
      tilesLoading,
      characterLoaded,
      characterAnimating,
      fps: s.getEngine().getFps(),
    };
  });
}

// Navigate to the app in test mode and wait until the scene is loaded and the
// player has been placed on the terrain.
export async function gotoApp(page: Page): Promise<void> {
  await page.goto("/?test");
  await expect
    .poll(async () => {
      const st = await readState(page);
      return st.ready && st.terrainMeshCount > 0 && st.ground !== null;
    }, { timeout: 30_000, message: "scene did not become ready" })
    .toBe(true);
}

// Stop the render loop and draw one final frame, so the canvas holds a single
// static image. Without this the scene renders continuously and tiny per-frame
// GPU variance prevents Playwright from ever capturing two matching frames.
export async function freezeScene(page: Page): Promise<void> {
  await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = (window as any).__scene;
    if (!s) return;
    s.getEngine().stopRenderLoop();
    s.render();
  });
}

// Wait until the visible scene stops changing, so a screenshot is stable. We
// can't wait for zero tiles in flight — coarse streaming can sit with a few
// loads perpetually in flight — so instead wait until the tile HUD line is
// unchanged across several consecutive polls.
export async function waitForTilesSettled(page: Page): Promise<void> {
  let last = "";
  let stableReads = 0;
  await expect
    .poll(async () => {
      const line = await page.evaluate(
        () =>
          document
            .getElementById("debug-hud")
            ?.textContent?.split("\n")
            .find((l) => l.startsWith("tiles:")) ?? "",
      );
      if (line && line === last) stableReads++;
      else { stableReads = 0; last = line; }
      return stableReads;
    }, { timeout: 30_000, intervals: [1000] })
    .toBeGreaterThanOrEqual(3);
  await page.waitForTimeout(500); // let the last decoded tiles render
}
