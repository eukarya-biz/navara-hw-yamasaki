// Metres per degree on the WGS84 ellipsoid at a latitude -- the scale factors
// behind every flat-earth "lat/lng difference times a constant" in this scene
// (crowd, trail, goal distance, audio, head bob, closing shot).
//
// This replaces the literal 110540 that was used everywhere. At Shinjuku the
// true meridional value is 110,953 m/deg (navara's own frame measures the
// same), so the literal was 0.37 % short; the crowd and the trail were drawn
// up to 0.2 m and 1 m from their logical positions at the edges of their
// local frames. The walk grid keeps its own constants inside its JSON: it is
// written and read with the same numbers, so its cell mapping is consistent
// as it is.

const A = 6378137;
const F = 1 / 298.257223563;
const E2 = F * (2 - F);
const DEG = Math.PI / 180;

export type MetresPerDegree = {
  /** Along a meridian (north-south). */
  lat: number;
  /** Along the parallel (east-west) at this latitude. */
  lng: number;
};

export function metresPerDegree(latDeg: number): MetresPerDegree {
  const phi = latDeg * DEG;
  const s2 = Math.sin(phi) ** 2;
  const meridional = (A * (1 - E2)) / Math.pow(1 - E2 * s2, 1.5);
  const parallel = (A / Math.sqrt(1 - E2 * s2)) * Math.cos(phi);
  return { lat: meridional * DEG, lng: parallel * DEG };
}
