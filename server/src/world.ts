import type { PlayerState, Vec3 } from "../../shared/types";
import { SPAWN_POINT } from "../../shared/types";

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

  movePlayer(id: string, position: Vec3, rotation: number): void {
    const player = this.players.get(id);
    if (player) {
      player.position = position;
      player.rotation = rotation;
    }
  }

  getPlayers(): PlayerState[] {
    return Array.from(this.players.values());
  }

  hasPlayer(id: string): boolean {
    return this.players.has(id);
  }
}
