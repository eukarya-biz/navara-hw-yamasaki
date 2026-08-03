// Verifies the floor-following / wall-blocking logic against the real grid,
// by replaying PersonViewPlugin's actual movement model:
//   horizontal: position += forward * moveSpeed * dt
//   vertical:   alt += dirZ * altSpeed * dt, clamped to [minAlt, maxAlt]
// and applying the same correction main.ts applies each frame.

import { readFileSync } from "node:fs";

const data = JSON.parse(readFileSync("public/data/ubld_walkgrid.json", "utf8"));

const cellOf = (lat, lng) => [
  Math.floor(((lng - data.lng0) * data.mPerDegLng) / data.cell),
  Math.floor(((lat - data.lat0) * data.mPerDegLat) / data.cell),
];
const surfacesAt = (lat, lng) => data.grid[cellOf(lat, lng).join(",")];

function surfaceFor(lat, lng, alt, tolerance = 3) {
  const pairs = surfacesAt(lat, lng);
  if (!pairs?.length) return null;
  let best = null;
  let bestDist = Infinity;
  for (const [floor, ceiling] of pairs) {
    const d = Math.abs(alt - floor);
    if (d < bestDist) {
      bestDist = d;
      best = { floor, ceiling };
    }
  }
  return bestDist > tolerance ? null : best;
}

const START = { lat: 35.6931732, lng: 139.7026279, alt: 24.96 };

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  (ok ? pass++ : fail++);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -- " + detail : ""}`);
};

// 1. the hard-coded START must be a real walkable spot
const s0 = surfaceFor(START.lat, START.lng, START.alt);
check(
  "START sits on a walkable surface",
  s0 !== null,
  s0 ? `floor ${s0.floor} ceiling ${s0.ceiling}` : "no surface",
);
check(
  "START headroom fits a 1.1 m child eye line",
  s0 !== null && s0.ceiling - s0.floor > 1.3,
  s0 ? `clearance ${(s0.ceiling - s0.floor).toFixed(2)} m` : "",
);
check(
  "START alt matches the measured floor within 5 cm",
  s0 !== null && Math.abs(START.alt - s0.floor) < 0.05,
);

// 2. replay the old bug: the default altSpeed of 30 m/s vs a 2.9 m corridor
{
  const dt = 1 / 60;
  const dataFloorMin = Math.min(
    ...Object.values(data.grid).flat().map(([f]) => f),
  );
  let alt = START.alt;
  let framesToEscape = null;
  for (let i = 0; i < 10 * 60; i++) {
    alt = Math.max(-100, alt - 30 * dt);
    if (framesToEscape === null && alt < dataFloorMin) framesToEscape = i + 1;
  }
  check(
    "default altSpeed leaves the dataset in well under a second",
    framesToEscape !== null && framesToEscape < 30,
    `escaped after ${framesToEscape} frames (${(framesToEscape / 60).toFixed(2)} s), ` +
      `10 s of holding reaches ${alt.toFixed(1)} m`,
  );
}

// 3. same input, but with floor-following on
{
  let p = { ...START };
  const dt = 1 / 60;
  let last = { ...START };
  let minAlt = Infinity;
  let maxAlt = -Infinity;
  for (let i = 0; i < 4 * 60; i++) {
    p.alt -= 1.5 * dt; // descend key held, corrected altSpeed
    const s = surfaceFor(p.lat, p.lng, p.alt);
    if (s) {
      p.alt = s.floor;
      last = { ...p };
    } else {
      p = { ...last };
    }
    minAlt = Math.min(minAlt, p.alt);
    maxAlt = Math.max(maxAlt, p.alt);
  }
  check(
    "floor-following pins altitude to the floor while descend is held",
    Math.abs(minAlt - START.alt) < 0.01 && Math.abs(maxAlt - START.alt) < 0.01,
    `alt stayed in ${minAlt.toFixed(2)}..${maxAlt.toFixed(2)}`,
  );
}

// 4. walk in every direction for 60 s and confirm we never leave the data
{
  const dt = 1 / 60;
  const moveSpeed = 1.4;
  let escapes = 0;
  let blocked = 0;
  let floorsSeen = new Set();
  const headings = 16;
  for (let hIdx = 0; hIdx < headings; hIdx++) {
    const heading = (hIdx / headings) * Math.PI * 2;
    let p = { ...START };
    let last = { ...START };
    for (let i = 0; i < 60 * 60; i++) {
      const step = moveSpeed * dt;
      const dLat = (Math.cos(heading) * step) / data.mPerDegLat;
      const dLng = (Math.sin(heading) * step) / data.mPerDegLng;
      const cand = { lat: p.lat + dLat, lng: p.lng + dLng, alt: p.alt };
      const s = surfaceFor(cand.lat, cand.lng, cand.alt);
      if (s) {
        p = { lat: cand.lat, lng: cand.lng, alt: s.floor };
        last = { ...p };
        floorsSeen.add(Math.round(s.floor));
      } else {
        blocked++;
        p = { ...last };
      }
      if (surfaceFor(p.lat, p.lng, p.alt) === null) escapes++;
    }
  }
  check(
    "60 s walk in 16 directions never ends up off the walkable grid",
    escapes === 0,
    `escapes=${escapes}, blocked frames=${blocked}`,
  );
  check(
    "the walk reaches more than one floor elevation",
    floorsSeen.size > 1,
    `floors reached: ${[...floorsSeen].sort((a, b) => a - b).join(", ")} m`,
  );
}

// 5. a point well outside the surveyed area must be rejected
{
  const far = surfaceFor(35.68, 139.69, 25);
  check("a point outside the dataset has no surface", far === null);
}

// 6. jitter check: once standing on the floor, no correction should be emitted
{
  const s = surfaceFor(START.lat, START.lng, START.alt);
  const deadzone = 0.1;
  const needsFix = Math.abs(START.alt - s.floor) > deadzone;
  check("a stationary walker on the floor emits no teleport", !needsFix);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
