// The goal: the parent, waiting at the top of the stairs.
//
// Location is measured, not guessed. A breadth-first search from START over
// the shipped walk grid (same 3 m stair tolerance the player's own movement
// uses) produced 7,656 reachable (cell, floor) states. Of those, this is the
// highest floor band that is also *open* -- 14 of its 25 surrounding cells are
// walkable, so the parent can be seen from a distance rather than around a
// corner -- and it sits 382 m of walking from START, so the journey is real.
//
//   floor 38.50 m, ceiling 41.13 m (2.63 m of headroom)
//   openness 14/25, 191 grid steps from START
//
// The data's highest reachable floor is 39.21 m, but that cell is tighter
// (openness 12/25, 1.91 m headroom), so this one reads better as a place to
// stand and be found.
//
// Guidance is the light, per the design decision: the shaft is visible only
// once there is line of sight, so the player still feels lost in the
// corridors, and turning a corner to see the glow is the moment of hope.
// The calling voice (src/audio.ts) is the continuous directional backup.

import {
  Group,
  Mesh,
  CylinderGeometry,
  CircleGeometry,
  MeshBasicMaterial,
  AdditiveBlending,
  DoubleSide,
  Quaternion,
  Vector3,
  type Matrix4,
} from "three";
import {
  MeshDesc,
  type ViewContext,
  type MeshConfig,
  type MeshUpdate,
  geodeticToVector3,
  northUpEastToFixedFrame,
} from "@navaramap/three";
import type ThreeView from "@navaramap/three";
import { buildBlockPerson, type BlockPerson } from "./crowd";

const DEG2RAD = Math.PI / 180;

/** Measured -- see the note at the top of this file. */
export const GOAL = {
  lat: 35.6910744,
  lng: 139.7011900,
  /** Floor elevation (orthometric, same datum as the walk grid). */
  alt: 38.5,
  ceiling: 41.13,
};

/**
 * Where the debug "walk up to the parent" button drops you. This has to be a
 * cell that actually has a floor at the parent's own elevation: the cell
 * directly south of the goal only carries the 33.5 m floor, so teleporting
 * there sent the player five metres down onto a different level, out of sight
 * of the parent and unable to trigger anything. Measured from the grid:
 *
 *   floor 38.50 m, ceiling 41.13 m, 6.3 m from the parent
 *
 * Deliberately outside the 3.5 m reunion radius, so the moment still happens
 * by walking into it rather than by arriving on top of it.
 */
export const GOAL_APPROACH = {
  lat: 35.6910202,
  lng: 139.7012122,
  alt: 38.5,
};

/** Warm, unlike the grey crowd, so the parent reads as "not one of them". */
const PARENT_COLOR = 0xd9c9a8;
/** Slightly taller than the tallest crowd member. */
const PARENT_SCALE = 1.15;

const LIGHT_COLOR = 0xffe9c4;

// ---------------------------------------------------------------------------
// Shared placement helper
// ---------------------------------------------------------------------------

function ecefAt(lat: number, lng: number, height: number): Vector3 {
  return geodeticToVector3({
    lat: lat * DEG2RAD,
    lng: lng * DEG2RAD,
    height,
  } as never) as unknown as Vector3;
}

/**
 * North-Up-East frame at the goal, as a quaternion. Our meshes are built Y-up
 * like any Three.js object, so this is what stands them upright on the globe.
 */
function frameQuatAt(lat: number, lng: number, height: number): Quaternion {
  const origin = ecefAt(lat, lng, height);
  const m = northUpEastToFixedFrame(origin) as unknown as Matrix4;
  return new Quaternion().setFromRotationMatrix(m);
}

// ---------------------------------------------------------------------------
// The parent
// ---------------------------------------------------------------------------

type ParentDescription = {
  goalParent?: { frameQuat: Quaternion };
};

export type ParentConfig = MeshConfig & ParentDescription;
export type ParentUpdate = MeshUpdate & ParentDescription;

export class ParentMeshDesc extends MeshDesc<ParentConfig, ParentUpdate, Group> {
  private cfg: ParentConfig;
  private person!: BlockPerson;

  constructor(view: ThreeView, ctx: ViewContext, config: ParentConfig) {
    super(view, ctx, config);
    this.cfg = config;
  }

  createMesh(): Group {
    this.person = buildBlockPerson(PARENT_COLOR, PARENT_SCALE);
    const root = new Group();
    root.add(this.person.group);
    root.position.copy(ecefAt(GOAL.lat, GOAL.lng, GOAL.alt));
    return root;
  }

