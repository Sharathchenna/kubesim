import { camera, type CameraKey } from "../../kit/camera";
import { b, cue } from "./cues";
import { NODE_H, P, POD, slotCenter } from "./iso";

/** World positions (world units; the cluster is centred on 0,0). Derived from iso.tsx geometry, not guessed. */
const killPod = slotCenter("w3", 0);
export const KILL_TARGET = P(killPod[0], killPod[1], NODE_H + POD + 4); // top face of worker-3's Pod
export const RING = { gx: 67, gy: -115, z: 230, r: 64 }; // ReplicaSet ring, floating over worker-3
export const POWER_BUTTON = { x: 430, y: -64 }; // right of worker-3's right corner (372, 0)
export const PROOF = { x: 1900, y: 0, w: 820 }; // the real Sandbox, off to the right on the same canvas

/** The camera: [t, x, y, zoom] on the kit's heavy spring. Push-ins on the kill and the failing Node. */
export const CAMERA: readonly CameraKey[] = [
  [0, 0, -20, 1.9],
  [cue.nodes[0], 0, -20, 1.55],
  [cue.kill, 170, -80, 2.0],
  [cue.ring, 120, -120, 1.65],
  [cue.heal, 0, -20, 1.55],
  [cue.term, 0, -64, 1.45],
  [cue.cursorIn2, 150, -30, 1.8],
  [cue.lift, 60, -110, 1.35],
  [cue.pullBack, 0, -20, 1.55],
  [b(18, 3), PROOF.x, PROOF.y, 1.25],
];

export const view = (t: number) => camera(t, CAMERA);
