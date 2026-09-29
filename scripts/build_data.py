"""Clean the assessor data downloads and build data/attributes.json for the dashboard.

    python scripts/build_data.py            # uses data/incoming/ (if any) then data/source/

Files are recognized by their column headers, not their names, so dated file
names ("Land Attributes 9.10.26.xlsx") and .csv or .xlsx both work. Three
downloads are used:

  Land Attributes                 ACCOUNT #, LEA, SITE ACCESS, ... OTHER ATTRIBUTES
  Public Data - GENERAL ACCT INFO ACCOUNT NO, ACCOUNT TYPE, PARCEL NO, ...
  Public Data - VALUES            ACCOUNT NO, ... LAND ACTUAL, ... IMPROVEMENTS ACTUAL

Any recognized file dropped in data/incoming/ replaces the matching slim copy in
data/source/ (land_attributes.csv, general_account_info.csv, values.csv) and the
original download is deleted. Only the columns the dashboard uses are kept, so
owner names and mailing addresses are never stored in the repository.
data/source/manifest.json records the original file names. Other files in
data/incoming/ (sales, building attributes) are ignored and left in place.
"""
import json
import re
import sys
from collections import Counter, OrderedDict
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "data" / "source"
INCOMING = ROOT / "data" / "incoming"
OUT = ROOT / "data" / "attributes.json"
GEO_INDEX = ROOT / "data" / "geo_index.json"

KINDS = {
    "land": "land_attributes",
    "general": "general_account_info",
    "values": "values",
}

# ---------------------------------------------------------------- categories
# (key, label, group). Order here is the order in the dashboard's pickers.
CATEGORIES = [
    ("land_use", "Land Use Class", "Classification"),
    ("lea", "Land Economic Area (LEA)", "Classification"),
    ("land_primary", "Land Type – Primary", "Land Type"),
    ("land_secondary", "Land Type – Secondary", "Land Type"),
    ("views", "Views", "Site"),
    ("unique", "Unique Characteristics", "Site"),
    ("access_surface", "Site Access – Road Type", "Access"),
    ("access_maint", "Site Access – Maintenance", "Access"),
    ("electricity", "Electricity", "Utilities"),
    ("sewer", "Sewer", "Utilities"),
    ("water", "Water", "Utilities"),
    ("easement", "Easement", "Restrictions"),
    ("deed_restricted", "Deed Restricted", "Restrictions"),
    ("mining_district", "Mining District", "Other"),
    ("arrowhead", "Arrowhead Lot Attributes", "Other"),
]
# Labels in the packed OTHER ATTRIBUTES column -> category key
OTHER_KEYS = {
    "LAND TYPE PRIMARY": "land_primary",
    "LAND TYPE SECONDARY": "land_secondary",
    "VIEWS": "views",
    "UNIQUE CHARACTERISTICS": "unique",
    "EASEMENT": "easement",
    "DEED RESTRICTED": "deed_restricted",
    "MINING DISTRICT": "mining_district",
    "ARROWHEAD": "arrowhead",
}
# Categories every land record is expected to carry; blanks are reported as "missing".
CORE = ["land_use", "lea", "land_primary", "views", "access_surface", "access_maint",
        "electricity", "sewer", "water"]
# Categories that should hold exactly one value.
SINGLE = ["land_primary", "land_secondary", "views"]

SURFACE_CODES = {
    "PAVED ACCESS", "IMPROVED DIRT OR GRAVEL ROAD", "UNIMPROVED DIRT ROAD", "4 X 4 ACCESS ONLY",
    "NO VEHICULAR ACCESS WITH PROXIMITY TO ROAD", "NO VEHICULAR ACCESS AND NO PROXIMITY TO ROAD",
    "NO VEHICULAR", "ALLEY ACCESS ONLY", "PRIVATE ROAD", "NO LEGAL ACCESS",
}
LAND_USE_CLASSES = {"RESIDENTIAL", "VACANT", "AGRICULTURAL", "EXEMPT", "COMMERCIAL",
                    "INDUSTRIAL", "COMMON ELEMENT", "MIXED USE", "NATURAL RESOURCES",
                    "PRODUCING MINES", "STATE ASSESSED"}
