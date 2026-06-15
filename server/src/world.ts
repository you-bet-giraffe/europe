import type { PlayerState, Vec3 } from "../../shared/types";
import { SPAWN_POINT } from "../../shared/types";

// Sane elevation envelope for the Adriatic terrain. Positions outside it can
// only be a buggy or hostile client, so we clamp Y into range rather than let a
// player teleport to ±Infinity and get broadcast to everyone.
const MIN_ELEVATION = -500;
const MAX_ELEVATION = 12000;

// True only for a Vec3 whose components are all finite numbers (rejects NaN,
// ±Infinity, missing fields, and non-object payloads).
export function isFiniteVec3(v: unknown): v is Vec3 {
  if (typeof v !== "object" || v === null) return false;
  const { x, y, z } = v as Record<string, unknown>;
  return (
    typeof x === "number" && Number.isFinite(x) &&
    typeof y === "number" && Number.isFinite(y) &&
    typeof z === "number" && Number.isFinite(z)
  );
}

export class World {
  private players = new Map<string, PlayerState>();

  addPlayer(id: string): PlayerState {
    const state: PlayerState = {
      id,
      position: { ...SPAWN_POINT },
      rotation: 0,
    };
    this.players.set(id, state);
    return state;
  }

  removePlayer(id: string): void {
    this.players.delete(id);
  }

  // Apply a client-supplied move after validating it. Returns false (and leaves
  // the player's last good state intact) when the input is malformed, so the
  // server stays authoritative over garbage input.
  movePlayer(id: string, position: Vec3, rotation: number): boolean {
    const player = this.players.get(id);
    if (!player) return false;
    if (!isFiniteVec3(position) || !Number.isFinite(rotation)) return false;

    player.position = {
      x: position.x,
      y: Math.min(Math.max(position.y, MIN_ELEVATION), MAX_ELEVATION),
      z: position.z,
    };
    player.rotation = rotation;
    return true;
  }

  getPlayer(id: string): PlayerState | undefined {
    return this.players.get(id);
  }

  getPlayers(): PlayerState[] {
    return Array.from(this.players.values());
  }

  // Players within radiusM (horizontal X/Z) of a point — used to send each
  // client only the peers it can actually see. Includes any player sitting on
  // the point itself (e.g. the requester), so callers get themselves back.
  playersNear(center: Vec3, radiusM: number): PlayerState[] {
    const r2 = radiusM * radiusM;
    const out: PlayerState[] = [];
    for (const p of this.players.values()) {
      const dx = p.position.x - center.x;
      const dz = p.position.z - center.z;
      if (dx * dx + dz * dz <= r2) out.push(p);
    }
    return out;
  }
}
