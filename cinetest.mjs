// Does the computed shot actually contain the dataset?
const NS = 474, EW = 502;
const DIAG = Math.hypot(NS, EW);
const PITCH = 55 * Math.PI / 180;
const MARGIN = 1.15;

console.log(`データ範囲: 南北 ${NS} m / 東西 ${EW} m / 対角 ${DIAG.toFixed(0)} m\n`);

for (const [fov, aspect, label] of [
  [50, 16/9, "FOV50 ワイド"],
  [50, 4/3,  "FOV50 4:3"],
  [50, 1.0,  "FOV50 正方形(最も厳しい)"],
  [35, 16/9, "FOV35 望遠寄り"],
  [75, 16/9, "FOV75 広角"],
]) {
  const vHalf = (fov/2) * Math.PI/180;
  const hHalf = Math.atan(Math.tan(vHalf) * aspect);
  const want = DIAG / 2;
  const d = Math.max(want/Math.tan(vHalf), want/Math.tan(hHalf)) * MARGIN;
  const h = d * Math.sin(PITCH);
  const r = d * Math.cos(PITCH);

  // Verify: at distance d, what ground extent fits in the tighter axis?
  const fitsV = 2 * d * Math.tan(vHalf);
  const fitsH = 2 * d * Math.tan(hHalf);
  const ok = Math.min(fitsV, fitsH) >= DIAG;
  console.log(`${label.padEnd(24)} 距離 ${d.toFixed(0)}m → 高度 ${h.toFixed(0)}m / 水平 ${r.toFixed(0)}m`);
  console.log(`${" ".repeat(24)} 収まる幅 縦${fitsV.toFixed(0)}m 横${fitsH.toFixed(0)}m  ${ok ? "OK 対角が収まる" : "NG"}`);
}

console.log("\n=== 以前の固定値との比較 ===");
console.log(`  旧: 高度 165 m 固定 → 対角690mを収めるには全く不足`);
const vHalf = 25*Math.PI/180;
console.log(`  165mで収まる幅(FOV50・真下): ${(2*165*Math.tan(vHalf)).toFixed(0)} m  ← 端が切れる理由`);
