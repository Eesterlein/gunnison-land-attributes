# Gunnison County Land Attributes Dashboard

**Live site:** https://eesterlein.github.io/gunnison-land-attributes/

> **Independent research project.** This dashboard is an independent research project built from publicly available Gunnison County, Colorado assessor data downloads and GIS parcel data. It is **not** an official product of the Gunnison County Assessor's Office or Gunnison County, is not a system of record, and may contain errors or out-of-date information. Always verify against official county records.

An interactive map and review tool for exploring land attributes on every parcel in Gunnison County. It is designed to help appraisers find accounts that are **missing land attributes** or carry attributes that **don't match the properties around them**.

## Features

### Map
- Every tax parcel in the county (about 17,500 shapes covering about 21,000 accounts; stacked condo units share one shape).
- Pick any **land attribute** (Land Type, Views, Unique Characteristics, Site Access, Electricity, Sewer, Water, LEA, Easements, Deed Restrictions, Mining District, …) and a **sub-attribute**, and matching parcels light up.
- Flip through values with ▲ ▼ or the keyboard (↑ ↓ or J K). Each attribute also lists *No value recorded* and *No land record*.
- Search by account, parcel number, address, subdivision or area.
- Filter by account type and area. Switch between light, aerial and topo basemaps.
- Click a parcel for its accounts, every land attribute, values, review flags and a link to the county property record.
- Optionally outline parcels that differ from their neighbors on the selected attribute.
- Links are shareable (for example `#map?c=views&v=PANORAMIC OR OUTSTANDING`).

### Review & Stats
- **Coverage by account type:** the share of accounts that carry each core attribute. Click a cell to list who's missing it.
- **Neighborhood consistency:** flags accounts whose value differs from what most comparable properties around them carry. You can compare against adjacent parcels or the same subdivision, and adjust the thresholds. For utilities, vacant lots are compared with vacant lots and improved with improved.
- **Data-entry checks:** multiple values in single-value fields, conflicting utility entries, repeated values, legacy site-access codes, and improved properties whose utilities show none.
- **Attribute value distributions**, plus a filterable **review list** with CSV export and a one-click jump to the parcel on the map.

## Updating the data

The dashboard is rebuilt automatically from new assessor downloads:

1. In this repository on GitHub, open **`data/incoming/`**.
2. Click **Add file → Upload files**, drag in any of the latest downloads, and click **Commit changes**:
   - `Land Attributes <date>.xlsx`
   - `Public Data - GENERAL ACCT INFO <date>.xlsx`
   - `Public Data - VALUES <date>.xlsx`
3. A GitHub Action cleans the files, rebuilds `data/attributes.json` and republishes the site in about 1–2 minutes. You can follow it on the **Actions** tab.

Notes:
- Files are recognized by their column headers, so the date in the name doesn't matter, and `.xlsx` and `.csv` both work.
- You can upload one file or all three. Anything not uploaded keeps its previous version.
- Only the columns the dashboard uses are kept (in `data/source/*.csv`). Owner names and mailing addresses are not stored.

To rebuild locally instead:

```bash
pip install pandas openpyxl geopandas
cp ~/Downloads/"Land Attributes 9.10.26.xlsx" data/incoming/
python scripts/build_data.py
python -m http.server   # then open http://localhost:8000
```

### Updating parcel shapes

Parcel geometry changes rarely and is built separately from the county `Taxparcelassessor` shapefile:

```bash
python scripts/build_geometry.py path/to/Taxparcelassessor.shp
python scripts/build_data.py
```

This writes `data/parcels.geojson` (shapes) and `data/geo_index.json` (accounts per shape, bounds and the neighbor list used for consistency checks).

## How the data is cleaned

- **Shifted headers:** in the Land Attributes export, the `LAND TYPE` / `LEGAL DESCRIPTION` / `SUBDIVISION` headers sit over the wrong columns. Those columns are identified by content.
- **Packed "Other Attributes":** this text field is split into separate attributes: Land Type Primary and Secondary, Views, Unique Characteristics, Easement, Deed Restricted, Mining District and Arrowhead lot attributes. Any new label the county adds becomes its own attribute automatically.
- **Site Access** is split into *road type* (paved, gravel, 4×4, no vehicular access, …) and *maintenance* (year-round or seasonal, government or private).
- **Multi-value fields** (LEA, utilities, land-use class) are split into individual values, and duplicate entries are removed and flagged.
- Accounts are joined to parcel shapes by account number, falling back to parcel number.

## Project layout

```
index.html, assets/         static site (MapLibre GL JS, no build step)
data/parcels.geojson        parcel shapes (WGS84, lightly simplified)
data/geo_index.json         accounts per shape, bounds, neighbors
data/attributes.json        cleaned attributes + review flags (generated)
data/source/                slim copies of the latest downloads
data/incoming/              drop new downloads here
scripts/build_data.py       cleaning + attribute build
scripts/build_geometry.py   shapefile → map geometry
.github/workflows/          rebuild + GitHub Pages deploy
```

## Data sources

- Gunnison County Assessor public data downloads: Land Attributes, General Account Info, Values.
- Gunnison County GIS tax parcel shapefile.
- Basemaps: Esri World Light/Dark Gray Canvas, World Imagery and World Topo.

Built as an independent research project. It has no affiliation with or endorsement by Gunnison County.
