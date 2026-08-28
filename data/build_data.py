#!/usr/bin/env python3
"""
Regenerate buildings.json and lots.json from UMD's public ArcGIS services.

Data sources (public, no auth):
  - Buildings:  MD iMap "MD_CampusFacilities" MapServer, layer 2 (UMD Buildings)
  - Lots/Garages: UMD DOTS "CampusMapDefault_NoInsite" FeatureServer,
                  layer 6 (ParkingLotPoint), layer 5 (ParkingGarageLotPoint)

Run:  python3 build_data.py
Requires only the Python standard library (uses urllib).
"""
import json, re, urllib.request, urllib.parse, statistics, os

HERE = os.path.dirname(os.path.abspath(__file__))

BLDG_URL = ("https://mdgeodata.md.gov/imap/rest/services/Structure/"
            "MD_CampusFacilities/MapServer/2/query")
LOT_BASE = ("https://services9.arcgis.com/1rOwFRpAwrxe0rBl/arcgis/rest/"
            "services/CampusMapDefault_NoInsite/FeatureServer")


def fetch(url, params):
    q = urllib.parse.urlencode(params)
    with urllib.request.urlopen(f"{url}?{q}", timeout=90) as r:
        return json.load(r)


def poly_centroid(geom):
    if not geom:
        return None
    t, c = geom["type"], geom["coordinates"]
    ring = c[0] if t == "Polygon" else c[0][0]
    xs = [p[0] for p in ring]
    ys = [p[1] for p in ring]
    return [round(statistics.mean(xs), 6), round(statistics.mean(ys), 6)]


# ---------------------------------------------------------------- buildings
def build_buildings():
    d = fetch(BLDG_URL, {"where": "1=1", "outFields": "BUILDINGID,NAME",
                         "outSR": "4326", "f": "geojson"})
    out = []
    for f in d["features"]:
        name = (f["properties"].get("NAME") or "").strip()
        cen = poly_centroid(f.get("geometry"))
        if name and cen:
            out.append({"name": name, "lng": cen[0], "lat": cen[1]})
    # de-dup by name, keep first; sort alphabetically
    seen, uniq = set(), []
    for b in sorted(out, key=lambda x: x["name"].lower()):
        if b["name"].lower() in seen:
            continue
        seen.add(b["name"].lower())
        uniq.append(b)
    return uniq


# ---------------------------------------------------------------- lots
def base_code(name):
    """'16a' -> '16', 'K5' -> 'K', '1b (S)' -> '1', 'XX1' -> 'XX'."""
    n = name.strip()
    m = re.match(r"^\d+", n)          # numbered lot
    if m:
        return m.group(0)
    m = re.match(r"^[A-Za-z]+", n)    # lettered lot: leading letters only
    return m.group(0).upper() if m else n.upper()


# Faculty/Staff overflow letter lots (base letter prefixes), per DOTS.
FS_OVERFLOW_LETTERS = {"K", "P", "U", "V", "X", "XX", "Z"}

# The five campus garages come from the Buildings layer (complete + reliably
# named). Four of five are open to visitors (ParkMobile / pay station); the
# Terrapin Trail garage is the one not open to visitors, per DOTS. The
# UMUC/Marriott garage is privately run (not UMD DOTS) and is excluded.
# "aliases" are the numeric/short lot codes the regulations use for a garage
# (e.g. commuter/resident assignment lists say "Lot 6" = Terrapin Trail,
# "Lot 19" = Mowatt, "SDG" = Stadium Drive Garage).
GARAGE_NAMES = {
    "Mowatt Lane Parking Garage":   {"visitor": True,  "fs": True, "aliases": ["19"]},
    "Union Lane Parking Garage":    {"visitor": True,  "fs": True, "aliases": []},
    "Stadium Drive Parking Garage": {"visitor": True,  "fs": True, "aliases": ["SDG"]},
    "Regents Drive Parking Garage": {"visitor": True,  "fs": True, "aliases": ["B", "RR"]},
    "Terrapin Trail Parking Garage":{"visitor": False, "fs": True, "aliases": ["6"]},
}

# Lots that registrants must relocate from for major athletic/special events,
# per the "Athletic Restrictions" note in the regulations.
ATHLETIC_LOTS = {"1", "3", "4", "5", "6", "7", "9", "11", "SDG"}


def build_lots(buildings):
    # --- surface lots from the point layer -------------------------------
    pts = fetch(f"{LOT_BASE}/6/query",
                {"where": "1=1", "outFields": "*", "outSR": "4326",
                 "f": "geojson"})["features"]

    groups = {}  # display name -> [coords, ...]
    for f in pts:
        name = (f["properties"].get("NAME") or "").strip()
        coords = f.get("geometry", {}).get("coordinates")
        if name and coords and "Garage" not in name:
            groups.setdefault(name, []).append(coords)

    lots = []
    for name, coords in groups.items():
        base = base_code(name)
        numbered = base.isdigit()
        lots.append({
            "code": name,
            "base": base,
            "lat": round(statistics.mean(c[1] for c in coords), 6),
            "lng": round(statistics.mean(c[0] for c in coords), 6),
            "kind": "lot",
            "student_numbered": numbered,
            "facstaff_lettered": not numbered,
            "fs_overflow": (base in FS_OVERFLOW_LETTERS)
                            or (numbered and base != "2"),
            "student_overflow": base == "4",
            "visitor_ok": False,   # surface visitor lots vary; see app note
            "aliases": [],
            "athletic": base in ATHLETIC_LOTS,
        })

    # --- garages from the buildings layer --------------------------------
    bmap = {b["name"]: b for b in buildings}
    for gname, flags in GARAGE_NAMES.items():
        b = bmap.get(gname)
        if not b:
            continue
        short = gname.replace(" Parking Garage", " Garage")
        lots.append({
            "code": short,
            "base": short,
            "lat": b["lat"],
            "lng": b["lng"],
            "kind": "garage",
            "student_numbered": False,
            "facstaff_lettered": False,
            "fs_overflow": flags["fs"],
            "student_overflow": False,
            "visitor_ok": flags["visitor"],
            "aliases": flags["aliases"],
            "athletic": any(a in ATHLETIC_LOTS for a in flags["aliases"]),
        })

    lots.sort(key=lambda x: (x["kind"], x["base"], x["code"]))
    return lots


if __name__ == "__main__":
    b = build_buildings()
    l = build_lots(b)
    with open(os.path.join(HERE, "buildings.json"), "w") as f:
        json.dump(b, f, separators=(",", ":"))
    with open(os.path.join(HERE, "lots.json"), "w") as f:
        json.dump(l, f, separators=(",", ":"))
    print(f"wrote {len(b)} buildings, {len(l)} lots/garages")
