// Floor/ceiling grid derived from the PLATEAU underground CityGML geometry.
//
// PersonViewPlugin 0.0.2 has no gravity and no collision -- its whole vertical
// model is `alt += dirZ * altSpeed * dt` clamped to [minAlt, maxAlt]. So the
// camera flies straight through floors and walls. This grid gives us the floor
// height ourselves: the tileset's glb vertices were bucketed into square cells,
// the distinct horizontal surfaces in each cell were detected, and every
// floor/ceiling pair with human clearance was kept.
//
// Two things are built on it: snapping altitude to the local floor (walking),
// and refusing to enter cells with no walkable surface (walls).

/** `[floorElevation, ceilingElevation]` in metres, orthometric. */
export type SurfacePair = [number, number];

export type WalkGridData = {
  /** Cell size in metres. */
  cell: number;
  /** Origin the local metre grid is measured from. */
  lat0: number;
  lng0: number;
  mPerDegLat: number;
  mPerDegLng: number;
  /** `"cx,cy"` -> surface pairs, ordered low to high. */
  grid: Record<string, SurfacePair[]>;
};

export type Surface = { floor: number; ceiling: number };

export class WalkGrid {
  private readonly d: WalkGridData;

  constructor(data: WalkGridData) {
    this.d = data;
  }

