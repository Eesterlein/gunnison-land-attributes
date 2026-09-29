"""Build the static map geometry from the county parcel shapefile.

Run this only when the parcel shapefile changes (it is not needed for routine
data updates):

    python scripts/build_geometry.py path/to/Taxparcelassessor.shp

Outputs
  data/parcels.geojson  one feature per unique parcel footprint (id = footprint index)
  data/geo_index.json   per footprint: shapefile accounts, parcel numbers, bbox, neighbors

Stacked condo units share an identical polygon in the shapefile; they are
collapsed to a single footprint so the map draws each shape once.
"""
import json
import sys
from pathlib import Path

import geopandas as gpd
import numpy as np
import shapely

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data"
SIMPLIFY_FT = 1.0      # simplification tolerance, in the source CRS (US survey feet)
NEIGHBOR_FT = 60.0     # parcels within this distance (feet) count as neighbors (spans most road ROWs)


def main(shp_path):
    g = gpd.read_file(shp_path)
    if g.crs is None:
        g = g.set_crs(2232)
    g = g[g.geometry.notna() & ~g.geometry.is_empty].copy()
    g["geometry"] = shapely.make_valid(g.geometry.values)
    g["geometry"] = g.geometry.simplify(SIMPLIFY_FT, preserve_topology=True)
    g = g[~g.geometry.is_empty]

    # Collapse identical footprints (stacked condos). Normalize + round coordinates for a stable key.
    keys = [shapely.normalize(shapely.set_precision(geom, 0.1)).wkb for geom in g.geometry.values]
    g["fkey"] = keys
    groups = g.groupby("fkey", sort=False)

    fp_geoms, fp_accts, fp_parcels = [], [], []
    for _, rows in groups:
        fp_geoms.append(rows.geometry.iloc[0])
        fp_accts.append(sorted({a.strip() for a in rows["ACCOUNTNO"].dropna() if a.strip()}))
        fp_parcels.append(sorted({p.strip() for p in rows["ParcelNumb"].dropna() if p.strip()}))
    fp = gpd.GeoDataFrame({"i": np.arange(len(fp_geoms))}, geometry=fp_geoms, crs=g.crs)
    print(f"{len(g)} shapefile rows -> {len(fp)} unique footprints")

    # Neighbors: footprints within NEIGHBOR_FT of each other (computed in feet, before reprojection).
    buf = fp.copy()
    buf["geometry"] = fp.geometry.buffer(NEIGHBOR_FT, resolution=2)
    pairs = gpd.sjoin(buf[["i", "geometry"]], fp[["i", "geometry"]], predicate="intersects")
    pairs = pairs[pairs["i_left"] != pairs["i_right"]]
    neighbors = [[] for _ in range(len(fp))]
    for a, b in zip(pairs["i_left"].values, pairs["i_right"].values):
        neighbors[a].append(int(b))

    wgs = fp.to_crs(4326)
    wgs["geometry"] = shapely.set_precision(wgs.geometry.values, 1e-6)  # ~0.1 m
    bounds = wgs.geometry.bounds.round(6).values

    features = []
    for i, geom in enumerate(wgs.geometry.values):
        if geom.is_empty:
            continue
        features.append({"type": "Feature", "id": i, "properties": {},
                         "geometry": shapely.geometry.mapping(geom)})
    with open(OUT / "parcels.geojson", "w") as f:
        json.dump({"type": "FeatureCollection", "features": features}, f, separators=(",", ":"))

    bbox = [None if np.isnan(b).any() else [float(x) for x in b] for b in bounds]  # None = empty shape
    index = {
        "fields": ["accounts", "parcels", "bbox", "neighbors"],
        "footprints": [[fp_accts[i], fp_parcels[i], bbox[i], sorted(neighbors[i])]
                       for i in range(len(fp))],
    }
    with open(OUT / "geo_index.json", "w") as f:
        json.dump(index, f, separators=(",", ":"), allow_nan=False)

    for name in ("parcels.geojson", "geo_index.json"):
        print(f"{name}: {(OUT / name).stat().st_size / 1e6:.1f} MB")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
