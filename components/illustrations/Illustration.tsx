"use client";

// Step-through Concept Illustration. A scene is a set of boxes (optionally
// grouped) and edges; each step highlights some of them, animates packets
// along "flow" edges, and shows a caption. Contributors add a scene in
// ./scenes.ts and register it; nothing here needs to change.

import { useEffect, useId, useRef, useState } from "react";

export type Tone = "slate" | "violet" | "blue" | "green" | "amber" | "red";

export interface Box {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  sub?: string;
  tone?: Tone;
  /** A container drawn behind other boxes (e.g. a Node). */
  group?: boolean;
}

export interface Edge {
  id: string;
  from: string;
  to: string;
  label?: string;
  /** Bend the line by this many px (perpendicular). */
  bend?: number;
}

export interface Step {
  title: string;
  text: string;
  /** Box and edge ids to highlight. Everything else is dimmed. */
  on: string[];
  /** Edge ids that carry an animated packet this step. */
  flow?: string[];
  /** Boxes shown with an ✕ (e.g. a not-ready Pod). */
  off?: string[];
}

export interface Scene {
  id: string;
  title: string;
  width: number;
  height: number;
  boxes: Box[];
  edges: Edge[];
  steps: Step[];
}

// Drawn like a blueprint: ink lines on paper. Kinds are told apart by a faint
// ink fill; colour is kept for health only (green running, amber starting, red failing).
const INK = "#172340";
const PAPER = "#fbfaf6";
const SOFT = "#5a6680";
const LINE = "rgba(23,35,64,.32)";
const TONES: Record<Tone, { fill: string; stroke: string; text: string; sub: string; on: string }> = {
  slate: { fill: PAPER, stroke: LINE, text: INK, sub: SOFT, on: INK },
  violet: { fill: "rgba(23,35,64,.06)", stroke: LINE, text: INK, sub: SOFT, on: INK },
  blue: { fill: "rgba(23,35,64,.04)", stroke: LINE, text: INK, sub: SOFT, on: INK },
  green: { fill: PAPER, stroke: "rgba(21,128,61,.55)", text: INK, sub: "#15803d", on: "#15803d" },
  amber: { fill: PAPER, stroke: "rgba(180,83,9,.55)", text: INK, sub: "#b45309", on: "#b45309" },
  red: { fill: PAPER, stroke: "rgba(185,28,28,.55)", text: INK, sub: "#b91c1c", on: "#b91c1c" },
};

type Pt = { x: number; y: number };

/** Point where the ray from a box's centre towards `to` leaves the box. */
function exit(b: Box, to: Pt): Pt {
  const c = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  const dx = to.x - c.x;
  const dy = to.y - c.y;
  const sx = dx === 0 ? Infinity : b.w / 2 / Math.abs(dx);
  const sy = dy === 0 ? Infinity : b.h / 2 / Math.abs(dy);
  const s = Math.min(sx, sy);
  return { x: c.x + dx * s, y: c.y + dy * s };
}

function edgePath(a: Box, b: Box, bend = 0): { d: string; mid: Pt } {
  const ca = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
  const cb = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  const p = exit(a, cb);
  const q = exit(b, ca);
  const len = Math.hypot(q.x - p.x, q.y - p.y) || 1;
  const nx = -(q.y - p.y) / len;
  const ny = (q.x - p.x) / len;
  const m = { x: (p.x + q.x) / 2 + nx * bend, y: (p.y + q.y) / 2 + ny * bend };
  // Pull the end back a little so the arrowhead sits outside the box.
  const back = 4;
  const ex = q.x - ((q.x - m.x) / (Math.hypot(q.x - m.x, q.y - m.y) || 1)) * back;
  const ey = q.y - ((q.y - m.y) / (Math.hypot(q.x - m.x, q.y - m.y) || 1)) * back;
  return { d: `M${p.x},${p.y} Q${m.x},${m.y} ${ex},${ey}`, mid: { x: (p.x + 2 * m.x + q.x) / 4, y: (p.y + 2 * m.y + q.y) / 4 } };
}

