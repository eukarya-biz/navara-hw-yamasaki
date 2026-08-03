import ThreeView, { Color } from "@navaramap/three";
import {
  DefaultPlugin,
  type DefaultDescriptions,
} from "@navaramap/three_default_plugin";
import { PersonViewPlugin } from "@navaramap/three_plugins";
import { Pane } from "tweakpane";
import { WalkGrid, WalkerConstraint } from "./walkgrid";
import { spawnInstancedCrowd, type InstancedCrowdHandles } from "./crowd-instanced";
import { GOAL, GOAL_APPROACH, GoalController } from "./goal";
import { CallAudio } from "./audio";
import { showIntro, showEnding } from "./framing";
import { TrailRecorder, showTrail, type TrailHandles } from "./trail";
import type { MeshHandle } from "@navaramap/three";

// ---------------------------------------------------------------------------
// Facts measured from the tileset, not guessed.
//
// The glb vertices were reprojected to geodetic coordinates and checked against
// every tile's declared boundingVolume.region -- mean error 0.00, so these
// numbers are the data's own. Note the glTF Y-up -> 3D Tiles Z-up conversion
// (x, -z, y) is required; without it heights come out wrong by ~80 m.
//
//   coverage  lat 35.690633..35.695045, lng 139.697650..139.703828
//   heights   15.32..45.49 m (orthometric, Tokyo Bay datum)
//   levels    floors cluster at 25.0 / 30.0-30.5 / 32.5-33.5 / 35.5-36.0 m
//
// The start point is the most open cell on the largest level: 17 of its 25
// neighbouring cells are also walkable.
// ---------------------------------------------------------------------------
const START = {
  lat: 35.6931732,
  lng: 139.7026279,
  /** Floor here. Ceiling is 28.16 m, so 3.2 m of headroom. */
  alt: 24.96,
  heading: 0,
};

/**
 * One well-connected spot per major level, each taken from a real cell in the
 * shipped grid rather than computed at runtime, so the jump buttons cannot land
 * inside a wall. Cell counts show how much floor each level has.
 */
const LEVELS: { label: string; lat: number; lng: number; alt: number }[] = [
  { label: "25.0 m 層 (1784セル・最大)", lat: 35.6932094, lng: 139.6991991, alt: 24.98 },
  { label: "33.5 m 層 (1332セル)", lat: 35.6914363, lng: 139.7007697, alt: 33.37 },
  { label: "30.5 m 層 (834セル)", lat: 35.6921962, lng: 139.6993539, alt: 30.71 },
  { label: "30.0 m 層 (671セル)", lat: 35.6922686, lng: 139.7012564, alt: 29.95 },
  { label: "24.0 m 層 (584セル)", lat: 35.6937884, lng: 139.70046, alt: 24.09 },
];

const DEFAULT_UNDERGROUND_TILESET = "data/shinjuku_ubld_3dtiles/tileset.json";
const tilesetOverride = new URLSearchParams(location.search).get("tileset");

// THE FIX: a root-relative path like "/data/foo/tileset.json" is fetched fine
// by the browser, but the engine's own internal URL joining (used to resolve
// each tile's relative content.uri against the tileset's own URL) silently
// breaks on it -- no error, it just never requests any tile content. Every
// failure over the last two days shared this one root cause, regardless of
// glTF version, b3dm vs glTF, boundingVolume shape, or geometricError. A
// fully-qualified absolute URL (scheme + host) fixes it outright.
const UNDERGROUND_TILESET = new URL(
  tilesetOverride ?? DEFAULT_UNDERGROUND_TILESET,
  location.href,
).href;
const WALK_GRID = "data/ubld_walkgrid.json";

/** Child's eye line. This is the whole point of the project. */
// A 4-year-old. Children get lost most between 2 and 5 -- roughly 80% of cases
// -- and 3-5 is the peak, so 4 is the middle of the window this piece is about.
// 1.0 m rather than 1.1 m also widens the gap to the crowd (1.44-1.73 m), which
// is the whole point: you have to look up to see a face.
// Longest shortest-path across the walkable network, from reachtest.mjs
// (351 grid steps x 2 m). Shown on the ending card as the scale of the place.
const LONGEST_PATH_M = 702;

const CHILD_EYE_HEIGHT = 1.0;
const ADULT_EYE_HEIGHT = 1.6;

/** The data has no textures, so give the geometry a muted concrete tone. */
const UNDERGROUND_COLOR = 0xa8a29a;

/**
 * The underground model has no textures, so it needs light that has direction.
 * Evening sun sits below the horizon and delivers nothing at all, which reads
 * as a flat single-colour surface. Borrowing midday sun gives the geometry
 * shape; shadows are off, so the ceiling does not block it.
 */
const SCENE_DATE = new Date(Date.UTC(2026, 6, 28, 3, 0, 0)); // JST 12:00

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  style: string,
  html = "",
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.setAttribute("style", style);
  node.innerHTML = html;
  return node;
}

