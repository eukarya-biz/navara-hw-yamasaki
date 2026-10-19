// The walked path, and the two points that bracket it.
//
// The closing aerial shot shows the whole underground; this draws the player's
// actual route across it. That turns the reveal from "look how big this place
// is" into "look how big it is, and look how you moved through it" -- the
// wandering, the backtracking and the dead ends are all in the line.
//
// Both the ribbon and the beams live in a local North-Up-East frame anchored at
// one point, for the same reason the crowd does: `BufferGeometry` positions are
// **float32**, and ECEF coordinates here are ~4,000,000 m, where float32 has
// about 5 cm of resolution. A path built from raw ECEF would come out visibly
// kinked and jittering. Local metre offsets round-trip with ~1e-5 m error.
//
// Nothing here is visible while walking. A 120 m beam of light standing over the
// goal would both look wrong from inside a 3 m corridor and act as a giant
// arrow, which is exactly what the design decision about guidance ruled out.

import {
  BufferAttribute,
  BufferGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  AdditiveBlending,
  CircleGeometry,
  DoubleSide,
  Quaternion,
  Vector3,
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

const DEG2RAD = Math.PI / 180;
const M_PER_DEG_LAT = 110540;

export type TrailPoint = { lat: number; lng: number; alt: number };

/**
 * Samples the player's position by distance rather than by time, so a slow
 * shuffle and a fast run produce the same line density, and standing still adds
 * nothing at all.
 */
export class TrailRecorder {
  readonly points: TrailPoint[] = [];
  private recording = true;

  constructor(
    /** Minimum spacing between samples, metres. */
    private spacingM = 1.5,
    /** Hard cap, so an unusually long session cannot grow without bound. */
    private maxPoints = 6000,
  ) {}

  stop(): void {
    this.recording = false;
  }

  reset(): void {
    this.points.length = 0;
    this.recording = true;
  }

  record(lat: number, lng: number, alt: number): void {
    if (!this.recording || this.points.length >= this.maxPoints) return;
    const last = this.points[this.points.length - 1];
    if (last) {
      const dN = (lat - last.lat) * M_PER_DEG_LAT;
      const dE = (lng - last.lng) * M_PER_DEG_LAT * Math.cos(lat * DEG2RAD);
      const dU = alt - last.alt;
      const moved = Math.hypot(dN, dE, dU);
      if (moved < this.spacingM) return;
      // A jump this large is a teleport (debug buttons, level jumps), not a
      // walk. Recording it would draw a straight line across the whole map.
      if (moved > 25) {
        this.points.push({ lat, lng, alt });
        return;
      }
    }
    this.points.push({ lat, lng, alt });
  }
}

// ---------------------------------------------------------------------------
// Local frame shared by the ribbon and the markers
// ---------------------------------------------------------------------------

export type LocalFrame = {
  anchor: TrailPoint;
  ecef: Vector3;
  quat: Quaternion;
  mPerDegLng: number;
};

export function makeLocalFrame(anchor: TrailPoint): LocalFrame {
  // geodeticToVector3 takes degrees (navara >= 0.1.0).
  const ecef = geodeticToVector3({
    lat: anchor.lat,
    lng: anchor.lng,
    height: anchor.alt,
  });
  const m = northUpEastToFixedFrame(ecef);
  return {
    anchor,
    ecef,
    quat: new Quaternion().setFromRotationMatrix(m),
    mPerDegLng: M_PER_DEG_LAT * Math.cos(anchor.lat * DEG2RAD),
  };
}

/** Local offset in metres: (north, up, east) to match the NUE frame. */
function toLocal(frame: LocalFrame, p: TrailPoint): Vector3 {
  return new Vector3(
    (p.lat - frame.anchor.lat) * M_PER_DEG_LAT,
    p.alt - frame.anchor.alt,
    (p.lng - frame.anchor.lng) * frame.mPerDegLng,
  );
}

// ---------------------------------------------------------------------------
// The trail ribbon
// ---------------------------------------------------------------------------

type TrailDescription = {
  trail?: {
    frame: LocalFrame;
    points: TrailPoint[];
    /** Ribbon width in metres. Read from ~700 m up, so metres not centimetres. */
    widthM: number;
    /** Lift above the floor so it does not z-fight with it. */
    liftM: number;
    color: number;
  };
};

export type TrailConfig = MeshConfig & TrailDescription;
export type TrailUpdate = MeshUpdate & TrailDescription;

/**
 * A flat ribbon following the path. Deliberately not `THREE.Line`: line width
 * is ignored by most WebGL implementations, so a polyline would render as a
 * hairline 1 px wide however far away the camera is. A real quad strip gives a
 * width in world units, which is what makes it readable from altitude.
 */
export class TrailMeshDesc extends MeshDesc<TrailConfig, TrailUpdate, Group> {
  private cfg: TrailConfig;

  constructor(view: ThreeView, ctx: ViewContext, config: TrailConfig) {
    super(view, ctx, config);
    this.cfg = config;
  }

  createMesh(): Group {
    const root = new Group();
    const desc = this.cfg.trail;
    if (!desc || desc.points.length < 2) return root;

    const { frame, points, widthM, liftM } = desc;
    const local = points.map((p) => {
      const v = toLocal(frame, p);
      v.y += liftM;
      return v;
    });

    const half = widthM / 2;
    const positions: number[] = [];
    const indices: number[] = [];
    const up = new Vector3(0, 1, 0);
    const dir = new Vector3();
    const side = new Vector3();

    // One pair of vertices per point, offset either side of the path. The
    // offset uses the *horizontal* direction only, so the ribbon stays flat
    // even where the path climbs stairs.
    for (let i = 0; i < local.length; i++) {
      const prev = local[Math.max(0, i - 1)];
      const next = local[Math.min(local.length - 1, i + 1)];
      dir.subVectors(next, prev);
      dir.y = 0;
      if (dir.lengthSq() < 1e-8) dir.set(1, 0, 0);
      dir.normalize();
      side.crossVectors(up, dir).normalize().multiplyScalar(half);

      positions.push(
        local[i].x + side.x,
        local[i].y + side.y,
        local[i].z + side.z,
        local[i].x - side.x,
        local[i].y - side.y,
        local[i].z - side.z,
      );

      if (i > 0) {
        const a = (i - 1) * 2;
        const b = a + 1;
        const c = i * 2;
        const d = c + 1;
        indices.push(a, c, b, b, c, d);
      }
    }

    const geom = new BufferGeometry();
    geom.setAttribute(
      "position",
      new BufferAttribute(new Float32Array(positions), 3),
    );
    geom.setIndex(indices);
    geom.computeVertexNormals();

    const mesh = new Mesh(
      geom,
      new MeshBasicMaterial({
        color: desc.color,
        transparent: true,
        opacity: 0.9,
        blending: AdditiveBlending,
        depthWrite: false,
        // The route runs 0.5 m above the floor, and the underground's ceilings
        // reach 45 m -- so from 697 m up the whole line sits *inside* the
        // structure and the roof hides it completely. It is a data overlay, not
        // an object in the scene, so it ignores depth and draws on top.
        depthTest: false,
        side: DoubleSide,
        toneMapped: false,
      }),
    );
    mesh.renderOrder = 999;
    root.add(mesh);

    root.traverse((o) => {
      o.frustumCulled = false;
    });
    root.position.copy(frame.ecef);
    root.quaternion.copy(frame.quat);
    return root;
  }
}

// ---------------------------------------------------------------------------
// Start / goal markers
// ---------------------------------------------------------------------------

type MarkerDescription = {
  trailMarker?: {
    frame: LocalFrame;
    at: TrailPoint;
    color: number;
    /** Beam height in metres. Tall enough to read from the aerial shot. */
    heightM: number;
  };
};

export type MarkerConfig = MeshConfig & MarkerDescription;
export type MarkerUpdate = MeshUpdate & MarkerDescription;

/** A vertical beam with a disc at its foot, marking one point on the map. */
export class TrailMarkerMeshDesc extends MeshDesc<
  MarkerConfig,
  MarkerUpdate,
  Group
> {
  private cfg: MarkerConfig;
  private parts: Mesh[] = [];

  constructor(view: ThreeView, ctx: ViewContext, config: MarkerConfig) {
    super(view, ctx, config);
    this.cfg = config;
  }

  createMesh(): Group {
    const root = new Group();
    const desc = this.cfg.trailMarker;
    if (!desc) return root;

    const mat = (opacity: number): MeshBasicMaterial =>
      new MeshBasicMaterial({
        color: desc.color,
        transparent: true,
        opacity,
        blending: AdditiveBlending,
        depthWrite: false,
        // As with the ribbon: these are markers on a map, and the lower part of
        // each beam (and the whole disc at its foot) would otherwise be hidden
        // inside the structure.
        depthTest: false,
        side: DoubleSide,
        toneMapped: false,
      });

    const local = toLocal(desc.frame, desc.at);

    // Core beam, plus a wider soft one so it reads as light rather than a pole.
    const core = new Mesh(
      new CylinderGeometry(1.6, 1.6, desc.heightM, 12, 1, true),
      mat(0.5),
    );
    core.position.set(local.x, local.y + desc.heightM / 2, local.z);
    root.add(core);
    this.parts.push(core);

    const halo = new Mesh(
      new CylinderGeometry(5, 5, desc.heightM, 12, 1, true),
      mat(0.16),
    );
    halo.position.copy(core.position);
    root.add(halo);
    this.parts.push(halo);

    const disc = new Mesh(new CircleGeometry(9, 32), mat(0.4));
    disc.rotation.x = -Math.PI / 2;
    disc.position.set(local.x, local.y + 0.4, local.z);
    root.add(disc);
    this.parts.push(disc);

    root.traverse((o) => {
      o.frustumCulled = false;
      o.renderOrder = 998;
    });
    root.position.copy(desc.frame.ecef);
    root.quaternion.copy(desc.frame.quat);
    return root;
  }

  update(time: number): void {
    // Slow pulse so the two markers read as active lights in a still frame.
    const pulse = 0.8 + 0.2 * Math.sin((time / 1000) * ((2 * Math.PI) / 3));
    const base = [0.5, 0.16, 0.4];
    this.parts.forEach((p, i) => {
      (p.material as MeshBasicMaterial).opacity = base[i] * pulse;
    });
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

export const TRAIL_COLOR = 0x7fd4ff; // cool: the route taken
export const START_COLOR = 0x9fe8ff; // cool: where it began
export const GOAL_COLOR = 0xffd08a; // warm: where the parent was

let registered = false;

export type TrailHandles = { remove: () => void };

/**
 * Draws the walked path plus a marker at each end. Call when the closing shot
 * starts; returns a handle so a replay can clear the previous one.
 */
export function showTrail(
  view: ThreeView,
  points: TrailPoint[],
  start: TrailPoint,
  goal: TrailPoint,
): TrailHandles {
  if (!registered) {
    view.registerMesh("trail", TrailMeshDesc);
    view.registerMesh("trailMarker", TrailMarkerMeshDesc);
    registered = true;
  }

  // Anchor everything to the first recorded point, so all local offsets stay
  // within a few hundred metres.
  const frame = makeLocalFrame(points[0] ?? start);
  type AddArg = Parameters<ThreeView["addMesh"]>[0];
  const handles: { delete: () => void }[] = [];

  if (points.length >= 2) {
    const trailConfig: TrailConfig = {
      trail: {
        frame,
        points,
        widthM: 4.5,
        liftM: 0.5,
        color: TRAIL_COLOR,
      },
    };
    handles.push(
      view.addMesh<TrailMeshDesc>(trailConfig as unknown as AddArg),
    );
  }

  for (const [at, color] of [
    [start, START_COLOR],
    [goal, GOAL_COLOR],
  ] as const) {
    const markerConfig: MarkerConfig = {
      trailMarker: { frame, at, color, heightM: 130 },
    };
    handles.push(
      view.addMesh<TrailMarkerMeshDesc>(markerConfig as unknown as AddArg),
    );
  }

  if (points.length < 5) {
    console.warn(
      `[trail] only ${points.length} sample(s) recorded -- the line will be ` +
        "invisible at this scale. This is expected if you used the debug " +
        "teleport instead of walking; walk from START to see the route.",
    );
  }
  console.info(
    `[trail] ${points.length} samples drawn, ` +
      `start (${start.lat.toFixed(6)}, ${start.lng.toFixed(6)}) -> ` +
      `goal (${goal.lat.toFixed(6)}, ${goal.lng.toFixed(6)})`,
  );

  return { remove: () => handles.forEach((h) => h.delete()) };
}