  update(time: number): void {
    const desc = this.cfg.goalParent;
    if (!desc || !this.raw) return;

    // The parent is searching too: a slow look around, ±50° over ~7 s. Cheap,
    // but it stops the figure reading as a statue.
    const sway = Math.sin((time / 1000) * ((2 * Math.PI) / 7)) * (50 * DEG2RAD);
    const qLook = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), sway);
    this.raw.quaternion.copy(desc.frameQuat.clone().multiply(qLook));
  }
}

// ---------------------------------------------------------------------------
// The light shaft
// ---------------------------------------------------------------------------

type BeaconDescription = {
  goalBeacon?: { frameQuat: Quaternion };
};

export type BeaconConfig = MeshConfig & BeaconDescription;
export type BeaconUpdate = MeshUpdate & BeaconDescription;

/**
 * Light spilling down from the stairwell above the parent. There is no point
 * light in the default descriptor set (only ambient / sun / probes), so this
 * is additive emissive geometry rather than real lighting -- for a visible
 * beacon that is actually the more reliable choice, since it cannot be washed
 * out by tone mapping the way a weak point light would be.
 */
export class BeaconMeshDesc extends MeshDesc<BeaconConfig, BeaconUpdate, Group> {
  private cfg: BeaconConfig;
  private core!: Mesh;
  private halo!: Mesh;
  private pool!: Mesh;

  constructor(view: ThreeView, ctx: ViewContext, config: BeaconConfig) {
    super(view, ctx, config);
    this.cfg = config;
  }

  createMesh(): Group {
    const root = new Group();
    const shaftHeight = GOAL.ceiling - GOAL.alt + 6; // continues up past the ceiling

    const mkMat = (opacity: number): MeshBasicMaterial =>
      new MeshBasicMaterial({
        color: LIGHT_COLOR,
        transparent: true,
        opacity,
        blending: AdditiveBlending,
        depthWrite: false,
        side: DoubleSide,
        toneMapped: false, // keep the glow from being crushed by exposure
      });

    // Bright inner core, soft outer halo.
    this.core = new Mesh(
      new CylinderGeometry(0.55, 1.1, shaftHeight, 16, 1, true),
      mkMat(0.3),
    );
    this.core.position.y = shaftHeight / 2;
    root.add(this.core);

    this.halo = new Mesh(
      new CylinderGeometry(1.5, 2.6, shaftHeight, 16, 1, true),
      mkMat(0.12),
    );
    this.halo.position.y = shaftHeight / 2;
    root.add(this.halo);

    // Pool of light on the floor, lifted 2 cm to avoid z-fighting.
    this.pool = new Mesh(new CircleGeometry(2.8, 32), mkMat(0.22));
    this.pool.rotation.x = -Math.PI / 2;
    this.pool.position.y = 0.02;
    root.add(this.pool);

    // The SDK disables frustum culling on its own georeferenced models because
    // of the RTE coordinate system; do the same here so a beacon that is meant
    // to be seen from far away is never culled by a stale bounding sphere.
    root.traverse((o) => {
      o.frustumCulled = false;
    });

    root.position.copy(ecefAt(GOAL.lat, GOAL.lng, GOAL.alt));
    return root;
  }

  update(time: number): void {
    const desc = this.cfg.goalBeacon;
    if (!desc || !this.raw) return;

    this.raw.quaternion.copy(desc.frameQuat);

    // Slow breathing so it reads as light rather than a solid object.
    const pulse = 0.85 + 0.15 * Math.sin((time / 1000) * ((2 * Math.PI) / 4));
    (this.core.material as MeshBasicMaterial).opacity = 0.3 * pulse;
    (this.halo.material as MeshBasicMaterial).opacity = 0.12 * pulse;
    (this.pool.material as MeshBasicMaterial).opacity = 0.22 * pulse;
  }
}

// ---------------------------------------------------------------------------
// Proximity + reunion
// ---------------------------------------------------------------------------

export type GoalPhase = "searching" | "reunited";

export type GoalCallbacks = {
  /** Fired once, when the player reaches the parent. */
  onReunion?: () => void;
  /**
   * Ambient intensity and tone-mapping exposure, driven every frame during
   * the relief ramp so the caller can apply them to the view.
   */
  onLightLevel?: (ambientIntensity: number, exposure: number) => void;
};

const REACH_M = 3.5;
const RELIEF_MS = 1800;

export class GoalController {
  private registered = false;
  private parentHandle: ReturnType<ThreeView["addMesh"]> | null = null;
  private beaconHandle: ReturnType<ThreeView["addMesh"]> | null = null;

