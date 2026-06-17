"""Convert DEM tiles into GLB terrain meshes with cross-tile normals."""

import json
import struct
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.windows import Window
import trimesh
from tqdm import tqdm

try:
    import DracoPy
    _HAS_DRACO = True
except ImportError:
    _HAS_DRACO = False


# ── Normal computation ────────────────────────────────────────────────────────

def _compute_normals(elev_ext: np.ndarray, resolution: float) -> np.ndarray:
    """Compute vertex normals from a heightmap extended by 1px on every side.

    Uses central differences across tile borders so adjacent tiles produce
    matching normals at their shared edges.

    elev_ext: float32 array of shape (verts_per_edge+2, verts_per_edge+2)
    Returns:  float32 array of shape (verts_per_edge*verts_per_edge, 3)
    """
    # For vertex at (row, col) in the output grid, the neighbours in elev_ext
    # are at (row+1, col) with east/west/north/south offset by ±1.
    #
    # Coordinate system: x = east (col), y = elevation, z = south (row).
    # Normal = normalise(cross(tangent_z, tangent_x))
    #        = normalise([-Δelev_x,  2·resolution,  -Δelev_z])
    #
    # where Δelev_x = east_neighbour - west_neighbour  (central difference)
    #       Δelev_z = south_neighbour - north_neighbour

    delta_x = elev_ext[1:-1, 2:] - elev_ext[1:-1, :-2]   # (H, W)
    delta_z = elev_ext[2:, 1:-1] - elev_ext[:-2, 1:-1]   # (H, W)

    nx = -delta_x
    ny = np.full_like(nx, 2.0 * resolution)
    nz = -delta_z

    length = np.sqrt(nx ** 2 + ny ** 2 + nz ** 2)
    nx /= length
    ny /= length
    nz /= length

    return np.stack([nx.ravel(), ny.ravel(), nz.ravel()], axis=1).astype(np.float32)


# ── Mesh geometry ─────────────────────────────────────────────────────────────

def _build_vertices_faces(
    elev: np.ndarray, tile_size: float
) -> tuple[np.ndarray, np.ndarray]:
    """Build vertex position and face index arrays from a float32 elevation grid."""
    rows, cols = elev.shape
    xs = np.linspace(0.0, tile_size, cols, dtype=np.float32)
    zs = np.linspace(0.0, tile_size, rows, dtype=np.float32)
    xx, zz = np.meshgrid(xs, zs)
    vertices = np.stack([xx.ravel(), elev.ravel(), zz.ravel()], axis=1)

    r = np.arange(rows - 1)
    c = np.arange(cols - 1)
    rr, cc = np.meshgrid(r, c, indexing="ij")
    i = (rr * cols + cc).ravel()
    faces = np.concatenate(
        [np.stack([i, i + 1, i + cols], axis=1),
         np.stack([i + 1, i + cols + 1, i + cols], axis=1)],
        axis=0,
    ).astype(np.int32)

    return vertices, faces


# ── GLB export ────────────────────────────────────────────────────────────────

def _pack_glb(gltf_dict: dict, binary: bytes) -> bytes:
    json_bytes = json.dumps(gltf_dict, separators=(",", ":")).encode("utf-8")
    json_bytes += b" " * ((4 - len(json_bytes) % 4) % 4)
    binary += b"\x00" * ((4 - len(binary) % 4) % 4)

    total = 12 + 8 + len(json_bytes) + 8 + len(binary)
    return (
        struct.pack("<III", 0x46546C67, 2, total)
        + struct.pack("<II", len(json_bytes), 0x4E4F534A) + json_bytes
        + struct.pack("<II", len(binary), 0x004E4942) + binary
    )


