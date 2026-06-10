import {
  AbstractEngine,
  Scene,
  ArcRotateCamera,
  HemisphericLight,
  DirectionalLight,
  Vector3,
  Mesh,
  MeshBuilder,
  StandardMaterial,
  Color3,
  ShadowGenerator,
} from "@babylonjs/core";
import { NetworkClient } from "./network";
import { InputController } from "./input";
import { TileStreamer, configureDraco } from "./terrain";
import type { PlayerState } from "../../shared/types";
import { SPAWN_POINT } from "../../shared/types";

const MOVE_SPEED    = 8;    // m/s walk
const SPRINT_SPEED  = 20;   // m/s sprint
const TURN_SPEED    = 1.8;  // rad/s Q/E turn
const GRAVITY       = 20;   // m/s² downward acceleration
const JUMP_SPEED    = 9;    // m/s initial upward velocity (~2 m peak height)
const SERVER_URL    = "http://localhost:4000";
const SEND_HZ       = 20;   // position broadcast rate
const RECONCILE_MAX = 5;    // metres: hard-snap threshold for local player correction
const REMOTE_LERP   = 12;   // per-second lerp factor for remote player smoothing

// scene_z = -game_z  (positive scene Z points south, matching tile mesh row direction)
const SPAWN_SCENE_X =  SPAWN_POINT.x;
const SPAWN_SCENE_Z = -SPAWN_POINT.z;

interface RemotePlayer {
  mesh:      Mesh;
  targetPos: Vector3;
}

export class Game {
  private scene:      Scene;
  private network:    NetworkClient;
  private input:      InputController;
  private terrain:    TileStreamer;
  private camera!:    ArcRotateCamera;
  private playerMesh!: Mesh;

  private myId:          string | null = null;
  private remotePlayers  = new Map<string, RemotePlayer>();
  private lastGroundY:   number | null = null;  // cached per-frame to avoid double ray cast
  private sendTimer      = 0;
  private flying         = false;
  private grounded       = false;
  private verticalVel    = 0;   // m/s, only used when not flying

  constructor(
    engine: AbstractEngine,
    private canvas: HTMLCanvasElement,
  ) {
    this.scene   = new Scene(engine);
    this.network = new NetworkClient(`ws://localhost:4000`);
    this.input   = new InputController();
    this.terrain = new TileStreamer(this.scene, SERVER_URL);
  }

  async init(): Promise<void> {
    configureDraco();
    this.setupLighting();
    this.setupPlayer();
    this.setupCamera();
    this.setupHudToggle();
    this.setupNetwork();
    await this.terrain.init();
    // Use playerMesh's actual position (not the constant) in case of any float
    // rounding difference between the constant and the position setter result.
    const px = this.playerMesh.position.x;
    const pz = this.playerMesh.position.z;
    await this.terrain.loadAtPosition(px, pz);
    // Render one frame so all world matrices are computed before raycasting.
    this.scene.render();
    let elevation = this.terrain.getHeightAt(px, pz);
    if (elevation === null) {
      // Draco decompression may finish async; yield one microtask and retry.
      await new Promise(r => setTimeout(r, 50));
      this.scene.render();
      elevation = this.terrain.getHeightAt(px, pz);
    }
    // Place player on terrain; fall back to 500m if raycast fails (player will
    // fall to terrain via the per-frame ground collision in movePlayer).
    this.playerMesh.position.y = (elevation ?? 500) + 1;
    this.camera.target.y = this.playerMesh.position.y;
    this.network.connect();
  }

  // ── Networking ────────────────────────────────────────────────────────────────

  private setupNetwork(): void {
    this.network.onInit = (id) => { this.myId = id; };

    this.network.onWorldState = (players) => {
      const seen = new Set<string>();
      for (const p of players) {
        if (p.id === this.myId) {
          this.reconcileLocalPlayer(p);
        } else {
          seen.add(p.id);
          const remote = this.remotePlayers.get(p.id);
          const pos = gameToScene(p.position.x, p.position.y, p.position.z);
          if (remote) {
            remote.targetPos.copyFrom(pos);
          } else {
            this.spawnRemotePlayer(p);
          }
        }
      }
      // Clean up any remote player not present in this snapshot
      for (const [id] of this.remotePlayers) {
        if (!seen.has(id)) this.removeRemotePlayer(id);
      }
    };

    this.network.onPlayerJoined = (player) => {
      if (player.id !== this.myId) this.spawnRemotePlayer(player);
    };

    this.network.onPlayerLeft = (id) => this.removeRemotePlayer(id);
  }