async function main(): Promise<void> {
  document.body.style.margin = "0";
  document.body.style.overflow = "hidden";
  document.body.style.background = "#000";

  const container = el("div", "position:fixed;inset:0;");
  document.body.appendChild(container);

  const hud = el(
    "div",
    "position:fixed;right:12px;bottom:12px;z-index:10;padding:10px 12px;" +
      "border-radius:8px;background:rgba(0,0,0,.72);color:#fff;" +
      "font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;" +
      "white-space:pre;pointer-events:none;",
  );
  document.body.appendChild(hud);

  const help = el(
    "div",
    "position:fixed;left:12px;bottom:12px;z-index:10;padding:10px 12px;" +
      "border-radius:8px;background:rgba(0,0,0,.72);color:#fff;" +
      "font:13px/1.7 system-ui,sans-serif;pointer-events:none;",
    "<b>操作</b><br>" +
      "画面をクリック: マウスで視点を回す (Escで解除)<br>" +
      "W / S: 前進・後退 &nbsp; A / D: 左右に回転<br>" +
      "V: 一人称 / 三人称の切り替え<br>" +
      "Shift: 走る",
  );
  document.body.appendChild(help);

  // Faded out for the closing shot: the aerial reveal is what gets recorded and
  // screenshotted, and a debug readout across it is noise. (The HUD also freezes
  // during the shot, because the frame loop hands over to the cinematic before
  // reaching the HUD update -- so leaving it up would show stale numbers.)
  for (const node of [hud, help]) {
    node.style.transition = "opacity .8s ease";
  }
  const setOverlaysVisible = (visible: boolean): void => {
    for (const node of [hud, help]) {
      node.style.opacity = visible ? "1" : "0";
    }
  };

  const banner = el(
    "div",
    "position:fixed;left:50%;top:14px;transform:translateX(-50%);z-index:20;" +
      "padding:8px 14px;border-radius:8px;background:rgba(180,40,40,.9);" +
      "color:#fff;font:13px/1.5 system-ui,sans-serif;display:none;",
  );
  document.body.appendChild(banner);

  // --- walkable floor grid ------------------------------------------------
  const grid = await WalkGrid.load(WALK_GRID);
  const range = grid.floorRange();
  const constraint = new WalkerConstraint(grid);
  constraint.reset(START.lat, START.lng, START.alt);

  // Sanity check the hard-coded start against the grid actually shipped.
  const startSurface = grid.surfaceFor(START.lat, START.lng, START.alt);
  if (!startSurface) {
    console.warn(
      "[start] no walkable surface at START -- the grid and START disagree",
    );
  }

  // --- view ---------------------------------------------------------------
  const view = new ThreeView<DefaultDescriptions>({
    container,
    animation: true,
    picking: false,
    // Shadows off on purpose: the ceiling would block the borrowed sunlight
    // and put the whole interior back into darkness.
    shadow: false,
    backgroundColor: new Color().setHex(0x000000),
  });

  const defaults = new DefaultPlugin();
  view.addPlugin(defaults);

  // Only when a `?tileset=` override was actually given -- floor-following and
  // the walk grid are specific to the Shinjuku underground's own geometry.
  const testingOtherTileset = tilesetOverride !== null;

  const personView = new PersonViewPlugin({
    startLat: START.lat,
    startLng: START.lng,
    startHeight: START.alt,
    startHeading: START.heading,
    initialView: "fpv",
    allowCameraControl: false,
    fpvHeightOffset: CHILD_EYE_HEIGHT,
    // 1.9 m/s. Note this is NOT realism: a 3-4 year old walks at 0.42-0.56 m/s
    // (1.5-2 km/h), which would turn the 378 m route into ~12 minutes. The old
    // 1.4 m/s was already an adult's pace, so "make it realistic" would mean
    // three times slower, not faster. The justification is the story instead --
    // a frightened child hurries -- and the cadence below is what actually
    // sells "child" rather than the speed.
    moveSpeed: 1.9,
    rotationSpeed: 1.6,
    // Default altSpeed is 30 m/s. A corridor is ~2.6 m tall, so one tap of the
    // descend key used to punch straight through the floor and keep going to
    // minAlt. Floor-following owns altitude now, but keep this slow in case
    // free-fly is switched on.
    altSpeed: testingOtherTileset ? 40 : 1.5,
    minAlt: testingOtherTileset ? -200 : range.min - 2,
    maxAlt: testingOtherTileset ? 4000 : range.max + 4,
  });
  view.addPlugin(personView);

  await view.init();

  defaults.addDefaultPhotorealScene();

  // The globe is the ellipsoid/terrain shell. Standing underneath it, it is an
  // opaque lid over the whole view -- this is the grey mass that hid the
  // corridors. `hideUnderground` drops it once the camera is below the surface.
  view.globe.hideUnderground = true;

  view.atmosphere.date = SCENE_DATE;

  // A globe-scale renderer's default near plane can be metres deep, which
  // clips everything when the eye is 1.0 m off the floor of a 3 m corridor.
  console.info(
    `[camera] near was ${view.camera.near}, far ${view.camera.far}`,
  );
  view.camera.near = 0.1;

  // No textures on this data, so exposure has to stay near 1.0; earlier runs at
  // exposure 8 (an outdoor-night value) blew 41% of the frame to pure white.
  const AMBIENT_BASE = 0.35;
  const EXPOSURE_BASE = 1.0;
  view.toneMappingExposure = EXPOSURE_BASE;

  // addLight() accepts the ambient shape, but its return type is the base
  // LightHandle, whose update() only knows about `position`. The concrete
  // AmbientLightDesc type lives in @navaramap/three_default_descs, which is
  // only a transitive dependency here -- importing across that boundary would
  // couple us to a version we do not manage. A structural type for just the
  // one call we make is enough, and keeps the dependency surface unchanged.
  type AmbientHandle = {
    update: (u: { ambient?: { intensity?: number } }) => void;
  };
  const ambientLight = view.addLight({
    ambient: { intensity: AMBIENT_BASE },
  }) as unknown as AmbientHandle;

  // Ambient occlusion is what actually makes an unlit interior readable: it
  // darkens corners and recesses from geometry alone, no light required.
  view.addEffect({ ssao: { intensity: 2.0, radius: 0.05 } });

  const undergroundLayer = view.addLayer({
    type: "cesium3dtiles",
    // The converter wrote EPSG:6697, so these heights are orthometric -- the
    // same datum the walk grid was measured in. No geoid shift here.
    // IMPORTANT: this URL must be fully-qualified (see UNDERGROUND_TILESET
    // above) -- a root-relative path silently loads nothing.
    data: { url: UNDERGROUND_TILESET },
    model: {
      show: true,
      height: 0,
      color: new Color().setHex(UNDERGROUND_COLOR),
      maxSse: 16,
    },
  });
  console.info(`[layer] url=${UNDERGROUND_TILESET}`);

  // Feature creation is the earliest sign the tileset parsed and produced
  // geometry, so count it.
  let features = 0;
  view.on("layer", (kind, layerId, ..._rest) => {
    if (kind === "featureCreated") {
      features++;
      if (features <= 3 || features % 200 === 0) {
        console.info(`[layer] featureCreated #${features} (${layerId})`);
      }
    }
  });

  if (testingOtherTileset) {
    // Free flight, so an above-ground tileset can actually be reached.
    constraint.enabled = false;
    console.info("[test] custom tileset -- floor-following off, free flight on");
  }

  // --- attribution -------------------------------------------------------
  // Navara ships an attribution UI and creates one by default (the ⓘ button in
  // the bottom-right corner), so this goes through the official API rather than
  // a hand-rolled label. Credit format follows what the PLATEAU 3D Tiles
  // datasets themselves use.
  view.attribution?.add([
    {
      attribution: "3D City Model (Project PLATEAU) Shinjuku Ward (FY2025) - MLIT",
      attributionUrl: "https://www.mlit.go.jp/plateau/",
    },
  ]);


  // --- crowd ---------------------------------------------------------------
  // Six InstancedMeshes (one per body part) rather than six Meshes per person,
  // so the draw-call count is fixed at six and the population can be in the
  // hundreds. See src/crowd-instanced.ts for why instance matrices are local
  // offsets from an anchor instead of raw ECEF (float32 precision).
  let crowd: InstancedCrowdHandles | null = null;
  const crowdParams = { count: 500 };
  function respawnCrowd(): void {
    crowd?.remove();
    crowd = spawnInstancedCrowd(view, {
      count: crowdParams.count,
      grid,
      // Anchor anywhere in the area; START keeps local offsets small.
      anchor: { lat: START.lat, lng: START.lng, alt: START.alt },
      stepRadiusM: 8,
      speed: 1.2,
      animateM: 22,
      visibleM: 50,
      // A bit beyond visibleM so people are recycled out of sight. Measured:
      // ~2,656 m² is walkable within 50 m of START, so 500 people is roughly
      // 0.19 people/m² -- between "やや混雑" and "混雑" for a station.
      localRadiusM: 60,
      getPlayer: () => {
        const st = personView.getState();
        return { lat: st.lat, lng: st.lng };
      },
    });
  }
  respawnCrowd();

  // Declared here rather than next to its debug panel bindings: the frame loop
  // below reads walkParams.eye for the head bob's baseline.
  const walkParams = { follow: !testingOtherTileset, eye: CHILD_EYE_HEIGHT };

  // --- head bob ------------------------------------------------------------
  // What makes a viewpoint read as a small child is the step *rate*, not the
  // travel speed: a 4-year-old's stride is 30-35 cm against an adult's ~70 cm,
  // so the head rises and falls about twice as often for the same distance.
  // These two numbers are guesses that need a screen to judge, so they are in
  // the debug panel rather than baked in.
// 4.8 steps/s at 1.9 m/s implies a ~40 cm stride, near a 4-year-old's 30-35 cm
  // and well short of an adult's ~70 cm. An earlier default of 2.9 Hz worked out
  // to a 66 cm stride -- an adult gait -- which defeated the point; feeltest.mjs
  // now guards against that. Amplitude is small because a fast bob with a large
  // one reads as vibration rather than footsteps.
  const bob = { enabled: true, hz: 4.8, amplitudeM: 0.018 };
  let bobPhase = 0;
  let lastBobMs: number | null = null;
  let lastPos: { lat: number; lng: number } | null = null;
  let distanceWalkedM = 0;
  // Samples the route so the closing shot can draw where the player actually
  // went. Sampled by distance, so standing still costs nothing.
  const trail = new TrailRecorder();
  let trailHandles: TrailHandles | null = null;

  // --- ending cinematic ----------------------------------------------------
  // Rising the camera cannot be done with teleport(): PersonViewPlugin's tick
  // clamps altitude to [minAlt, maxAlt] on *every* frame, input or not
  //   x = Math.max(minAlt, Math.min(maxAlt, currentHeight + input))
  // so a teleport above maxAlt is pulled back the very next frame. The camera
  // height, though, is `clampedAlt + fpvHeightOffset`, and setFpvHeightOffset()
  // is unclamped -- so the rise is done by growing the offset instead. The
  // player's logical position stays on the floor, which also keeps the shot
  // anchored over where they were standing.
  // Tunable from the debug panel: this is a shot, and shots get adjusted by
  // looking at them.
  const cine = {
    seconds: 20,
    /** How far round the dataset the camera travels over the shot. */
    orbitDeg: 120,
    /** Look-down angle once risen. Positive pitch looks down. */
    pitchDeg: 55,
    /** Fraction of the shot spent rising; the rest holds and keeps turning. */
    riseFrac: 0.45,
    /** Extra room around the data. 1.0 exactly touches the frame edges. */
    margin: 1.15,
  };

  // Centre and extent of the walkable network, measured from the shipped grid
  // rather than guessed, so the shot frames the whole thing.
  //   南北 474 m / 東西 502 m / 対角 690 m, centre 35.6928566, 139.7008250
  const areaCenter = grid.bounds();

  /**
   * How far the camera has to be from the centre for the whole dataset to fit,
   * computed from the *actual* camera FOV and aspect ratio at runtime. A
   * hard-coded height cannot work: the first attempt used 165 m, which needs
   * 435-937 m depending on FOV, so the edges were cut off. Reading the real
   * frustum also means it still frames correctly in any window shape.
   */
  function framingDistanceM(): number {
    const cam = view.camera.raw;
    const vHalf = ((cam.fov ?? 50) / 2) * (Math.PI / 180);
    const aspect = cam.aspect || 16 / 9;
    const hHalf = Math.atan(Math.tan(vHalf) * aspect);
    // Fit the diagonal, because the shot rotates and the extent presented to
    // the camera changes as it goes round.
    const want = areaCenter.diagonalM / 2;
    const dV = want / Math.tan(vHalf);
    const dH = want / Math.tan(hHalf);
    return Math.max(dV, dH) * cine.margin;
  }

  let cinematicStartMs: number | null = null;
  let cinematicDone = false;
  let cinematicHeadingStart = 0;
  let cinematicDistanceM = 0;

  // --- goal: the parent, and the light that leads to them ------------------
  let searchStartedMs = performance.now();

  // Insurance, off by default: an arrow pointing at the parent. The design
  // decision was to guide with light, because a permanent arrow dissolves the
  // feeling of being lost -- but this stays available for demos and for anyone
  // who would rather not wander 380 m.
  const hintArrow = el(
    "div",
    "position:fixed;left:50%;top:50%;z-index:25;width:0;height:0;" +
      "display:none;pointer-events:none;",
    '<div style="position:absolute;left:-14px;top:-64px;width:28px;' +
      'font:28px/1 system-ui,sans-serif;color:rgba(255,232,190,.85);' +
      'text-align:center;text-shadow:0 0 8px rgba(0,0,0,.6);">&#9650;</div>',
  );
  document.body.appendChild(hintArrow);

  const audio = new CallAudio();
  audio.setSource(GOAL.lat, GOAL.lng);

  const goal = new GoalController(view, AMBIENT_BASE, EXPOSURE_BASE, {
    onReunion: () => {
      audio.stopCalling();
      audio.playRelief();
      // The shot starts from wherever the player was standing, lifting away
      // from them rather than cutting.
      playCinematic();
    },
    onLightLevel: (ambient, exposure) => {
      ambientLight.update({ ambient: { intensity: ambient } });
      view.toneMappingExposure = exposure;
    },
  });
  goal.spawn();

  /** Runs the closing shot from wherever the camera is now. */
  function playCinematic(): void {
    cinematicDone = false;
    cinematicStartMs = performance.now();
    cinematicDistanceM = framingDistanceM();
    const st = personView.getState();
    cinematicHeadingStart = Math.atan2(
      (st.lng - areaCenter.lng) * areaCenter.mPerDegLng,
      (st.lat - areaCenter.lat) * 110540,
    );
    constraint.enabled = false;
    bob.enabled = false;
    setOverlaysVisible(false);
    view.globe.transparent = true;
    view.globe.opacity = 0;

    // Freeze the route and draw it, with a beam at each end. Hidden until now:
    // a 130 m column of light over the goal would look absurd from inside a 3 m
    // corridor, and would work as exactly the arrow the design ruled out.
    audio.fadeAmbience(4);
    trail.stop();
    trailHandles?.remove();
    trailHandles = showTrail(
      view,
      trail.points,
      { lat: START.lat, lng: START.lng, alt: START.alt },
      { lat: GOAL.lat, lng: GOAL.lng, alt: GOAL.alt },
    );

    console.info(
      `[cinematic] orbiting ${areaCenter.diagonalM.toFixed(0)} m of data ` +
        `from ${cinematicDistanceM.toFixed(0)} m out ` +
        `(height ${(cinematicDistanceM * Math.sin((cine.pitchDeg * Math.PI) / 180)).toFixed(0)} m)`,
    );
  }

  /** Jump to the end of the shot. 20 seconds is a long time to sit through twice. */
  function skipCinematic(): void {
    if (cinematicStartMs === null || cinematicDone) return;
    cinematicStartMs = performance.now() - cine.seconds * 1000;
  }
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" || e.key === " ") skipCinematic();
  });

  // --- mouse look ---------------------------------------------------------
  // PersonViewPlugin has no mouse look, but setHeading/setFpvPitch are public,
  // so pointer lock can drive them directly.
  const MAX_PITCH = (85 * Math.PI) / 180;
  let pitch = 0;
  container.addEventListener("click", () => {
    if (document.pointerLockElement !== container) container.requestPointerLock();
  });
  document.addEventListener("mousemove", (e) => {
    if (document.pointerLockElement !== container) return;
    personView.setHeading(personView.getHeading() + e.movementX * 0.0022);
    // Positive fpvPitch tilts the view down, so invert movementY.
    // The cinematic owns the pitch while it runs.
    if (cinematicStartMs !== null && !cinematicDone) return;
    pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, pitch + e.movementY * 0.0022));
    personView.setFpvPitch(pitch);
  });

  // --- floor following ----------------------------------------------------
  // Polled rather than driven from onStateChange: the correction is a
  // teleport(), which changes state and would re-enter the listener.
  let corrections = 0;
  const tick = (): void => {
    const s = personView.getState();
    const fix = constraint.correct(s.lat, s.lng, s.alt);
    if (fix) {
      corrections++;
      personView.teleport({
        lat: fix.lat,
        lng: fix.lng,
        alt: fix.alt,
        heading: s.heading,
      });
    }

    const nowMs = performance.now();

    // How far the player moved since the last frame -- drives both the walked
    // distance shown at the end and whether the head bobs.
    let movedM = 0;
    if (lastPos) {
      const dN = (s.lat - lastPos.lat) * 110540;
      const dE =
        (s.lng - lastPos.lng) * 110540 * Math.cos(s.lat * (Math.PI / 180));
      movedM = Math.hypot(dN, dE);
      // Ignore teleports (debug buttons, level jumps) so the total stays honest.
      if (movedM < 2) distanceWalkedM += movedM;
      lastPos.lat = s.lat;
      lastPos.lng = s.lng;
    } else {
      lastPos = { lat: s.lat, lng: s.lng };
    }

    trail.record(s.lat, s.lng, s.alt);

    // The cinematic owns fpvHeightOffset while it runs, so the bob must not
    // also be writing to it.
    if (cinematicStartMs !== null && !cinematicDone) {
      const t = Math.min(1, (nowMs - cinematicStartMs) / (cine.seconds * 1000));

      // The rise happens over the first part of the shot; the turn continues
      // throughout, so the reveal keeps developing after the climb settles.
      const riseT = Math.min(1, t / cine.riseFrac);
      const rise =
        riseT < 0.5
          ? 4 * riseT * riseT * riseT
          : 1 - Math.pow(-2 * riseT + 2, 3) / 2;
      // Ease the turn at both ends so it does not start or stop abruptly.
      const turn = 0.5 - Math.cos(Math.PI * t) / 2;

      const pitchTarget = (cine.pitchDeg * Math.PI) / 180;
      const pitchNow = pitch + (pitchTarget - pitch) * rise;
      const theta =
        cinematicHeadingStart + ((cine.orbitDeg * Math.PI) / 180) * turn;

      // Decompose the framing distance into height and ground radius at the
      // look-down angle, so the camera ends up on a cone around the centre.
      const targetH = cinematicDistanceM * Math.sin(pitchTarget);
      const targetR = cinematicDistanceM * Math.cos(pitchTarget);
      const radius = targetR * rise;

      // Anchor position: on the orbit circle around the dataset centre. Only
      // altitude is clamped by the plugin, so moving lat/lng like this is fine.
      const anchorLat = areaCenter.lat + (radius * Math.cos(theta)) / 110540;
      const anchorLng =
        areaCenter.lng + (radius * Math.sin(theta)) / areaCenter.mPerDegLng;
      // Face the centre: the bearing from a point on the circle back to the
      // middle is its own angle plus half a turn.
      personView.teleport({
        lat: anchorLat,
        lng: anchorLng,
        alt: START.alt,
        heading: theta + Math.PI,
      });

      // Camera height is `clampedAlt + fpvHeightOffset`, and only the offset is
      // unclamped -- so read back the altitude the plugin settled on and make up
      // the difference. Self-correcting, rather than assuming maxAlt.
      const settledAlt = personView.getState().alt;
      const wantHeight = walkParams.eye + (targetH - walkParams.eye) * rise;
      personView.setFpvHeightOffset(Math.max(0.1, wantHeight - settledAlt));
      personView.setFpvPitch(pitchNow);

      if (t >= 1) {
        cinematicDone = true;
        // Hand the pitch back where the cinematic left it, so the first mouse
        // movement afterwards does not snap the view back to horizontal.
        pitch = (cine.pitchDeg * Math.PI) / 180;
        showEnding(
          {
            elapsedSec: (performance.now() - searchStartedMs) / 1000,
            distanceM: distanceWalkedM,
            walkableAreaM2: grid.cellCount * 4, // 2 m grid
            longestPathM: LONGEST_PATH_M,
          },
          () => {
            // "Keep looking": leave the aerial view in place.
          },
        );
      }
      requestAnimationFrame(tick);
      return;
    }

    const bobDt =
      lastBobMs === null ? 0 : Math.min(nowMs - lastBobMs, 100) / 1000;
    lastBobMs = nowMs;
    if (bob.enabled) {
      // Advance only while actually walking; standing still eases the head back
      // to the baseline instead of freezing it mid-step.
      const walking = movedM > 0.002 && movedM < 2;
      if (walking) {
        bobPhase += bobDt * bob.hz * 2 * Math.PI;
      } else {
        bobPhase = 0;
      }
      const offset = walking ? Math.sin(bobPhase) * bob.amplitudeM : 0;
      personView.setFpvHeightOffset(walkParams.eye + offset);
    }

    crowd?.sim.step(nowMs);

    // Tie the murmur to how many people are actually within earshot. 60 visible
    // is treated as "full" -- at the default 500 population roughly 350-400 are
    // in range in an open concourse, but only a handful in a narrow passage, and
    // that contrast is the point.
    const nearby = crowd?.sim.visibleCount() ?? 0;
    if (audioParams.ambience) {
      audio.setAmbience(Math.min(1, nearby / 60) * audioParams.ambienceLevel);
    }
    goal.update(s.lat, s.lng, nowMs);
    if (hintArrow.style.display !== "none") {
      const rel = goal.bearingFrom(s.lat, s.lng) - s.heading;
      hintArrow.style.transform = `rotate(${(rel * 180) / Math.PI}deg)`;
    }
    audio.setListener(s.lat, s.lng, s.heading);
    audio.update(nowMs);

    const status = constraint.lastStatus;
    banner.style.display = status === "off-grid" ? "block" : "none";
    if (status === "off-grid") {
      banner.textContent = "地下街データの外に出ています — 「開始地点に戻る」を押してください";
    }

    const surf = constraint.lastSurface;
    const mem = view.memoryStats();
    const tiles = mem?.retainedTiles3d ?? -1;
    hud.textContent =
      `lat  ${s.lat.toFixed(6)}\n` +
      `lng  ${s.lng.toFixed(6)}\n` +
      `alt  ${s.alt.toFixed(2)} m (標高)\n` +
      `視線 ${(s.alt + personView.getFpvHeightOffset()).toFixed(2)} m\n` +
      `向き ${(((((s.heading * 180) / Math.PI) % 360) + 360) % 360).toFixed(0)}°\n` +
      `状態 ${
        {
          floor: "床の上",
          blocked: "壁 (進入拒否)",
          "off-grid": "データ外",
          free: "自由飛行",
        }[status]
      }\n` +
      (surf
        ? `床   ${surf.floor.toFixed(2)} m / 天井 ${surf.ceiling.toFixed(2)} m\n`
        : "床   なし\n") +
      `タイル ${tiles === -1 ? "?" : tiles} / 面 ${features}` +
      `${tiles === 0 && features === 0 ? "  ← 読込0件" : ""}\n` +
      `補正 ${corrections}\n` +
      `群衆 ${crowd?.sim.visibleCount() ?? 0}/${crowdParams.count} 表示中\n` +
      `親まで ${goal.distanceM.toFixed(0)} m` +
      `${goal.currentPhase === "reunited" ? " (再会)" : ""}`;

    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  // --- debug panel --------------------------------------------------------
  const pane = new Pane({ title: "Debug" });

  const fWalk = pane.addFolder({ title: "歩行" });
  fWalk
    .addBinding(walkParams, "follow", { label: "床に沿って歩く" })
    .on("change", (ev) => {
      constraint.enabled = ev.value;
    });
  fWalk
    .addBinding(walkParams, "eye", {
      label: "目線の高さ (m)",
      min: 0.6,
      max: 1.9,
      step: 0.05,
    })
    .on("change", (ev) => {
      personView.setFpvHeightOffset(ev.value);
    });
  fWalk.addButton({ title: "子ども目線 (1.0m・4歳)" }).on("click", () => {
    walkParams.eye = CHILD_EYE_HEIGHT;
    personView.setFpvHeightOffset(CHILD_EYE_HEIGHT);
    pane.refresh();
  });
  fWalk.addButton({ title: "大人目線 (1.6m)" }).on("click", () => {
    walkParams.eye = ADULT_EYE_HEIGHT;
    personView.setFpvHeightOffset(ADULT_EYE_HEIGHT);
    pane.refresh();
  });
  fWalk.addButton({ title: "開始地点に戻る" }).on("click", () => {
    constraint.reset(START.lat, START.lng, START.alt);
    personView.teleport({ ...START });
    pitch = 0;
    personView.setFpvPitch(0);
    respawnCrowd();
  });

  const fLevels = pane.addFolder({ title: "階層へ移動", expanded: false });
  for (const level of LEVELS) {
    fLevels.addButton({ title: level.label }).on("click", () => {
      constraint.reset(level.lat, level.lng, level.alt);
      personView.teleport({
        lat: level.lat,
        lng: level.lng,
        alt: level.alt,
        heading: personView.getHeading(),
      });
      respawnCrowd();
    });
  }

  const fCrowd = pane.addFolder({ title: "群衆(試作)", expanded: false });
  fCrowd
    .addBinding(crowdParams, "count", { label: "人数", min: 0, max: 1500, step: 50 })
    .on("change", () => {});
  fCrowd.addButton({ title: "配置し直す" }).on("click", () => respawnCrowd());

  const fFeel = pane.addFolder({ title: "歩きの感触", expanded: false });
  fFeel.addBinding(bob, "enabled", { label: "頭を上下させる" });
  fFeel.addBinding(bob, "hz", {
    label: "歩調 (歩/秒)",
    min: 1,
    max: 7,
    step: 0.1,
  });
  fFeel.addBinding(bob, "amplitudeM", {
    label: "上下の幅 (m)",
    min: 0,
    max: 0.08,
    step: 0.005,
  });

  const fGoal = pane.addFolder({ title: "ゴール(親)", expanded: false });
  const goalParams = { hint: false };
  fGoal
    .addBinding(goalParams, "hint", { label: "方向ヒントを出す" })
    .on("change", (ev) => {
      hintArrow.style.display = ev.value ? "block" : "none";
    });
  fGoal.addButton({ title: "親のそばへ移動(演出の確認)" }).on("click", () => {
    // GOAL_APPROACH is a measured cell on the parent's own floor -- see the
    // note in goal.ts for why an offset guessed from GOAL's own coordinates
    // put the player on the wrong level.
    constraint.reset(GOAL_APPROACH.lat, GOAL_APPROACH.lng, GOAL_APPROACH.alt);
    personView.teleport({
      lat: GOAL_APPROACH.lat,
      lng: GOAL_APPROACH.lng,
      alt: GOAL_APPROACH.alt,
      heading: goal.bearingFrom(GOAL_APPROACH.lat, GOAL_APPROACH.lng),
    });
    respawnCrowd();
  });
  const fAudio = pane.addFolder({ title: "音", expanded: false });
  const audioParams = { ambience: true, ambienceLevel: 1.0 };
  fAudio
    .addBinding(audioParams, "ambience", { label: "ざわめき" })
    .on("change", (ev) => {
      if (!ev.value) audio.fadeAmbience(0.5);
    });
  fAudio.addBinding(audioParams, "ambienceLevel", {
    label: "ざわめきの大きさ",
    min: 0,
    max: 2,
    step: 0.1,
  });
  fAudio.addButton({ title: "音の状態をコンソールに出す" }).on("click", () => {
    console.info(
      `[audio] 親の声: ${audio.hasVoice ? "読み込み済み" : "未設置 (audio/call1.mp3)"} / ` +
        `ざわめき: ${audio.ambienceKind}`,
    );
  });

  const fCine = pane.addFolder({ title: "終幕のカメラ", expanded: false });
  fCine.addBinding(cine, "seconds", { label: "長さ (秒)", min: 4, max: 40, step: 1 });
  fCine.addBinding(cine, "orbitDeg", { label: "回る角度 (°)", min: 0, max: 360, step: 10 });
  fCine.addBinding(cine, "pitchDeg", { label: "見下ろす角度 (°)", min: 20, max: 89, step: 1 });
  fCine.addBinding(cine, "riseFrac", { label: "上昇に使う割合", min: 0.2, max: 1, step: 0.05 });
  fCine.addBinding(cine, "margin", { label: "周囲の余白", min: 1, max: 2, step: 0.05 });
  fCine.addButton({ title: "ここから再生(親を探さずに確認)" }).on("click", () => {
    playCinematic();
  });
  fCine
    .addButton({ title: "見本の軌跡で再生(歩かずに確認)" })
    .on("click", () => {
      // Substitute the real shortest route through the grid for the recorded
      // one, so the ribbon can be checked without walking 378 m first. This is
      // a genuine walkable path, not a straight line.
      const route = grid.pathBetween(
        { lat: START.lat, lng: START.lng, alt: START.alt },
        { lat: GOAL.lat, lng: GOAL.lng, alt: GOAL.alt },
      );
      trail.reset();
      for (const p of route) trail.record(p.lat, p.lng, p.alt);
      console.info(`[trail] sample route: ${route.length} cells`);
      playCinematic();
    });
  fCine.addButton({ title: "止めて地上から戻る" }).on("click", () => {
    cinematicStartMs = null;
    cinematicDone = false;
    trailHandles?.remove();
    trailHandles = null;
    trail.reset();
    setOverlaysVisible(true);
    constraint.enabled = true;
    walkParams.follow = true;
    bob.enabled = true;
    view.globe.opacity = 1;
    view.globe.transparent = false;
    pitch = 0;
    personView.setFpvPitch(0);
    personView.setFpvHeightOffset(walkParams.eye);
    constraint.reset(START.lat, START.lng, START.alt);
    personView.teleport({ ...START });
    pane.refresh();
  });

  fGoal.addButton({ title: "演出をリセット" }).on("click", () => {
    goal.reset();
    audio.startCalling();
    searchStartedMs = performance.now();
    distanceWalkedM = 0;
  });

  const fScene = pane.addFolder({ title: "見え方", expanded: false });
  const sceneParams = {
    exposure: 1.0,
    globeUnder: true,
    color: 0xa8a29a,
  };
  fScene
    .addBinding(sceneParams, "exposure", {
      label: "露出",
      min: 0.2,
      max: 4,
      step: 0.1,
    })
    .on("change", (ev) => {
      view.toneMappingExposure = ev.value;
    });
  fScene
    .addBinding(sceneParams, "globeUnder", { label: "地表を隠す(地下用)" })
    .on("change", (ev) => {
      view.globe.hideUnderground = ev.value;
    });
  fScene
    .addButton({ title: "上空200mから俯瞰(描画確認)" })
    .on("click", () => {
      // Isolates "did the tileset load at all" from "is the camera in the
      // wrong place": from up here the underground mass should be visible as
      // a shape on the ground, with the globe hidden.
      // teleport({ alt: 200 }) does NOT work here: the plugin's tick clamps
      // altitude to [minAlt, maxAlt] every frame, so it snaps straight back to
      // maxAlt (~43 m). Camera height is `clampedAlt + fpvHeightOffset` and the
      // offset is unclamped, so the lift has to go through the offset instead.
      constraint.enabled = false;
      walkParams.follow = false;
      bob.enabled = false; // would otherwise overwrite the offset every frame
      // The globe is an opaque lid between an above-ground camera and the
      // underground below it.
      view.globe.transparent = true;
      view.globe.opacity = 0;
      personView.teleport({
        lat: START.lat - 0.003,
        lng: START.lng,
        alt: START.alt,
        heading: 0,
      });
      personView.setFpvHeightOffset(200);
      pitch = (55 * Math.PI) / 180; // positive pitch looks down
      personView.setFpvPitch(pitch);
      pane.refresh();
    });

  // Report tile loading a few times after startup so an empty scene can be
  // told apart from a mispositioned camera without opening the profiler.
  for (const delay of [2000, 5000, 10000]) {
    setTimeout(() => {
      const m = view.memoryStats();
      console.info(
        `[tiles @${delay / 1000}s] retainedTiles3d=${m?.retainedTiles3d}, ` +
          `buffers=${m?.bufferCount}, gpuBytesEst=${m?.gpuBytesEst}`,
      );
    }, delay);
  }

  // Expose a little for console poking.
  Object.assign(window, {
    view,
    personView,
    grid,
    constraint,
    getCrowd: () => crowd,
    getCrowdCount: () => crowd?.sim.people.length ?? 0,
  });

  showIntro({
    onStart: () => {
      personView.start();
      searchStartedMs = performance.now();
      // A real user gesture: the only thing browsers accept for starting an
      // AudioContext. Previously this rode along on the canvas click that grabs
      // pointer lock, which worked but coupled audio to an unrelated action.
      void audio.resume();
    },
  });

  console.info(
    `[underground] walkable cells: ${grid.cellCount}, ` +
      `floor range ${range.min.toFixed(2)}..${range.max.toFixed(2)} m`,
  );
}

main().catch((err) => {
  console.error(err);
  const box = document.createElement("pre");
  box.style.cssText =
    "position:fixed;inset:20px;z-index:99;padding:16px;overflow:auto;" +
    "background:#300;color:#fbb;font:12px/1.5 ui-monospace,monospace;";
  box.textContent = `起動に失敗しました\n\n${String(err?.stack ?? err)}`;
  document.body.appendChild(box);
});