def _export_draco_glb(
    vertices: np.ndarray, faces: np.ndarray, normals: np.ndarray
) -> bytes:
    """GLB with KHR_draco_mesh_compression for positions/indices.

    DracoPy's basic encoder handles positions + indices only, so normals are
    stored as a separate uncompressed float32 buffer view in the same binary
    chunk.  Both are in one GLB buffer — the loader gets smooth normals without
    needing client-side recomputation.
    """
    verts = vertices.astype(np.float32)
    idx   = faces.astype(np.uint32)

    # Quantize normals to SNORM8 (int8, normalized [-127..127] → [-1..1]).
    # Reduces normal storage 4× vs float32 with imperceptible quality loss.
    # Each VEC3 gets a 4th padding byte so every element is 4-byte aligned,
    # which is required by the glTF spec (byteStride % 4 == 0).
    norms_q = np.clip(np.round(normals * 127.0), -127, 127).astype(np.int8)
    # Interleave a zero padding byte after every 3 normal bytes → shape (n, 4)
    n_verts = len(verts)
    norms_padded = np.zeros((n_verts, 4), dtype=np.int8)
    norms_padded[:, :3] = norms_q
    normal_bytes = norms_padded.tobytes()   # n_verts × 4 bytes

    draco_bytes = bytes(DracoPy.encode_mesh_to_buffer(
        points=verts.flatten(),
        faces=idx.flatten(),
        quantization_bits=14,
        compression_level=7,
    ))
    draco_pad = (4 - len(draco_bytes) % 4) % 4

    binary = draco_bytes + b"\x00" * draco_pad + normal_bytes

    n_indices    = len(idx) * 3
    normal_offset = len(draco_bytes) + draco_pad

    gltf = {
        "asset": {"version": "2.0", "generator": "empires-gis-pipeline"},
        "extensionsUsed": ["KHR_draco_mesh_compression"],
        "extensionsRequired": ["KHR_draco_mesh_compression"],
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0}],
        "meshes": [{
            "primitives": [{
                "attributes": {"POSITION": 0, "NORMAL": 1},
                "indices": 2,
                "extensions": {
                    "KHR_draco_mesh_compression": {
                        "bufferView": 0,
                        "attributes": {"POSITION": 0},
                    }
                },
            }]
        }],
        "accessors": [
            {   # POSITION — data in Draco, no bufferView
                "componentType": 5126, "count": n_verts, "type": "VEC3",
                "min": verts.min(axis=0).tolist(),
                "max": verts.max(axis=0).tolist(),
            },
            {   # NORMAL — SNORM8, padded to 4 bytes/element (byteStride=4)
                "bufferView": 1, "byteOffset": 0,
                "componentType": 5120,   # BYTE
                "normalized": True,
                "count": n_verts, "type": "VEC3",
            },
            {   # INDICES — data in Draco, no bufferView
                "componentType": 5125, "count": n_indices, "type": "SCALAR",
            },
        ],
        "bufferViews": [
            {"buffer": 0, "byteOffset": 0,             "byteLength": len(draco_bytes)},
            {   # byteStride=4 covers the padding byte
                "buffer": 0, "byteOffset": normal_offset,
                "byteLength": len(normal_bytes), "byteStride": 4,
            },
        ],
        "buffers": [{"byteLength": len(binary)}],
    }

    return _pack_glb(gltf, binary)


def _export_plain_glb(
    vertices: np.ndarray, faces: np.ndarray, normals: np.ndarray
) -> bytes:
    m = trimesh.Trimesh(
        vertices=vertices, faces=faces,
        vertex_normals=normals,
        process=False,
    )
    return m.export(file_type="glb")


# ── Pipeline stage ────────────────────────────────────────────────────────────

