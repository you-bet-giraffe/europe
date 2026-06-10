from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class Config:
    # Bounding box in WGS84
    west: float = 12.0
    east: float = 21.0
    south: float = 40.0
    north: float = 46.5

    # Zoom level for Terrarium source tiles (12 = ~39m/px at equator, ~27m at 45°N)
    zoom: int = 12

    # Target coordinate reference system
    crs: str = "EPSG:32633"  # UTM Zone 33N

    # Mesh vertex spacing in meters
    resolution: float = 25.0

    # Game tile edge length in meters
    tile_size: float = 4000.0

    # Output directory
    output_dir: Path = Path("output")

    # Object storage (leave blank to skip upload)
    bucket: str = ""
    endpoint_url: str = ""  # set for R2: https://<account>.r2.cloudflarestorage.com
    key_prefix: str = "world"

    @property
    def verts_per_edge(self) -> int:
        # +1 so adjacent tiles share their border vertices (no seams)
        return int(self.tile_size / self.resolution) + 1

    @property
    def tile_pixels(self) -> int:
        return int(self.tile_size / self.resolution)