ELECTRIC_STATUS = {"INSTALLED", "NOT INSTALLED AVAILABLE NEAR SITE", "NO", "NOT AVAILABLE", "TO SITE"}
NO_UTILITY = {
    "electricity": {"NO", "NOT AVAILABLE", "NOT INSTALLED AVAILABLE NEAR SITE", "TO SITE"},
    "water": {"NONE", "NOT INSTALLED", "DOMESTIC TO SITE NOT YET INSTALLED", "DOMESTIC AVAILABLE NEAR SITE"},
    "sewer": {"NONE", "ISDS ALLOWED NOT INSTALLED", "CENTRAL TO SITE NOT YET INSTALLED",
              "CENTRAL AVAILABLE NEAR SITE", "ISDS NOT ALLOWED", "CENTRAL NOT AVAILABLE"},
}
OFF_GRID = re.compile(r"^OFF GRID")
IMPROVED_TYPES = {"Residential", "Condo", "Commercial", "Mobile Home"}


# ---------------------------------------------------------------- reading
def norm_header(c):
    return re.sub(r"\s+", " ", str(c)).strip().upper()


def read_table(path):
    if path.suffix.lower() in (".xlsx", ".xls"):
        df = pd.read_excel(path, dtype=str)
    else:
        try:
            df = pd.read_csv(path, dtype=str, encoding="utf-8-sig")
        except UnicodeDecodeError:
            df = pd.read_csv(path, dtype=str, encoding="latin-1")
    df.columns = [norm_header(c) for c in df.columns]
    return df


def detect_kind(cols):
    cols = set(cols)
    if "OTHER ATTRIBUTES" in cols and "LEA" in cols:
        return "land"
    if "OWNER NAME1" in cols or ("ACCOUNT TYPE" in cols and "PROPERTY LOCATION AREA" in cols):
        return "general"
    if any("LAND ACTUAL" in c for c in cols) and any("IMPROVEMENTS ACTUAL" in c for c in cols):
        return "values"
    return None


def peek_columns(path):
    if path.suffix.lower() in (".xlsx", ".xls"):
        df = pd.read_excel(path, dtype=str, nrows=0)
    else:
        try:
            df = pd.read_csv(path, dtype=str, nrows=0, encoding="utf-8-sig")
        except UnicodeDecodeError:
            df = pd.read_csv(path, dtype=str, nrows=0, encoding="latin-1")
    return [norm_header(c) for c in df.columns]


def data_files(folder):
    return sorted(p for p in folder.glob("*")
                  if p.suffix.lower() in (".xlsx", ".xls", ".csv") and not p.name.startswith(("~$", ".")))


# Columns kept from each download (land attributes are kept whole: no owner data in it).
KEEP = {
    "general": ["ACCOUNT NO", "ACCOUNT TYPE", "PARCEL NO", "IMPROVED PROPERTY TYPE", "PROPERTY ADDRESS",
                "PROPERTY LOCATION AREA", "SUBDIVISION NAME", "CONDO NAME"],
    "values": lambda cols: [c for c in cols if c in ("ACCOUNT NO", "PARCEL NO") or re.search(
        r"(LAND|IMPROVEMENTS|TOTAL) ACTUAL$", c) and "GOVT" not in c],
}
MANIFEST = SOURCE / "manifest.json"


def promote_incoming():
    """Slim recognized downloads from data/incoming/ into data/source/<kind>.csv."""
    manifest = json.loads(MANIFEST.read_text()) if MANIFEST.exists() else {}
    moved = []
    for p in data_files(INCOMING):
        kind = detect_kind(peek_columns(p))
        if not kind:
            print(f"  ignoring {p.name} (not a land / general / values download)")
            continue
        df = read_table(p)
        keep = KEEP.get(kind)
        if keep is not None:
            cols = keep(list(df.columns)) if callable(keep) else [c for c in keep if c in df.columns]
            df = df[cols]
        for old in SOURCE.glob(KINDS[kind] + ".*"):
            old.unlink()
        dest = SOURCE / (KINDS[kind] + ".csv")
        df.to_csv(dest, index=False)
        p.unlink()
        manifest[kind] = {"file": p.name, "added": datetime.now(timezone.utc).strftime("%Y-%m-%d")}
        moved.append(f"{p.name} -> {dest.name}")
    MANIFEST.write_text(json.dumps(manifest, indent=2))
    return moved