def mesh(config, compress: bool = True) -> Path:
    dem_path = Path(config.output_dir) / "dem.tif"
    meshes_dir = Path(config.output_dir) / "meshes"
    meshes_dir.mkdir(parents=True, exist_ok=True)

    with open(Path(config.output_dir) / "tile_index.json") as f:
        tile_index = json.load(f)

    use_draco = compress and _HAS_DRACO
    if compress and not _HAS_DRACO:
        print("Warning: DracoPy not installed — output will be uncompressed (~34GB).")
        print("         pip install DracoPy")
    else:
        print(f"Mesh export: {'Draco-compressed' if use_draco else 'uncompressed'}")

    tp = config.tile_pixels       # 160  — grid intervals per tile
    vpe = config.verts_per_edge   # 161  — vertices per edge (includes shared border)

    print(f"Generating meshes for {len(tile_index)} tiles...")

    with rasterio.open(dem_path) as dem:
        for tile_meta in tqdm(tile_index, desc="Meshing"):
            tx, ty = tile_meta["x"], tile_meta["y"]
            glb_path = meshes_dir / f"{tx}_{ty}.glb"
            if glb_path.exists():
                continue

            col_off = tx * tp
            row_off = ty * tp

            # Read a 163×163 window — 1px beyond each edge so central differences
            # for border vertices use real neighbours from adjacent tiles.
            # boundless=True pads with 0.0 (sea level) for world-edge tiles.
            #
            # Coarse tiles need no edge stitching: a tile's east column is DEM
            # col (tx+1)*tp — exactly the west column of its neighbour — so shared
            # edges already sample identical heights. Only the fine mesh, which
            # upsamples between these, must be snapped back (see _process_fine_tile).
            ext_window = Window(col_off - 1, row_off - 1, vpe + 2, vpe + 2)
            elev_ext = dem.read(
                1, window=ext_window, boundless=True, fill_value=0.0
            ).astype(np.float32)

            elev = elev_ext[1:-1, 1:-1]   # central 161×161 for vertex positions

            vertices, faces = _build_vertices_faces(elev, config.tile_size)
            normals = _compute_normals(elev_ext, config.resolution)

            if use_draco:
                glb_bytes = _export_draco_glb(vertices, faces, normals)
            else:
                glb_bytes = _export_plain_glb(vertices, faces, normals)

            glb_path.write_bytes(glb_bytes)

    return meshes_dir


# ── Fine-mesh pipeline stage (2 m default) ────────────────────────────────────
#
# Reads the same coarse dem.tif with rasterio out_shape bilinear/bicubic
# upsampling — no extra DEM needed, just finer triangulation from the same data.

def _process_fine_tile(args: tuple) -> None:
    """Worker: generate one fine-resolution GLB from a coarse DEM window.

    Designed for ProcessPoolExecutor (module-level, fully picklable).
    Each worker opens its own rasterio handle to avoid thread-safety issues.
    """
    (
        dem_path, col_off, row_off,
        coarse_vpe, fine_vpe,
        tile_size, fine_resolution,
        glb_path, use_draco,
    ) = args

    import rasterio as _rio
    from rasterio.enums import Resampling as _Res
    from rasterio.windows import Window as _Win

    with _rio.open(dem_path) as dem:
        # Read the same (coarse_vpe+2) × (coarse_vpe+2) window used by mesh(),
        # but ask rasterio to output (fine_vpe+2) × (fine_vpe+2) samples via
        # bicubic interpolation.  This upsamples e.g. 163×163 → 2003×2003.
        ext_window = _Win(col_off - 1, row_off - 1, coarse_vpe + 2, coarse_vpe + 2)
        elev_ext = dem.read(
            1,
            window=ext_window,
            boundless=True,
            fill_value=0.0,
            out_shape=(fine_vpe + 2, fine_vpe + 2),
            resampling=_Res.cubic,
        ).astype("float32")

        # The coarse grid this tile must stitch to: the exact DEM samples mesh()
        # turns into the coarse tile's vertices (the central coarse_vpe window).
        coarse = dem.read(
            1,
            window=_Win(col_off, row_off, coarse_vpe, coarse_vpe),
            boundless=True,
            fill_value=0.0,
        ).astype("float32")

    elev = elev_ext[1:-1, 1:-1]   # strip the 1-px border → fine_vpe × fine_vpe

    # Snap the four borders onto the coarse tile's edges to eliminate T-junction
    # cracks. The coarse mesh draws each edge as straight segments between its
    # 25 m vertices; the fine edge (bicubic) bows off those chords, opening gaps
    # against coarse — and against other fine tiles, which bow differently.
    # Linearly interpolating the coarse edge heights puts every fine border vertex
    # back onto the coarse chord. Adjacent tiles share the DEM column/row sampled
    # here, so their snapped edges come out identical (fine↔fine and fine↔coarse).
    xc = np.linspace(0.0, 1.0, coarse_vpe)
    xf = np.linspace(0.0, 1.0, fine_vpe)
    elev[0, :]  = np.interp(xf, xc, coarse[0, :])    # north
    elev[-1, :] = np.interp(xf, xc, coarse[-1, :])   # south
    elev[:, 0]  = np.interp(xf, xc, coarse[:, 0])    # west
    elev[:, -1] = np.interp(xf, xc, coarse[:, -1])   # east

    vertices, faces = _build_vertices_faces(elev, tile_size)
    normals          = _compute_normals(elev_ext, fine_resolution)

    glb_bytes = (
        _export_draco_glb(vertices, faces, normals)
        if use_draco
        else _export_plain_glb(vertices, faces, normals)
    )
    Path(glb_path).write_bytes(glb_bytes)


