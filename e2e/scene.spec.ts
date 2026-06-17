import { test, expect } from "@playwright/test";
import { gotoApp, readState } from "./fixtures";

// Tier 1: assertions against the live scene graph. Deterministic and renderer
// independent — these catch the class of bugs that hit this project (missing
// normals, fall-through, absent textures, unrendered skybox).
test.describe("terrain scene", () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
  });

  test("terrain meshes have normals", async ({ page }) => {
    // Regression: the Draco GLBs store normals in a separate buffer the glTF
    // loader drops on decode, so meshes arrived unlit (stochastic noise). They
    // must be recomputed on import.
    const st = await readState(page);
    expect(st.terrainMeshCount).toBeGreaterThan(0);
    expect(st.sampleHasNormals).toBe(true);
  });

  test("terrain has UVs and a grass colour texture", async ({ page }) => {
    const st = await readState(page);
    expect(st.sampleHasUVs).toBe(true);
    expect(st.sampleHasColorTexture).toBe(true);
  });

  test("player rests on the terrain surface", async ({ page }) => {
    // Regression: broken ground raycast / tile placement made the player fall
    // through the world. The capsule sits at ground + 1.
    const st = await readState(page);
    expect(st.ground).not.toBeNull();
    expect(st.playerY).not.toBeNull();
    expect(Math.abs((st.playerY as number) - ((st.ground as number) + 1))).toBeLessThan(0.6);
  });

  test("skybox is rendered", async ({ page }) => {
    // Regression: the skybox is at the origin while the world is UTM-offset, so
    // it was frustum-culled until exempted. Assert it's actually in the draw set.
    const st = await readState(page);
    expect(st.skyboxActive).toBe(true);
  });

  test("character model loads and animates", async ({ page }) => {
    // The player capsule's visuals are replaced by an animated GLB character.
    const st = await readState(page);
    expect(st.characterLoaded).toBe(true);
    expect(st.characterAnimating).toBe(true);
  });
});
