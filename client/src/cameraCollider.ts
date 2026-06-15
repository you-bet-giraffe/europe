import { ArcRotateCamera, Vector3 } from "@babylonjs/core";
import type { TileStreamer } from "./terrain";

const CAM_CLEARANCE = 1.5;  // m the camera is kept above the terrain it would clip
const CAM_STEP      = 0.5;  // m boom-shorten search resolution
const CAM_RESTORE   = 3;    // per-second ease rate zooming back out once clear

// Keeps an ArcRotateCamera above the terrain as the player and the mouse move
// it. The user's zoom is the radius we want; if the boom's far end sinks below
// the ground we first shorten it (sliding the camera up toward the player).
// When even the shortest boom still clips — e.g. orbiting the mouse straight
// down — shortening can't help, so we limit the pitch (beta) instead, which is
// what makes the mouse rotation itself stop at the ground.
//
// Drive it from camera.onAfterCheckInputsObservable so the collision reflects
// the mouse-driven orbit/zoom on the same frame instead of clipping for a frame
// before the next correction.
export class CameraCollider {
  private radiusTarget: number;
  private lastRadius:   number;

  constructor(
    private camera:  ArcRotateCamera,
    private terrain: TileStreamer,
  ) {
    this.radiusTarget = this.lastRadius = camera.radius;
  }

  clamp(): void {
    const cam = this.camera;
    const dt = cam.getScene().getEngine().getDeltaTime() / 1000;

    // A radius that differs from what we wrote last frame can only be the wheel:
    // treat that as the user's new wanted zoom, not a collision artefact.
    if (Math.abs(cam.radius - this.lastRadius) > 1e-4) this.radiusTarget = cam.radius;
    const wanted = this.radiusTarget;
    const dir = this.orbitDir();

    if (this.clears(wanted, dir)) {
      // Nothing in the way: ease back out to the wanted distance.
      cam.radius += (wanted - cam.radius) * Math.min(1, dt * CAM_RESTORE);
    } else {
      const shorter = this.safeRadius(wanted, dir);
      if (this.clears(shorter, dir)) {
        cam.radius = shorter; // pull in immediately so the boom never clips
      } else {
        // Can't clear by zooming: hold the wanted distance and raise the pitch
        // so the camera rides just above the ground (limits the downward orbit).
        cam.radius = wanted;
        const g = this.terrain.getHeightAt(cam.target.x + dir.x * wanted, cam.target.z + dir.z * wanted);
        if (g !== null) {
          const cosNeeded = (g + CAM_CLEARANCE - cam.target.y) / wanted;
          cam.beta = Math.acos(Math.max(-1, Math.min(1, cosNeeded)));
        }
      }
    }
    this.lastRadius = cam.radius;
  }

  // Unit orbit direction (camera = target + radius·dir), derived from the angles
  // so it reflects this frame's input even before the view matrix is rebuilt.
  private orbitDir(): Vector3 {
    const sinB = Math.sin(this.camera.beta);
    return new Vector3(
      Math.cos(this.camera.alpha) * sinB,
      Math.cos(this.camera.beta),
      Math.sin(this.camera.alpha) * sinB,
    );
  }

  // Does the camera at this radius sit ≥ CAM_CLEARANCE above the terrain?
  private clears(r: number, dir: Vector3): boolean {
    const tgt = this.camera.target;
    const g = this.terrain.getHeightAt(tgt.x + dir.x * r, tgt.z + dir.z * r);
    return g === null || tgt.y + dir.y * r >= g + CAM_CLEARANCE;
  }

  // Largest radius ≤ wanted whose camera point clears the terrain, or the lower
  // limit if none does. Shrinking the radius only raises and nears the camera,
  // so the safe region is the near end.
  private safeRadius(wanted: number, dir: Vector3): number {
    const lower = this.camera.lowerRadiusLimit ?? 0;
    for (let r = wanted; r > lower; r -= CAM_STEP) {
      if (this.clears(r, dir)) return r;
    }
    return lower;
  }
}
