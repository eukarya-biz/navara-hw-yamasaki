// Crowd, instanced -- the version that can actually fill a station concourse.
//
// The first crowd built one Group of six Meshes per person, so 25 people cost
// 150 draw calls and the underground still looked deserted. Draw calls, not
// triangles, were the ceiling.
//
// Here each *body part* is one InstancedMesh: every torso in the scene is one
// draw call, every head is another, and so on. Six draw calls total, whatever
// the population. 300 people cost the same six as 25. Limbs keep swinging,
// because each instance carries its own matrix rather than sharing a pose.
//
// The one non-obvious constraint drives the whole design: `instanceMatrix` is
// **float32**, and ECEF positions here are ~4,000,000 m. Measured (matrixtest.mjs):
//
//   ECEF x -3955318.2      -> float32 -3955318.25   (0.05 m error)
//   the same x + 2 cm      -> float32 -3955318.25   (identical!)
//
// The static error is survivable; the second line is not. 2 cm is one frame of
// walking at 1.2 m/s, and at this magnitude float32 cannot represent it at all,
// so the crowd would simply never move -- positions would quantise to a ~5 cm
// lattice and people would jump between cells instead of walking.
//
// So the InstancedMesh itself is placed at one anchor with `geodetic` (the base
// class fixes its world matrix from full-precision geodetic input) and every
// instance matrix is a *local* offset in metres from that anchor. A 137 m local
// offset round-trips through float32 with 5e-6 m error. This is also exactly
// what the API means by "local position relative to the parent group".
//
// Frame convention: `geodetic` builds a West-Up-North frame, so local
// (x, y, z) = (metres west, metres up, metres north). Model forward is +Z,
// which is north at heading 0; lateral is ±X, which is what makes a rotation
// about local X swing a limb forwards and backwards.

import {
  BoxGeometry,
  Color,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
  type BufferGeometry,
} from "three";
import {
  InstancedMeshDesc,
  type ViewContext,
  type InstancedMeshConfig,
  type InstancedChildConfig,
} from "@navaramap/three";
import type ThreeView from "@navaramap/three";
import type { SceneView } from "./descriptions";
import { metresPerDegree, type MetresPerDegree } from "./geo";
import type { WalkGrid, SurfacePair } from "./walkgrid";

// --- body proportions, nominal (heightScale 1.0) ---------------------------
// Same figures as the single-mesh version, which was checked against the child
// eye height: total 1.57 m at scale 1, and 0.92-1.10 scaling gives adults of
// 1.44-1.73 m towering over a 1.0 m viewpoint.
const HIP_Y = 0.75;
const SHOULDER_Y = 1.35;
const TORSO_HALF_W = 0.16;
const TORSO_DEPTH = 0.18;
const HEAD_SIZE = 0.22;
const LEG_THICK = 0.13;
const LEG_X = 0.09;
const ARM_THICK = 0.09;
const ARM_LEN = 0.5;
const ARM_X = TORSO_HALF_W + ARM_THICK / 2;

const CROWD_COLORS = [
  0x3a3f4b, 0x5a4632, 0x2f4a3d, 0x4a3b4f, 0x37424a, 0x5c3a3a, 0x454545,
  0x2e3a4a, 0x4f4536, 0x3d3d3d, 0x2b3340, 0x584a3c,
];

/** Which body part an instanced descriptor draws. */
export type CrowdPart = "torso" | "head" | "legL" | "legR" | "armL" | "armR";

const CROWD_PARTS: readonly CrowdPart[] = [
  "torso",
  "head",
  "legL",
  "legR",
  "armL",
  "armR",
];

/** One registered key; the part is in the config, so the six adds share it. */
const CROWD_PART_KEY = "crowdPart";

// ---------------------------------------------------------------------------
// Per-person simulation state (shared by all six descriptors)
// ---------------------------------------------------------------------------