  private reconcileLocalPlayer(server: PlayerState): void {
    const serverPos = gameToScene(server.position.x, server.position.y, server.position.z);
    const dxz = Math.hypot(
      this.playerMesh.position.x - serverPos.x,
      this.playerMesh.position.z - serverPos.z,
    );
    const dy = Math.abs(this.playerMesh.position.y - serverPos.y);
    if (dxz > RECONCILE_MAX) {
      this.playerMesh.position.x = serverPos.x;
      this.playerMesh.position.z = serverPos.z;
      this.camera.target.x = serverPos.x;
      this.camera.target.z = serverPos.z;
    }
    if (dy > RECONCILE_MAX) {
      this.playerMesh.position.y = serverPos.y;
      this.camera.target.y = serverPos.y;
    }
  }

  private spawnRemotePlayer(player: PlayerState): void {
    if (this.remotePlayers.has(player.id)) return;
    const pos = gameToScene(player.position.x, player.position.y, player.position.z);
    const mesh = MeshBuilder.CreateCapsule(
      `remote_${player.id}`, { height: 2, radius: 0.4 }, this.scene,
    );
    mesh.position.copyFrom(pos);
    const mat = new StandardMaterial(`remote_mat_${player.id}`, this.scene);
    mat.diffuseColor = new Color3(0.8, 0.2, 0.2);
    mesh.material = mat;
    this.remotePlayers.set(player.id, { mesh, targetPos: pos.clone() });
  }

  private removeRemotePlayer(id: string): void {
    const remote = this.remotePlayers.get(id);
    if (!remote) return;
    remote.mesh.material?.dispose();
    remote.mesh.dispose();
    this.remotePlayers.delete(id);
  }

  // ── Scene setup ───────────────────────────────────────────────────────────────

  private setupLighting(): void {
    const ambient = new HemisphericLight("ambient", new Vector3(0, 1, 0), this.scene);
    ambient.intensity = 0.4;
    ambient.groundColor = new Color3(0.2, 0.2, 0.2); // dim ground bounce so underground camera still sees terrain
    const sun = new DirectionalLight("sun", new Vector3(-1, -2, -1), this.scene);
    sun.intensity = 0.8;
    const shadows = new ShadowGenerator(2048, sun);
    shadows.useBlurExponentialShadowMap = true;
    this.scene.metadata = { shadows };
  }

  private setupPlayer(): void {
    this.playerMesh = MeshBuilder.CreateCapsule(
      "player", { height: 2, radius: 0.4 }, this.scene,
    );
    this.playerMesh.position.set(SPAWN_SCENE_X, 0, SPAWN_SCENE_Z);
    const mat = new StandardMaterial("playerMat", this.scene);
    mat.diffuseColor = new Color3(0.2, 0.4, 0.8);
    this.playerMesh.material = mat;
    (this.scene.metadata.shadows as ShadowGenerator).addShadowCaster(this.playerMesh);
  }

  private setupCamera(): void {
    this.camera = new ArcRotateCamera(
      "camera", -Math.PI / 2, Math.PI / 3, 15,
      this.playerMesh.position.clone(),
      this.scene,
    );
    this.camera.attachControl(this.canvas, true);
    this.camera.lowerRadiusLimit = 5;
    this.camera.upperRadiusLimit = 2000;
    this.camera.minZ = 1;
    this.camera.maxZ = 50000;
  }

  // ── Per-frame ─────────────────────────────────────────────────────────────────

