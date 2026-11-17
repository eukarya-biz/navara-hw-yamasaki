// Minimap (top-left), built to the Hiroshima archive's spec -- a navara
// Plugin that draws on `preRender` from the camera's own position and
// heading, a 220 px framed square, the player as a white triangle on a dark
// pedestal -- with the underground's own floor plan as the map instead of a
// street map. A street map tells you nothing down here; the plan of the
// corridors does.
//
// The plan is baked offline from the edited CityGML (tools/build_floorplan.py
// -> public/data/ubld_floorplan.json): floor outlines and the foot of every
// wall, with the opened doors cut out. The floor the player stands on is drawn
// bright with its walls, the floors above and below faintly, so stacked
// corridors read as layers. North up and centred on the player: the whole
// ~500 m underground squeezed into 220 px would be unreadable.
//
// On by default, with the parent marked: finding them on the map is how the
// piece is played. Both can be switched off from the debug panel.

import { Plugin, type ViewContext } from "@navaramap/three";
import type ThreeView from "@navaramap/three";
import { metresPerDegree, type MetresPerDegree } from "./geo";
import type { WalkGrid } from "./walkgrid";

/** On-screen size, CSS px. */
const SIZE_PX = 220;
/** Map scale on screen, px per metre (220 px shows about 180 m). */
const VIEW_PX_PER_M = 1.2;
/** Resolution of the pre-rendered plan, px per metre. */
const BAKE_PX_PER_M = 3;
/** Pedestal and arrow size, px. */
const MARKER_PX = 9;
/** "This floor": plan parts within this of the player's floor, metres. */
const LEVEL_BAND_M = 2;
/** The camera sits at most this far above the floor (eye line + bob). */
const EYE_MAX_M = 2.2;

const COLOR_FLOOR_HERE = "#d9cfb8";
const COLOR_FLOOR_OTHER = "rgba(150, 150, 160, 0.18)";
const COLOR_WALL_HERE = "rgba(40, 36, 30, 0.95)";
const COLOR_PARENT = "#2f9fe0";

type FloorPlan = {
  origin: { lat: number; lng: number };
  floors: { h: number; pts: number[] }[];
  walls: { h: number; seg: [number, number, number, number] }[];
};

/** Dark line under a light one, so it reads on any colour. */
function strokeOnAnyBase(ctx: CanvasRenderingContext2D, alpha: number): void {
  ctx.strokeStyle = `rgba(0, 0, 0, ${alpha * 0.7})`;
  ctx.lineWidth = 2.5;
  ctx.stroke();
  ctx.strokeStyle = `rgba(255, 255, 255, ${alpha})`;
  ctx.lineWidth = 1;
  ctx.stroke();
}

export class Minimap extends Plugin<ThreeView, ViewContext> {
  readonly element: HTMLDivElement;

  private view: ThreeView | null = null;
  private plan: FloorPlan | null = null;
  private mPerDeg: MetresPerDegree | null = null;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  /** The whole plan for one level band, re-painted when the level changes. */
  private readonly bake = document.createElement("canvas");
  private readonly bakeCtx: CanvasRenderingContext2D;
  /** Metre coordinates of the bake's top-left corner. */
  private minX = 0;
  private maxY = 0;
  private bakedLevel: number | null | undefined = undefined;
  private visible = false;
  private parent: { lat: number; lng: number } | null = null;
  private drawn: { lng: number; lat: number; heading: number; level: number | null } | null = null;

  constructor(
    private readonly grid: WalkGrid,
    /** URL of ubld_floorplan.json. */
    private readonly planUrl: string,
  ) {
    super();
    this.element = document.createElement("div");
    this.element.setAttribute(
      "style",
      `display:none;position:fixed;top:12px;left:12px;z-index:10;width:${SIZE_PX}px;height:${SIZE_PX}px;` +
        "border:1px solid rgba(255,255,255,.35);border-radius:6px;overflow:hidden;" +
        "background:rgba(10,12,16,.82);pointer-events:none;transition:opacity .8s ease;",
    );
    this.canvas = document.createElement("canvas");
    this.canvas.width = SIZE_PX;
    this.canvas.height = SIZE_PX;
    this.canvas.setAttribute("style", "display:block;width:100%;height:100%;");
    this.element.appendChild(this.canvas);
    this.ctx = this.context2d(this.canvas);
    this.bakeCtx = this.context2d(this.bake);
  }

  async init(view: ThreeView, _ctx: ViewContext): Promise<void> {
    this.view = view;
    view.on("preRender", this.draw);
    const res = await fetch(this.planUrl);
    if (!res.ok) throw new Error(`minimap: floor plan fetch failed: ${res.status} ${this.planUrl}`);
    const plan: FloorPlan = await res.json();
    this.plan = plan;
    this.mPerDeg = metresPerDegree(plan.origin.lat);
    const xs = plan.floors.flatMap((f) => f.pts.filter((_, i) => i % 2 === 0));
    const ys = plan.floors.flatMap((f) => f.pts.filter((_, i) => i % 2 === 1));
    const margin = 10;
    this.minX = Math.min(...xs) - margin;
    this.maxY = Math.max(...ys) + margin;
    this.bake.width = Math.ceil((Math.max(...xs) + margin - this.minX) * BAKE_PX_PER_M);
    this.bake.height = Math.ceil((this.maxY - (Math.min(...ys) - margin)) * BAKE_PX_PER_M);
  }

