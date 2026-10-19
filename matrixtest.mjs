import { Matrix4, Quaternion, Vector3 } from "three";

// 1. Prove the float32 precision problem is real (justifies the anchor design).
console.log("=== instanceMatrix is float32: what ECEF costs ===");
const ecefX = -3955318.2;
const f32 = new Float32Array(1);
f32[0] = ecefX;
console.log(`  ECEF x        : ${ecefX}`);
console.log(`  as float32    : ${f32[0]}`);
console.log(`  error         : ${Math.abs(f32[0] - ecefX).toFixed(3)} m  <-- visible snapping`);
f32[0] = ecefX + 0.02; // one frame of walking at 1.2 m/s
console.log(`  +2cm step also rounds to: ${f32[0]}  (movement lost entirely)`);

const local = 137.482;
f32[0] = local;
console.log(`  local offset  : ${local} -> float32 ${f32[0]}, error ${Math.abs(f32[0]-local).toExponential(2)} m  <-- fine`);

// 2. Heading convention: model forward is +Z; in the West-Up-North frame that
//    `geodetic` builds, heading 0 must face north (+Z) and 90 east (-X).
console.log("\n=== heading: model +Z forward, frame X=west Y=up Z=north ===");
const axisY = new Vector3(0, 1, 0);
for (const [name, headingDeg] of [["north", 0], ["east", 90], ["south", 180], ["west", 270]]) {
  const h = headingDeg * Math.PI / 180;
  const q = new Quaternion().setFromAxisAngle(axisY, -h);
  const fwd = new Vector3(0, 0, 1).applyQuaternion(q); // model forward
  // local (x,y,z) = (west, up, north)
  const northComp = fwd.z, eastComp = -fwd.x;
  const gotDeg = ((Math.atan2(eastComp, northComp) * 180 / Math.PI) + 360) % 360;
  const ok = Math.abs(gotDeg - headingDeg) < 0.001 || Math.abs(gotDeg - headingDeg - 360) < 0.001;
  console.log(`  heading ${String(headingDeg).padStart(3)}° (${name.padEnd(5)}) -> forward points ${gotDeg.toFixed(1)}°  ${ok ? "OK" : "MISMATCH"}`);
}

// 3. Limb pivot: a swinging leg must rotate about the hip, and its foot must
//    leave the ground forwards/backwards, never sideways.
console.log("\n=== leg swing pivots at the hip, swings along forward axis ===");
const HIP_Y = 0.75, LEG_X = 0.09;
for (const swing of [0, 0.5, -0.5]) {
  const mPerson = new Matrix4().compose(new Vector3(0,0,0), new Quaternion(), new Vector3(1,1,1));
  const mPivot = new Matrix4().makeTranslation(-LEG_X, HIP_Y, 0);
  const mSwing = new Matrix4().makeRotationX(swing);
  const m = mPerson.clone().multiply(new Matrix4().multiplyMatrices(mPivot, mSwing));
  // Foot = bottom of the leg, at local (0, -HIP_Y, 0) before the transform.
  const foot = new Vector3(0, -HIP_Y, 0).applyMatrix4(m);
  const hip = new Vector3(0, 0, 0).applyMatrix4(m);
  console.log(`  swing ${swing.toFixed(2).padStart(5)} rad: hip=(${hip.x.toFixed(3)},${hip.y.toFixed(3)},${hip.z.toFixed(3)}) foot=(${foot.x.toFixed(3)},${foot.y.toFixed(3)},${foot.z.toFixed(3)})`);
}
console.log("  hip must stay fixed at (-0.090, 0.750, 0.000) for all swings; foot z must move, x must not.");

// 4. Draw-call arithmetic
console.log("\n=== draw calls ===");
for (const n of [25, 240, 600]) {
  console.log(`  ${String(n).padStart(3)} people: per-mesh = ${n*6} draw calls, instanced = 6`);
}
