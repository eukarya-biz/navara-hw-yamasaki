// Sanity-checks the walk numbers against the child-development figures they
// claim to be based on, so the comments in main.ts cannot quietly drift.
const MOVE_SPEED = 1.9;      // src/main.ts moveSpeed
const BOB_HZ = 4.8;          // src/main.ts bob.hz default
const ROUTE_M = 378;         // measured START -> parent, goaltest.mjs

let fails = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` -- ${detail}` : ""}`);
  if (!ok) fails++;
};

// Route duration: the point of raising the speed was to fit a judge's patience.
const mins = ROUTE_M / MOVE_SPEED / 60;
check("route is walkable in a few minutes", mins < 4,
  `${ROUTE_M} m at ${MOVE_SPEED} m/s = ${mins.toFixed(1)} min`);

// Honesty check on the comment in main.ts: a real 3-4 year old is much slower,
// so this must NOT be presented as realism.
const REAL_CHILD_MS = [1.5 / 3.6, 2.0 / 3.6]; // 1.5-2 km/h
const realMins = [ROUTE_M / REAL_CHILD_MS[1] / 60, ROUTE_M / REAL_CHILD_MS[0] / 60];
check("chosen speed is faster than a real 4-year-old (so it is a story choice)",
  MOVE_SPEED > REAL_CHILD_MS[1],
  `real 3-4yo ${REAL_CHILD_MS[0].toFixed(2)}-${REAL_CHILD_MS[1].toFixed(2)} m/s ` +
  `= ${realMins[0].toFixed(0)}-${realMins[1].toFixed(0)} min for the same route`);

// Cadence is what reads as "child": stride = speed / step rate. A 4-year-old's
// stride is 30-35 cm; an adult's is ~70 cm.
const stride = MOVE_SPEED / BOB_HZ;
// A 4-year-old's stride is 30-35 cm. Allow up to 45 cm as the practical
// compromise, but reject anything approaching an adult's ~70 cm -- an earlier
// default of 2.9 Hz gave 66 cm, which is exactly the failure this catches.
check("bob cadence implies a child-sized stride, not an adult one",
  stride < 0.45,
  `${MOVE_SPEED} m/s at ${BOB_HZ} steps/s = ${(stride * 100).toFixed(0)} cm stride ` +
  `(4yo 30-35 cm, adult ~70 cm)`);

// The crowd must still tower over the eye line -- that is the whole premise.
const EYE = 1.0;
const CROWD_MIN_H = 1.57 * 0.92, CROWD_MAX_H = 1.57 * 1.10;
check("every adult's eye line is above the child's",
  CROWD_MIN_H > EYE,
  `child eye ${EYE} m vs crowd ${CROWD_MIN_H.toFixed(2)}-${CROWD_MAX_H.toFixed(2)} m tall`);

console.log(fails === 0 ? "\nPASS  walk feel numbers are consistent"
                        : `\nFAIL  ${fails} check(s) failed`);
process.exit(fails ? 1 : 0);
