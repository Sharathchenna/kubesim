// The home page's hero: an isometric twin of the Cluster View (same geometry
// as the promo film, videos/src/videos/kubesim-film/iso.tsx). One Pod is
// deleted and its ReplicaSet creates a replacement, on a 12 s CSS loop, while
// a Service keeps sending traffic to the healthy ones. (Not a crash loop: a
// crashing container is restarted in place by the kubelet, and the ReplicaSet
// leaves that Pod alone.) Decorative: the real, interactive cluster is further
// down the page.

const NODE_W = 200;
const NODE_H = 16;
const POD = 52;
const GAP = 30;

const P = (x: number, y: number, z: number) => [(x - y) * 0.866, (x + y) * 0.5 - z] as const;
const pts = (list: [number, number, number][]) => list.map(([x, y, z]) => P(x, y, z).map((v) => v.toFixed(1)).join(",")).join(" ");

type Faces = readonly [top: string, left: string, right: string];
const NODE: Faces = ["#FFFFFF", "#E2E8F0", "#CBD5E1"];
const POD_BLUE: Faces = ["#93C5FD", "#3B82F6", "#2563EB"];
const POD_TEAL: Faces = ["#99F6E4", "#14B8A6", "#0D9488"];
const POD_RED: Faces = ["#FECACA", "#F87171", "#DC2626"];
const SYS: Faces = ["#EDE9FE", "#C4B5FD", "#A78BFA"];

type NodeId = "cp" | "w1" | "w2";
const GRID: Record<NodeId, [number, number]> = { cp: [0, 0], w1: [0, 1], w2: [1, 0] };
const LABEL: Record<NodeId, string> = { cp: "control-plane", w1: "worker-1", w2: "worker-2" };
const SLOTS = [[26, 26], [122, 26], [26, 122], [122, 122]] as const;

const origin = (n: NodeId) => [-(NODE_W + GAP / 2) + GRID[n][0] * (NODE_W + GAP), -(NODE_W + GAP / 2) + GRID[n][1] * (NODE_W + GAP)] as const;
const slotCenter = (n: NodeId, k: number) => {
  const [x, y] = origin(n);
  return [x + SLOTS[k][0] + POD / 2, y + SLOTS[k][1] + POD / 2] as const;
};

function Box({ x, y, z, w, d, h, faces: [top, left, right], stroke }: { x: number; y: number; z: number; w: number; d: number; h: number; faces: Faces; stroke?: string }) {
  const line = stroke ? { stroke, strokeWidth: 1.2, strokeLinejoin: "round" as const } : {};
  return (
    <g>
      <polygon points={pts([[x, y + d, z], [x + w, y + d, z], [x + w, y + d, z + h], [x, y + d, z + h]])} fill={left} {...line} />
      <polygon points={pts([[x + w, y, z], [x + w, y + d, z], [x + w, y + d, z + h], [x + w, y, z + h]])} fill={right} {...line} />
      <polygon points={pts([[x, y, z + h], [x + w, y, z + h], [x + w, y + d, z + h], [x, y + d, z + h]])} fill={top} {...line} />
    </g>
  );
}

function Slab({ n }: { n: NodeId }) {
  const [x, y] = origin(n);
  const [e, f] = P(x + 12, y + NODE_W - 10, NODE_H);
  return (
    <g>
      <Box x={x} y={y} z={0} w={NODE_W} d={NODE_W} h={NODE_H} faces={NODE} stroke="#E2E8F0" />
      <text transform={`matrix(0.866,0.5,-0.866,0.5,${e},${f})`} fontFamily="var(--font-geist-mono)" fontSize={15} fontWeight={500} fill="#64748B">
        {LABEL[n]}
      </text>
    </g>
  );
}

function Pod({ n, k, faces = POD_BLUE, led = "#16A34A", className, style, dashed }: { n: NodeId; k: number; faces?: Faces; led?: string; className?: string; style?: React.CSSProperties; dashed?: boolean }) {
  const [gx, gy] = slotCenter(n, k);
  const x = gx - POD / 2;
  const y = gy - POD / 2;
  const [lx, ly] = P(gx, gy, NODE_H + POD);
  return (
    <g className={className} style={style}>
      {dashed ? (
        <g fill="none" stroke="#3B82F6" strokeWidth={1.8} strokeDasharray="5 5">
          <polygon points={pts([[x, y + POD, NODE_H], [x + POD, y + POD, NODE_H], [x + POD, y + POD, NODE_H + POD], [x, y + POD, NODE_H + POD]])} />
          <polygon points={pts([[x + POD, y, NODE_H], [x + POD, y + POD, NODE_H], [x + POD, y + POD, NODE_H + POD], [x + POD, y, NODE_H + POD]])} />
          <polygon points={pts([[x, y, NODE_H + POD], [x + POD, y, NODE_H + POD], [x + POD, y + POD, NODE_H + POD], [x, y + POD, NODE_H + POD]])} />
        </g>
      ) : (
        <>
          <Box x={x} y={y} z={NODE_H} w={POD} d={POD} h={POD} faces={faces} />
          <ellipse cx={lx} cy={ly} rx={7} ry={4} fill={led} />
        </>
      )}
    </g>
  );
}

