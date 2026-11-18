// The opening shot: from orbit down to Shinjuku, through the ground and into
// the underground, ending on the child's eye line at the start point. One
// continuous camera, the way the Hiroshima archive opens -- the underground is
// not a separate scene but a place under a real city on a real globe, and this
// is the one moment that says so.
//
// The ground (src/ground.ts) does the see-through by itself as the camera goes
// below the surface; this only flies the camera. Skip (button, Esc, Space)
// cuts to the landing pose.

import type ThreeView from "@navaramap/three";
import { animateCamera, applyPose, poseLookingAt, type CameraPose } from "./camera";
import { SHINJUKU_SURFACE_M } from "./ground";

export type OpeningPlace = {
  lat: number;
  lng: number;
  /** Where the camera lands: the player's eye at the start point. */
  eyeHeight: number;
  heading: number;
};

export class Opening {
  private skipped = false;
  private readonly waits = new Set<() => void>();
  private readonly button: HTMLButtonElement;

  constructor(
    private readonly view: ThreeView,
    private readonly place: OpeningPlace,
  ) {
    this.button = document.createElement("button");
    this.button.textContent = "スキップ";
    this.button.setAttribute(
      "style",
      "position:fixed;right:16px;bottom:16px;z-index:30;padding:8px 18px;" +
        "border:1px solid rgba(255,255,255,.35);border-radius:6px;" +
        "background:rgba(10,12,16,.6);color:#e8e2d8;font:13px system-ui,sans-serif;cursor:pointer;",
    );
    this.button.addEventListener("click", this.skip);
  }

  /** The first frame, before anything has loaded: the globe from orbit. */
  get globePose(): CameraPose {
    return { lat: this.place.lat, lng: this.place.lng, height: 20_000_000, pitch: -90, heading: 0 };
  }

  get landingPose(): CameraPose {
    return { lat: this.place.lat, lng: this.place.lng, height: this.place.eyeHeight, pitch: 0, heading: this.place.heading };
  }

  /** Plays to the landing pose, or cuts to it on skip. */
  async run(): Promise<void> {
    document.body.appendChild(this.button);
    window.addEventListener("keydown", this.onKey);
    try {
      const { view, place } = this;
      const target = { lat: place.lat, lng: place.lng, height: SHINJUKU_SURFACE_M };
      const near = poseLookingAt(target, 260, 35, place.heading - 20);
      const cancelled = (): boolean => this.skipped;

      applyPose(view, this.globePose);
      await this.wait(700);
      if (!this.skipped) await animateCamera(view, this.globePose, near, 10000, cancelled, 0.55);
      if (!this.skipped) await animateCamera(view, near, this.landingPose, 5000, cancelled, 0.3);
      applyPose(view, this.landingPose);
    } finally {
      window.removeEventListener("keydown", this.onKey);
      this.button.remove();
    }
  }

  private skip = (): void => {
    this.skipped = true;
    for (const resolve of this.waits) resolve();
    this.waits.clear();
  };

  private onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape" || e.key === " ") this.skip();
  };

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => {
        this.waits.delete(done);
        resolve();
      };
      this.waits.add(done);
      window.setTimeout(done, ms);
    });
  }
}
