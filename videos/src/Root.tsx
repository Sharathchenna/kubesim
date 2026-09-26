import { Composition } from "remotion";

import { DURATION } from "./videos/kubesim-film/cues";
import { KubesimFilm, type FilmProps } from "./videos/kubesim-film/KubesimFilm";

const defaults: FilmProps = { fps: 60, debug: false };

export function Root() {
  return (
    <Composition
      id="KubesimFilm"
      component={KubesimFilm}
      width={1920}
      height={1080}
      fps={60}
      durationInFrames={Math.round(DURATION * 60)}
      defaultProps={defaults}
      calculateMetadata={({ props }) => ({ fps: props.fps, durationInFrames: Math.round(DURATION * props.fps) })}
    />
  );
}
