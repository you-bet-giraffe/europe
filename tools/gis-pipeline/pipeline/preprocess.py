"""Decode Terrarium tiles, build a mosaic VRT, reproject to UTM at target resolution."""

import xml.etree.ElementTree as ET
from pathlib import Path

import mercantile
import numpy as np
import rasterio
from affine import Affine
from rasterio.transform import from_bounds
from rasterio.warp import calculate_default_transform, reproject, Resampling
from rasterio.windows import Window
from PIL import Image
from tqdm import tqdm


def _terrarium_to_elevation(img: np.ndarray) -> np.ndarray:
    r = img[:, :, 0].astype(np.float32)
    g = img[:, :, 1].astype(np.float32)
    b = img[:, :, 2].astype(np.float32)
    return r * 256.0 + g + b / 256.0 - 32768.0


def _decode_tiles(terrarium_dir: Path, tmp_dir: Path) -> list[Path]:
    """Convert Terrarium PNGs to float32 GeoTIFFs in Web Mercator."""
    tmp_dir.mkdir(parents=True, exist_ok=True)
    tif_paths = []

    png_files = sorted(terrarium_dir.glob("*.png"))
    for png_path in tqdm(png_files, desc="Decoding Terrarium tiles"):
        tif_path = tmp_dir / png_path.with_suffix(".tif").name
        tif_paths.append(tif_path)

        if tif_path.exists():
            continue

        z, x, y = (int(p) for p in png_path.stem.split("_"))
        bounds = mercantile.xy_bounds(mercantile.Tile(x=x, y=y, z=z))

        img = np.array(Image.open(png_path).convert("RGB"))
        elev = _terrarium_to_elevation(img)

        transform = from_bounds(bounds.left, bounds.bottom, bounds.right, bounds.top, 256, 256)
        with rasterio.open(
            tif_path, "w",
            driver="GTiff", height=256, width=256,
            count=1, dtype="float32",
            crs="EPSG:3857", transform=transform,
        ) as ds:
            ds.write(elev, 1)

    return tif_paths


def _build_vrt(tif_paths: list[Path], vrt_path: Path) -> None:
    """Build a GDAL VRT mosaic from a list of co-CRS GeoTIFFs."""
    min_x = min_y = float("inf")
    max_x = max_y = float("-inf")
    res_x = res_y = None
    crs_wkt = None
    tile_info = []

    for p in tif_paths:
        with rasterio.open(p) as ds:
            b = ds.bounds
            min_x = min(min_x, b.left)
            min_y = min(min_y, b.bottom)
            max_x = max(max_x, b.right)
            max_y = max(max_y, b.top)
            if res_x is None:
                res_x, res_y = ds.res
                crs_wkt = ds.crs.wkt
            tile_info.append((p, ds.width, ds.height, b))

    total_w = round((max_x - min_x) / res_x)
    total_h = round((max_y - min_y) / res_y)

    root = ET.Element("VRTDataset", rasterXSize=str(total_w), rasterYSize=str(total_h))
    ET.SubElement(root, "SRS").text = crs_wkt
    ET.SubElement(root, "GeoTransform").text = (
        f"{min_x}, {res_x}, 0, {max_y}, 0, {-res_y}"
    )
    band = ET.SubElement(root, "VRTRasterBand", dataType="Float32", band="1")

    for p, w, h, b in tile_info:
        src = ET.SubElement(band, "SimpleSource")
        ET.SubElement(src, "SourceFilename", relativeToVRT="0").text = str(p.absolute())
        ET.SubElement(src, "SourceBand").text = "1"
        ET.SubElement(src, "SrcRect", xOff="0", yOff="0", xSize=str(w), ySize=str(h))
        dst_x = round((b.left - min_x) / res_x)
        dst_y = round((max_y - b.top) / res_y)
        ET.SubElement(src, "DstRect", xOff=str(dst_x), yOff=str(dst_y), xSize=str(w), ySize=str(h))

    ET.indent(root, space="  ")
    ET.ElementTree(root).write(str(vrt_path))


def preprocess(config) -> Path:
    out_path = Path(config.output_dir) / "dem.tif"
    if out_path.exists():
        print("dem.tif already exists, skipping preprocess")
        return out_path

    terrarium_dir = Path(config.output_dir) / "terrarium"
    tmp_dir = Path(config.output_dir) / "tmp"
    vrt_path = Path(config.output_dir) / "mosaic.vrt"

    tif_paths = _decode_tiles(terrarium_dir, tmp_dir)

    print("Building mosaic VRT...")
    _build_vrt(tif_paths, vrt_path)

    print(f"Reprojecting to {config.crs} at {config.resolution}m...")
    # GDAL_MAX_DATASET_POOL_SIZE: VRT has 10 k+ sources; raise the pool so GDAL
    # doesn't thrash file handles.  Warp in horizontal strips so the single-pass
    # reproject never needs to buffer the whole raster in RAM.
    with rasterio.Env(GDAL_MAX_DATASET_POOL_SIZE=512, GDAL_CACHEMAX=1024):
        with rasterio.open(vrt_path) as src:
            dst_transform, dst_w, dst_h = calculate_default_transform(
                src.crs, config.crs,
                src.width, src.height,
                *src.bounds,
                resolution=config.resolution,
            )
            print(f"Output DEM: {dst_w} × {dst_h} px  ({dst_w * dst_h / 1e6:.0f}M pixels)")

            strip_rows = 2000  # ~200 MB per strip for float32 at ~28 k cols
            n_strips = (dst_h + strip_rows - 1) // strip_rows

            with rasterio.open(
                out_path, "w",
                driver="GTiff", height=dst_h, width=dst_w,
                count=1, dtype="float32",
                crs=config.crs, transform=dst_transform,
                compress="deflate",
            ) as dst:
                for i in tqdm(range(n_strips), desc="Reprojecting strips"):
                    y_off = i * strip_rows
                    h = min(strip_rows, dst_h - y_off)

                    # Affine for this strip: same origin X, shifted origin Y
                    strip_transform = Affine(
                        dst_transform.a, 0.0, dst_transform.c,
                        0.0, dst_transform.e,
                        dst_transform.f + y_off * dst_transform.e,
                    )

                    dest_arr = np.zeros((h, dst_w), dtype=np.float32)
                    reproject(
                        source=rasterio.band(src, 1),
                        destination=dest_arr,
                        src_transform=src.transform,
                        src_crs=src.crs,
                        dst_transform=strip_transform,
                        dst_crs=config.crs,
                        resampling=Resampling.bilinear,
                    )
                    dst.write(dest_arr, 1, window=Window(0, y_off, dst_w, h))

    return out_path
