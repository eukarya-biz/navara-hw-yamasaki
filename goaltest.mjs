// Verifies the goal and its approach point against the shipped walk grid.
// Both are hard-coded measurements in src/goal.ts, so this guards against them
// drifting out of step with the data (e.g. if the tileset is ever regenerated).
import { readFileSync } from "node:fs";

const d = JSON.parse(readFileSync("public/data/ubld_walkgrid.json", "utf8"));
const src = readFileSync("src/goal.ts", "utf8");

function constBlock(name) {
  const i = src.indexOf(`export const ${name} = {`);
  if (i < 0) throw new Error(`${name} not found in src/goal.ts`);
  const body = src.slice(i, src.indexOf("};", i));
  const grab = (k) => {
    const m = body.match(new RegExp(`\\b${k}:\\s*(-?[0-9.]+)`));
    return m ? parseFloat(m[1]) : null;
  };
  return { lat: grab("lat"), lng: grab("lng"), alt: grab("alt") };
}

const GOAL = constBlock("GOAL");
const APPROACH = constBlock("GOAL_APPROACH");
const START = { lat: 35.6931732, lng: 139.7026279, alt: 24.96 };
const TOL = 3;
const REUNION_RADIUS = 3.5;

const cellOf = (lat, lng) => [
  Math.floor(((lng - d.lng0) * d.mPerDegLng) / d.cell),
  Math.floor(((lat - d.lat0) * d.mPerDegLat) / d.cell),
];

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` -- ${detail}` : ""}`);
  if (!ok) failures++;
};

function floorAt(point) {
  const pairs = d.grid[cellOf(point.lat, point.lng).join(",")];
  if (!pairs) return null;
  return pairs.find(([f]) => Math.abs(f - point.alt) < 0.6) ?? null;
}

// The parent and the approach point must both stand on a real floor at the
// elevation the code claims.
const gFloor = floorAt(GOAL);
check("parent stands on a real floor", !!gFloor,
  gFloor ? `floor ${gFloor[0]} ceiling ${gFloor[1]} (headroom ${(gFloor[1]-gFloor[0]).toFixed(2)} m)` : "no surface at GOAL.alt");

const aFloor = floorAt(APPROACH);
check("approach point stands on a real floor", !!aFloor,
  aFloor ? `floor ${aFloor[0]} ceiling ${aFloor[1]}` : "no surface at GOAL_APPROACH.alt");

// Critically: the same floor. An approach point on a different level leaves the
// player five metres below the parent with no way to trigger the reunion.
check("approach point is on the parent's floor",
  !!gFloor && !!aFloor && Math.abs(gFloor[0] - aFloor[0]) < 0.6,
  gFloor && aFloor ? `${aFloor[0]} vs ${gFloor[0]}` : "");

// Far enough to walk in, close enough to see.
const approachDist = Math.hypot(
  (APPROACH.lat - GOAL.lat) * d.mPerDegLat,
  (APPROACH.lng - GOAL.lng) * d.mPerDegLng,
);
check("approach point is outside the reunion radius",
  approachDist > REUNION_RADIUS, `${approachDist.toFixed(2)} m > ${REUNION_RADIUS} m`);
check("approach point is within sight", approachDist < 15, `${approachDist.toFixed(2)} m`);

// And the whole point: you can actually walk there from the start.
const start = cellOf(START.lat, START.lng);
const sPairs = d.grid[start.join(",")];
const sFloor = sPairs.reduce((b, [f]) =>
  Math.abs(f - START.alt) < Math.abs(b - START.alt) ? f : b, sPairs[0][0]);
const goalCell = cellOf(GOAL.lat, GOAL.lng).join(",");
const seen = new Set([`${start[0]},${start[1]},${sFloor.toFixed(2)}`]);
const queue = [[start[0], start[1], sFloor, 0]];
let steps = null;
while (queue.length) {
  const [cx, cy, floor, n] = queue.shift();
  if (`${cx},${cy}` === goalCell && steps === null) steps = n;
  for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
    const nx = cx + dx, ny = cy + dy;
    const pairs = d.grid[`${nx},${ny}`];
    if (!pairs) continue;
    for (const [f] of pairs) {
      if (Math.abs(f - floor) > TOL) continue;
      const key = `${nx},${ny},${f.toFixed(2)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      queue.push([nx, ny, f, n + 1]);
    }
  }
}
check("parent is reachable on foot from START", steps !== null,
  steps !== null ? `${steps} steps = ${steps * d.cell} m` : "unreachable");

// Open enough that the parent is visible rather than round a corner.
const [gx, gy] = cellOf(GOAL.lat, GOAL.lng);
let open = 0;
for (let dx = -2; dx <= 2; dx++) {
  for (let dy = -2; dy <= 2; dy++) {
    const pairs = d.grid[`${gx+dx},${gy+dy}`];
    if (pairs && pairs.some(([f]) => Math.abs(f - GOAL.alt) <= TOL)) open++;
  }
}
check("parent stands somewhere open", open >= 10, `${open}/25 cells walkable`);

console.log(failures === 0
  ? "\nPASS  goal geometry agrees with the shipped grid"
  : `\nFAIL  ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