/** The scene's drawing for one step. */
function SceneSvg({ scene, i, className }: { scene: Scene; i: number; className?: string }) {
  const step = scene.steps[i];
  const on = new Set(step.on);
  const off = new Set(step.off ?? []);
  const flow = new Set(step.flow ?? []);
  const byId = new Map(scene.boxes.map((b) => [b.id, b]));
  const lit = (id: string) => on.size === 0 || on.has(id);
  // The same scene can be drawn twice (inline and enlarged): keep marker/path ids unique.
  const pre = `${scene.id}${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return (
    <svg viewBox={`0 0 ${scene.width} ${scene.height}`} className={className ?? "block w-full"} role="img" aria-label={`${scene.title}: ${step.title}. ${step.text}`}>
          <defs>
            <marker id={`arr-${pre}`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,1 L9,5 L0,9 z" fill="context-stroke" />
            </marker>
          </defs>

          {scene.boxes
            .filter((b) => b.group)
            .map((b) => {
              const t = TONES[b.tone ?? "slate"];
              return (
                <g key={b.id} className="ill-t" opacity={lit(b.id) ? 1 : 0.4}>
                  <rect x={b.x} y={b.y} width={b.w} height={b.h} fill={b.tone && b.tone !== "slate" ? t.fill : "rgba(23,35,64,.025)"} stroke={on.has(b.id) ? t.on : t.stroke} strokeDasharray="5 4" />
                  <text x={b.x + 12} y={b.y + 18} fill={t.sub} style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: "0.06em" }}>
                    {b.label.toUpperCase()}
                  </text>
                </g>
              );
            })}

          {scene.edges.map((e) => {
            const a = byId.get(e.from)!;
            const b = byId.get(e.to)!;
            const { d, mid } = edgePath(a, b, e.bend);
            const active = on.has(e.id);
            return (
              <g key={e.id} className="ill-t" opacity={lit(e.id) ? 1 : 0.3}>
                <path id={`${pre}-${e.id}`} d={d} fill="none" stroke={active ? INK : LINE} strokeWidth={active ? 1.8 : 1.2} markerEnd={`url(#arr-${pre})`} />
                {e.label && (
                  <g>
                    <rect x={mid.x - e.label.length * 3 - 6} y={mid.y - 9} width={e.label.length * 6 + 12} height={18} fill={PAPER} stroke={active ? INK : LINE} />
                    <text x={mid.x} y={mid.y + 3.5} textAnchor="middle" fill={active ? INK : SOFT} style={{ fontSize: 10, fontFamily: "var(--font-geist-mono)" }}>
                      {e.label}
                    </text>
                  </g>
                )}
                {flow.has(e.id) && (
                  <circle key={`${i}-${e.id}`} className="ill-packet" r={4.5} fill={INK} stroke={PAPER} strokeWidth={1.5}>
                    <animateMotion dur="1.6s" repeatCount="indefinite" rotate="auto">
                      <mpath href={`#${pre}-${e.id}`} />
                    </animateMotion>
                  </circle>
                )}
              </g>
            );
          })}

          {scene.boxes
            .filter((b) => !b.group)
            .map((b) => {
              const t = TONES[b.tone ?? "slate"];
              const active = on.has(b.id);
              const isOff = off.has(b.id);
              return (
                <g key={b.id} className="ill-t" opacity={lit(b.id) ? 1 : 0.35}>
                  <rect x={b.x} y={b.y} width={b.w} height={b.h} fill={isOff ? PAPER : t.fill} stroke={active ? t.on : t.stroke} strokeWidth={active ? 1.8 : 1} />
                  <text x={b.x + b.w / 2} y={b.y + (b.sub ? b.h / 2 - 2 : b.h / 2 + 4)} textAnchor="middle" fill={isOff ? "rgba(23,35,64,.4)" : t.text} style={{ fontSize: 12, fontWeight: 600 }}>
                    {b.label}
                  </text>
                  {b.sub && (
                    <text x={b.x + b.w / 2} y={b.y + b.h / 2 + 13} textAnchor="middle" fill={isOff ? "rgba(23,35,64,.4)" : t.sub} style={{ fontSize: 10 }}>
                      {b.sub}
                    </text>
                  )}
                  {isOff && <path d={`M${b.x + b.w - 16},${b.y + 8} l8,8 M${b.x + b.w - 8},${b.y + 8} l-8,8`} stroke="#b91c1c" strokeWidth={1.6} strokeLinecap="round" />}
                </g>
              );
            })}
        </svg>
  );
}

/** Faint ink dot grid on paper behind the drawing. */
const DOTS: React.CSSProperties = { backgroundImage: "radial-gradient(circle, rgba(23,35,64,.13) 1px, transparent 1.2px)", backgroundSize: "18px 18px" };

