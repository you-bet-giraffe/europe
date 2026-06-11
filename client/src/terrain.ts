import { Scene, SceneLoader, DracoCompression, StandardMaterial, Color3, Texture, Quaternion, Ray, Vector3, VertexBuffer, type AbstractMesh, type TransformNode } from "@babylonjs/core";
import "@babylonjs/loaders/glTF";

const TILE_SIZE         = 4000;   // metres per tile edge
const LOAD_RADIUS       = 12000;  // load coarse tiles within this distance
const UNLOAD_RADIUS     = 20000;  // drop coarse tiles beyond this distance
const FINE_LOAD_RADIUS  = 6500;   // load fine tiles within this distance (covers 3×3 tile grid)
const FINE_UNLOAD_RADIUS = 9000;  // drop fine tiles beyond this distance
const MAX_CONCURRENT    = 4;      // parallel in-flight GLB requests per tier
const UPDATE_INTERVAL   = 1000;   // ms between streaming checks

export function configureDraco(): void {
  DracoCompression.Configuration = {
    decoder: {
      wasmUrl:       "/draco/draco_wasm_wrapper_gltf.js",
      wasmBinaryUrl: "/draco/draco_decoder_gltf.wasm",
      fallbackUrl:   "/draco/draco_decoder_gltf.js",
    },
  };
}

interface WorldMeta {
  tileSize:     number;
  gridOriginX:  number; // game_x of west edge of tile (0,0)
  northEdgeZ:   number; // game_z of north edge of tile (0,0)
  tilesX:       number;
  tilesY:       number;
}

interface LoadedTile {
  gameX: number;
  gameZ: number;
  root:  TransformNode;
}

export class TileStreamer {
  private meta: WorldMeta | null = null;

  // Coarse tiles (25 m mesh spacing)
  private loaded  = new Map<string, LoadedTile>();
  private loading = new Set<string>();

  // Fine tiles (2 m mesh spacing) — loaded close to the player
  private fineLoaded  = new Map<string, LoadedTile>();
  private fineLoading = new Set<string>();

  private lastUpdate = 0;
  private _debugCounter = 0;

  constructor(
    private scene:     Scene,
    private serverUrl: string,
  ) {}

  async init(): Promise<void> {
    const res = await fetch(`${this.serverUrl}/world/meta`);
    this.meta = (await res.json()) as WorldMeta;
    console.log(
      `TileStreamer ready — grid ${this.meta.tilesX}×${this.meta.tilesY} tiles`
    );
  }

  // sceneX / sceneZ: player position in Babylon scene space
  // (scene_z = -game_z so that +z is south, matching the tile mesh row direction)
  update(sceneX: number, sceneZ: number): void {
    if (!this.meta) return;
    const now = performance.now();
    if (now - this.lastUpdate < UPDATE_INTERVAL) return;
    this.lastUpdate = now;

    const { gridOriginX, northEdgeZ, tilesX, tilesY } = this.meta;

    const gx = sceneX;
    const gz = -sceneZ;

    const cx = Math.floor((gx - gridOriginX) / TILE_SIZE);
    const cy = Math.floor((northEdgeZ - gz)  / TILE_SIZE);

    // ── Coarse tile streaming ────────────────────────────────────────────────

    const range = Math.ceil(LOAD_RADIUS / TILE_SIZE) + 1;
    for (let dy = -range; dy <= range; dy++) {
      for (let dx = -range; dx <= range; dx++) {
        const tx = cx + dx;
        const ty = cy + dy;
        if (tx < 0 || ty < 0 || tx >= tilesX || ty >= tilesY) continue;

        const tileGameX = gridOriginX + tx * TILE_SIZE;
        const tileGameZ = northEdgeZ - (ty + 1) * TILE_SIZE;
        const dist = tileDist(gx, gz, tileGameX, tileGameZ);
        if (dist > LOAD_RADIUS) continue;

        const key = `${tx}_${ty}`;
        if (!this.loaded.has(key) && !this.loading.has(key)) {
          if (this.loading.size < MAX_CONCURRENT) {
            void this.loadTile(tx, ty, tileGameX, tileGameZ);
          }
        }
      }
    }

    for (const [key, tile] of this.loaded) {
      if (tileDist(gx, gz, tile.gameX, tile.gameZ) > UNLOAD_RADIUS) {
        // Also drop any fine tile for this key before discarding coarse
        this.unloadFineTile(key);
        tile.root.dispose();
        this.loaded.delete(key);
      }
    }

    // ── Fine tile streaming ──────────────────────────────────────────────────

    const fineRange = Math.ceil(FINE_LOAD_RADIUS / TILE_SIZE) + 1;
    for (let dy = -fineRange; dy <= fineRange; dy++) {
      for (let dx = -fineRange; dx <= fineRange; dx++) {
        const tx = cx + dx;
        const ty = cy + dy;
        if (tx < 0 || ty < 0 || tx >= tilesX || ty >= tilesY) continue;

        const tileGameX = gridOriginX + tx * TILE_SIZE;
        const tileGameZ = northEdgeZ - (ty + 1) * TILE_SIZE;
        const dist = tileDist(gx, gz, tileGameX, tileGameZ);
        if (dist > FINE_LOAD_RADIUS) continue;

        const key = `${tx}_${ty}`;
        if (!this.fineLoaded.has(key) && !this.fineLoading.has(key)) {
          if (this.fineLoading.size < MAX_CONCURRENT) {
            void this.loadFineTile(tx, ty, tileGameX, tileGameZ);
          }
        }
      }
    }

    for (const [key, tile] of this.fineLoaded) {
      if (tileDist(gx, gz, tile.gameX, tile.gameZ) > FINE_UNLOAD_RADIUS) {
        this.unloadFineTile(key);
      }
    }
  }

