import { at, type Grid } from "../../kit/time";

/** Measured: scripts/beats.py on the edit (119.995 BPM, spread 2.4 ms, first downbeat at 0). */
export const grid: Grid = { bpm: 119.995, firstBeat: 0, pickupBeats: 0, beatsPerBar: 4 };
export const b = (bar: number, beat = 1, fraction = 0) => at(grid, bar, beat, fraction);
export const BAR = b(2) - b(1);
export const DURATION = 46;

/** The beat sheet as data. Scene code reads only these. */
export const cue = {
  logoDraw: b(1, 1),
  logoFill: b(1, 3),
  logoInner: b(1, 4),
  wordmark: b(2, 1),
  lockupOut: b(2, 4),

  nodes: [b(4, 1), b(4, 2), b(4, 3), b(4, 4)],
  podsLand: [b(5, 1), b(5, 2), b(5, 3)],
  allGreen: b(5, 4),

  cursorIn: b(7, 1),
  kill: b(7, 3),
  actual2: b(7, 4),
  ring: b(8, 1),
  ringPulse: b(8, 2),
  beam: b(8, 3),
  ride: b(8, 4),
  heal: b(9, 1),
  cursorOut: b(8, 2),

  term: b(11, 1),
  typeEnd: b(11, 3, 0.8),
  enter: b(11, 4),
  rainLand: [b(12, 1), b(12, 1, 0.5), b(12, 2)],
  rainGreen: [b(12, 3), b(12, 3, 0.5), b(12, 4)],

  cursorIn2: b(14, 1),
  powerClick: b(14, 3),
  glitch: b(14, 4),
  red: b(15, 1),
  sink: b(15, 2),
  grey: b(15, 3),
  notReady: b(15, 4),
  lift: b(16, 1),
  evictLand: [b(17, 1), b(17, 2)],
  evicted: b(17, 3),
  pullBack: b(17, 4),
  cursorOut2: b(15, 2),

  proof: b(19, 1),
  pills: [b(19, 2), b(19, 3), b(19, 4), b(20, 1)],
  plainEnglish: b(20, 3),

  endDrop: b(22, 1),
  endLand: b(22, 1, 0.8),
  endMorph: b(22, 2),
  endInner: b(22, 3),
  endWord: b(22, 4),
  tagline: b(22, 4, 0.5),
} as const;

/** Bars that belong to the world (the isometric canvas). Everything else is punchlines or the logo. */
export const WORLD_WINDOWS: readonly [number, number][] = [
  [b(4), b(6)],
  [b(7), b(10)],
  [b(11), b(13)],
  [b(14), b(18)],
  [b(19), b(21)],
];
