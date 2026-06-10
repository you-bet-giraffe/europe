import { db } from "./db";

export interface TileMeta {
  x: number;
  y: number;
  gameX: number;
  gameZ: number;
  elevMin: number;
  elevMax: number;
  assetKey: string;
  heightmapKey: string;
}

export class TileRegistry {
  private tiles: TileMeta[] = [];

  async load(): Promise<void> {
    const { rows } = await db.query<{
      x: number; y: number;
      game_x: number; game_z: number;
      elev_min: number; elev_max: number;
      asset_key: string; heightmap_key: string;
    }>(
      "SELECT x, y, game_x, game_z, elev_min, elev_max, asset_key, heightmap_key FROM world_tiles"
    );

    this.tiles = rows.map(r => ({
      x: r.x,
      y: r.y,
      gameX: r.game_x,
      gameZ: r.game_z,
      elevMin: r.elev_min,
      elevMax: r.elev_max,
      assetKey: r.asset_key,
      heightmapKey: r.heightmap_key,
    }));

    console.log(`Loaded ${this.tiles.length} world tiles`);
  }

  // Returns tiles whose SW corner is within radiusM of the given game-world point.
  tilesNear(gameX: number, gameZ: number, radiusM: number): TileMeta[] {
    const r2 = radiusM * radiusM;
    return this.tiles.filter(t => {
      const dx = t.gameX - gameX;
      const dz = t.gameZ - gameZ;
      return dx * dx + dz * dz <= r2;
    });
  }

  get count(): number {
    return this.tiles.length;
  }
}

export const tileRegistry = new TileRegistry();