  // ── Tile loaders ─────────────────────────────────────────────────────────────

  private async loadTile(
    tx: number, ty: number, gameX: number, gameZ: number,
  ): Promise<void> {
    const key = `${tx}_${ty}`;
    this.loading.add(key);
    try {
      const root = await this.importTile(
        `${this.serverUrl}/tiles/`, `${tx}_${ty}.glb`, gameX, gameZ, `terrain_${tx}_${ty}`,
      );
      if (!root) return;

      // If a fine tile is already present for this key, start hidden
      if (this.fineLoaded.has(key)) {
        root.setEnabled(false);
      }

      this.loaded.set(key, { gameX, gameZ, root });
    } catch (err) {
      this.pushError(`${key}: ${String(err).slice(0, 80)}`);
    } finally {
      this.loading.delete(key);
    }
  }

  private async loadFineTile(
    tx: number, ty: number, gameX: number, gameZ: number,
  ): Promise<void> {
    const key = `${tx}_${ty}`;
    this.fineLoading.add(key);
    try {
      const root = await this.importTile(
        `${this.serverUrl}/tiles/fine/`, `${tx}_${ty}.glb`, gameX, gameZ, `terrain_fine_${tx}_${ty}`,
      );
      if (!root) return;

      // Hide the coarse counterpart while fine is visible
      this.loaded.get(key)?.root.setEnabled(false);

      this.fineLoaded.set(key, { gameX, gameZ, root });
      this._lastDebug = `LOD fine ${key} loaded`;
    } catch {
      // Fine tile not generated yet — coarse stays visible, no error logged
    } finally {
      this.fineLoading.delete(key);
    }
  }

  private unloadFineTile(key: string): void {
    const fine = this.fineLoaded.get(key);
    if (!fine) return;
    fine.root.dispose();
    this.fineLoaded.delete(key);
    this.fineLoading.delete(key);
    // Re-enable coarse tile
    this.loaded.get(key)?.root.setEnabled(true);
  }

  // Shared GLTF import helper — positions the root and applies the terrain material.
  // Returns the root TransformNode, or null if no geometry was found.
  private async importTile(
    baseUrl: string,
    filename: string,
    gameX: number,
    gameZ: number,
    matName: string,
  ): Promise<TransformNode | null> {
    const result = await SceneLoader.ImportMeshAsync("", baseUrl, filename, this.scene);
    if (result.meshes.length === 0) return null;

    const allNodes: TransformNode[] = [...result.meshes, ...result.transformNodes];
    const root = allNodes.find(n => !n.parent) ?? result.meshes[0];

    // The glTF loader applies rotationQuaternion=180°Y and scaling=(1,1,-1) to
    // convert right-handed glTF to Babylon's left-handed space. Our pipeline
    // already writes vertices in scene orientation (x east, z south), so reset
    // both — keeping the z-flip would shift every tile one tile north, mirrored.
    root.rotationQuaternion = Quaternion.Identity();
    root.scaling.setAll(1);
    root.position.set(gameX, 0, -(gameZ + TILE_SIZE));

    const mat = new StandardMaterial(matName, this.scene);
    mat.diffuseColor = new Color3(0.2, 0.6, 0.2);
    mat.backFaceCulling = false;

    let geoCount = 0;
    for (const mesh of result.meshes) {
      const tv = (mesh as AbstractMesh & { getTotalVertices?(): number }).getTotalVertices?.() ?? 0;
      if (tv > 0) {
        mesh.material  = mat;
        mesh.isPickable = true;
        geoCount++;
      }
    }
    this._lastDebug = `${filename} geo=${geoCount}`;

    return geoCount > 0 ? root : null;
  }