  static async load(url: string): Promise<WalkGrid> {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`walk grid fetch failed: ${res.status} ${url}`);
    }
    return new WalkGrid((await res.json()) as WalkGridData);
  }

  get cellCount(): number {
    return Object.keys(this.d.grid).length;
  }

  /** Cell indices for a geodetic position. */
  cellOf(lat: number, lng: number): [number, number] {
    const x = (lng - this.d.lng0) * this.d.mPerDegLng;
    const y = (lat - this.d.lat0) * this.d.mPerDegLat;
    return [Math.floor(x / this.d.cell), Math.floor(y / this.d.cell)];
  }

  surfacesAt(lat: number, lng: number): SurfacePair[] | undefined {
    const [cx, cy] = this.cellOf(lat, lng);
    return this.d.grid[`${cx},${cy}`];
  }

  /**
   * The surface the walker should be standing on at this position, given the
   * altitude they are currently at.
   *
   * Picking the *nearest* floor rather than the lowest is what keeps stacked
   * corridors working: the walker stays on the level they are already on
   * instead of dropping to the deepest one whenever passages overlap. The
   * tolerance has to be loose enough for a stair step between adjacent cells
   * but tight enough not to jump between levels.
   */
  surfaceFor(
    lat: number,
    lng: number,
    alt: number,
    tolerance = 3,
  ): Surface | null {
    const pairs = this.surfacesAt(lat, lng);
    if (!pairs || pairs.length === 0) return null;
    let best: Surface | null = null;
    let bestDist = Infinity;
    for (const [floor, ceiling] of pairs) {
      const dist = Math.abs(alt - floor);
      if (dist < bestDist) {
        bestDist = dist;
        best = { floor, ceiling };
      }
    }
    if (best === null || bestDist > tolerance) return null;
    return best;
  }

  /**
   * Cell centers (as lat/lng) within `radiusM` metres of a point, each with
   * its surface pairs. Flat local-metre approximation, same as `cellOf` --
   * fine at this scale (a few hundred metres at most).
   *
   * Used for crowd placement: pick a walkable spawn point, or a nearby
   * wander target, without guessing lat/lng blind and hoping it lands on
   * a floor.
   */
  cellsWithin(
    lat: number,
    lng: number,
    radiusM: number,
  ): { lat: number; lng: number; surfaces: SurfacePair[] }[] {
    const [cx, cy] = this.cellOf(lat, lng);
    const reach = Math.ceil(radiusM / this.d.cell) + 1;
    const out: { lat: number; lng: number; surfaces: SurfacePair[] }[] = [];
    for (let dx = -reach; dx <= reach; dx++) {
      for (let dy = -reach; dy <= reach; dy++) {
        const distM = Math.hypot(dx * this.d.cell, dy * this.d.cell);
        if (distM > radiusM) continue;
        const surfaces = this.d.grid[`${cx + dx},${cy + dy}`];
        if (!surfaces) continue;
        out.push({
          lat: this.d.lat0 + ((cy + dy + 0.5) * this.d.cell) / this.d.mPerDegLat,
          lng: this.d.lng0 + ((cx + dx + 0.5) * this.d.cell) / this.d.mPerDegLng,
          surfaces,
        });
      }
    }
    return out;
  }

  /**
   * Every walkable cell as lat/lng plus its surfaces. Used to scatter the crowd
   * across the whole network rather than in a bubble around the player, so the
   * concourse stays populated wherever the player walks.
   */
  allCells(): { lat: number; lng: number; surfaces: SurfacePair[] }[] {
    const out: { lat: number; lng: number; surfaces: SurfacePair[] }[] = [];
    for (const key in this.d.grid) {
      const comma = key.indexOf(",");
      const cx = Number(key.slice(0, comma));
      const cy = Number(key.slice(comma + 1));
      out.push({
        lat: this.d.lat0 + ((cy + 0.5) * this.d.cell) / this.d.mPerDegLat,
        lng: this.d.lng0 + ((cx + 0.5) * this.d.cell) / this.d.mPerDegLng,
        surfaces: this.d.grid[key],
      });
    }
    return out;
  }

  /**
   * Centre and extent of the walkable network, in metres. Used to frame the
   * closing aerial shot: the camera has to know how big the thing it is looking
   * at actually is, and measuring beats guessing.
   *
   * Measured on the shipped grid: 474 m north-south, 502 m east-west,
   * 690 m diagonal, centred at 35.6928566 / 139.7008250.
   */
  bounds(): {
    lat: number;
    lng: number;
    northSouthM: number;
    eastWestM: number;
    diagonalM: number;
    mPerDegLng: number;
  } {
    let minLat = Infinity;
    let maxLat = -Infinity;
    let minLng = Infinity;
    let maxLng = -Infinity;
    for (const key in this.d.grid) {
      const comma = key.indexOf(",");
      const cx = Number(key.slice(0, comma));
      const cy = Number(key.slice(comma + 1));
      const lat = this.d.lat0 + ((cy + 0.5) * this.d.cell) / this.d.mPerDegLat;
      const lng = this.d.lng0 + ((cx + 0.5) * this.d.cell) / this.d.mPerDegLng;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
    }
    const northSouthM = (maxLat - minLat) * this.d.mPerDegLat;
    const eastWestM = (maxLng - minLng) * this.d.mPerDegLng;
    return {
      lat: (minLat + maxLat) / 2,
      lng: (minLng + maxLng) / 2,
      northSouthM,
      eastWestM,
      diagonalM: Math.hypot(northSouthM, eastWestM),
      mPerDegLng: this.d.mPerDegLng,
    };
  }

  /**
   * Shortest walkable route between two points, as a list of cell centres.
   * Breadth-first over (cell, floor) states with the same stair tolerance the
   * player's own movement uses, so the result is a route a player could really
   * take -- not a straight line through walls.
   *
   * Used by the debug panel to preview the trail ribbon without walking the
   * full 378 m first.
   */
  pathBetween(
    from: { lat: number; lng: number; alt: number },
    to: { lat: number; lng: number; alt: number },
    stairTolerance = 3,
  ): { lat: number; lng: number; alt: number }[] {
    const [sx, sy] = this.cellOf(from.lat, from.lng);
    const [gx, gy] = this.cellOf(to.lat, to.lng);
    const startPairs = this.d.grid[`${sx},${sy}`];
    if (!startPairs) return [];
    const startFloor = startPairs.reduce(
      (best, [f]) =>
        Math.abs(f - from.alt) < Math.abs(best - from.alt) ? f : best,
      startPairs[0][0],
    );

    const key = (x: number, y: number, f: number): string =>
      `${x},${y},${f.toFixed(2)}`;
    const prev = new Map<string, string | null>();
    const queue: [number, number, number][] = [[sx, sy, startFloor]];
    prev.set(key(sx, sy, startFloor), null);
    let found: [number, number, number] | null = null;

    while (queue.length > 0) {
      const [cx, cy, floor] = queue.shift() as [number, number, number];
      if (cx === gx && cy === gy) {
        found = [cx, cy, floor];
        break;
      }
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const nx = cx + dx;
        const ny = cy + dy;
        const pairs = this.d.grid[`${nx},${ny}`];
        if (!pairs) continue;
        for (const [f] of pairs) {
          if (Math.abs(f - floor) > stairTolerance) continue;
          const k = key(nx, ny, f);
          if (prev.has(k)) continue;
          prev.set(k, key(cx, cy, floor));
          queue.push([nx, ny, f]);
        }
      }
    }
    if (!found) return [];

    const out: { lat: number; lng: number; alt: number }[] = [];
    let cursor: string | null = key(found[0], found[1], found[2]);
    while (cursor) {
      const [xs, ys, fs] = cursor.split(",");
      const cx = Number(xs);
      const cy = Number(ys);
      out.push({
        lat: this.d.lat0 + ((cy + 0.5) * this.d.cell) / this.d.mPerDegLat,
        lng: this.d.lng0 + ((cx + 0.5) * this.d.cell) / this.d.mPerDegLng,
        alt: Number(fs),
      });
      cursor = prev.get(cursor) ?? null;
    }
    return out.reverse();
  }

  /** Elevation range covered by the grid, for altitude clamping. */
  floorRange(): { min: number; max: number } {
    let min = Infinity;
    let max = -Infinity;
    for (const pairs of Object.values(this.d.grid)) {
      for (const [floor] of pairs) {
        if (floor < min) min = floor;
        if (floor > max) max = floor;
      }
    }
    return { min, max };
  }
}

