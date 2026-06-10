"""Split the merged DEM into game tiles and export 16-bit PNG heightmaps."""

import json
from pathlib import Path

import numpy as np
import rasterio
from rasterio.windows import Window
from tqdm import tqdm


def tile(config) -> Path:
    dem_path = Path(config.output_dir) / "dem.tif"
    tiles_dir = Path(config.output_dir) / "tiles"
    tiles_dir.mkdir(parents=True, exist_ok=True)

    tp = config.tile_pixels   # 160  (grid intervals per tile)
    vpe = config.verts_per_edge  # 161  (pixels including shared border)

    with rasterio.open(dem_path) as src:
        t = src.transform
        raster_w, raster_h = src.width, src.height

        # UTM origin = top-left corner of the raster
        origin_utm_x = t.c
        origin_utm_y = t.f  # top edge (north), UTM northing

        # Game-world origin = center of the raster
        center_utm_x = origin_utm_x + (raster_w * config.resolution) / 2.0
        center_utm_y = origin_utm_y - (raster_h * config.resolution) / 2.0

        # Save world-level metadata once
        world_meta = {
            "crs": config.crs,
            "resolution": config.resolution,
            "tile_size": config.tile_size,
            "verts_per_edge": vpe,
            "origin_utm_x": origin_utm_x,
            "origin_utm_y": origin_utm_y,
            "center_utm_x": center_utm_x,
            "center_utm_y": center_utm_y,
            "raster_width": raster_w,
            "raster_height": raster_h,
        }
        with open(Path(config.output_dir) / "world_meta.json", "w") as f:
            json.dump(world_meta, f, indent=2)

        nx = (raster_w + tp - 1) // tp
        ny = (raster_h + tp - 1) // tp
        print(f"Generating {nx} × {ny} = {nx * ny} tiles...")

        tile_index = []

        for ty_idx in tqdm(range(ny), desc="Tiling"):
            for tx_idx in range(nx):
                col_off = tx_idx * tp
                row_off = ty_idx * tp

                window = Window(col_off, row_off, vpe, vpe)
                # boundless=True pads out-of-bounds pixels with fill_value
                data = src.read(1, window=window, boundless=True, fill_value=0.0)

                elev_min = float(data.min())
                elev_max = float(data.max())
                elev_range = max(elev_max - elev_min, 1.0)

                # Encode elevation into uint16
                scale = elev_range / 65535.0
                offset = elev_min
                encoded = ((data - offset) / scale).clip(0, 65535).astype(np.uint16)

                stem = f"{tx_idx}_{ty_idx}"

                # Write 16-bit PNG via rasterio (Pillow mangles 16-bit depth)
                png_path = tiles_dir / f"{stem}.png"
                with rasterio.open(
                    png_path, "w",
                    driver="PNG", height=vpe, width=vpe,
                    count=1, dtype=rasterio.uint16,
                ) as dst:
                    dst.write(encoded[np.newaxis, :, :])

                # UTM south-west corner of this tile
                tile_utm_x = origin_utm_x + col_off * config.resolution
                tile_utm_y = origin_utm_y - (row_off + tp) * config.resolution

                # Game-world position of the tile's SW corner
                game_x = tile_utm_x - center_utm_x
                game_z = tile_utm_y - center_utm_y

                meta = {
                    "x": tx_idx, "y": ty_idx,
                    "game_x": game_x, "game_z": game_z,
                    "utm_x": tile_utm_x, "utm_y": tile_utm_y,
                    "elev_min": elev_min, "elev_max": elev_max,
                    "scale": scale, "offset": offset,
                }
                with open(tiles_dir / f"{stem}.json", "w") as f:
                    json.dump(meta, f)

                tile_index.append(meta)

    with open(Path(config.output_dir) / "tile_index.json", "w") as f:
        json.dump(tile_index, f)

    return tiles_dir
