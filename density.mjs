import { readFileSync } from "node:fs";
const d = JSON.parse(readFileSync("public/data/ubld_walkgrid.json", "utf8"));
const cellArea = d.cell * d.cell;
const total = Object.keys(d.grid).length;

console.log(`歩行可能セル: ${total}  (1セル ${cellArea} m²)  総面積 ${total*cellArea} m²`);
console.log(`\n240人を全体に散らした場合の密度: ${(240/(total*cellArea)).toFixed(4)} 人/m²`);
console.log(`  = 1人あたり ${((total*cellArea)/240).toFixed(0)} m²  ← スカスカな理由`);

const cellOf = (lat,lng) => [
  Math.floor(((lng - d.lng0) * d.mPerDegLng) / d.cell),
  Math.floor(((lat - d.lat0) * d.mPerDegLat) / d.cell),
];

// 視界半径内に実際にある歩行可能面積を、代表的な3地点で測る
const points = [
  ["START (24.96m層)", 35.6931732, 139.7026279],
  ["33.5m層", 35.6914363, 139.7007697],
  ["ゴール (38.5m層)", 35.6910744, 139.7011900],
];
console.log("\n=== 視界半径内の歩行可能面積(階層を問わず) ===");
for (const [name, lat, lng] of points) {
  const [cx, cy] = cellOf(lat, lng);
  const row = [];
  for (const R of [20, 35, 50]) {
    const reach = Math.ceil(R / d.cell);
    let n = 0;
    for (let dx=-reach; dx<=reach; dx++) for (let dy=-reach; dy<=reach; dy++) {
      if (Math.hypot(dx*d.cell, dy*d.cell) > R) continue;
      if (d.grid[`${cx+dx},${cy+dy}`]) n++;
    }
    row.push(`R=${R}m: ${String(n).padStart(4)}セル ${String(n*cellArea).padStart(5)} m²`);
  }
  console.log(`  ${name.padEnd(18)} ${row.join("  |  ")}`);
}

// 目標密度から必要人数を逆算(視界50m内)
console.log("\n=== 駅の混雑として妥当な密度から、視界50m内に必要な人数 ===");
const [cx, cy] = cellOf(35.6931732, 139.7026279);
let near50 = 0;
const reach = Math.ceil(50 / d.cell);
for (let dx=-reach; dx<=reach; dx++) for (let dy=-reach; dy<=reach; dy++) {
  if (Math.hypot(dx*d.cell, dy*d.cell) > 50) continue;
  if (d.grid[`${cx+dx},${cy+dy}`]) near50++;
}
const area50 = near50 * cellArea;
console.log(`  START周辺50m内の歩行可能面積: ${area50} m²`);
for (const [label, dens] of [["閑散", 0.05], ["やや混雑", 0.15], ["混雑", 0.3], ["ラッシュ", 0.6]]) {
  console.log(`  ${label.padEnd(8)} ${dens} 人/m²  → ${Math.round(area50*dens)} 人`);
}

console.log("\n=== 全体に散らす方式で同じ密度を出すなら ===");
for (const [label, dens] of [["やや混雑", 0.15], ["混雑", 0.3]]) {
  console.log(`  ${label} (${dens} 人/m²) → 全体で ${Math.round(total*cellArea*dens)} 人 必要`);
}