def load_sources():
    found = {}
    for p in data_files(SOURCE):
        kind = detect_kind(peek_columns(p))
        if kind:
            found[kind] = p
    missing = [k for k in KINDS if k not in found]
    if missing:
        sys.exit(f"Missing source download(s) in data/source/: {', '.join(missing)}")
    return found


# ---------------------------------------------------------------- cleaning helpers
def clean(v):
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return ""
    return re.sub(r"\s+", " ", str(v)).strip()


def split_list(v):
    return [p.strip() for p in clean(v).split(",") if p.strip()]


def dedupe(seq):
    return list(OrderedDict.fromkeys(seq))


def to_num(v):
    s = clean(v).replace(",", "").replace("$", "")
    try:
        f = float(s)
        return f if f == f else None
    except ValueError:
        return None


def parse_land_size(v):
    """'4.809 Acres' / '9,375 Sq Ft' -> acres (float) or None."""
    m = re.match(r"^([\d,.]+)\s*(ACRES?|SQ\s*FT)", clean(v).upper())
    if not m:
        return None
    n = float(m.group(1).replace(",", ""))
    return round(n if m.group(2).startswith("ACRE") else n / 43560, 4)


def identify_land_columns(df):
    """The Land Attributes export's header row is shifted over three columns
    (the 'LAND TYPE' header sits over legal descriptions, 'SUBDIVISION' over the
    land-use class). Identify those three columns by content instead of header."""
    sample = df.head(2000)
    candidates = [c for c in df.columns if c in ("LAND TYPE", "LEGAL DESCRIPTION", "SUBDIVISION")]

    def use_score(col):
        vals = sample[col].dropna().map(lambda s: [p.strip().upper() for p in str(s).split(",")])
        vals = vals[vals.map(len) > 0]
        return (vals.map(lambda ps: all(p in LAND_USE_CLASSES for p in ps)).mean() if len(vals) else 0)

    use_col = max(candidates, key=use_score)
    rest = [c for c in candidates if c != use_col]
    # legal descriptions are longer than subdivision names
    legal_col = max(rest, key=lambda c: sample[c].dropna().astype(str).str.len().mean())
    subdiv_col = [c for c in rest if c != legal_col][0]
    return use_col, legal_col, subdiv_col


