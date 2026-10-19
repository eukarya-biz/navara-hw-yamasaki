// Procedural crowd -- no downloaded character models.
//
// Every "person" is a handful of Three.js boxes (torso/head/arms/legs) built
// in code, animated with a sine-wave walk cycle, and wandered around the
// existing walk grid at random. Zero external assets, zero licensing
// questions, and it reuses ubld_walkgrid.json so people never spawn inside
// a wall or a pillar.
//
// Positioning follows the same pattern MeshConfig documents for georeferenced
// custom meshes: geodeticToVector3() for the ECEF position, and the NUE
// (North-Up-East) tangent frame for orientation, since our model is built
// Y-up like every other Three.js object. Heading is then a plain rotation
// around local Y inside that frame.
//
// NOT YET VISUALLY VERIFIED (no browser here) -- see the notes at the bottom
// of this file for the two things most likely to need a sign flip on first
// run: the heading-to-rotation formula, and degrees vs radians into
// geodeticToVector3.

import { Group, Mesh, BoxGeometry, MeshStandardMaterial, Quaternion, Vector3 } from "three";
import {
  MeshDesc,
  type ViewContext,
  type MeshConfig,
  type MeshUpdate,
  geodeticToVector3,
  northUpEastToFixedFrame,
} from "@navaramap/three";
import type ThreeView from "@navaramap/three";
import { metresPerDegree } from "./geo";
import type { WalkGrid, SurfacePair } from "./walkgrid";


// ---------------------------------------------------------------------------
// Procedural low-poly person
// ---------------------------------------------------------------------------

export type BlockPerson = {
  group: Group;
  leftHip: Group;
  rightHip: Group;
  leftShoulder: Group;
  rightShoulder: Group;
};

/**
 * A handful of boxes standing in for Kenney/Kay Lousberg's rigged characters.
 * Adult-scale (~1.6-1.75 m) on purpose: the whole point of the project is a
 * child looking *up* at these from 1.1 m.
 */
export function buildBlockPerson(color: number, heightScale: number): BlockPerson {
  const mat = new MeshStandardMaterial({ color, roughness: 0.9 });
  const group = new Group();
  const s = heightScale;

  const hipY = 0.75 * s;
  const shoulderY = 1.35 * s;

  // Torso spans exactly hip..shoulder, so the head and arms below can be
  // attached to those lines with no gap. (An earlier version sized the torso
  // independently and left the head floating ~13 cm above it.)
  const torsoHeight = shoulderY - hipY;
  const torsoHalfWidth = 0.16 * s;
  const torso = new Mesh(
    new BoxGeometry(torsoHalfWidth * 2, torsoHeight, 0.18 * s),
    mat,
  );
  torso.position.y = (hipY + shoulderY) / 2;
  group.add(torso);

  // Head sits directly on the shoulder line.
  const headSize = 0.22 * s;
  const head = new Mesh(new BoxGeometry(0.2 * s, headSize, 0.2 * s), mat);
  head.position.y = shoulderY + headSize / 2;
  group.add(head);

  function limb(
    pivotY: number,
    sideX: number,
    length: number,
    thickness: number,
  ): Group {
    const pivot = new Group();
    pivot.position.set(sideX, pivotY, 0);
    const box = new Mesh(new BoxGeometry(thickness, length, thickness), mat);
    box.position.y = -length / 2;
    pivot.add(box);
    group.add(pivot);
    return pivot;
  }

  // Legs reach the floor (length == hipY), and sit under the torso.
  const legThickness = 0.13 * s;
  const leftHip = limb(hipY, -0.09 * s, hipY, legThickness);
  const rightHip = limb(hipY, 0.09 * s, hipY, legThickness);

  // Arms hug the torso sides: offset = torso half-width + half the arm's own
  // thickness, so the inner face touches the body instead of floating beside it.
  const armThickness = 0.09 * s;
  const armX = torsoHalfWidth + armThickness / 2;
  const leftShoulder = limb(shoulderY, -armX, 0.5 * s, armThickness);
  const rightShoulder = limb(shoulderY, armX, 0.5 * s, armThickness);

  return { group, leftHip, rightHip, leftShoulder, rightShoulder };
}

/** Muted clothing-ish tones -- cheap stand-in for the 75-skin variety pack. */
const CROWD_COLORS = [
  0x3a3f4b, 0x5a4632, 0x2f4a3d, 0x4a3b4f, 0x37424a, 0x5c3a3a, 0x454545,
  0x2e3a4a, 0x4f4536, 0x3d3d3d,
];