  private movePlayer(dt: number): void {
    const { forward, right, turn, sprint, flyUp, flyDown } = this.input.movement;

    // Space: edge-triggered — exit fly mode, or jump when grounded
    if (this.input.consume("Space")) {
      if (this.flying) {
        this.flying = false;
        this.verticalVel = 0;
      } else if (this.grounded) {
        this.verticalVel = JUMP_SPEED;
        this.grounded = false;
      }
    }

    // X or Z while grounded/falling → enter fly mode
    if ((flyUp || flyDown) && !this.flying) {
      this.flying = true;
      this.verticalVel = 0;
    }

    if (turn !== 0) this.camera.alpha -= turn * TURN_SPEED * dt;

    // Forward vector derived from camera horizontal angle (ArcRotateCamera formula:
    // camera.x = target.x + r·cos(α)·cos(β), camera.z = target.z + r·sin(α)·cos(β))
    // so camera-to-target XZ direction = (-cos(α), -sin(α)).
    const yaw  = this.camera.alpha;
    const fwdX = -Math.cos(yaw);
    const fwdZ = -Math.sin(yaw);

    // Player mesh always faces the current forward direction, even when standing still.
    this.playerMesh.rotation.y = Math.atan2(fwdX, fwdZ);

    if (forward !== 0 || right !== 0) {
      const speed = sprint ? SPRINT_SPEED : MOVE_SPEED;
      const dx = (fwdX * forward + fwdZ * right) * speed * dt;
      const dz = (fwdZ * forward - fwdX * right) * speed * dt;
      this.playerMesh.position.x += dx;
      this.playerMesh.position.z += dz;
    }

    // Vertical movement
    if (this.flying) {
      const dv = (flyUp ? 1 : 0) - (flyDown ? 1 : 0);
      this.playerMesh.position.y += dv * MOVE_SPEED * dt;
    } else {
      this.verticalVel -= GRAVITY * dt;
      this.playerMesh.position.y += this.verticalVel * dt;

      // Ground collision — cache result so HUD can reuse without a second ray cast
      this.lastGroundY = this.terrain.getHeightAt(
        this.playerMesh.position.x,
        this.playerMesh.position.z,
      );
      if (this.lastGroundY !== null && this.playerMesh.position.y < this.lastGroundY + 1) {
        this.playerMesh.position.y = this.lastGroundY + 1;
        this.verticalVel = 0;
        this.grounded = true;
      } else {
        this.grounded = false;
      }
    }

    // Camera always tracks player
    this.camera.target.copyFrom(this.playerMesh.position);
  }

  private sendPosition(dt: number): void {
    this.sendTimer += dt;
    if (this.sendTimer < 1 / SEND_HZ) return;
    this.sendTimer = 0;
    const p = this.playerMesh.position;
    this.network.send({
      type: "move",
      position: { x: p.x, y: p.y, z: -p.z }, // scene → game coords
      rotation: this.playerMesh.rotation.y,
    });
  }

  private lerpRemotePlayers(dt: number): void {
    const t = Math.min(1, dt * REMOTE_LERP);
    for (const [, remote] of this.remotePlayers) {
      Vector3.LerpToRef(remote.mesh.position, remote.targetPos, t, remote.mesh.position);
    }
  }

  // ── HUD ───────────────────────────────────────────────────────────────────────

  private hud = document.getElementById("debug-hud");
  private hudVisible = true;

  private setupHudToggle(): void {
    window.addEventListener("keydown", (e) => {
      if (e.code === "Backquote") {
        this.hudVisible = !this.hudVisible;
        if (this.hud) this.hud.style.display = this.hudVisible ? "" : "none";
      }
    });
  }

  update(): void {
    const dt = this.scene.getEngine().getDeltaTime() / 1000;
    this.movePlayer(dt);
    this.sendPosition(dt);
    this.lerpRemotePlayers(dt);
    this.terrain.update(this.playerMesh.position.x, this.playerMesh.position.z);
    this.scene.render();
    if (this.hud && this.hudVisible) {
      const p = this.playerMesh.position;
      this.hud.textContent = [
        `fps: ${this.scene.getEngine().getFps().toFixed(0)}`,
        `pos: (${p.x.toFixed(0)}, ${p.y.toFixed(1)}, ${p.z.toFixed(0)})`,
        `ground: ${this.lastGroundY !== null ? this.lastGroundY.toFixed(1) : "null"}  flying: ${this.flying}`,
        `tiles: ${this.terrain.loadedCount} coarse  ${this.terrain.fineLoadedCount} fine  ${this.terrain.loadingCount + this.terrain.fineLoadingCount} loading`,
        `geo meshes: ${this.terrain.pickableMeshCount}`,
        `peers: ${this.remotePlayers.size}`,
        this.terrain.lastDebug,
        ...this.terrain.errorLog,
      ].join("\n");
    }
  }
}

// Convert game-coordinate Vec3 to Babylon scene-space Vector3
function gameToScene(x: number, y: number, z: number): Vector3 {
  return new Vector3(x, y, -z);
}
