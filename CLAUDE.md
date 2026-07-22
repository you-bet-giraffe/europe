# CLAUDE.md

## GIS tiles are NOT in git

The GIS pipeline output — terrain tiles, meshes, DEMs, `.glb` fine meshes — is **generated locally and intentionally excluded from git** (`.gitignore`: `tools/gis-pipeline/*/output/`). This repo does not use Git LFS; these artifacts were removed from history to keep the repo small.

- The server reads tiles from the path in `server/.env` → `TILES_DIR`.
- If `tools/gis-pipeline/*/output/` is missing, regenerate it with the GIS pipeline (`tools/gis-pipeline/`) rather than expecting it from a clone.
- Do not commit anything under those `output/` directories, and do not re-add LFS.

> Note: `TILES_DIR` in `server/.env` may still point at the old `.../code/empires/...` path — update it to the current checkout location if tiles fail to load.

## Binary assets

Real app assets (grass textures, `robot.glb`, draco decoder wasm, e2e snapshot baselines) are committed as **normal git blobs** (~17 MB total), not LFS. `.gitattributes` marks binary extensions as non-text so git won't diff/filter them.