# ---------------------------------------------------------------- main build
def main():
    SOURCE.mkdir(parents=True, exist_ok=True)
    INCOMING.mkdir(parents=True, exist_ok=True)
    moved = promote_incoming()
    for m in moved:
        print("  new download:", m)
    src = load_sources()
    manifest = json.loads(MANIFEST.read_text()) if MANIFEST.exists() else {}
    land = read_table(src["land"])
    gen = read_table(src["general"])
    val = read_table(src["values"])
    print(f"land {len(land)} rows, general {len(gen)} rows, values {len(val)} rows")

    acct_col_land = next(c for c in land.columns if c.startswith("ACCOUNT"))
    land[acct_col_land] = land[acct_col_land].map(clean)
    land = land[land[acct_col_land] != ""].drop_duplicates(acct_col_land)
    gen["ACCOUNT NO"] = gen["ACCOUNT NO"].map(clean)
    gen = gen[gen["ACCOUNT NO"] != ""].drop_duplicates("ACCOUNT NO")
    val["ACCOUNT NO"] = val["ACCOUNT NO"].map(clean)
    val = val.drop_duplicates("ACCOUNT NO")

    use_col, legal_col, subdiv_col = identify_land_columns(land)
    col_land_actual = next(c for c in val.columns if c.endswith("LAND ACTUAL"))
    col_imp_actual = next(c for c in val.columns if c.endswith("IMPROVEMENTS ACTUAL"))
    col_total_actual = next(c for c in val.columns if c.endswith("TOTAL ACTUAL") and "GOVT" not in c)
    value_year = (re.match(r"(\d{4})", col_land_actual) or [None, ""])[1]

    # --- geometry lookup (account -> footprint, parcel -> footprint)
    geo = json.loads(GEO_INDEX.read_text())["footprints"]
    fp_by_acct, fp_by_parcel = {}, {}
    for i, (accts, parcels, _bbox, _nb) in enumerate(geo):
        for a in accts:
            fp_by_acct.setdefault(a, i)
        for p in parcels:
            fp_by_parcel.setdefault(p, i)

    cat_keys = [k for k, _, _ in CATEGORIES]
    cat_index = {k: i for i, k in enumerate(cat_keys)}
    dyn_categories = []  # labels in OTHER ATTRIBUTES not in OTHER_KEYS
    values = {k: Counter() for k in cat_keys}

    def ensure_category(label):
        key = "other_" + re.sub(r"[^a-z0-9]+", "_", label.lower()).strip("_")
        if key not in cat_index:
            cat_index[key] = len(cat_keys)
            cat_keys.append(key)
            values[key] = Counter()
            dyn_categories.append((key, label.title(), "Other"))
        return key

    land_by_acct = {}
    raw_flags = {}  # acct -> list of (category, issue code, detail)
    for row in land.to_dict("records"):
        a = row[acct_col_land]
        attrs = {k: [] for k in cat_keys}
        flags = []

        attrs["land_use"] = [p.title() for p in split_list(row.get(use_col))]
        attrs["lea"] = [p.strip() for p in re.split(r",\s*(?=\d+\s*:)", clean(row.get("LEA"))) if p.strip()]

        surface, maint = [], []
        for p in split_list(row.get("SITE ACCESS")):
            p = p.upper().replace("4 x 4", "4 X 4")
            (surface if p in SURFACE_CODES else maint).append(p)
        attrs["access_surface"], attrs["access_maint"] = surface, maint

        for util, col in (("electricity", "ELECTRICITY"), ("sewer", "SEWER"), ("water", "WATER")):
            attrs[util] = split_list(row.get(col))

        other = clean(row.get("OTHER ATTRIBUTES"))
        for part in re.split(r"\.\s+|\.$", other):
            part = part.strip()
            if ":" not in part:
                continue
            label, v = (s.strip() for s in part.split(":", 1))
            if not v:
                continue
            key = OTHER_KEYS.get(label.upper()) or ensure_category(label.upper())
            attrs.setdefault(key, []).append(v.upper())

        # --- per-record consistency checks (on raw lists, before de-duplication)
        for k in cat_keys:
            vs = attrs.get(k, [])
            dups = [v for v, n in Counter(vs).items() if n > 1]
            if dups:
                flags.append((k, "repeated", ", ".join(dups)))
            attrs[k] = dedupe(vs)
        for k in SINGLE:
            if len(attrs[k]) > 1:
                flags.append((k, "multiple", " / ".join(attrs[k])))
        if attrs["land_primary"] and attrs["land_primary"] == attrs["land_secondary"]:
            flags.append(("land_secondary", "same_as_primary", attrs["land_primary"][0]))
        es = [v for v in attrs["electricity"] if v in ELECTRIC_STATUS]
        if len(es) > 1:
            flags.append(("electricity", "conflict", " / ".join(es)))
        sw = [v for v in attrs["sewer"] if v != "CENTRAL AVAILABLE NEAR SITE"]
        if len(sw) > 1:
            flags.append(("sewer", "conflict", " / ".join(attrs["sewer"])))
        wt = [v for v in attrs["water"] if v != "STORAGE TANK"]
        if len(wt) > 1 and ("NOT INSTALLED" in wt or len({w.split()[0] for w in wt}) < len(wt)):
            flags.append(("water", "conflict", " / ".join(attrs["water"])))
        if maint and not surface and all(m in ("YEAR ROUND", "SEASONAL") for m in maint):
            flags.append(("access_surface", "legacy", ", ".join(maint)))

        land_by_acct[a] = {
            "attrs": attrs,
            "subdivision": clean(row.get(subdiv_col)),
            "land_size": clean(row.get("LAND SIZE")),
            "acres": parse_land_size(row.get("LAND SIZE")),
        }
        raw_flags[a] = flags

    gen_by_acct = {r["ACCOUNT NO"]: r for r in gen.to_dict("records")}
    val_by_acct = {r["ACCOUNT NO"]: r for r in val.to_dict("records")}

    all_accts = sorted(set(gen_by_acct) | set(land_by_acct))
    categories = [{"key": k, "label": l, "group": g} for k, l, g in CATEGORIES + dyn_categories]

    # value dictionaries (sorted by frequency) built in a first pass
    for a in all_accts:
        L = land_by_acct.get(a)
        if L:
            for k in cat_keys:
                values[k].update(L["attrs"].get(k, []))
    value_lists = {k: [v for v, _ in values[k].most_common()] for k in cat_keys}
    value_ix = {k: {v: i for i, v in enumerate(value_lists[k])} for k in cat_keys}

    rows = []
    stats = Counter()
    for a in all_accts:
        G = gen_by_acct.get(a, {})
        V = val_by_acct.get(a, {})
        L = land_by_acct.get(a)
        parcel = re.sub(r"\D", "", clean(G.get("PARCEL NO")))
        fp = fp_by_acct.get(a, fp_by_parcel.get(parcel, -1))
        acct_type = clean(G.get("ACCOUNT TYPE")) or (L["attrs"]["land_use"][0] if L and L["attrs"]["land_use"] else "Unknown")
        imp_type = clean(G.get("IMPROVED PROPERTY TYPE"))
        imp_val = to_num(V.get(col_imp_actual))
        flags = list(raw_flags.get(a, []))

        if L:
            for k in CORE:
                if not L["attrs"][k]:
                    flags.append((k, "missing", ""))
            if imp_type in IMPROVED_TYPES and (imp_val or 0) > 0:
                for util, none_set in NO_UTILITY.items():
                    vs = L["attrs"][util]
                    if vs and all(v in none_set for v in vs) and not any(OFF_GRID.match(v) for v in vs):
                        flags.append((util, "improved_no_utility", f"{imp_type}: " + " / ".join(vs)))

        stats["accounts"] += 1
        stats["with_land"] += bool(L)
        stats["mapped"] += fp >= 0
        rows.append([
            a,
            clean(G.get("PARCEL NO")),
            acct_type,
            imp_type,
            clean(G.get("PROPERTY ADDRESS")),
            clean(G.get("PROPERTY LOCATION AREA")),
            clean(G.get("SUBDIVISION NAME")) or (L["subdivision"] if L else ""),
            clean(G.get("CONDO NAME")),
            L["land_size"] if L else "",
            L["acres"] if L else None,
            to_num(V.get(col_land_actual)),
            imp_val,
            to_num(V.get(col_total_actual)),
            1 if L else 0,
            fp,
            [[value_ix[k][v] for v in L["attrs"].get(k, [])] for k in cat_keys] if L else None,
            [[cat_index[k], code, detail] for k, code, detail in flags],
        ])

    out = {
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "sources": {k: manifest.get(k, {}).get("file", p.name) for k, p in src.items()},
        "valueYear": value_year,
        "categories": categories,
        "core": CORE,
        "values": [value_lists[k] for k in cat_keys],
        "fields": ["account", "parcel", "type", "improvedType", "address", "area", "subdivision",
                   "condo", "landSize", "acres", "landValue", "impValue", "totalValue",
                   "hasLand", "fp", "attrs", "flags"],
        "rows": rows,
    }
    OUT.write_text(json.dumps(out, separators=(",", ":"), allow_nan=False))
    print(f"accounts {stats['accounts']}, with land record {stats['with_land']}, "
          f"mapped {stats['mapped']}; wrote {OUT.relative_to(ROOT)} ({OUT.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
