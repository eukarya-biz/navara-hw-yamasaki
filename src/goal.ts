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
} from "three";
import {
  MeshDesc,
  type MeshConfig,
  type MeshUpdate,
  type MeshHandle,
} from "@navaramap/three";
import { buildBlockPerson, type BlockPerson } from "./block-person";
import type { SceneView } from "./descriptions";
import { metresPerDegree } from "./geo";

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

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

// Placement: both meshes are added with `geodetic` (lat/lng in degrees, height
// in metres), so the base class builds the upright West-Up-North frame and owns
// the root transform. Children animate inside that frame as usual.

// ---------------------------------------------------------------------------
// The parent
// ---------------------------------------------------------------------------

type ParentDescription = {
  goalParent?: Record<string, never>;
};

export type ParentConfig = MeshConfig & ParentDescription;
export type ParentUpdate = MeshUpdate & ParentDescription;

export class ParentMeshDesc extends MeshDesc<ParentConfig, ParentUpdate, Group> {
  private person!: BlockPerson;

  createMesh(): Group {
    this.person = buildBlockPerson(PARENT_COLOR, PARENT_SCALE);
    // The root is placed by `geodetic`; the figure turns inside it.
    const root = new Group();
    root.add(this.person.group);
    return root;
  }

  update(time: number): void {
    if (!this.raw) return;
    // The parent is searching too: a slow look around, ±50° over ~7 s. Cheap,
    // but it stops the figure reading as a statue.
    this.person.group.rotation.y =
      Math.sin((time / 1000) * ((2 * Math.PI) / 7)) * (50 * DEG2RAD);
  }
}

// ---------------------------------------------------------------------------
// The light shaft
// ---------------------------------------------------------------------------

type BeaconDescription = {
  goalBeacon?: Record<string, never>;
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
  private core!: Mesh<CylinderGeometry, MeshBasicMaterial>;
  private halo!: Mesh<CylinderGeometry, MeshBasicMaterial>;
  private pool!: Mesh<CircleGeometry, MeshBasicMaterial>;

  // Stays in the default (opaque) pass on purpose: the transparent pass does
  // not depth-test against the walls, and this light is meant to be seen only
  // once there is line of sight (measured: in the transparent pass it showed
  // through the walls from 265 m away).

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
    return root;
  }

  update(time: number): void {
    if (!this.raw) return;
    // Slow breathing so it reads as light rather than a solid object.
    const pulse = 0.85 + 0.15 * Math.sin((time / 1000) * ((2 * Math.PI) / 4));
    this.core.material.opacity = 0.3 * pulse;
    this.halo.material.opacity = 0.12 * pulse;
    this.pool.material.opacity = 0.22 * pulse;
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
  private parentHandle: MeshHandle<ParentMeshDesc> | null = null;
  private beaconHandle: MeshHandle<BeaconMeshDesc> | null = null;

  private phase: GoalPhase = "searching";
  private reunionStartMs: number | null = null;
  private lastDistanceM = Infinity;

  constructor(
    private view: SceneView,
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

    const at = { lat: GOAL.lat, lng: GOAL.lng, height: GOAL.alt };

    // `geodetic` stands both upright on the globe. The parent faces the way
    // the player arrives and looks around from there; the beacon is round.
    this.parentHandle = this.view.addMesh<ParentMeshDesc>({
      goalParent: {},
      geodetic: {
        ...at,
        heading: this.bearingFrom(GOAL_APPROACH.lat, GOAL_APPROACH.lng) + 180,
      },
    });
    this.beaconHandle = this.view.addMesh<BeaconMeshDesc>({
      goalBeacon: {},
      geodetic: at,
    });

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
    const m = metresPerDegree(lat);
    return Math.hypot((GOAL.lat - lat) * m.lat, (GOAL.lng - lng) * m.lng);
  }

  /**
   * Compass bearing from the player to the parent in degrees, 0 = north,
   * increasing clockwise -- the same convention as PersonViewPlugin's heading.
   */
  bearingFrom(lat: number, lng: number): number {
    const m = metresPerDegree(lat);
    return Math.atan2((GOAL.lng - lng) * m.lng, (GOAL.lat - lat) * m.lat) * RAD2DEG;
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
