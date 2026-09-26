/** The music edit and one sound per meaningful event, each placed on its measured peak. */
import { Audio, Sequence, staticFile, useVideoConfig } from "remotion";

import { b, cue } from "./cues";
import peaks from "./sfx-peaks.json";

type Hit = { file: keyof typeof peaks; at: number; volume: number; length?: number; from?: number };

const HITS: Hit[] = [
  { file: "whoosh-soft", at: cue.logoDraw + 0.45, volume: 0.25 },
  { file: "click", at: cue.logoFill, volume: 0.3 },
  { file: "click", at: cue.nodes[0], volume: 0.22 },
  { file: "click", at: cue.nodes[1], volume: 0.22 },
  { file: "click", at: cue.nodes[2], volume: 0.22 },
  { file: "click", at: cue.nodes[3], volume: 0.22 },
  ...cue.podsLand.map((at) => ({ file: "pop" as const, at, volume: 0.35 })),
  { file: "click", at: cue.kill, volume: 0.35 },
  { file: "glass-shatter", at: cue.kill + 0.02, volume: 0.4, length: 1.2 },
  { file: "alarm-blip", at: cue.actual2, volume: 0.25 },
  { file: "laser-zap", at: cue.beam + 0.15, volume: 0.25, length: 1.1 },
  { file: "pop", at: cue.heal, volume: 0.45 },
  { file: "chime", at: cue.heal + 0.05, volume: 0.3 },
  { file: "typing", at: cue.term + 0.15, volume: 0.25, length: cue.typeEnd - cue.term - 0.15, from: 3 },
  { file: "click", at: cue.enter, volume: 0.35 },
  { file: "whoosh-drop", at: cue.rainLand[0] - 0.15, volume: 0.25, length: 1.2 },
  ...cue.rainLand.map((at) => ({ file: "pop" as const, at, volume: 0.32 })),
  { file: "click", at: cue.powerClick, volume: 0.35 },
  { file: "digital-glitch", at: cue.glitch + 0.25, volume: 0.3 },
  { file: "power-down", at: cue.sink, volume: 0.3, length: 1.6 },
  { file: "whoosh", at: cue.lift + 0.45, volume: 0.25 },
  { file: "whoosh", at: cue.lift + 0.85, volume: 0.22 },
  ...cue.evictLand.map((at) => ({ file: "pop" as const, at, volume: 0.35 })),
  { file: "whoosh-soft", at: cue.proof + 0.2, volume: 0.22 },
  ...[...cue.pills, cue.plainEnglish].map((at) => ({ file: "pop" as const, at, volume: 0.18 })),
  { file: "pop", at: cue.endLand, volume: 0.45 },
  { file: "chime", at: cue.endInner, volume: 0.3 },
];

export function Sound() {
  const { fps } = useVideoConfig();
  return (
    <>
      <Audio src={staticFile("audio/kubesim-film/music/kubesim-film-edit.wav")} volume={0.85} />
      {HITS.map((hit, i) => {
        const { peak, duration } = peaks[hit.file];
        const lead = hit.from !== undefined ? 0 : peak;
        const start = Math.max(0, Math.round((hit.at - lead) * fps));
        const length = Math.round((hit.length ?? duration - (hit.from ?? 0)) * fps);
        return (
          <Sequence key={i} from={start} durationInFrames={Math.max(1, length)} layout="none">
            <Audio src={staticFile(`audio/kubesim-film/sfx/${hit.file}.mp3`)} volume={hit.volume} trimBefore={hit.from ? Math.round(hit.from * fps) : undefined} />
          </Sequence>
        );
      })}
    </>
  );
}

export const LAST_BAR = b(23);
