// Test mode is enabled with the ?test query param. It makes the app
// deterministic for automated visual tests:
//   - forces the WebGL2 backend (reproducible in headless Chromium / CI),
//   - skips connecting to the game server (no nondeterministic remote peers),
//   - exposes the Babylon scene on window.__scene for scene-graph assertions.
export const TEST_MODE =
  typeof location !== "undefined" &&
  new URLSearchParams(location.search).has("test");
