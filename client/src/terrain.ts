import { Scene, SceneLoader, DracoCompression, PBRMaterial, MaterialPluginBase, Color3, Texture, Quaternion, VertexBuffer, VertexData, type UniformBuffer, type AbstractMesh, type TransformNode } from "@babylonjs/core";
import "@babylonjs/loaders/glTF";

const TILE_SIZE         = 4000;   // metres per tile edge
const LOAD_RADIUS       = 12000;  // load coarse tiles within this distance
const UNLOAD_RADIUS     = 20000;  // drop coarse tiles beyond this distance
const FINE_LOAD_RADIUS  = 6500;   // load fine tiles within this distance (covers 3×3 tile grid)
const FINE_UNLOAD_RADIUS = 9000;  // drop fine tiles beyond this distance
const MAX_CONCURRENT    = 4;      // parallel in-flight GLB requests per tier
const UPDATE_INTERVAL   = 1000;   // ms between streaming checks
const GRASS_REPEAT_M    = 20;     // grass texture repeats every N metres

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
  gameX:   number;
  gameZ:   number;
  root:    TransformNode;
  heights: Float32Array;  // vpe×vpe elevation grid (row-major: row=south idx, col=east idx)
  vpe:     number;        // vertices per edge of the square grid
}

// Per-channel mean of grass_tex_macro.png (sampled offline). Dividing each octave
// by this re-centres it on 1.0, so the macro re-tints the albedo around its
// original tone instead of darkening or green-shifting it.
const MACRO_MEAN: [number, number, number] = [0.3224, 0.3542, 0.0675];

// Breaks up the obvious detail-texture tiling by modulating the terrain albedo
// with a low-frequency colour map sampled in *world* space (so it's seamless
// across tiles, independent of the per-tile detail UVs). Two octaves at
// different scales are multiplied — the product of two periods has no visible
// repeat of its own — and each is mean-normalised so the result averages 1.0.
class GrassMacroPlugin extends MaterialPluginBase {
  sizeM    = 240;  // world period of octave 1, in metres (octave 2 is 0.41×)
  strength = 0.85; // 0 = no variation, 1 = full

  constructor(material: PBRMaterial, private readonly macro: Texture) {
    super(material, "GrassMacro", 200, {});
    this._enable(true);
  }

  getClassName(): string { return "GrassMacroPlugin"; }

  // Hold back the shader until the macro texture has decoded.
  isReadyForSubMesh(): boolean { return this.macro.isReady(); }

  getSamplers(samplers: string[]): void { samplers.push("macroSampler"); }

  getUniforms() {
    return {
      ubo: [
        { name: "uMacroSizeM",    size: 1, type: "float" },
        { name: "uMacroStrength", size: 1, type: "float" },
        { name: "uMacroMean",     size: 3, type: "vec3"  },
      ],
      fragment: `
        uniform float uMacroSizeM;
        uniform float uMacroStrength;
        uniform vec3  uMacroMean;
      `,
    };
  }

  bindForSubMesh(uniformBuffer: UniformBuffer): void {
    uniformBuffer.updateFloat("uMacroSizeM", this.sizeM);
    uniformBuffer.updateFloat("uMacroStrength", this.strength);
    uniformBuffer.updateFloat3("uMacroMean", MACRO_MEAN[0], MACRO_MEAN[1], MACRO_MEAN[2]);
    uniformBuffer.setTexture("macroSampler", this.macro);
  }

  getCustomCode(shaderType: string) {
    if (shaderType !== "fragment") return null;
    // surfaceAlbedo is the live albedo at this PBR injection point; vPositionW is
    // the fragment's world position (a varying the PBR shader already declares).
    // getSamplers() only registers the texture for binding — the sampler itself
    // must be declared in the shader, hence CUSTOM_FRAGMENT_DEFINITIONS.
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: `uniform sampler2D macroSampler;`,
      CUSTOM_FRAGMENT_UPDATE_ALBEDO: `
        vec2 macroUv1 = vPositionW.xz / uMacroSizeM;
        vec2 macroUv2 = vPositionW.xz / (uMacroSizeM * 0.41) + vec2(0.37);
        vec3 macroA = texture2D(macroSampler, macroUv1).rgb / uMacroMean;
        vec3 macroB = texture2D(macroSampler, macroUv2).rgb / uMacroMean;
        vec3 macroVar = macroA * macroB;
        surfaceAlbedo.rgb *= mix(vec3(1.0), macroVar, uMacroStrength);
      `,
    };
  }
}

