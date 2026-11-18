"""Bake the underground's floor plan for the minimap.

    python3 -I tools/build_floorplan.py <ubld.gml> [public/data/ubld_floorplan.json]

Input is the EDITED CityGML the bundled tileset was made from (see README,
"モデルの差し替え"): closure surfaces, room seams and the passable doors are
already gone or opened there, so the plan shows corridors as you walk them.

Output (local metres east / north of `origin`, using the same WGS84 metres
per degree as src/geo.ts):
  floors: [{ h, pts: [x, y, x, y, ...] }]    FloorSurface outlines, h = mean height
  walls:  [{ h, seg: [x1, y1, x2, y2] }]     the foot of each wall face; opened
                                              doors (holes in the wall) are cut out
"""
import json
import math
import sys
import xml.etree.ElementTree as ET

GML = "{http://www.opengis.net/gml}"
A = 6378137.0
F = 1 / 298.257223563
E2 = F * (2 - F)

src = sys.argv[1]
out = sys.argv[2] if len(sys.argv) > 2 else "public/data/ubld_floorplan.json"
root = ET.parse(src).getroot()

def local(tag):
    return tag.rsplit("}", 1)[-1]

def ring(el):
    pl = el.find(f".//{GML}posList")
    v = [float(t) for t in pl.text.split()]
    return [(v[i], v[i + 1], v[i + 2]) for i in range(0, len(v) - 2, 3)]

# origin = middle of all floor vertices; metres per degree as src/geo.ts
floor_polys = []
for el in root.iter():
    if local(el.tag) == "FloorSurface":
        for poly in el.iter(f"{GML}Polygon"):
            floor_polys.append(ring(poly.find(f"{GML}exterior")))
lats = [p[0] for r in floor_polys for p in r]
lngs = [p[1] for r in floor_polys for p in r]
lat0 = (min(lats) + max(lats)) / 2
lng0 = (min(lngs) + max(lngs)) / 2
phi = math.radians(lat0)
s2 = math.sin(phi) ** 2
m_lat = A * (1 - E2) / (1 - E2 * s2) ** 1.5 * math.pi / 180
m_lng = A / math.sqrt(1 - E2 * s2) * math.cos(phi) * math.pi / 180

def xy(p):
    return ((p[1] - lng0) * m_lng, (p[0] - lat0) * m_lat)

r1 = lambda v: round(v, 1)
floors = []
for r in floor_polys:
    pts = [c for p in r[:-1] for c in map(r1, xy(p))]
    floors.append({"h": round(sum(p[2] for p in r) / len(r), 2), "pts": pts})

walls = []
for el in root.iter():
    if local(el.tag) not in ("WallSurface", "InteriorWallSurface"):
        continue
    for poly in el.iter(f"{GML}Polygon"):
        ext = ring(poly.find(f"{GML}exterior"))
        base = min(p[2] for p in ext)
        foot = [xy(p) for p in ext if p[2] - base < 0.3]
        if len(foot) < 2:
            continue
        # the two foot points farthest apart give the wall's footprint
        a, b = max(((p, q) for p in foot for q in foot), key=lambda pq: math.dist(pq[0], pq[1]))
        L = math.dist(a, b)
        if L < 0.2:
            continue
        ux, uy = (b[0] - a[0]) / L, (b[1] - a[1]) / L
        # holes reaching the floor (opened doors) cut the footprint
        cuts = []
        for hole in poly.findall(f"{GML}interior"):
            hr = ring(hole)
            if min(p[2] for p in hr) - base > 0.3:
                continue
            ts = [((x - a[0]) * ux + (y - a[1]) * uy) for x, y in map(xy, hr)]
            cuts.append((min(ts), max(ts)))
        cuts.sort()
        t = 0.0
        pieces = []
        for c0, c1 in cuts:
            if c0 > t:
                pieces.append((t, c0))
            t = max(t, c1)
        if t < L:
            pieces.append((t, L))
        for t0, t1 in pieces:
            if t1 - t0 < 0.1:
                continue
            walls.append({"h": round(base, 2), "seg": [r1(a[0] + ux * t0), r1(a[1] + uy * t0), r1(a[0] + ux * t1), r1(a[1] + uy * t1)]})

json.dump({"origin": {"lat": lat0, "lng": lng0}, "floors": floors, "walls": walls}, open(out, "w"), separators=(",", ":"))
print(f"floors {len(floors)}, wall segments {len(walls)} -> {out}")
