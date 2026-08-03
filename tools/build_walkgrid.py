import json, math, os, sys
from collections import defaultdict
import numpy as np
import pygltflib

import pathlib
ROOT = pathlib.Path(__file__).resolve().parent.parent
BASE = str(ROOT / "public/data/shinjuku_ubld_3dtiles")
OUT = str(ROOT / "public/data/ubld_walkgrid.json")
CELL = 2.0
# A surface counts as walkable floor/ceiling only if it is close to horizontal.
NZ_MIN = 0.75

ts = json.load(open(os.path.join(BASE, "tileset.json")))
leaves = []
def walk(node, acc):
    t = node.get("transform")
    if t:
        acc = acc + np.array(t, dtype=np.float64).reshape(4, 4)[3, :3]
    ch = node.get("children") or []
    if node.get("content") and not ch:
        leaves.append((node["content"]["uri"], acc.copy()))
    for x in ch:
        walk(x, acc)
walk(ts["root"], np.zeros(3))

CT = {5126: np.float32, 5123: np.uint16, 5125: np.uint32, 5121: np.uint8}

def read_acc(g, blob, idx, nc):
    a = g.accessors[idx]
    bv = g.bufferViews[a.bufferView]
    dt = np.dtype(CT[a.componentType])
    elem = dt.itemsize * nc
    stride = bv.byteStride or elem
    base = (bv.byteOffset or 0) + (a.byteOffset or 0)
    if stride == elem:
        arr = np.frombuffer(blob, dtype=dt, count=a.count * nc, offset=base)
        return arr.reshape(a.count, nc) if nc > 1 else arr
    out = np.empty((a.count, nc), dtype=dt)
    for i in range(a.count):
        out[i] = np.frombuffer(blob, dtype=dt, count=nc, offset=base + i * stride)
    return out if nc > 1 else out.ravel()

A = 6378137.0
F = 1.0 / 298.257223563
E2 = F * (2 - F)
def to_geo(xyz):
    x, y, z = xyz[:, 0], xyz[:, 1], xyz[:, 2]
    lon = np.arctan2(y, x)
    p = np.hypot(x, y)
    lat = np.arctan2(z, p * (1 - E2))
    for _ in range(8):
        N = A / np.sqrt(1 - E2 * np.sin(lat) ** 2)
        lat = np.arctan2(z + E2 * N * np.sin(lat), p)
    N = A / np.sqrt(1 - E2 * np.sin(lat) ** 2)
    h = p / np.cos(lat) - N
    return np.degrees(lat), np.degrees(lon), h

# First pass: gather all triangles as geodetic-derived local metre coords.
tris = []
for uri, acc in leaves:
    g = pygltflib.GLTF2().load(os.path.join(BASE, uri))
    blob = g.binary_blob()
    for mesh in g.meshes:
        for prim in mesh.primitives:
            if prim.attributes.POSITION is None or prim.indices is None:
                continue
            v = read_acc(g, blob, prim.attributes.POSITION, 3).astype(np.float64)
            v = np.stack([v[:, 0], -v[:, 2], v[:, 1]], axis=1)  # Y-up -> Z-up
            idx = read_acc(g, blob, prim.indices, 1).astype(np.int64)
            la, lo, h = to_geo(v + acc)
            tris.append((la, lo, h, idx))

lat_all = np.concatenate([t[0] for t in tris])
lng_all = np.concatenate([t[1] for t in tris])
lat0 = float((lat_all.min() + lat_all.max()) / 2)
lng0 = float((lng_all.min() + lng_all.max()) / 2)
mlat = 110540.0
mlng = 111320.0 * math.cos(math.radians(lat0))
print("origin lat0=%.7f lng0=%.7f" % (lat0, lng0))

