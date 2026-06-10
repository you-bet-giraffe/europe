"""Download Terrarium elevation tiles from the public AWS elevation-tiles-prod bucket."""

import boto3
from botocore import UNSIGNED
from botocore.config import Config as BotoConfig
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import mercantile
from tqdm import tqdm

BUCKET = "elevation-tiles-prod"


def fetch(config, workers: int = 8) -> Path:
    out_dir = Path(config.output_dir) / "terrarium"
    out_dir.mkdir(parents=True, exist_ok=True)

    s3 = boto3.client("s3", config=BotoConfig(signature_version=UNSIGNED))

    tiles = list(mercantile.tiles(
        config.west, config.south, config.east, config.north,
        zooms=config.zoom,
    ))
    print(f"Fetching {len(tiles)} source tiles at zoom {config.zoom}...")

    def download(tile: mercantile.Tile) -> None:
        dest = out_dir / f"{tile.z}_{tile.x}_{tile.y}.png"
        if dest.exists():
            return
        key = f"terrarium/{tile.z}/{tile.x}/{tile.y}.png"
        s3.download_file(BUCKET, key, str(dest))

    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(download, t): t for t in tiles}
        for future in tqdm(as_completed(futures), total=len(futures), desc="Fetching"):
            future.result()

    return out_dir