export type Person = {
  lat: number;
  lng: number;
  alt: number;
  target: { lat: number; lng: number } | null;
  pauseUntilMs: number;
  walkPhase: number;
  speed: number;
  heading: number;
  scale: number;
  color: Color;
  /** Metres from the player, refreshed each frame. */
  distM: number;
  /** Cached local offset from the anchor, in metres (west, up, north). */
  localX: number;
  localY: number;
  localZ: number;
};

function pickSurface(pairs: SurfacePair[], nearAlt: number): number {
  let best = pairs[0][0];
  let bestDist = Infinity;
  for (const [floor] of pairs) {
    const d = Math.abs(floor - nearAlt);
    if (d < bestDist) {
      bestDist = d;
      best = floor;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// The shared simulation
// ---------------------------------------------------------------------------

export type CrowdSimOptions = {
  count: number;
  grid: WalkGrid;
  /** Anchor for the local frame. Any point in the area; the centre is fine. */
  anchor: { lat: number; lng: number; alt: number };
  /** How far a single wander leg goes, metres. */
  stepRadiusM: number;
  speed: number;
  /** Within this distance limbs animate; beyond it the pose freezes. */
  animateM: number;
  /** Beyond this distance instances are collapsed to nothing. */
  visibleM: number;
  /**
   * People live inside this radius of the player and are recycled when they
   * fall outside it.
   *
   * Scattering the population over the whole 28,508 m² network was what made
   * 240 people look deserted: that is 0.0084 people/m², one person per 119 m²,
   * and ~90% of them stood where the player could never see them. Keeping the
   * population local means every person contributes to the density that is
   * actually on screen. Should be a little larger than `visibleM` so recycling
   * happens out of sight.
   */
  localRadiusM: number;
  getPlayer: () => { lat: number; lng: number };
};

const PAUSE_MIN_MS = 400;
const PAUSE_MAX_MS = 2600;
const STRIDE_HZ = 1.8;
const SWING = 0.5;
const ARM_SWING = 0.35;

/**
 * Owns the crowd's state and hands matrices to the six part descriptors.
 * Deliberately separate from the descriptors: the simulation runs once per
 * frame, not six times.
 */
export class CrowdSim {
  readonly people: Person[] = [];
  /** Degree-to-metre scale at the anchor; the area is small enough for one. */
  private readonly mPerDeg: MetresPerDegree;
  private lastMs: number | null = null;

  constructor(private opts: CrowdSimOptions) {
    this.mPerDeg = metresPerDegree(opts.anchor.lat);
    this.populate();
  }

  private populate(): void {
    const { grid, count } = this.opts;
    const player = this.opts.getPlayer();
    const cells = grid.cellsWithin(
      player.lat,
      player.lng,
      this.opts.localRadiusM,
    );
    if (cells.length === 0) {
      console.warn("[crowd] no walkable cells near the player; no crowd spawned");
      return;
    }
    for (let i = 0; i < count; i++) {
      const cell = cells[Math.floor(Math.random() * cells.length)];
      const alt = pickSurface(cell.surfaces, cell.surfaces[0][0]);
      const p: Person = {
        lat: cell.lat,
        lng: cell.lng,
        alt,
        target: null,
        pauseUntilMs: 0,
        walkPhase: Math.random() * Math.PI * 2,
        speed: this.opts.speed * (0.85 + Math.random() * 0.3),
        heading: Math.random() * Math.PI * 2,
        scale: 0.92 + Math.random() * 0.18,
        color: new Color(CROWD_COLORS[i % CROWD_COLORS.length]),
        distM: Infinity,
        localX: 0,
        localY: 0,
        localZ: 0,
      };
      this.refreshLocal(p);
      this.people.push(p);
    }
    const areaM2 = cells.length * 4; // 2 m grid
    console.info(
      `[crowd] ${this.people.length} people within ${this.opts.localRadiusM} m ` +
        `(${cells.length} cells = ${areaM2} m², ` +
        `${(this.people.length / areaM2).toFixed(3)} people/m²)`,
    );
  }

  private refreshLocal(p: Person): void {
    const a = this.opts.anchor;
    p.localX = -(p.lng - a.lng) * this.mPerDeg.lng; // west
    p.localY = p.alt - a.alt; // up
    p.localZ = (p.lat - a.lat) * this.mPerDeg.lat; // north
  }

  /** Advance the simulation. Call once per frame, before the descriptors draw. */
  step(nowMs: number): void {
    const dt =
      this.lastMs === null ? 0 : Math.min(nowMs - this.lastMs, 100) / 1000;
    this.lastMs = nowMs;

    const player = this.opts.getPlayer();

    for (const p of this.people) {
      const dN = (p.lat - player.lat) * this.mPerDeg.lat;
      const dE = (p.lng - player.lng) * this.mPerDeg.lng;
      p.distM = Math.hypot(dN, dE);

      // Recycle anyone who has fallen outside the local radius. They are moved
      // to a fresh walkable cell near the player rather than deleted, so the
      // instance count -- and therefore the on-screen density -- stays constant
      // as the player walks. Recycling happens beyond `visibleM`, so nobody
      // pops into existence on screen.
      if (p.distM > this.opts.localRadiusM) {
        this.recycle(p, player);
        continue;
      }

      // Beyond the visible radius nothing else is simulated -- skipping this is
      // what keeps a large population cheap.
      if (p.distM > this.opts.visibleM || dt === 0) continue;

      if (p.target === null) {
        if (nowMs >= p.pauseUntilMs) {
          const near = this.opts.grid.cellsWithin(
            p.lat,
            p.lng,
            this.opts.stepRadiusM,
          );
          const pick = near[Math.floor(Math.random() * near.length)];
          if (pick) p.target = { lat: pick.lat, lng: pick.lng };
          else p.pauseUntilMs = nowMs + 1000;
        }
      } else {
        const tN = (p.target.lat - p.lat) * this.mPerDeg.lat;
        const tE = (p.target.lng - p.lng) * this.mPerDeg.lng;
        const dist = Math.hypot(tN, tE);
        const stepLen = p.speed * dt;

        if (dist <= stepLen || dist < 0.15) {
          p.lat = p.target.lat;
          p.lng = p.target.lng;
          p.target = null;
          p.pauseUntilMs =
            nowMs + PAUSE_MIN_MS + Math.random() * (PAUSE_MAX_MS - PAUSE_MIN_MS);
        } else {
          p.heading = Math.atan2(tE, tN);
          const frac = stepLen / dist;
          p.lat += (p.target.lat - p.lat) * frac;
          p.lng += (p.target.lng - p.lng) * frac;
          if (p.distM < this.opts.animateM) {
            p.walkPhase += dt * STRIDE_HZ * 2 * Math.PI * (p.speed / 1.4);
          }
        }

        const pairs = this.opts.grid.surfacesAt(p.lat, p.lng);
        if (pairs && pairs.length > 0) p.alt = pickSurface(pairs, p.alt);
      }

      this.refreshLocal(p);
    }
  }

  /**
   * Move a person to a random walkable cell near the player. Reuses the Person
   * object so nothing is allocated and the instance index stays valid.
   */
  private recycle(p: Person, player: { lat: number; lng: number }): void {
    const cells = this.opts.grid.cellsWithin(
      player.lat,
      player.lng,
      this.opts.localRadiusM,
    );
    if (cells.length === 0) return;
    // Refill out of sight: a cell beyond the visible radius when there is one,
    // so nobody pops into existence in front of the camera. (The comment used
    // to promise this while the code picked any cell; measured pop-ins.)
    const outOfSight = cells.filter((c) => {
      const dN = (c.lat - player.lat) * this.mPerDeg.lat;
      const dE = (c.lng - player.lng) * this.mPerDeg.lng;
      return Math.hypot(dN, dE) > this.opts.visibleM;
    });
    const pool = outOfSight.length > 0 ? outOfSight : cells;
    const cell = pool[Math.floor(Math.random() * pool.length)];
    p.lat = cell.lat;
    p.lng = cell.lng;
    p.alt = pickSurface(cell.surfaces, cell.surfaces[0][0]);
    p.target = null;
    p.pauseUntilMs = 0;
    p.heading = Math.random() * Math.PI * 2;
    this.refreshLocal(p);
  }

  /** Number of people currently inside the visible radius. */
  visibleCount(): number {
    let n = 0;
    for (const p of this.people) if (p.distM <= this.opts.visibleM) n++;
    return n;
  }

  /** Limb swing for a person, or 0 when too far to bother animating. */
  swingOf(p: Person): number {
    if (p.target === null || p.distM > this.opts.animateM) return 0;
    return Math.sin(p.walkPhase);
  }

  isVisible(p: Person): boolean {
    return p.distM <= this.opts.visibleM;
  }
}

// ---------------------------------------------------------------------------
// Part descriptors
// ---------------------------------------------------------------------------

type PartDescription = {
  sim: CrowdSim;
  part: CrowdPart;
};

export type CrowdPartConfig = InstancedMeshConfig & {
  crowdPart?: PartDescription;
};

/** Geometry for one body part, pre-translated so its own pivot sits at origin. */
function geometryFor(part: CrowdPart): BufferGeometry {
  switch (part) {
    case "torso": {
      const g = new BoxGeometry(TORSO_HALF_W * 2, SHOULDER_Y - HIP_Y, TORSO_DEPTH);
      g.translate(0, (HIP_Y + SHOULDER_Y) / 2, 0);
      return g;
    }
    case "head": {
      const g = new BoxGeometry(0.2, HEAD_SIZE, 0.2);
      g.translate(0, SHOULDER_Y + HEAD_SIZE / 2, 0);
      return g;
    }
    case "legL":
    case "legR": {
      // Pivot at the hip: hang the box downwards from the origin so a rotation
      // about X swings it from the hip rather than about its own centre.
      const g = new BoxGeometry(LEG_THICK, HIP_Y, LEG_THICK);
      g.translate(0, -HIP_Y / 2, 0);
      return g;
    }
    case "armL":
    case "armR": {
      const g = new BoxGeometry(ARM_THICK, ARM_LEN, ARM_THICK);
      g.translate(0, -ARM_LEN / 2, 0);
      return g;
    }
  }
}

/** Where a part's pivot sits in the body, and how its swing relates to gait. */
function pivotFor(part: CrowdPart): {
  x: number;
  y: number;
  swingSign: number;
} {
  switch (part) {
    case "torso":
    case "head":
      return { x: 0, y: 0, swingSign: 0 };
    case "legL":
      return { x: -LEG_X, y: HIP_Y, swingSign: 1 };
    case "legR":
      return { x: LEG_X, y: HIP_Y, swingSign: -1 };
    // Arms counter-swing against the leg on the same side.
    case "armL":
      return { x: -ARM_X, y: SHOULDER_Y, swingSign: -1 };
    case "armR":
      return { x: ARM_X, y: SHOULDER_Y, swingSign: 1 };
  }
}

const ZERO_SCALE = new Vector3(0, 0, 0);

/**
 * One body part, instanced across the whole crowd.
 *
 * Six of these are added under one registered key. They share a single
 * CrowdSim, and each rebuilds only its own instance matrices per frame.
 */
export class CrowdPartDesc extends InstancedMeshDesc<
  BufferGeometry,
  MeshStandardMaterial,
  CrowdPartConfig
> {
  private part: CrowdPart;
  private sim: CrowdSim;

  // Scratch objects, reused every frame: allocating per instance per frame
  // would churn thousands of objects a second.
  private mPerson = new Matrix4();
  private mPart = new Matrix4();
  private mSwing = new Matrix4();
  private mPivot = new Matrix4();
  private qHeading = new Quaternion();
  private vPos = new Vector3();
  private vScale = new Vector3();
  private axisY = new Vector3(0, 1, 0);

  constructor(view: ThreeView, ctx: ViewContext, config: CrowdPartConfig) {
    super(view, ctx, config);
    const desc = config.crowdPart;
    if (!desc) throw new Error(`"${CROWD_PART_KEY}" needs { sim, part }`);
    this.part = desc.part;
    this.sim = desc.sim;
  }

  protected createGeometry(): BufferGeometry {
    return geometryFor(this.part);
  }

  protected createMaterial(): MeshStandardMaterial {
    // MeshStandardMaterial is one of the ShaderLib materials Navara patches to
    // write the G-buffer, so SSAO applies to the crowd with no extra work.
    return new MeshStandardMaterial({ roughness: 0.9 });
  }

  protected getChildConfigs(): InstancedChildConfig[] {
    return this.sim.people.map(() => ({ matrix: new Matrix4() }));
  }

  protected getInstanceColor(_config: InstancedChildConfig): Color | undefined {
    // Colours are assigned positionally in update(); see setColorAt there.
    return undefined;
  }

  createMesh(): InstancedMesh<BufferGeometry, MeshStandardMaterial> {
    const mesh = super.createMesh();
    // Per-instance clothing colour. Written once -- it never changes.
    this.sim.people.forEach((p, i) => mesh.setColorAt(i, p.color));
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    // Navara turns culling off on its own georeferenced models because of the
    // RTE coordinate system; the same reasoning applies here, and the bounding
    // sphere of an instanced mesh whose instances move every frame would be
    // wrong anyway.
    mesh.frustumCulled = false;
    return mesh;
  }

  update(_time: number): void {
    const mesh = this.raw;
    if (!mesh) return;

    const { x: px, y: py, swingSign } = pivotFor(this.part);
    const isLimb = swingSign !== 0;
    const people = this.sim.people;

    for (let i = 0; i < people.length; i++) {
      const p = people[i];

      if (!this.sim.isVisible(p)) {
        // Collapsing to zero scale is how an instance "disappears": there is no
        // per-instance visibility flag, and rebuilding the instance list every
        // time somebody walks out of range would cost more than it saves.
        this.mPerson.compose(this.vPos.set(0, 0, 0), this.qHeading.identity(), ZERO_SCALE);
        mesh.setMatrixAt(i, this.mPerson);
        continue;
      }

      // Model forward is +Z, which is north in the West-Up-North frame; a
      // compass heading (clockwise from north) is a negative turn about Y.
      this.qHeading.setFromAxisAngle(this.axisY, -p.heading);
      this.vPos.set(p.localX, p.localY, p.localZ);
      this.vScale.setScalar(p.scale);
      this.mPerson.compose(this.vPos, this.qHeading, this.vScale);

      if (isLimb) {
        const swing = this.sim.swingOf(p) * swingSign;
        const amp = this.part === "legL" || this.part === "legR" ? SWING : ARM_SWING;
        this.mPivot.makeTranslation(px, py, 0);
        this.mSwing.makeRotationX(swing * amp);
        this.mPart.multiplyMatrices(this.mPivot, this.mSwing);
        this.mPerson.multiply(this.mPart);
      }

      mesh.setMatrixAt(i, this.mPerson);
    }

    mesh.instanceMatrix.needsUpdate = true;
  }
}

// ---------------------------------------------------------------------------
// Spawning
// ---------------------------------------------------------------------------

let registered = false;

export type InstancedCrowdHandles = {
  sim: CrowdSim;
  remove: () => void;
};

/**
 * Registers and adds all six part descriptors for one crowd.
 * Six draw calls, `options.count` people.
 */
export function spawnInstancedCrowd(
  view: SceneView,
  options: CrowdSimOptions,
): InstancedCrowdHandles {
  if (!registered) {
    view.registerMesh(CROWD_PART_KEY, CrowdPartDesc);
    registered = true;
  }

  const sim = new CrowdSim(options);
  const { anchor } = options;
  const handles = CROWD_PARTS.map((part) =>
    view.addMesh<CrowdPartDesc>({
      crowdPart: { sim, part },
      geodetic: { lat: anchor.lat, lng: anchor.lng, height: anchor.alt },
    }),
  );

  return {
    sim,
    remove: () => handles.forEach((h) => h.delete()),
  };
}
