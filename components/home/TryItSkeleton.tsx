// What the home page's live cluster looks like while it boots: the shop's diagram in outline (its
// workloads, three Nodes, the Services and the Ingress) over the command chips and terminal strip. The
// outline keeps the real diagram's proportions and fits the pane the same way the Cluster View does,
// so the cards land where their outlines were.

const CARD = "fill-paper stroke-ink/10";

/** The shop as the Cluster View lays it out, in its own units (about 2.1 : 1). */
const SHAPES: [x: number, y: number, w: number, h: number][] = [
  // workloads
  ...[0, 1, 2, 3, 4].map((i): [number, number, number, number] => [i * 262, 0, 236, 54]),
  // Nodes: the control plane, then two workers holding the shop's Pods
  [0, 118, 230, 112],
  [262, 118, 330, 196],
  [624, 118, 330, 196],
  // config and storage, to the right of the Nodes
  [1000, 118, 236, 40],
  [1000, 176, 236, 40],
  // Services
  ...[0, 1, 2, 3].map((i): [number, number, number, number] => [i * 262, 380, 236, 54]),
  // the Ingress
  [350, 500, 250, 58],
];

export function TryItSkeleton() {
  return (
    <div role="status" aria-label="Starting a cluster…" className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)_212px] md:grid-rows-[minmax(0,1fr)_230px]">
      <div className="relative min-h-0 border-b border-ink/10 px-4 pb-10 pt-8 motion-safe:animate-pulse">
        <svg viewBox="-20 -20 1276 598" className="h-full w-full" aria-hidden>
          {SHAPES.map(([x, y, w, h], i) => (
            <rect key={i} x={x} y={y} width={w} height={h} rx={14} className={CARD} strokeWidth={2} vectorEffect="non-scaling-stroke" />
          ))}
        </svg>
        <span className="absolute left-4 top-3 text-[12.5px] text-ink-soft">Starting a cluster…</span>
      </div>
      <div className="flex min-h-0 flex-col bg-paper md:grid md:grid-cols-[230px_minmax(0,1fr)]">
        <div className="flex shrink-0 gap-1.5 overflow-hidden border-b border-ink/10 p-3 md:flex-col md:border-b-0 md:border-r">
          {[112, 96, 118, 88].map((w) => (
            <span key={w} className="h-[28px] shrink-0 rounded-lg border border-ink/10" style={{ width: w }} />
          ))}
        </div>
        <div className="space-y-2.5 p-4">
          {[46, 70, 58, 64].map((w, i) => (
            <span key={i} className="block h-2 rounded-full bg-ink/[0.07]" style={{ width: `${w}%` }} />
          ))}
        </div>
      </div>
    </div>
  );
}