  get isVisible(): boolean {
    return this.visible;
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.element.style.display = visible ? "block" : "none";
    this.drawn = null;
  }

  /** Mark the parent on the map, or hide it with null. */
  setParent(at: { lat: number; lng: number } | null): void {
    this.parent = at;
    this.drawn = null;
  }

  private context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("minimap: no 2D context");
    return ctx;
  }

  /** The floor under the camera: the highest walk-grid floor at or below it. */
  private levelAt(lat: number, lng: number, height: number): number | null {
    const pairs = this.grid.surfacesAt(lat, lng);
    const fallback = this.bakedLevel ?? null;
    if (!pairs) return fallback;
    let best: number | null = null;
    for (const [floor] of pairs) {
      if (floor <= height + 0.5 && floor >= height - EYE_MAX_M - 1 && (best === null || floor > best)) best = floor;
    }
    return best ?? fallback;
  }

  /** Metres from the plan origin to bake pixels. */
  private bx(x: number): number {
    return (x - this.minX) * BAKE_PX_PER_M;
  }
  private by(y: number): number {
    return (this.maxY - y) * BAKE_PX_PER_M;
  }

  /** Paint the whole plan once for a level: this floor bright with walls, others faint. */
  private bakeLevel(plan: FloorPlan, level: number | null): void {
    const ctx = this.bakeCtx;
    ctx.clearRect(0, 0, this.bake.width, this.bake.height);
    const near = (h: number): boolean => level !== null && Math.abs(h - level) <= LEVEL_BAND_M;
    const path = (pts: number[]): void => {
      ctx.beginPath();
      ctx.moveTo(this.bx(pts[0]), this.by(pts[1]));
      for (let i = 2; i < pts.length; i += 2) ctx.lineTo(this.bx(pts[i]), this.by(pts[i + 1]));
      ctx.closePath();
    };
    ctx.fillStyle = COLOR_FLOOR_OTHER;
    for (const f of plan.floors) {
      if (near(f.h)) continue;
      path(f.pts);
      ctx.fill();
    }
    ctx.fillStyle = COLOR_FLOOR_HERE;
    for (const f of plan.floors) {
      if (!near(f.h)) continue;
      path(f.pts);
      ctx.fill();
    }
    ctx.strokeStyle = COLOR_WALL_HERE;
    ctx.lineWidth = 1.5;
    ctx.lineCap = "round";
    ctx.beginPath();
    for (const w of plan.walls) {
      if (!near(w.h)) continue;
      ctx.moveTo(this.bx(w.seg[0]), this.by(w.seg[1]));
      ctx.lineTo(this.bx(w.seg[2]), this.by(w.seg[3]));
    }
    ctx.stroke();
    this.bakedLevel = level;
  }

  /** The player: a white triangle on a dark pedestal, north up. */
  private drawMarker(x: number, y: number, heading: number): void {
    const { ctx } = this;
    ctx.save();
    ctx.translate(x, y);
    ctx.beginPath();
    ctx.arc(0, 0, MARKER_PX * 1.3, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(10, 12, 16, 0.78)";
    ctx.fill();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.6)";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.rotate((heading * Math.PI) / 180);
    ctx.beginPath();
    ctx.moveTo(0, -MARKER_PX * 0.92);
    ctx.lineTo(MARKER_PX * 0.58, MARKER_PX * 0.66);
    ctx.lineTo(0, MARKER_PX * 0.28);
    ctx.lineTo(-MARKER_PX * 0.58, MARKER_PX * 0.66);
    ctx.closePath();
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.restore();
  }

  private draw = (): void => {
    const view = this.view;
    const plan = this.plan;
    const m = this.mPerDeg;
    if (!this.visible || !view || !plan || !m) return;
    const pos = view.camera.positionGeographic;
    const heading = view.camera.orientation.heading ?? 0;
    const level = this.levelAt(pos.lat, pos.lng, pos.height);

    const prev = this.drawn;
    if (prev && prev.lng === pos.lng && prev.lat === pos.lat && prev.heading === heading && prev.level === level) return;
    this.drawn = { lng: pos.lng, lat: pos.lat, heading, level };
    if (level !== this.bakedLevel) this.bakeLevel(plan, level);

    const half = SIZE_PX / 2;
    const px = (pos.lng - plan.origin.lng) * m.lng;
    const py = (pos.lat - plan.origin.lat) * m.lat;
    const k = VIEW_PX_PER_M / BAKE_PX_PER_M;
    const { ctx } = this;
    ctx.clearRect(0, 0, SIZE_PX, SIZE_PX);
    ctx.drawImage(this.bake, half - this.bx(px) * k, half - this.by(py) * k, this.bake.width * k, this.bake.height * k);

    if (this.parent) {
      const gx = half + (this.parent.lng - pos.lng) * m.lng * VIEW_PX_PER_M;
      const gy = half - (this.parent.lat - pos.lat) * m.lat * VIEW_PX_PER_M;
      const margin = 6;
      ctx.beginPath();
      ctx.arc(Math.min(SIZE_PX - margin, Math.max(margin, gx)), Math.min(SIZE_PX - margin, Math.max(margin, gy)), 3.5, 0, Math.PI * 2);
      ctx.fillStyle = COLOR_PARENT;
      ctx.fill();
      strokeOnAnyBase(ctx, 0.9);
    }

    ctx.fillStyle = "rgba(255,255,255,.7)";
    ctx.font = "600 11px system-ui,sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("N", half, 14);
    this.drawMarker(half, half, heading);
  };
}
