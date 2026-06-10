CREATE TABLE world_tiles (
  x             INT     NOT NULL,
  y             INT     NOT NULL,
  zoom          INT     NOT NULL DEFAULT 0,
  game_x        FLOAT   NOT NULL,
  game_z        FLOAT   NOT NULL,
  utm_x         FLOAT   NOT NULL,
  utm_y         FLOAT   NOT NULL,
  elev_min      FLOAT   NOT NULL,
  elev_max      FLOAT   NOT NULL,
  asset_key     TEXT    NOT NULL,
  heightmap_key TEXT    NOT NULL,
  biome         TEXT,
  PRIMARY KEY (x, y, zoom)
);

-- Spatial lookup: find tiles near a game-world position
CREATE INDEX ON world_tiles (game_x, game_z);