// ---------------------------------------------------------------------------
// Per-instance wander state
// ---------------------------------------------------------------------------

type WanderState = {
  lat: number;
  lng: number;
  alt: number;
  target: { lat: number; lng: number } | null;
  pauseUntilMs: number;
  walkPhase: number;
  speed: number; // m/s
  headingRad: number; // compass bearing, 0 = north, increases toward east
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
// Mesh descriptor
// ---------------------------------------------------------------------------

type CrowdPersonDescription = {
  crowdPerson?: {
    grid: WalkGrid;
    home: { lat: number; lng: number };
    wanderRadiusM: number;
    speed: number;
    color: number;
    heightScale: number;
    /** Shared North-Up-East frame quaternion, computed once (see spawnCrowd). */
    frameQuat: Quaternion;
    /** Distance-based LOD thresholds, metres from the player. */
    lod: { animate: number; visible: number };
    /** Live player position, read each frame for LOD -- see spawnCrowd. */
    getPlayerLatLng: () => { lat: number; lng: number };
  };
};

export type CrowdPersonConfig = MeshConfig & CrowdPersonDescription;
export type CrowdPersonUpdate = MeshUpdate & CrowdPersonDescription;

const STRIDE_HZ = 1.8; // leg swings per second at speed 1.4 m/s, scaled by speed below
const SWING_AMPLITUDE = 0.5; // radians
const ARM_AMPLITUDE = 0.35;
const PAUSE_MIN_MS = 400;
const PAUSE_MAX_MS = 2200;

export class CrowdPersonMeshDesc extends MeshDesc<
  CrowdPersonConfig,
  CrowdPersonUpdate,
  Group
> {
  private config: CrowdPersonConfig;
  private person!: BlockPerson;
  private state!: WanderState;
  private lastTimeMs: number | null = null;
  private visibleNow = true;
  private static nextDebugId = 0;
  private debugId = CrowdPersonMeshDesc.nextDebugId++;
  /** Only the first instance logs, and only for its first few frames. */
  private static debugFramesLeft = 5;

  constructor(view: ThreeView, ctx: ViewContext, config: CrowdPersonConfig) {
    super(view, ctx, config);
    this.config = config;
  }

  createMesh(): Group {
    const cfg = this.config.crowdPerson!;
    this.person = buildBlockPerson(cfg.color, cfg.heightScale);

    const firstCell = cfg.grid.cellsWithin(cfg.home.lat, cfg.home.lng, 1);
    const startAlt = firstCell[0]
      ? pickSurface(firstCell[0].surfaces, 0)
      : 0;

    if (this.debugId === 0) {
      console.info(
        `[crowd#0] createMesh: home=(${cfg.home.lat.toFixed(6)},${cfg.home.lng.toFixed(6)}) ` +
          `cellsFound=${firstCell.length} startAlt=${startAlt}`,
      );
    }

    this.state = {
      lat: cfg.home.lat,
      lng: cfg.home.lng,
      alt: startAlt,
      target: null,
      pauseUntilMs: 0,
      walkPhase: Math.random() * Math.PI * 2, // desync legs across instances
      speed: cfg.speed * (0.85 + Math.random() * 0.3),
      headingRad: Math.random() * Math.PI * 2,
    };

    // matrixAutoUpdate stays on: we drive position/quaternion directly every
    // frame in update(), which is exactly what Object3D expects.
    return this.person.group;
  }

  update(time: number): void {
    const cfg = this.config.crowdPerson;
    if (!cfg || !this.raw) return;

    const dtMs = this.lastTimeMs === null ? 0 : time - this.lastTimeMs;
    this.lastTimeMs = time;
    const dt = Math.min(dtMs, 100) / 1000; // clamp huge dt after a tab switch

    // ---- LOD: skip work entirely for far-away instances ----
    const player = cfg.getPlayerLatLng();
    const mp = metresPerDegree(player.lat);
    const dLat = (this.state.lat - player.lat) * mp.lat;
    const dLng = (this.state.lng - player.lng) * mp.lng;
    const distM = Math.hypot(dLat, dLng);

    const shouldBeVisible = distM < cfg.lod.visible;
    if (shouldBeVisible !== this.visibleNow) {
      this.visibleNow = shouldBeVisible;
      this.raw.visible = shouldBeVisible;
    }
    if (this.debugId === 0 && CrowdPersonMeshDesc.debugFramesLeft > 0) {
      console.info(
        `[crowd#0] update: player=(${player.lat.toFixed(6)},${player.lng.toFixed(6)}) ` +
          `me=(${this.state.lat.toFixed(6)},${this.state.lng.toFixed(6)}) distM=${distM.toFixed(1)} ` +
          `visible=${shouldBeVisible}`,
      );
    }
    if (!shouldBeVisible) return;
    const animate = distM < cfg.lod.animate;

    // ---- wander state machine ----
    if (dt > 0) {
      if (this.state.target === null) {
        if (time >= this.state.pauseUntilMs) {
          const candidates = cfg.grid.cellsWithin(
            this.state.lat,
            this.state.lng,
            cfg.wanderRadiusM,
          );
          const pick =
            candidates[Math.floor(Math.random() * candidates.length)];
          if (pick) {
            this.state.target = { lat: pick.lat, lng: pick.lng };
          } else {
            this.state.pauseUntilMs = time + 1000;
          }
        }
      } else {
        const mt = metresPerDegree(this.state.lat);
        const tLatM = (this.state.target.lat - this.state.lat) * mt.lat;
        const tLngM = (this.state.target.lng - this.state.lng) * mt.lng;
        const distToTarget = Math.hypot(tLatM, tLngM);
        const step = this.state.speed * dt;

        if (distToTarget <= step || distToTarget < 0.15) {
          this.state.lat = this.state.target.lat;
          this.state.lng = this.state.target.lng;
          this.state.target = null;
          this.state.pauseUntilMs =
            time + PAUSE_MIN_MS + Math.random() * (PAUSE_MAX_MS - PAUSE_MIN_MS);
        } else {
          // Compass bearing: 0 = north (+lat), 90 = east (+lng).
          this.state.headingRad = Math.atan2(tLngM, tLatM);
          const frac = step / distToTarget;
          this.state.lat += (this.state.target.lat - this.state.lat) * frac;
          this.state.lng += (this.state.target.lng - this.state.lng) * frac;

          if (animate) {
            this.state.walkPhase += dt * STRIDE_HZ * 2 * Math.PI * (this.state.speed / 1.4);
          }
        }
      }

      // Snap to the floor under the (possibly moved) position.
      const cell = cfg.grid.cellsWithin(this.state.lat, this.state.lng, 1)[0];
      if (cell) this.state.alt = pickSurface(cell.surfaces, this.state.alt);
    }

    // ---- limb animation ----
    const walking = this.state.target !== null && animate;
    const swing = walking ? Math.sin(this.state.walkPhase) : 0;
    const swingOpp = walking ? Math.sin(this.state.walkPhase + Math.PI) : 0;
    this.person.leftHip.rotation.x = swing * SWING_AMPLITUDE;
    this.person.rightHip.rotation.x = swingOpp * SWING_AMPLITUDE;
    this.person.leftShoulder.rotation.x = swingOpp * ARM_AMPLITUDE;
    this.person.rightShoulder.rotation.x = swing * ARM_AMPLITUDE;

    // ---- placement: ECEF position + NUE-frame heading ----
    try {
      const origin = geodeticToVector3({
        lat: this.state.lat,
        lng: this.state.lng,
        height: this.state.alt,
      });

      // Heading rotation inside the NUE frame (X=north, Y=up, Z=east): the
      // model's own local +Z is its "forward". See file header for the
      // derivation of the PI/2 offset.
      const qHeading = new Quaternion().setFromAxisAngle(
        new Vector3(0, 1, 0),
        Math.PI / 2 - this.state.headingRad,
      );
      const qFinal = cfg.frameQuat.clone().multiply(qHeading);

      this.raw.position.copy(origin);
      this.raw.quaternion.copy(qFinal);

      if (this.debugId === 0 && CrowdPersonMeshDesc.debugFramesLeft > 0) {
        CrowdPersonMeshDesc.debugFramesLeft--;
        console.info(
          `[crowd#0] placed at ECEF (${this.raw.position.x.toFixed(1)}, ` +
            `${this.raw.position.y.toFixed(1)}, ${this.raw.position.z.toFixed(1)})`,
        );
      }
    } catch (err) {
      if (this.debugId === 0) {
        console.error("[crowd#0] placement failed:", err);
      }
    }
  }

  onUpdateConfig(updates: CrowdPersonUpdate): void {
    super.onUpdateConfig(updates);
  }
}

// ---------------------------------------------------------------------------
// Spawning
// ---------------------------------------------------------------------------

export type CrowdOptions = {
  count: number;
  center: { lat: number; lng: number };
  /** How far from `center` people are allowed to spawn/wander, in metres. */
  areaRadiusM: number;
  /** How far a single wander leg goes, in metres. */
  stepRadiusM?: number;
  speed?: number;
  /** Distance (m) from the player within which characters still animate. */
  lodAnimateM?: number;
  /** Distance (m) from the player beyond which characters are hidden. */
  lodVisibleM?: number;
  getPlayerLatLng: () => { lat: number; lng: number };
};

let registered = false;

/** Call once before the first spawnCrowd(). */
export function registerCrowdMesh(view: ThreeView): void {
  if (registered) return;
  view.registerMesh("crowdPerson", CrowdPersonMeshDesc);
  registered = true;
}

/**
 * Spawns a wandering crowd. Every character is placed on a real walkable
 * cell to start (never inside a wall/pillar), and picks new random nearby
 * cells to wander toward for as long as the scene runs.
 */
export function spawnCrowd(
  view: ThreeView,
  grid: WalkGrid,
  options: CrowdOptions,
): ReturnType<ThreeView["addMesh"]>[] {
  registerCrowdMesh(view);

  const spawnPoints = grid.cellsWithin(
    options.center.lat,
    options.center.lng,
    options.areaRadiusM,
  );
  if (spawnPoints.length === 0) {
    console.warn("[crowd] no walkable cells found near the requested center");
    return [];
  }

  console.info(
    `[crowd] spawning near (${options.center.lat.toFixed(6)}, ${options.center.lng.toFixed(6)}), ` +
      `${spawnPoints.length} walkable cells within ${options.areaRadiusM}m`,
  );

  // Curvature over a ~1km area is negligible (~0.01 deg), so one shared
  // North-Up-East frame for every instance is visually indistinguishable
  // from computing it per-character, and far cheaper.
  const originForFrame = geodeticToVector3({
    lat: options.center.lat,
    lng: options.center.lng,
    height: 25,
  });
  console.info(
    `[crowd] shared frame origin (ECEF): (${originForFrame.x.toFixed(1)}, ` +
      `${originForFrame.y.toFixed(1)}, ${originForFrame.z.toFixed(1)})`,
  );
  const frameMatrix = northUpEastToFixedFrame(originForFrame);
  const frameQuat = new Quaternion().setFromRotationMatrix(frameMatrix);

  const handles: ReturnType<ThreeView["addMesh"]>[] = [];
  for (let i = 0; i < options.count; i++) {
    const home = spawnPoints[Math.floor(Math.random() * spawnPoints.length)];
    const config: CrowdPersonConfig = {
      crowdPerson: {
        grid,
        home: { lat: home.lat, lng: home.lng },
        wanderRadiusM: options.stepRadiusM ?? 8,
        speed: options.speed ?? 1.2,
        color: CROWD_COLORS[i % CROWD_COLORS.length],
        heightScale: 0.92 + Math.random() * 0.18,
        frameQuat,
        lod: {
          animate: options.lodAnimateM ?? 20,
          visible: options.lodVisibleM ?? 45,
        },
        getPlayerLatLng: options.getPlayerLatLng,
      },
    };
    // view's own generic Descriptions type (e.g. DefaultDescriptions in
    // main.ts) doesn't know about our custom "crowdPerson" mesh type, so
    // addMesh()'s signature won't structurally accept it -- this is a type-
    // level gap only; registerMesh() above is what actually wires it up at
    // runtime. `config` itself is still fully checked against
    // CrowdPersonConfig, so a typo in its fields would still be caught.
    const handle = view.addMesh<CrowdPersonMeshDesc>(
      config as unknown as Parameters<ThreeView["addMesh"]>[0],
    );
    handles.push(handle);
  }

  console.info(`[crowd] spawned ${options.count} people near the given center`);
  return handles;
}

// ---------------------------------------------------------------------------
// Known unknowns -- check these first if the crowd looks wrong on screen
// ---------------------------------------------------------------------------
//
// 1. geodeticToVector3 takes lat/lng in *degrees* (navara >= 0.1.0). It took
//    radians in 0.0.2, and converting to radians after the upgrade put every
//    custom mesh 11,000 km away -- measured, not hypothetical.
//
// 2. Heading: derived as "model's local +Z is forward, rotate by
//    PI/2 - heading inside the NUE frame". If people walk sideways relative
//    to their own leg swing, the fix is a sign flip on that formula, not a
//    rewrite -- the position/floor logic is independent of it.
//
// 3. northUpEastToFixedFrame's rotation is extracted from the Matrix4 with
//    setFromRotationMatrix(), which assumes no scale in that matrix. Should
//    hold (it is a pure frame transform), but if people appear stretched or
//    skewed, this is the place to look.