  // Force-load the tile covering (sceneX, sceneZ) and wait for it to finish.
  async loadAtPosition(sceneX: number, sceneZ: number): Promise<void> {
    if (!this.meta) return;
    const { gridOriginX, northEdgeZ, tilesX, tilesY } = this.meta;
    const tx = Math.floor((sceneX - gridOriginX) / TILE_SIZE);
    const ty = Math.floor((northEdgeZ + sceneZ)   / TILE_SIZE);
    if (tx < 0 || ty < 0 || tx >= tilesX || ty >= tilesY) return;
    const key = `${tx}_${ty}`;
    if (this.loaded.has(key)) return;
    const tileGameX = gridOriginX + tx * TILE_SIZE;
    const tileGameZ = northEdgeZ - (ty + 1) * TILE_SIZE;
    await this.loadTile(tx, ty, tileGameX, tileGameZ);
  }

  // Raycast downward — iterate all enabled geo meshes.  Uses ray.intersectsMesh,
  // which transforms the world-space ray into mesh-local space (mesh.intersects
  // expects a local-space ray and would never hit).  Logs diagnostic to _lastDebug.
  getHeightAt(sceneX: number, sceneZ: number): number | null {
    const ray = new Ray(new Vector3(sceneX, 10000, sceneZ), new Vector3(0, -1, 0), 20000);
    let best: number | null = null;
    let hits = 0;

    for (const mesh of this.scene.meshes) {
      if (mesh.name === "player") continue;
      if ((mesh.getTotalVertices?.() ?? 0) === 0) continue;
      if (!mesh.isEnabled()) continue;

      mesh.computeWorldMatrix(true);

      const info = ray.intersectsMesh(mesh, false);
      if (!info.hit) continue;
      hits++;
      if (info.pickedPoint && (best === null || info.pickedPoint.y > best)) {
        best = info.pickedPoint.y;
      }
    }

    if (++this._debugCounter % 60 === 0) {
      if (hits === 0) {
        // No bounding-sphere hits — show first enabled geo mesh bounding box
        const geo = this.scene.meshes.find(
          m => m.name !== "player" && (m.getTotalVertices?.() ?? 0) > 0 && m.isEnabled()
        );
        if (geo) {
          geo.computeWorldMatrix(true);
          const bb = geo.getBoundingInfo().boundingBox;
          this._lastDebug = `${geo.name} z[${bb.minimumWorld.z.toFixed(0)},${bb.maximumWorld.z.toFixed(0)}] hits=0`;
        } else {
          this._lastDebug = `no enabled geo meshes`;
        }
      } else {
        this._lastDebug = `hits:${hits} y:${best?.toFixed(1) ?? "null"}`;
      }
    }

    return best;
  }

  // ── Diagnostics ───────────────────────────────────────────────────────────────

  private pushError(msg: string): void {
    this._errors.push(msg);
    if (this._errors.length > 5) this._errors.shift();
    console.error("[terrain]", msg);
  }

  get pickableMeshCount(): number { return this.scene.meshes.filter(m => (m.getTotalVertices?.() ?? 0) > 0).length; }
  get loadedCount():  number { return this.loaded.size; }
  get loadingCount(): number { return this.loading.size; }
  get fineLoadedCount():  number { return this.fineLoaded.size; }
  get fineLoadingCount(): number { return this.fineLoading.size; }
  get errorLog():   string[] { return this._errors; }
  get lastDebug():  string   { return this._lastDebug; }
  private _errors:    string[] = [];
  private _lastDebug = "";
}

// Distance from game point (gx, gz) to tile centre
function tileDist(gx: number, gz: number, tileGameX: number, tileGameZ: number): number {
  return Math.hypot(gx - (tileGameX + TILE_SIZE / 2), gz - (tileGameZ + TILE_SIZE / 2));
}
