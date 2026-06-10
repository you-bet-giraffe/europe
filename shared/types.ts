export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

// Vlorë, Albania — default character spawn (game-world meters from raster center, UTM 33N)
export const SPAWN_POINT: Vec3 = { x: 254298.3, y: 0, z: -310793.5 };

export interface PlayerState {
  id: string;
  position: Vec3;
  rotation: number;
}

export type ServerMessage =
  | { type: "init"; id: string }
  | { type: "world_state"; players: PlayerState[] }
  | { type: "player_joined"; player: PlayerState }
  | { type: "player_left"; id: string };

export type ClientMessage =
  | { type: "move"; position: Vec3; rotation: number }
  | { type: "ping"; timestamp: number };
