/**
 * Isometric twin of kubesim's Cluster View (components/sim/ClusterView.tsx is 2D;
 * the owner asked for isometric Pods). Pure SVG, no clock: every prop comes from t.
 * World units: 1 unit = 1 px at camera zoom 1; the cluster is centred on (0, 0).
 */
import type { ReactNode } from "react";

import { C, MONO } from "./tokens";

export const NODE_W = 200;
export const NODE_H = 16;
export const POD = 52;
const GAP = 30;

export type NodeId = "cp" | "w1" | "w2" | "w3";
/** 2x2 diamond: control-plane at the back, worker-1 left, worker-3 right, worker-2 front. */
const GRID: Record<NodeId, readonly [number, number]> = { cp: [0, 0], w1: [0, 1], w3: [1, 0], w2: [1, 1] };
export const ORDER: readonly NodeId[] = ["cp", "w1", "w3", "w2"];
export const LABEL: Record<NodeId, string> = { cp: "control-plane", w1: "worker-1", w2: "worker-2", w3: "worker-3" };
/** Slots on a Node: 0 back, 1 right, 2 left, 3 front. */
const SLOTS = [[26, 26], [122, 26], [26, 122], [122, 122]] as const;

export type Faces = readonly [top: string, left: string, right: string];

/** Ground (x, y) and height z to screen-space world units. */
export const P = (x: number, y: number, z: number) => [(x - y) * 0.866, (x + y) * 0.5 - z] as const;

export const origin = (n: NodeId) => [-(NODE_W + GAP / 2) + GRID[n][0] * (NODE_W + GAP), -(NODE_W + GAP / 2) + GRID[n][1] * (NODE_W + GAP)] as const;
export const slot = (n: NodeId, k: number) => {
  const [x, y] = origin(n);
  return [x + SLOTS[k][0], y + SLOTS[k][1]] as const;
};
/** Ground centre of a Pod slot. */
export const slotCenter = (n: NodeId, k: number) => {
  const [x, y] = slot(n, k);
  return [x + POD / 2, y + POD / 2] as const;
};
export const nodeCenter = (n: NodeId) => {
  const [x, y] = origin(n);
  return [x + NODE_W / 2, y + NODE_W / 2] as const;
};

const pts = (list: readonly (readonly [number, number, number])[]) => list.map(([x, y, z]) => P(x, y, z).map((v) => v.toFixed(2)).join(",")).join(" ");

type BoxProps = { x: number; y: number; z: number; w: number; d: number; h: number; faces: Faces; stroke?: string; strokeWidth?: number; dash?: string };

/** An isometric box: left face, right face, top face. */
export function Box({ x, y, z, w, d, h, faces: [top, left, right], stroke, strokeWidth = 1.5, dash }: BoxProps) {
  const line = stroke ? { stroke, strokeWidth, strokeLinejoin: "round" as const, strokeDasharray: dash } : {};
  return (
    <g>
      <polygon points={pts([[x, y + d, z], [x + w, y + d, z], [x + w, y + d, z + h], [x, y + d, z + h]])} fill={left} {...line} />
      <polygon points={pts([[x + w, y, z], [x + w, y + d, z], [x + w, y + d, z + h], [x + w, y, z + h]])} fill={right} {...line} />
      <polygon points={pts([[x, y, z + h], [x + w, y, z + h], [x + w, y + d, z + h], [x, y + d, z + h]])} fill={top} {...line} />
    </g>
  );
}

/** Text lying flat on the ground plane, baseline along +x. */
export function FlatText({ x, y, z, size, fill, children }: { x: number; y: number; z: number; size: number; fill: string; children: ReactNode }) {
  const [e, f] = P(x, y, z);
  return (
    <text transform={`matrix(0.866,0.5,-0.866,0.5,${e},${f})`} fontFamily={MONO} fontSize={size} fontWeight={500} fill={fill}>
      {children}
    </text>
  );
}

/** A Node slab with its name printed on the top face. `dz` sinks or lifts it. */
export function Slab({ n, faces = C.node, dz = 0, labelColor = C.label, stroke = C.line }: { n: NodeId; faces?: Faces; dz?: number; labelColor?: string; stroke?: string }) {
  const [x, y] = origin(n);
  return (
    <g>
      <Box x={x} y={y} z={dz} w={NODE_W} d={NODE_W} h={NODE_H} faces={faces} stroke={stroke} strokeWidth={1.2} />
      <FlatText x={x + 12} y={y + NODE_W - 10} z={dz + NODE_H} size={17} fill={labelColor}>
        {LABEL[n]}
      </FlatText>
    </g>
  );
}

/** The control plane's four system components (violet, per CONTRIBUTING.md tones). `rise[i]` 0..1 pops each in. */
export function SystemParts({ rise, flash = -1 }: { rise: readonly number[]; flash?: number }) {
  const [x, y] = origin("cp");
  return (
    <g>
      {SLOTS.map(([sx, sy], i) => {
        const u = rise[i] ?? 1;
        if (u <= 0) return null;
        const [bx, by] = P(x + sx + 26, y + sy + 26, NODE_H);
        return (
          <g key={i} transform={`translate(${bx} ${by}) scale(${0.6 + 0.4 * u}) translate(${-bx} ${-by})`} opacity={Math.min(1, u * 1.4)}>
            <Box x={x + sx + 4} y={y + sy + 4} z={NODE_H} w={44} h={12} d={44} faces={i === flash ? [C.sys[2], C.sys[1], C.sys[2]] : C.sys} />
          </g>
        );
      })}
    </g>
  );
}

export type PodLook = {
  /** Ground centre. */
  gx: number;
  gy: number;
  /** Base height (NODE_H when resting on a slab). */
  z: number;
  faces?: Faces;
  led?: string | null;
  /** Squash around the base centre. */
  sx?: number;
  sy?: number;
  opacity?: number;
  dashed?: boolean;
};

/** A Pod cube with its status LED on top. */
export function Pod({ gx, gy, z, faces = C.pod, led = C.ok, sx = 1, sy = 1, opacity = 1, dashed = false }: PodLook) {
  const x = gx - POD / 2;
  const y = gy - POD / 2;
  const [bx, by] = P(gx, gy, z);
  const [lx, ly] = P(gx, gy, z + POD);
  return (
    <g opacity={opacity} transform={`translate(${bx} ${by}) scale(${sx} ${sy}) translate(${-bx} ${-by})`}>
      {dashed ? (
        <Box x={x} y={y} z={z} w={POD} d={POD} h={POD} faces={["none", "none", "none"]} stroke={C.accent} strokeWidth={2} dash="5 5" />
      ) : (
        <Box x={x} y={y} z={z} w={POD} d={POD} h={POD} faces={faces} />
      )}
      {led && !dashed ? <ellipse cx={lx} cy={ly} rx={7} ry={4} fill={led} /> : null}
    </g>
  );
}

/** A circle of radius r lying on the ground plane at height z, as an ellipse. */
export function IsoRing({ gx, gy, z, r, ...rest }: { gx: number; gy: number; z: number; r: number } & React.SVGProps<SVGEllipseElement>) {
  const [cx, cy] = P(gx, gy, z);
  return <ellipse cx={cx} cy={cy} rx={r * 1.2247} ry={r * 0.7071} fill="none" {...rest} />;
}
