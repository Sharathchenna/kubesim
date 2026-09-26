import { AbsoluteFill } from "remotion";

import { TargetLog } from "../../kit/debug";
import { useTime } from "../../kit/time";
import { Ending, Opening } from "./acts/Brand";
import { Hud } from "./acts/Hud";
import { Words } from "./acts/Words";
import { World } from "./acts/World";
import { Sound } from "./Sound";
import { C } from "./tokens";

export type FilmProps = { fps: number; debug: boolean };

/** kubesim, "Kubernetes, you can see." 1920x1080, 23 bars at 120 BPM. Layers bottom to top per engine.md. */
export function KubesimFilm({ debug }: FilmProps) {
  const t = useTime();
  return (
    <AbsoluteFill style={{ background: C.canvas, overflow: "hidden" }}>
      <World t={t} />
      <Opening t={t} />
      <Ending t={t} />
      <Hud t={t} />
      <Words t={t} />
      <Sound />
      {debug ? <TargetLog /> : null}
    </AbsoluteFill>
  );
}