# Second pass: rasterize near-horizontal triangles into the cell grid.
cells = defaultdict(list)
n_tri = 0
n_horiz = 0
for la, lo, h, idx in tris:
    X = (lo - lng0) * mlng
    Y = (la - lat0) * mlat
    Z = h
    tri = idx.reshape(-1, 3)
    n_tri += len(tri)
    p0 = np.stack([X[tri[:, 0]], Y[tri[:, 0]], Z[tri[:, 0]]], axis=1)
    p1 = np.stack([X[tri[:, 1]], Y[tri[:, 1]], Z[tri[:, 1]]], axis=1)
    p2 = np.stack([X[tri[:, 2]], Y[tri[:, 2]], Z[tri[:, 2]]], axis=1)
    n = np.cross(p1 - p0, p2 - p0)
    ln = np.linalg.norm(n, axis=1)
    ok = ln > 1e-9
    nz = np.zeros(len(tri))
    nz[ok] = np.abs(n[ok, 2] / ln[ok])
    horiz = ok & (nz >= NZ_MIN)
    n_horiz += int(horiz.sum())

    for a0, a1, a2 in zip(p0[horiz], p1[horiz], p2[horiz]):
        minx = min(a0[0], a1[0], a2[0]); maxx = max(a0[0], a1[0], a2[0])
        miny = min(a0[1], a1[1], a2[1]); maxy = max(a0[1], a1[1], a2[1])
        cx0 = int(math.floor(minx / CELL)); cx1 = int(math.floor(maxx / CELL))
        cy0 = int(math.floor(miny / CELL)); cy1 = int(math.floor(maxy / CELL))
        zmean = (a0[2] + a1[2] + a2[2]) / 3.0
        # Always mark the centroid's cell so triangles smaller than a cell count.
        gcx = int(math.floor(((a0[0] + a1[0] + a2[0]) / 3.0) / CELL))
        gcy = int(math.floor(((a0[1] + a1[1] + a2[1]) / 3.0) / CELL))
        cells[(gcx, gcy)].append(zmean)
        if (cx1 - cx0) > 60 or (cy1 - cy0) > 60:
            continue  # pathological span; centroid already recorded
        # Point-in-triangle at each cell centre.
        d = (a1[1] - a2[1]) * (a0[0] - a2[0]) + (a2[0] - a1[0]) * (a0[1] - a2[1])
        if abs(d) < 1e-12:
            continue
        for cx in range(cx0, cx1 + 1):
            px = (cx + 0.5) * CELL
            for cy in range(cy0, cy1 + 1):
                py = (cy + 0.5) * CELL
                l1 = ((a1[1] - a2[1]) * (px - a2[0]) + (a2[0] - a1[0]) * (py - a2[1])) / d
                if l1 < -0.02 or l1 > 1.02:
                    continue
                l2 = ((a2[1] - a0[1]) * (px - a2[0]) + (a0[0] - a2[0]) * (py - a2[1])) / d
                if l2 < -0.02 or l2 > 1.02:
                    continue
                l3 = 1.0 - l1 - l2
                if l3 < -0.02 or l3 > 1.02:
                    continue
                cells[(cx, cy)].append(l1 * a0[2] + l2 * a1[2] + l3 * a2[2])

print("triangles: %d (near-horizontal: %d)" % (n_tri, n_horiz))
print("cells touched by a horizontal surface: %d" % len(cells))

def surfaces(vals):
    vals = np.sort(np.asarray(vals))
    out, start = [], 0
    for i in range(1, len(vals)):
        if vals[i] - vals[i - 1] > 0.5:
            out.append(float(np.median(vals[start:i])))
            start = i
    out.append(float(np.median(vals[start:])))
    return out

MIN_CLEAR, MAX_CLEAR = 1.9, 7.0
grid = {}
n_pairs = 0
for k, vals in cells.items():
    ss = surfaces(vals)
    pairs = []
    for i in range(len(ss) - 1):
        c = ss[i + 1] - ss[i]
        if MIN_CLEAR <= c <= MAX_CLEAR:
            pairs.append([round(ss[i], 2), round(ss[i + 1], 2)])
    if pairs:
        grid["%d,%d" % k] = pairs
        n_pairs += len(pairs)

print("walkable cells: %d (pairs: %d, area %.0f m2)"
      % (len(grid), n_pairs, len(grid) * CELL * CELL))

json.dump({"cell": CELL, "lat0": lat0, "lng0": lng0,
           "mPerDegLat": mlat, "mPerDegLng": mlng, "grid": grid},
          open(OUT, "w"), separators=(",", ":"))
print("wrote %s (%.0f KB)" % (OUT, os.path.getsize(OUT) / 1024))
