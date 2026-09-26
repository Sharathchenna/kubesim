import { Easing, interpolateColors } from "remotion";

import { critical, step } from "../../kit/spring";
import { clamp01 } from "../../kit/time";
import { WORLD_WINDOWS } from "./cues";
import { EASE } from "./tokens";

export const land = Easing.bezier(...EASE);
export const draw = Easing.bezier(0.65, 0, 0.35, 1);
export const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
export const mix = (from: string, to: string, u: number) => interpolateColors(clamp01(u), [0, 1], [from, to]);

/** Deterministic noise in [0, 1) from an integer seed. */
export const hash = (i: number) => {
  const s = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
};

export const FALL = 0.36;
const recover = critical(15);

/**
 * A Pod dropping onto its slot, landing exactly at `landAt`: accelerating fall
 * (it must hit fast for the squash to read), one squash, one smooth recover.
 * Returns null before the fall starts.
 */
export function dropPod(t: number, landAt: number, height = 760, fall = FALL) {
  const dt = t - landAt;
  if (dt < -fall) return null;
  if (dt < 0) {
    const u = 1 + dt / fall; // 0..1 over the fall
    return { lift: height * (1 - u * u), sx: 0.93, sy: 1.1 };
  }
  if (dt < 0.07) {
    const u = dt / 0.07;
    return { lift: 0, sx: lerp(1, 1.2, u), sy: lerp(1, 0.72, u) };
  }
  const r = step(dt - 0.07, recover);
  return { lift: 0, sx: lerp(1.2, 1, r), sy: lerp(0.72, 1, r) };
}

/** A ground ripple after a landing: radius grows, stroke thins, fades out. */
export function ripple(t: number, landAt: number) {
  const u = (t - landAt) / 0.65;
  if (u <= 0 || u >= 1) return null;
  const e = 1 - Math.pow(1 - u, 3);
  return { r: 30 * (1 + 1.7 * e), width: 3 - 2 * e, opacity: 0.85 * Math.pow(1 - u, 1.4) };
}

/** How much of the world is showing: 1 inside a world window, fading at the edges. */
export function worldShown(t: number) {
  let v = 0;
  for (const [a, z] of WORLD_WINDOWS) {
    const enter = clamp01((t - a) / 0.22);
    const leave = clamp01((z - 0.12 - t) / 0.12);
    v = Math.max(v, Math.min(enter, leave));
  }
  return v;
}

/** 0 → 1 over `length` seconds from `start`, on the product's easing. */
export const easeIn = (t: number, start: number, length: number) => land(clamp01((t - start) / length));
