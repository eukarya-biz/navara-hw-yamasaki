// Can you actually walk around down there? Flood-fills the walkable grid from
// the start cell using the same movement rule the game applies: you may step to
// a 4-neighbour cell if it has a surface within the stair tolerance of the one
// you are standing on.

import { readFileSync } from "node:fs";

const d = JSON.parse(readFileSync("public/data/ubld_walkgrid.json", "utf8"));
const START = { lat: 35.6931732, lng: 139.7026279, alt: 24.96 };
const STAIR_TOLERANCE = 3;

const cellOf = (lat, lng) => [
  Math.floor(((lng - d.lng0) * d.mPerDegLng) / d.cell),
  Math.floor(((lat - d.lat0) * d.mPerDegLat) / d.cell),
];

const totalCells = Object.keys(d.grid).length;
const start = cellOf(START.lat, START.lng);
const startPairs = d.grid[start.join(",")];
if (!startPairs) throw new Error("start cell is not in the grid");
const startFloor = startPairs.reduce(
  (b, [f]) => (Math.abs(f - START.alt) < Math.abs(b - START.alt) ? f : b),
  startPairs[0][0],
);

const seen = new Set([`${start[0]},${start[1]},${startFloor.toFixed(2)}`]);
const queue = [[start[0], start[1], startFloor]];
const floors = new Map();
let maxDist = 0;
const dist = new Map([[`${start[0]},${start[1]}`, 0]]);

while (queue.length) {
  const [cx, cy, floor] = queue.shift();
  floors.set(Math.round(floor), (floors.get(Math.round(floor)) ?? 0) + 1);
  const here = dist.get(`${cx},${cy}`) ?? 0;
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const nx = cx + dx;
    const ny = cy + dy;
    const pairs = d.grid[`${nx},${ny}`];
    if (!pairs) continue;
    for (const [f] of pairs) {
      if (Math.abs(f - floor) > STAIR_TOLERANCE) continue;
      const key = `${nx},${ny},${f.toFixed(2)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      queue.push([nx, ny, f]);
      const nd = here + 1;
      if (!dist.has(`${nx},${ny}`) || dist.get(`${nx},${ny}`) > nd) {
        dist.set(`${nx},${ny}`, nd);
      }
      maxDist = Math.max(maxDist, nd);
    }
  }
}

const reachedCells = new Set([...seen].map((k) => k.split(",").slice(0, 2).join(",")));
const pct = (100 * reachedCells.size) / totalCells;
const area = reachedCells.size * d.cell * d.cell;

console.log(`grid cells total        : ${totalCells}`);
console.log(`reachable from START    : ${reachedCells.size} (${pct.toFixed(1)}%)`);
console.log(`reachable floor area    : ${area.toFixed(0)} m2`);
console.log(`furthest cell           : ${maxDist} steps = ${(maxDist * d.cell).toFixed(0)} m of path`);
console.log(`floor elevations reached: ${[...floors.keys()].sort((a, b) => a - b).join(", ")} m`);
console.log("");

const ok = reachedCells.size > 800 && maxDist * d.cell > 150 && floors.size >= 2;
console.log(ok ? "PASS  the underground is connected and walkable from START"
              : "FAIL  the reachable area is too small or too flat");
process.exit(ok ? 0 : 1);