def fine_mesh(
    config,
    fine_resolution: float = 2.0,
    compress: bool = True,
    workers: int = 4,
    center_tx: int | None = None,
    center_ty: int | None = None,
    tile_radius: int = 999999,
) -> Path:
    """Generate fine-resolution terrain GLBs by bicubic-upsampling dem.tif.

    Output: <output_dir>/fine_meshes/{tx}_{ty}.glb
    fine_vpe = tile_size / fine_resolution + 1  (e.g. 2001 for 2 m)

    Skips tiles whose GLB already exists so the job is safely resumable.
    """
    dem_path = Path(config.output_dir) / "dem.tif"
    fine_dir = Path(config.output_dir) / "fine_meshes"
    fine_dir.mkdir(parents=True, exist_ok=True)

    with open(Path(config.output_dir) / "tile_index.json") as f:
        tile_index = json.load(f)

    use_draco = compress and _HAS_DRACO
    if compress and not _HAS_DRACO:
        print("Warning: DracoPy not installed — output will be uncompressed.")

    fine_vpe   = int(config.tile_size / fine_resolution) + 1   # e.g. 2001
    coarse_vpe = config.verts_per_edge                          # e.g. 161
    tp         = config.tile_pixels                             # e.g. 160

    args_list = []
    for tile_meta in tile_index:
        tx, ty   = tile_meta["x"], tile_meta["y"]
        if center_tx is not None and center_ty is not None:
            if abs(tx - center_tx) > tile_radius or abs(ty - center_ty) > tile_radius:
                continue
        glb_path = fine_dir / f"{tx}_{ty}.glb"
        if glb_path.exists():
            continue
        args_list.append((
            str(dem_path),
            tx * tp, ty * tp,      # col_off, row_off
            coarse_vpe, fine_vpe,
            config.tile_size, fine_resolution,
            str(glb_path), use_draco,
        ))

    if not args_list:
        print("All fine meshes already exist.")
        return fine_dir

    print(
        f"Generating {len(args_list)} fine meshes "
        f"({fine_resolution} m, {fine_vpe}×{fine_vpe} verts, {workers} workers)…"
    )

    with ProcessPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(_process_fine_tile, a): a for a in args_list}
        with tqdm(total=len(futures), desc=f"Fine meshing ({fine_resolution}m)") as bar:
            for fut in as_completed(futures):
                fut.result()   # re-raise worker exceptions immediately
                bar.update(1)

    return fine_dir
