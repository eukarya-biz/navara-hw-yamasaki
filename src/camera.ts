// Hand-driven camera moves for the opening, ported from the Hiroshima archive
// (hirosima-archive-navara/src/camera.ts): requestAnimationFrame + setCamera,
// eased, with height interpolated on a log scale. navara's own flyTo is frame
// driven and does not hold a real-time duration, and the descent from orbit to
// a child's eye line spans seven orders of magnitude in height -- a linear
// height would spend the whole move in space and then slam into the ground.

import type ThreeView from "@navaramap/three";
import { metresPerDegree } from "./geo";

/** A camera pose `setCamera` takes as is. Pitch is negative looking down. */
export type CameraPose = {
  lng: number;
  lat: number;
  height: number;
  pitch: number;
  heading?: number;
  roll?: number;
};

export function applyPose(view: ThreeView, pose: CameraPose): void {
  view.setCamera({
    lng: pose.lng,
    lat: pose.lat,
    height: pose.height,
    pitch: pose.pitch,
    heading: pose.heading ?? 0,
    roll: pose.roll ?? 0,
  });
}

/**
 * The pose that looks at `target` from `distanceM` away, `pitchDeg` below the
 * horizon (positive), facing `headingDeg`.
 */
export function poseLookingAt(
  target: { lat: number; lng: number; height: number },
  distanceM: number,
  pitchDeg: number,
  headingDeg: number,
): CameraPose {
  const p = (pitchDeg * Math.PI) / 180;
  const h = (headingDeg * Math.PI) / 180;
  const back = distanceM * Math.cos(p);
  const m = metresPerDegree(target.lat);
  return {
    lat: target.lat - (back * Math.cos(h)) / m.lat,
    lng: target.lng - (back * Math.sin(h)) / m.lng,
    height: target.height + distanceM * Math.sin(p),
    pitch: -pitchDeg,
    heading: headingDeg,
  };
}

export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// Equal time, equal ratio: the zoom reads as a constant speed.
function lerpHeight(a: number, b: number, t: number): number {
  if (a <= 0 || b <= 0) return lerp(a, b, t);
  return a * Math.pow(b / a, t);
}

/** Shortest turn from one heading to another, -180..180. */
function shortestAngleDelta(fromDeg: number, toDeg: number): number {
  return ((((toDeg - fromDeg) % 360) + 540) % 360) - 180;
}

function lerpAngle(a: number, b: number, t: number): number {
  return a + shortestAngleDelta(a, b) * t;
}

/**
 * Move from `from` to `to` over `duration` ms. Resolves early, where it is,
 * once `isCancelled` returns true (skip).
 *
 * `pitchLag` (0..1) holds the pitch back for that share of the move, so the
 * camera keeps looking down while it descends and tilts up late.
 */
export function animateCamera(
  view: ThreeView,
  from: CameraPose,
  to: CameraPose,
  duration: number,
  isCancelled?: () => boolean,
  pitchLag = 0,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const startTime = performance.now();

    function tick(): void {
      try {
        if (isCancelled?.()) {
          resolve();
          return;
        }
        const raw = Math.min((performance.now() - startTime) / duration, 1);
        const t = easeInOutCubic(raw);
        const pitchRaw = pitchLag > 0 ? Math.max(0, (raw - pitchLag) / (1 - pitchLag)) : raw;
        const tp = easeInOutCubic(Math.min(pitchRaw, 1));
        view.setCamera({
          lng: lerp(from.lng, to.lng, t),
          lat: lerp(from.lat, to.lat, t),
          height: lerpHeight(from.height, to.height, t),
          pitch: lerp(from.pitch, to.pitch, tp),
          heading: lerpAngle(from.heading ?? 0, to.heading ?? 0, t),
          roll: lerpAngle(from.roll ?? 0, to.roll ?? 0, t),
        });
        if (raw < 1) requestAnimationFrame(tick);
        else resolve();
      } catch (error) {
        reject(error);
      }
    }

    requestAnimationFrame(tick);
  });
}
