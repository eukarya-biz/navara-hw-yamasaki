import json
from collections import defaultdict

import pathlib
ROOT = pathlib.Path(__file__).resolve().parent.parent
d = json.load(open(ROOT / "public/data/ubld_walkgrid.json"))
cell = d["cell"]; lat0 = d["lat0"]; lng0 = d["lng0"]
mlat = d["mPerDegLat"]; mlng = d["mPerDegLng"]
grid = {tuple(map(int, k.split(","))): v for k, v in d["grid"].items()}

print("cell=%.1fm cells=%d" % (cell, len(grid)))

# group cells by rounded floor level
levels = defaultdict(list)
for k, pairs in grid.items():
    for f, c in pairs:
        levels[round(f * 2) / 2].append((k, f, c))

print("\ntop floor levels by cell count:")
for lv in sorted(levels, key=lambda x: -len(levels[x]))[:10]:
    print("  %6.1f m : %4d cells" % (lv, len(levels[lv])))

def to_geo(k):
    lng = lng0 + ((k[0] + 0.5) * cell) / mlng
    lat = lat0 + ((k[1] + 0.5) * cell) / mlat
    return lat, lng

def openness(k, member):
    return sum((k[0] + i, k[1] + j) in member
               for i in range(-3, 4) for j in range(-3, 4))

# main level = most populous
main_lv = max(levels, key=lambda x: len(levels[x]))
main_cells = {k for k, f, c in levels[main_lv]}
best = max(levels[main_lv], key=lambda t: (openness(t[0], main_cells), t[2] - t[1]))
k, f, c = best
lat, lng = to_geo(k)
print("\n=== recommended START (2m grid) ===")
print("  lat  %.7f" % lat)
print("  lng  %.7f" % lng)
print("  floor   %.2f m" % f)
print("  ceiling %.2f m  (clearance %.2f m)" % (c, c - f))
print("  openness %d / 49 neighbouring cells" % openness(k, main_cells))
print("  main level %.1f m, %d cells (%.0f m2)" % (main_lv, len(main_cells), len(main_cells) * cell * cell))

# a representative, well-connected spot per major level
print("\n=== level jump targets ===")
spots = []
for lv in sorted(levels, key=lambda x: -len(levels[x]))[:5]:
    member = {kk for kk, ff, cc in levels[lv]}
    b = max(levels[lv], key=lambda t: openness(t[0], member))
    la, ln = to_geo(b[0])
    spots.append({"label": "%.1f m" % lv, "lat": round(la, 7), "lng": round(ln, 7), "alt": round(b[1], 2)})
    print("  %6.1f m -> lat %.7f lng %.7f alt %.2f (cells %d)" % (lv, la, ln, b[1], len(member)))

json.dump({"start": {"lat": round(lat, 7), "lng": round(lng, 7), "alt": round(f, 2),
                     "ceiling": round(c, 2)},
           "levels": spots}, open(ROOT / "tools/start.json", "w"), indent=2)
print("\nwrote start.json")