export function HeroCluster() {
  // Service ring on the ground in front of the workers, with traffic to the healthy Pods.
  const [sx, sy] = [NODE_W + 40, NODE_W + 40];
  const ring = P(sx, sy, 0);
  const targets: [NodeId, number][] = [
    ["w1", 1],
    ["w1", 3],
    ["w2", 2],
  ];
  const corners = (["cp", "w1", "w2"] as NodeId[]).flatMap((n) => {
    const [x, y] = origin(n);
    return [P(x, y, NODE_H + POD + 30), P(x + NODE_W, y, 0), P(x, y + NODE_W, 0), P(x + NODE_W, y + NODE_W, 0)];
  });
  const minX = Math.min(...corners.map((c) => c[0]), ring[0] - 80) - 30;
  const maxX = Math.max(...corners.map((c) => c[0]), ring[0] + 80) + 30;
  const minY = Math.min(...corners.map((c) => c[1])) - 20;
  const maxY = Math.max(...corners.map((c) => c[1]), ring[1] + 40) + 20;
  const [cpx, cpy] = origin("cp");

  return (
    <div className="relative" aria-hidden="true">
      <svg viewBox={`${minX} ${minY} ${maxX - minX} ${maxY - minY}`} className="hc-float h-auto w-full drop-shadow-[0_30px_40px_rgba(15,23,42,0.10)]">
        <defs>
          <radialGradient id="hc-glow">
            <stop offset="0" stopColor="#3B82F6" stopOpacity="0.28" />
            <stop offset="1" stopColor="#3B82F6" stopOpacity="0" />
          </radialGradient>
        </defs>
        <ellipse cx={ring[0]} cy={ring[1]} rx={130} ry={75} fill="url(#hc-glow)" />
        <Slab n="cp" />
        <Slab n="w1" />
        <Slab n="w2" />
        {/* control plane components */}
        {SLOTS.map(([ax, ay], i) => (
          <g key={i} className="hc-pop" style={{ animationDelay: `${0.1 + i * 0.08}s` }}>
            <Box x={cpx + ax + 4} y={cpy + ay + 4} z={NODE_H} w={44} d={44} h={12} faces={SYS} />
          </g>
        ))}
        {/* healthy Pods */}
        <Pod n="w1" k={1} className="hc-pop" style={{ animationDelay: "0.5s" }} />
        <Pod n="w1" k={3} className="hc-pop" style={{ animationDelay: "0.65s" }} faces={POD_TEAL} />
        <Pod n="w2" k={2} className="hc-pop" style={{ animationDelay: "0.8s" }} />
        {/* the Pod that's deleted, its red Terminating phase, the scheduler's reservation and the replacement */}
        <g className="hc-pop" style={{ animationDelay: "0.95s" }}>
          <Pod n="w2" k={3} className="hc-crash" />
        </g>
        <Pod n="w2" k={3} faces={POD_RED} led="#DC2626" className="hc-red" />
        <Pod n="w2" k={1} dashed className="hc-ghost" />
        <Pod n="w2" k={1} className="hc-reborn" />
        {/* Service ring and traffic */}
        <ellipse cx={ring[0]} cy={ring[1]} rx={46} ry={26} fill="#FFFFFF" stroke="#BFDBFE" strokeWidth={2} />
        <ellipse cx={ring[0]} cy={ring[1] - 4} rx={30} ry={17} fill="#EFF6FF" stroke="#3B82F6" strokeWidth={1.5} />
        {targets.map(([n, k], i) => {
          const [gx, gy] = slotCenter(n, k);
          const [tx, ty] = P(gx, gy, NODE_H + 8);
          const d = `M${ring[0]},${ring[1] - 6} C${ring[0]},${ring[1] - 70} ${tx},${ty + 60} ${tx},${ty}`;
          return (
            <g key={i}>
              <path d={d} fill="none" stroke="#93C5FD" strokeWidth={1.4} strokeDasharray="3 5" opacity={0.8} />
              <circle r={4.5} fill="#2563EB" stroke="#fff" strokeWidth={1.5} className="hc-packet">
                <animateMotion dur="2.4s" begin={`${i * 0.8}s`} repeatCount="indefinite" path={d} keyPoints="0;1" keyTimes="0;1" calcMode="spline" keySplines="0.65 0 0.35 1" />
              </circle>
            </g>
          );
        })}
      </svg>

      {/* narration chips, like the canvas's "What just happened" */}
      <div className="pointer-events-none absolute left-[4%] top-[6%] flex items-center gap-2 rounded-full border border-slate-200/80 bg-white/90 px-3 py-1.5 font-mono text-[11.5px] text-slate-600 shadow-[0_4px_16px_rgba(15,23,42,.06)] backdrop-blur">
        <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
        deployment/web · replicas: 3
      </div>
      <div className="hc-chip pointer-events-none absolute bottom-[4%] right-0 max-w-[250px] lg:bottom-[9%] lg:-right-10 rounded-xl border border-red-200 bg-white/95 px-3 py-2 shadow-[0_8px_24px_rgba(15,23,42,.08)] backdrop-blur">
        <div className="flex items-center gap-1.5 font-mono text-[11.5px] font-medium text-red-700">
          <span className="hc-blink h-1.5 w-1.5 rounded-full bg-red-500" />
          Terminating
        </div>
        <div className="mt-0.5 text-[12px] leading-snug text-slate-600">kubectl delete pod web-7d4b9-x2k9p. A Pod that&apos;s shutting down no longer counts for its ReplicaSet.</div>
      </div>
      <div className="hc-chip2 pointer-events-none absolute bottom-[4%] right-0 max-w-[250px] lg:bottom-[9%] lg:-right-10 rounded-xl border border-green-200 bg-white/95 px-3 py-2 shadow-[0_8px_24px_rgba(15,23,42,.08)] backdrop-blur">
        <div className="flex items-center gap-1.5 font-mono text-[11.5px] font-medium text-green-700">
          <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
          SuccessfulCreate
        </div>
        <div className="mt-0.5 text-[12px] leading-snug text-slate-600">The ReplicaSet counts 2 of 3 and creates web-7d4b9-q8m2c. The scheduler places it on worker-2.</div>
      </div>
    </div>
  );
}
