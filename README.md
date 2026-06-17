# Empires

A multiplayer 3D game where players roam real-world Adriatic terrain (spawning at
Vlorë, Albania), rendered in the browser with [Babylon.js](https://www.babylonjs.com/)
and backed by a Node WebSocket server. It's an npm-workspaces monorepo.

## Data flow, end to end

1. **Pipeline** (offline) generates terrain tiles → uploads to storage + writes `world_tiles` rows.
2. **Server** loads tile metadata from Postgres, serves tile GLB/PNG over HTTP, and runs the realtime WebSocket world.
3. **Client** streams nearby tiles, renders the scene, moves the local player with client-side physics, and syncs positions through the server, which broadcasts everyone's state at 20 Hz.

## Top level

| Item | Purpose |
|------|---------|
| `package.json` | Workspace root. Defines `client` + `server` workspaces; scripts for `dev` (runs both via concurrently), `build`, and `test` (Playwright). |
| `playwright.config.ts` | E2E test config (Chrome, dev-server launch). |
| `.env.example` | Template for env vars (`DATABASE_URL`, `TILES_DIR`). |
| `.gitattributes` / `.gitignore` | Git config — `.gitattributes` marks the many `.glb`/`.tif` binaries. |
| `shared/` | Code shared between client and server. |
| `client/` | Browser game (Babylon.js + Vite). |
| `server/` | Game server (WebSocket + HTTP tile serving + Postgres). |
| `e2e/` | Playwright end-to-end tests. |
| `tools/` | The offline GIS data pipeline (Python). |

## `shared/`

- **`types.ts`** — The contract between client and server: `Vec3`, `PlayerState`, the `SPAWN_POINT` constant (Vlorë in UTM 33N meters), and the WebSocket message unions (`ServerMessage`: init/world_state/player_joined/player_left; `ClientMessage`: move/ping). Imported directly by both sides via relative path.

## `client/` — the game frontend (Babylon.js, TypeScript, Vite)

- **`src/main.ts`** — Entry point. Picks the render backend (WebGL2 by default; opt into WebGPU via `?webgpu`, though test mode always uses WebGL2), creates the `Game`, runs the render loop.
- **`src/game.ts`** — The core (~640 lines). Owns the scene, camera, lighting, skybox, player capsule, movement/physics (gravity, jump, fly mode, sprint), camera-terrain collision clamping, network reconciliation for the local player, and lerp/animation of remote players. Converts between game coords and Babylon scene coords.
- **`src/character.ts`** — Loads the animated `robot.glb`, manages locomotion clips (idle/walk/run/jump). Includes a workaround converting glTF PBR materials to `StandardMaterial` (WebGPU renders PBR white in this version).
- **`src/terrain.ts`** — `TileStreamer`: streams terrain GLB meshes around the player in two tiers (coarse + fine), Draco-decompressed, with grass texturing and `getHeightAt()` ray casting for ground collision.
- **`src/input.ts`** — Keyboard input controller (WASD/arrows, Q/E turn, Shift sprint, X/Z fly), with edge-triggered key consumption.
- **`src/network.ts`** — `NetworkClient`: WebSocket wrapper with reconnect and typed message callbacks.
- **`src/testMode.ts`** — `?test` flag that makes the app deterministic for visual tests.
- **`public/`** — Static assets: `draco/` (Draco decoder wasm/js), `models/robot.glb` (player character), `textures/grass.jpg`.
- **`index.html`, `vite.config.ts`, `tsconfig.json`** — App shell and build config.

## `server/` — game server (Node, TypeScript)

- **`src/index.ts`** — Main server. HTTP endpoints (`/health`, `/world/meta`, and `/tiles/:x_:y.glb|png` including `fine/` meshes served from `TILES_DIR`) plus a `ws` WebSocketServer. Runs a 20 Hz tick broadcasting `world_state` to all clients.
- **`src/world.ts`** — In-memory authoritative player registry (add/move/remove/getPlayers).
- **`src/tiles.ts`** — `TileRegistry`: loads tile metadata (bounds, elevation range, asset keys) from the `world_tiles` Postgres table.
- **`src/db.ts`** — Postgres connection pool from `DATABASE_URL`.
- **`migrations/`** — `node-pg-migrate` SQL: `001_initial_schema`, `002_spawn_defaults`, `003_world_tiles`.
- **`node-pg-migrate.json`, `tsconfig.json`** — Config.

## `e2e/` — Playwright tests

- **`fixtures.ts`** — Helpers that read live scene state from `window.__scene` and the debug HUD (`readState`, `waitForTilesSettled`, `freezeScene`).
- **`scene.spec.ts`** — Tier 1: scene-graph assertions (terrain has normals/UVs/textures, player doesn't fall through, skybox renders) — renderer-independent regression guards.
- **`visual.spec.ts`** — Tier 2: tolerant screenshot baseline of the spawn view (`*-snapshots/spawn-view-chrome-darwin.png`).

## `tools/gis-pipeline/` — offline terrain data pipeline (Python)

A [`click`](https://click.palletsprojects.com/) CLI (`pyproject.toml`, installable package) that turns public elevation data into game terrain. Stages in `pipeline/`:

- **`config.py`** — Bounding box (Adriatic), zoom, target CRS (UTM 33N), resolution (25 m), tile size (4 km).
- **`fetch.py`** — Downloads Terrarium elevation PNG tiles from AWS.
- **`preprocess.py`** — Decodes them to elevation, mosaics, reprojects to UTM.
- **`tiler.py`** — Splits the DEM into game tiles + 16-bit heightmap PNGs, emits world metadata.
- **`mesh.py`** — Builds GLB terrain meshes with seam-matched cross-tile normals (optional Draco).
- **`upload.py`** — Uploads to object storage (R2/S3) and emits `world_tiles` SQL.
- **`cli.py`** — Wires the stages into commands.
- **`full-run/` and `test-run/`** — Output directories holding the generated artifacts: `terrarium/` (source PNGs), `tmp/`, `tiles/` (heightmaps), `meshes/` + `fine_meshes/` (GLBs), `dem.tif`.

## Development

```bash
npm install          # install workspace deps
npm run dev          # run client + server together
npm test             # Playwright e2e tests
npm run build        # build client and server
```

The server needs `DATABASE_URL` (Postgres) and `TILES_DIR` set — see `.env.example`.
Run migrations with `npm run migrate --workspace=server`.