/** A Concept Illustration inside a lesson step: collapsed to one ruled row until the learner asks for it. */
export function Illustration({ scene, defaultOpen = false }: { scene: Scene; /** Start expanded (e.g. on a page that is all diagrams). */ defaultOpen?: boolean }) {
  const [shown, setShown] = useState(defaultOpen);
  const [i, setI] = useState(0);
  const [big, setBig] = useState(false);
  const step = scene.steps[i];
  const n = scene.steps.length;
  const bodyId = `${useId()}-diagram`;
  const controls = (
    <div className="ml-auto flex shrink-0 gap-1.5">
      <button onClick={() => setI(Math.max(0, i - 1))} disabled={i === 0} className="h-7 border border-ink/30 bg-paper px-2.5 text-[12.5px] text-ink transition-colors hover:border-ink disabled:opacity-40 disabled:hover:border-ink/30">
        ← Prev
      </button>
      <button onClick={() => setI(i === n - 1 ? 0 : i + 1)} className="h-7 border border-ink bg-ink px-2.5 text-[12.5px] text-paper transition-colors hover:bg-ink/90">
        {i === n - 1 ? "Replay" : "Next →"}
      </button>
    </div>
  );
  const caption = (
    <div key={i} className="cv-fade min-w-[240px] flex-1">
      <div className="text-[13.5px] font-medium text-ink">{step.title}</div>
      <p className="mt-0.5 text-[13px] leading-relaxed text-ink/85">{step.text}</p>
    </div>
  );

  return (
    <figure className="border-y border-ink/25 text-ink" aria-label={`Diagram: ${scene.title}`}>
      <div className="flex items-center">
        <button type="button" onClick={() => setShown(!shown)} aria-expanded={shown} aria-controls={bodyId} className="flex min-w-0 flex-1 items-baseline gap-2 px-1 py-2 text-left transition-colors hover:bg-ink/[0.04]">
          <span className="min-w-0 flex-1 text-[13.5px]">
            <span className="text-ink-soft">Diagram:</span> <span className="font-medium">{scene.title}</span> <span className="text-ink-soft">· {n} slides</span>
          </span>
          <span className="shrink-0 text-[12.5px] text-ink underline underline-offset-4">{shown ? "Hide" : "Show"}</span>
        </button>
        {shown && (
          <>
            <span className="ml-3 font-mono text-[11px] tabular-nums text-ink-soft">
              {i + 1}/{n}
            </span>
            <button onClick={() => setBig(true)} className="ml-2 min-h-6 border border-ink/30 bg-paper px-1.5 py-0.5 text-[11.5px] text-ink transition-colors hover:border-ink" aria-label={`Enlarge the ${scene.title} illustration`} title="Enlarge">
              ⤢ Enlarge
            </button>
          </>
        )}
      </div>
      {shown && (
        <div id={bodyId} className="border-t border-ink/15">
          {/* Tapping the drawing opens it large: in a narrow column its labels are too small to read. */}
          <button type="button" onClick={() => setBig(true)} className="block w-full cursor-zoom-in bg-paper" style={DOTS} aria-label={`Enlarge the ${scene.title} illustration`}>
            <SceneSvg scene={scene} i={i} />
          </button>
          <div className="flex flex-wrap items-end gap-x-4 gap-y-2 border-t border-ink/15 px-1 py-3">
            {caption}
            {controls}
          </div>
        </div>
      )}
      {big && (
        <Lightbox title={`Concept · ${scene.title}`} onClose={() => setBig(false)}>
          <div className="min-h-0 flex-1 overflow-auto bg-paper" style={DOTS}>
            <SceneSvg scene={scene} i={i} className="mx-auto block h-full max-h-[70vh] w-full" />
          </div>
          <div className="flex flex-wrap items-end gap-x-4 gap-y-2 border-t border-ink/15 px-5 py-4">
            {caption}
            {controls}
          </div>
        </Lightbox>
      )}
    </figure>
  );
}

/** A modal over the page (native <dialog>: focus stays inside, Esc closes). */
function Lightbox({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    return () => d?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => e.target === e.currentTarget && onClose()}
      aria-label={title}
      className="font-sheet m-auto flex h-[min(92vh,900px)] w-[min(96vw,1200px)] max-w-none flex-col overflow-hidden border-[1.5px] border-ink bg-paper p-0 text-ink backdrop:bg-ink/40 [&:not([open])]:hidden"
    >
      <div className="flex items-center justify-between border-b-[1.5px] border-ink px-5 py-3">
        <div className="text-[14px] font-medium">{title}</div>
        <button onClick={onClose} className="border border-ink/30 bg-paper px-2 py-0.5 text-[13px] text-ink transition-colors hover:border-ink" autoFocus>
          Close
        </button>
      </div>
      {children}
    </dialog>
  );
}