export class TileStreamer {
  private meta: WorldMeta | null = null;

  // Coarse tiles (25 m mesh spacing)
  private loaded  = new Map<string, LoadedTile>();
  private loading = new Set<string>();

  // Fine tiles (5 m mesh spacing) — loaded close to the player
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
      const tile = await this.importTile(
        `${this.serverUrl}/tiles/`, `${tx}_${ty}.glb`, gameX, gameZ,
      );
      if (!tile) return;

      // If a fine tile is already present for this key, start hidden
      if (this.fineLoaded.has(key)) {
        tile.root.setEnabled(false);
      }

      this.loaded.set(key, { gameX, gameZ, ...tile });
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
      const tile = await this.importTile(
        `${this.serverUrl}/tiles/fine/`, `${tx}_${ty}.glb`, gameX, gameZ,
      );
      if (!tile) return;

      // Hide the coarse counterpart while fine is visible
      this.loaded.get(key)?.root.setEnabled(false);

      this.fineLoaded.set(key, { gameX, gameZ, ...tile });
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

  // Shared grass material — one PBR material for every tile, created on first use.
  private terrainMat: PBRMaterial | null = null;

  private getTerrainMaterial(): PBRMaterial {
    if (this.terrainMat) return this.terrainMat;
    const mat = new PBRMaterial("terrain", this.scene);

    const albedo = new Texture("/textures/grass_tex_albedo.png", this.scene);
    const normal = new Texture("/textures/grass_tex_normal.png", this.scene);
    // ARM: R = ambient occlusion, G = roughness, B = height (height unused).
    const arm    = new Texture("/textures/grass_tex_arm.png", this.scene);

    // All three sets of texels share the planar tile UVs, so they tile together.
    // Max anisotropy — the ground is viewed at grazing angles, where the per-pixel
    // texel footprint is highly elongated; 16× sampling kills the minification moiré.
    for (const tex of [albedo, normal, arm]) {
      tex.uScale = tex.vScale = TILE_SIZE / GRASS_REPEAT_M;
      tex.anisotropicFilteringLevel = 16;
    }

    mat.albedoTexture = albedo;
    mat.bumpTexture   = normal;
    // Lift the grass slightly — the source albedo is quite dark, which also gives
    // the macro variation more tonal range to work with. albedoColor multiplies
    // the albedo texture (>1 brightens).
    mat.albedoColor = new Color3(1.2, 1.2, 1.2);

    // Pull AO from R and roughness from G of the ARM map. Leave metalness off the
    // texture (its blue channel holds height, not metalness) and force it to zero —
    // grass is dielectric, so it must never read B as metallic.
    mat.metallicTexture = arm;
    mat.useAmbientOcclusionFromMetallicTextureRed = true;
    mat.useRoughnessFromMetallicTextureGreen      = true;
    mat.metallic = 0;
    mat.roughness = 1; // scalar multiplier on the texture's roughness

    // Low-frequency colour variation to hide the detail-texture tiling. Sampled
    // in world space inside the shader, so it gets no uScale/anisotropy here.
    const macro = new Texture("/textures/grass_tex_macro.png", this.scene);
    new GrassMacroPlugin(mat, macro);

    mat.backFaceCulling = true; // terrain is only ever viewed from above
    this.terrainMat = mat;
    return mat;
  }

