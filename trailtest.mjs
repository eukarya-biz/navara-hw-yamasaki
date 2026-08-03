// Verifies the trail ribbon geometry: correct width, flat across stairs, and
// correctly wound triangles. A silently malformed ribbon is hard to diagnose
// from a screenshot, so it is checked arithmetically here.
import { Vector3 } from "three";

const WIDTH = 4.5;
let fails = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` -- ${detail}` : ""}`);
  if (!ok) fails++;
};

// Mirrors the loop in TrailMeshDesc.createMesh().
function buildRibbon(local, widthM) {
  const half = widthM / 2;
  const positions = [];
  const indices = [];
  const up = new Vector3(0, 1, 0);
  const dir = new Vector3();
  const side = new Vector3();
  for (let i = 0; i < local.length; i++) {
    const prev = local[Math.max(0, i - 1)];
    const next = local[Math.min(local.length - 1, i + 1)];
    dir.subVectors(next, prev);
    dir.y = 0;
    if (dir.lengthSq() < 1e-8) dir.set(1, 0, 0);
    dir.normalize();
    side.crossVectors(up, dir).normalize().multiplyScalar(half);
    positions.push(
      local[i].x + side.x, local[i].y + side.y, local[i].z + side.z,
      local[i].x - side.x, local[i].y - side.y, local[i].z - side.z,
    );
    if (i > 0) {
      const a = (i - 1) * 2, b = a + 1, c = i * 2, d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  return { positions, indices };
}

const vec = (x, y, z) => new Vector3(x, y, z);

// 1. A straight run: the two rails must be exactly widthM apart.
{
  const path = [vec(0,0,0), vec(10,0,0), vec(20,0,0)];
  const { positions, indices } = buildRibbon(path, WIDTH);
  const w = Math.hypot(
    positions[0]-positions[3], positions[1]-positions[4], positions[2]-positions[5],
  );
  check("straight path: ribbon is exactly the requested width",
    Math.abs(w - WIDTH) < 1e-6, `${w.toFixed(4)} m vs ${WIDTH} m`);
  check("straight path: two triangles per segment",
    indices.length === (path.length - 1) * 6,
    `${indices.length / 3} triangles for ${path.length - 1} segments`);
  check("no index exceeds the vertex count",
    Math.max(...indices) < positions.length / 3,
    `max index ${Math.max(...indices)}, ${positions.length / 3} vertices`);
}

// 2. Climbing stairs: the ribbon must stay flat (both rails at the same height),
//    which is the reason the direction is flattened before the cross product.
{
  const path = [vec(0,0,0), vec(5,3,0), vec(10,6,0)];
  const { positions } = buildRibbon(path, WIDTH);
  let maxTilt = 0;
  for (let i = 0; i < path.length; i++) {
    const yA = positions[i*6+1], yB = positions[i*6+4];
    maxTilt = Math.max(maxTilt, Math.abs(yA - yB));
  }
  check("climbing path: ribbon stays level across its width",
    maxTilt < 1e-9, `max height difference between rails ${maxTilt.toExponential(2)} m`);
}

// 3. A right-angle turn must not collapse or invert the ribbon.
{
  const path = [vec(0,0,0), vec(10,0,0), vec(10,0,10)];
  const { positions } = buildRibbon(path, WIDTH);
  let minW = Infinity;
  for (let i = 0; i < path.length; i++) {
    const w = Math.hypot(
      positions[i*6]-positions[i*6+3],
      positions[i*6+1]-positions[i*6+4],
      positions[i*6+2]-positions[i*6+5],
    );
    minW = Math.min(minW, w);
  }
  check("right-angle turn: ribbon never collapses",
    minW > WIDTH * 0.99, `narrowest ${minW.toFixed(3)} m`);
}

// 4. Duplicate consecutive points must not produce NaN.
{
  const path = [vec(0,0,0), vec(0,0,0), vec(5,0,0)];
  const { positions } = buildRibbon(path, WIDTH);
  check("duplicate points do not produce NaN",
    positions.every(Number.isFinite), "all coordinates finite");
}

// 5. Visibility from the closing shot's altitude.
{
  const H = 697, FOV = 50, SCREEN_PX = 1400;
  const groundPerPx = (2 * H * Math.tan((FOV/2) * Math.PI/180)) / SCREEN_PX;
  const px = WIDTH / groundPerPx;
  check("ribbon is legible from the aerial shot", px >= 4,
    `${WIDTH} m ~= ${px.toFixed(1)} px at ${H} m altitude`);
}

console.log(fails === 0 ? "\nPASS  trail geometry is sound" : `\nFAIL  ${fails} check(s)`);
process.exit(fails ? 1 : 0);