/**
 * Keeps a walker on the floor and inside the data.
 *
 * Driven by polling rather than PersonViewPlugin's `onStateChange`, because the
 * correction is applied with `teleport()`, which itself changes the state --
 * doing that from inside the state listener would re-enter it.
 */
export class WalkerConstraint {
  private last: { lat: number; lng: number; alt: number } | null = null;
  /** Set false to fly freely (debug). */
  enabled = true;
  /** Diagnostics for the HUD. */
  lastStatus: "floor" | "blocked" | "free" | "off-grid" = "free";
  lastSurface: Surface | null = null;

  constructor(
    private readonly grid: WalkGrid,
    /** Ignore corrections smaller than this, to avoid teleport jitter. */
    private readonly deadzone = 0.1,
  ) {}

  /** Seed the fallback position with a known-good spot. */
  reset(lat: number, lng: number, alt: number): void {
    this.last = { lat, lng, alt };
  }

  /**
   * Returns the position to teleport to, or null to leave the walker alone.
   */
  correct(lat: number, lng: number, alt: number): {
    lat: number;
    lng: number;
    alt: number;
  } | null {
    if (!this.enabled) {
      this.lastStatus = "free";
      this.lastSurface = this.grid.surfaceFor(lat, lng, alt, 6);
      this.last = { lat, lng, alt };
      return null;
    }

    const surface = this.grid.surfaceFor(lat, lng, alt);
    if (surface) {
      this.lastStatus = "floor";
      this.lastSurface = surface;
      this.last = { lat, lng, alt: surface.floor };
      if (Math.abs(alt - surface.floor) <= this.deadzone) return null;
      return { lat, lng, alt: surface.floor };
    }

    // Nowhere to stand: a wall, or outside the surveyed area.
    this.lastSurface = null;
    this.lastStatus = this.grid.surfacesAt(lat, lng) ? "blocked" : "off-grid";
    if (this.last === null) return null;
    return { ...this.last };
  }
}