  // Shared GLTF import helper — positions the root, applies the terrain material,
  // and extracts a height grid for collision sampling.  Returns null if the GLB
  // held no geometry.
  private async importTile(
    baseUrl: string,
    filename: string,
    gameX: number,
    gameZ: number,
  ): Promise<{ root: TransformNode; heights: Float32Array; vpe: number } | null> {
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

    const mat = this.getTerrainMaterial();

    let geoCount = 0;
    let heights: Float32Array | null = null;
    let vpe = 0;
    for (const mesh of result.meshes) {
      const tv = (mesh as AbstractMesh & { getTotalVertices?(): number }).getTotalVertices?.() ?? 0;
      if (tv === 0) continue;

      const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
      if (positions) {
        // The pipeline stores normals in a separate uncompressed buffer (DracoPy
        // can't compress them), but the glTF KHR_draco loader only reads
        // attributes packed inside the Draco blob (POSITION), so the mesh arrives
        // with no normals — lit as stochastic garbage. Recompute from the geometry.
        const indices = mesh.getIndices();
        if (indices) {
          // Compute normals from the geometry's original winding first, so they
          // point up regardless of the winding fix below.
          const normals = new Float32Array(positions.length);
          VertexData.ComputeNormals(positions, indices, normals);
          mesh.setVerticesData(VertexBuffer.NormalKind, normals);

          // Resetting the loader's (1,1,-1) RH→LH scaling (above) dropped the
          // winding flip that negative scale carried, leaving every triangle
          // front-facing downward — invisible under back-face culling. Reverse
          // each triangle's winding so the top surface faces the camera.
          for (let i = 0; i + 2 < indices.length; i += 3) {
            const t = indices[i + 1];
            indices[i + 1] = indices[i + 2];
            indices[i + 2] = t;
          }
          mesh.setIndices(indices, positions.length / 3);
        }

        // Tile GLBs carry no UVs (pipeline exports POSITION/NORMAL only), so
        // derive planar UVs from local x/z — one full UV repeat per tile, with
        // the texture's uScale/vScale handling the per-metre tiling.
        if (!mesh.getVerticesData(VertexBuffer.UVKind)) {
          const uvs = new Float32Array((positions.length / 3) * 2);
          for (let i = 0, j = 0; i < positions.length; i += 3, j += 2) {
            uvs[j]     = positions[i]     / TILE_SIZE;
            uvs[j + 1] = positions[i + 2] / TILE_SIZE;
          }
          mesh.setVerticesData(VertexBuffer.UVKind, uvs);
        }

        // Rebuild the regular elevation grid for O(1) height sampling.  Draco
        // reorders vertices on compression, so we can't trust buffer order —
        // instead snap each vertex to its grid cell by rounding local x/z.  The
        // grid is square (vpe×vpe) with vpe derivable from the vertex count.
        if (!heights) {
          vpe = Math.round(Math.sqrt(positions.length / 3));
          const spacing = TILE_SIZE / (vpe - 1);
          heights = new Float32Array(vpe * vpe);
          for (let i = 0; i < positions.length; i += 3) {
            const col = Math.round(positions[i]     / spacing);
            const row = Math.round(positions[i + 2] / spacing);
            if (col >= 0 && col < vpe && row >= 0 && row < vpe) {
              heights[row * vpe + col] = positions[i + 1];
            }
          }
        }
      }

      mesh.material   = mat;
      mesh.isPickable = false; // height comes from the grid, not ray picking
      geoCount++;
    }
    this._lastDebug = `${filename} geo=${geoCount}`;

    return geoCount > 0 && heights ? { root, heights, vpe } : null;
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

  // Sample terrain elevation at a scene-space XZ point by bilinearly
  // interpolating the stored height grid of the tile beneath it.  O(1) per call
  // — no per-frame raycast.  Prefers the fine tile when loaded, else coarse.
  // Returns world Y, or null if the covering tile hasn't loaded yet.
  getHeightAt(sceneX: number, sceneZ: number): number | null {
    if (!this.meta) return null;
    const { gridOriginX, northEdgeZ } = this.meta;
    const tx = Math.floor((sceneX - gridOriginX) / TILE_SIZE);
    const ty = Math.floor((northEdgeZ + sceneZ)   / TILE_SIZE);
    const key = `${tx}_${ty}`;
    const isFine = this.fineLoaded.has(key);
    const tile = this.fineLoaded.get(key) ?? this.loaded.get(key);
    if (!tile) return null;

    const { heights, vpe, gameX, gameZ } = tile;
    // Local coords within the tile: root sits at (gameX, 0, -(gameZ+TILE_SIZE)).
    const fcol = (sceneX - gameX) / (TILE_SIZE / (vpe - 1));
    const frow = (sceneZ + gameZ + TILE_SIZE) / (TILE_SIZE / (vpe - 1));
    // Clamp the base cell so a point on the south/east edge still has a +1 cell.
    const col0 = Math.min(Math.max(Math.floor(fcol), 0), vpe - 2);
    const row0 = Math.min(Math.max(Math.floor(frow), 0), vpe - 2);
    const fx = fcol - col0;
    const fz = frow - row0;

    const h00 = heights[row0 * vpe + col0];
    const h10 = heights[row0 * vpe + col0 + 1];
    const h01 = heights[(row0 + 1) * vpe + col0];
    const h11 = heights[(row0 + 1) * vpe + col0 + 1];
    const y = (h00 + (h10 - h00) * fx) * (1 - fz) + (h01 + (h11 - h01) * fx) * fz;

    if (++this._debugCounter % 60 === 0) {
      this._lastDebug = `h@${key} y:${y.toFixed(1)} ${isFine ? "fine" : "coarse"}`;
    }
    return y;
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