  private phase: GoalPhase = "searching";
  private reunionStartMs: number | null = null;
  private lastDistanceM = Infinity;

  constructor(
    private view: ThreeView,
    private baseAmbient: number,
    private baseExposure: number,
    private callbacks: GoalCallbacks = {},
  ) {}

  /** Places the parent and the light shaft. Safe to call once. */
  spawn(): void {
    if (!this.registered) {
      this.view.registerMesh("goalParent", ParentMeshDesc);
      this.view.registerMesh("goalBeacon", BeaconMeshDesc);
      this.registered = true;
    }

    const frameQuat = frameQuatAt(GOAL.lat, GOAL.lng, GOAL.alt);

    const parentConfig: ParentConfig = { goalParent: { frameQuat } };
    const beaconConfig: BeaconConfig = { goalBeacon: { frameQuat } };

    // Same type-level gap as the crowd: `view` is generic over the default
    // descriptions and does not know our custom mesh keys. registerMesh above
    // is what wires them up at runtime; the config objects themselves are
    // still fully checked against their own types.
    type AddArg = Parameters<ThreeView["addMesh"]>[0];
    this.parentHandle = this.view.addMesh<ParentMeshDesc>(
      parentConfig as unknown as AddArg,
    );
    this.beaconHandle = this.view.addMesh<BeaconMeshDesc>(
      beaconConfig as unknown as AddArg,
    );

    console.info(
      `[goal] parent placed at (${GOAL.lat}, ${GOAL.lng}) floor ${GOAL.alt} m`,
    );
  }

  get currentPhase(): GoalPhase {
    return this.phase;
  }

  get distanceM(): number {
    return this.lastDistanceM;
  }

  /** Metres from the player to the parent, flat-earth (fine at this scale). */
  distanceFrom(lat: number, lng: number): number {
    const dLat = (GOAL.lat - lat) * 110540;
    const dLng = (GOAL.lng - lng) * 110540 * Math.cos(lat * DEG2RAD);
    return Math.hypot(dLat, dLng);
  }

  /** Compass bearing from the player to the parent, radians, 0 = north. */
  bearingFrom(lat: number, lng: number): number {
    const dLat = (GOAL.lat - lat) * 110540;
    const dLng = (GOAL.lng - lng) * 110540 * Math.cos(lat * DEG2RAD);
    return Math.atan2(dLng, dLat);
  }

  /** Call once per frame from the main loop. */
  update(playerLat: number, playerLng: number, nowMs: number): void {
    this.lastDistanceM = this.distanceFrom(playerLat, playerLng);

    if (this.phase === "searching" && this.lastDistanceM <= REACH_M) {
      this.phase = "reunited";
      this.reunionStartMs = nowMs;
      console.info("[goal] reunion triggered");
      this.callbacks.onReunion?.();
    }

    if (this.phase === "reunited" && this.reunionStartMs !== null) {
      const t = Math.min(1, (nowMs - this.reunionStartMs) / RELIEF_MS);
      // Ease out, then settle a little above the baseline so the scene stays
      // brighter than the corridors were -- the relief should persist.
      const eased = 1 - Math.pow(1 - t, 3);
      const peakAmbient = this.baseAmbient * 3.0;
      const peakExposure = this.baseExposure * 1.45;
      const settleAmbient = this.baseAmbient * 2.0;
      const settleExposure = this.baseExposure * 1.2;

      // Rise for the first 60% of the ramp, then relax to the settle value.
      let ambient: number;
      let exposure: number;
      if (eased < 0.6) {
        const k = eased / 0.6;
        ambient = this.baseAmbient + (peakAmbient - this.baseAmbient) * k;
        exposure = this.baseExposure + (peakExposure - this.baseExposure) * k;
      } else {
        const k = (eased - 0.6) / 0.4;
        ambient = peakAmbient + (settleAmbient - peakAmbient) * k;
        exposure = peakExposure + (settleExposure - peakExposure) * k;
      }
      this.callbacks.onLightLevel?.(ambient, exposure);
    }
  }

  /** Back to searching, for testing the moment more than once. */
  reset(): void {
    this.phase = "searching";
    this.reunionStartMs = null;
    this.callbacks.onLightLevel?.(this.baseAmbient, this.baseExposure);
  }

  remove(): void {
    this.parentHandle?.delete();
    this.beaconHandle?.delete();
    this.parentHandle = null;
    this.beaconHandle = null;
  }
}
