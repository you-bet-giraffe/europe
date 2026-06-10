"""Upload tiles to object storage and emit SQL for world_tiles."""

import json
from pathlib import Path

import boto3
from tqdm import tqdm


def upload(config) -> Path:
    tiles_dir = Path(config.output_dir) / "tiles"
    meshes_dir = Path(config.output_dir) / "meshes"
    sql_path = Path(config.output_dir) / "world_tiles.sql"

    with open(Path(config.output_dir) / "tile_index.json") as f:
        tile_index = json.load(f)

    do_upload = bool(config.bucket)
    if do_upload:
        kwargs = {"endpoint_url": config.endpoint_url} if config.endpoint_url else {}
        s3 = boto3.client("s3", **kwargs)
        print(f"Uploading {len(tile_index)} tiles to s3://{config.bucket}/{config.key_prefix}...")
    else:
        print("No bucket configured — skipping upload, writing SQL only.")

    sql_rows = []

    for meta in tqdm(tile_index, desc="Uploading" if do_upload else "Building SQL"):
        tx, ty = meta["x"], meta["y"]
        stem = f"{tx}_{ty}"

        glb_key = f"{config.key_prefix}/meshes/{stem}.glb"
        hmap_key = f"{config.key_prefix}/heightmaps/{stem}.png"

        if do_upload:
            glb_path = meshes_dir / f"{stem}.glb"
            png_path = tiles_dir / f"{stem}.png"

            if glb_path.exists():
                s3.upload_file(
                    str(glb_path), config.bucket, glb_key,
                    ExtraArgs={"ContentType": "model/gltf-binary"},
                )
            if png_path.exists():
                s3.upload_file(
                    str(png_path), config.bucket, hmap_key,
                    ExtraArgs={"ContentType": "image/png"},
                )

        sql_rows.append(
            f"({tx}, {ty}, 0, "
            f"{meta['game_x']}, {meta['game_z']}, "
            f"{meta['utm_x']}, {meta['utm_y']}, "
            f"{meta['elev_min']}, {meta['elev_max']}, "
            f"'{glb_key}', '{hmap_key}', NULL)"
        )

    with open(sql_path, "w") as f:
        f.write(
            "INSERT INTO world_tiles "
            "(x, y, zoom, game_x, game_z, utm_x, utm_y, elev_min, elev_max, asset_key, heightmap_key, biome)\n"
            "VALUES\n"
        )
        f.write(",\n".join(sql_rows))
        f.write(";\n")

    print(f"SQL written to {sql_path}")
    return sql_path
