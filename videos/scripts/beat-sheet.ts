/** Writes the beat sheet table from cues.ts: bun scripts/beat-sheet.ts > kubesim-film-beat-sheet.md */
import { cue, grid } from "../src/videos/kubesim-film/cues";

const beat = 60 / grid.bpm;
const where = (s: number) => {
  const beats = Math.round((s / beat) * 2) / 2;
  const bar = Math.floor(beats / 4) + 1;
  return `${bar}.${(beats % 4) + 1}`;
};
const rows: string[] = ["| Cue | Bar.beat | Seconds | Frame @60 |", "|---|---|---|---|"];
for (const [name, value] of Object.entries(cue)) {
  for (const [i, s] of (Array.isArray(value) ? value : [value]).entries()) {
    rows.push(`| ${name}${Array.isArray(value) ? `[${i}]` : ""} | ${where(s)} | ${s.toFixed(2)} | ${Math.round(s * 60)} |`);
  }
}
console.log(`# kubesim-film beat sheet (${grid.bpm.toFixed(0)} BPM, 23 bars, 46 s)\n\n${rows.join("\n")}`);
