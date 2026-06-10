import json
from dataclasses import fields
from pathlib import Path

import click

from .config import Config


def _load_config(path: str) -> Config:
    p = Path(path)
    if p.exists():
        with open(p) as f:
            data = json.load(f)
        valid = {f.name for f in fields(Config)}
        return Config(**{k: v for k, v in data.items() if k in valid})
    return Config()


@click.group()
def main() -> None:
    """GIS pipeline — Adriatic terrain tiles for Empires."""


@main.command()
@click.option("--config", "cfg_path", default="pipeline.json", show_default=True)
@click.option("--workers", default=8, show_default=True, help="Parallel download threads")
def fetch(cfg_path: str, workers: int) -> None:
    """Download Terrarium source tiles from AWS."""
    from .fetch import fetch as _fetch
    _fetch(_load_config(cfg_path), workers=workers)


@main.command()
@click.option("--config", "cfg_path", default="pipeline.json", show_default=True)
def preprocess(cfg_path: str) -> None:
    """Merge, reproject, and resample the DEM."""
    from .preprocess import preprocess as _preprocess
    _preprocess(_load_config(cfg_path))


@main.command()
@click.option("--config", "cfg_path", default="pipeline.json", show_default=True)
def tile(cfg_path: str) -> None:
    """Split DEM into game tiles and export heightmap PNGs."""
    from .tiler import tile as _tile
    _tile(_load_config(cfg_path))


@main.command()
@click.option("--config", "cfg_path", default="pipeline.json", show_default=True)
@click.option("--compress/--no-compress", default=True, show_default=True,
              help="Draco-compress GLB output (requires DracoPy).")
def mesh(cfg_path: str, compress: bool) -> None:
    """Convert heightmap tiles to GLB terrain meshes."""
    from .mesh import mesh as _mesh
    _mesh(_load_config(cfg_path), compress=compress)


@main.command("fine-mesh")
@click.option("--config",      "cfg_path",   default="pipeline.json", show_default=True)
@click.option("--resolution",  default=2.0,  show_default=True,
              help="Mesh vertex spacing in metres (upsampled from coarse DEM).")
@click.option("--workers",     default=4,    show_default=True,
              help="Parallel worker processes.")
@click.option("--compress/--no-compress", default=True, show_default=True,
              help="Draco-compress GLB output (requires DracoPy).")
@click.option("--center-tx",  default=None, type=int,
              help="Tile X index to centre the generation region on.")
@click.option("--center-ty",  default=None, type=int,
              help="Tile Y index to centre the generation region on.")
@click.option("--tile-radius", default=999999, show_default=True,
              help="Only generate tiles within this many tile-widths of center.")
def fine_mesh_cmd(
    cfg_path: str, resolution: float, workers: int, compress: bool,
    center_tx: int | None, center_ty: int | None, tile_radius: int,
) -> None:
    """Generate fine-resolution GLB tiles by bicubic-upsampling dem.tif.

    Output goes to <output_dir>/fine_meshes/.  Skips tiles that already exist.

    To test near spawn:  pipeline fine-mesh --center-tx 160 --center-ty 171 --tile-radius 2
    """
    from .mesh import fine_mesh as _fine_mesh
    out = _fine_mesh(
        _load_config(cfg_path),
        fine_resolution=resolution,
        compress=compress,
        workers=workers,
        center_tx=center_tx,
        center_ty=center_ty,
        tile_radius=tile_radius,
    )
    click.echo(f"\nFine meshes written to {out}")


@main.command()
@click.option("--config", "cfg_path", default="pipeline.json", show_default=True)
def upload(cfg_path: str) -> None:
    """Upload tiles to object storage and write world_tiles.sql."""
    from .upload import upload as _upload
    _upload(_load_config(cfg_path))


@main.command()
@click.option("--config", "cfg_path", default="pipeline.json", show_default=True)
@click.option("--workers", default=8, show_default=True)
@click.option("--compress/--no-compress", default=True, show_default=True,
              help="Draco-compress GLB output (requires DracoPy).")
def run(cfg_path: str, workers: int, compress: bool) -> None:
    """Run the full pipeline (fetch → preprocess → tile → mesh)."""
    from .fetch import fetch as _fetch
    from .preprocess import preprocess as _preprocess
    from .tiler import tile as _tile
    from .mesh import mesh as _mesh

    cfg = _load_config(cfg_path)
    _fetch(cfg, workers=workers)
    _preprocess(cfg)
    _tile(cfg)
    _mesh(cfg, compress=compress)
    click.echo("\nDone. Run 'pipeline upload' to push to object storage.")
