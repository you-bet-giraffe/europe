-- Default spawn point: Vlorë, Albania (game-world coordinates, UTM 33N origin at raster center)
-- game_x =  254298.3 m east  of world center
-- game_y =      10.0 m above sea level (Vlorë coastal plain)
-- game_z = -310793.5 m south of world center  (negative = south in UTM northing)

ALTER TABLE characters
  ALTER COLUMN pos_x SET DEFAULT  254298.3,
  ALTER COLUMN pos_y SET DEFAULT      10.0,
  ALTER COLUMN pos_z SET DEFAULT -310793.5;
