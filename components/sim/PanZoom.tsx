"use client";

// A pan/zoom canvas: drag to move, wheel, trackpad or two-finger pinch to zoom,
// with fit-to-content. Clicks after a drag are swallowed so dragging over a
// Pod doesn't select it.

import { useCallback, useEffect, useRef, useState } from "react";

export interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface View {
  x: number;
  y: number;
  k: number;
}

const MIN_K = 0.3;
const MAX_K = 3;

export interface Inset {
  top?: number;
  bottom?: number;
  left?: number;
  right?: number;
}

/** Fitting never zooms out past this, so text stays readable (≥ ~9 px); the Learner pans instead. */
const MIN_FIT = 0.8;
/** The floor when the diagram is too wide for the visible canvas: below this, Nodes lose their details. */
const MIN_FIT_WIDE = 0.6;

export interface MiniRect {
  x: number;
  y: number;
  w: number;
  h: number;
  kind: string;
}

const GRID = 24;
const GRID_MAJOR = GRID * 4;

export function PanZoom({
  bounds,
  mustFit,
  fitKey,
  children,
  onBackgroundClick,
  inset,
  onZoom,
  minimap,
  captureWheel = true,
}: {
  bounds: Bounds;
  /** Part of the diagram that fit-to-screen always shows whole (the Nodes), zooming out further if it has to. */
  mustFit?: Bounds;
  fitKey: string;
  children: React.ReactNode;
  onBackgroundClick?: () => void;
  inset?: Inset;
  onZoom?: (k: number) => void;
  minimap?: MiniRect[];
  /** Zoom with the plain mouse wheel. Off for canvases embedded in a scrolling page: there only pinch / Ctrl+wheel zooms. */
  captureWheel?: boolean;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  /** Active touch/pen pointers, for pinch-zoom. */
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ dist: number } | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const drag = useRef<{ px: number; py: number; vx: number; vy: number; moved: boolean; id: number } | null>(null);
  const suppressClick = useRef(false);
  /** True once the Learner pans or zooms by hand; until then, resizes re-fit the view. */
  const touched = useRef(false);
  const [animating, setAnimating] = useState(false);
  const [grabbing, setGrabbing] = useState(false);
  const boundsRef = useRef(bounds);
  const mustRef = useRef(mustFit);
  const insetRef = useRef(inset);
  useEffect(() => {
    boundsRef.current = bounds;
    mustRef.current = mustFit;
    insetRef.current = inset;
  });

  const fit = useCallback((animate = true) => {
    const el = wrap.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const b = boundsRef.current;
    const i = { top: 0, bottom: 0, left: 0, right: 0, ...insetRef.current };
    const w = width - i.left - i.right;
    const h = height - i.top - i.bottom;
    const kW = (w - 48) / b.w;
    const kFit = Math.min(kW, (h - 48) / b.h);
    // Prefer readable (≥ MIN_FIT), but zoom out further (to MIN_FIT_WIDE) so every Node fits across the
    // visible width; a tall diagram then shows its top and the Learner scrolls down. Phones always get the
    // overview floor; the canvas simplifies objects instead of shrinking their text.
    const floor = width < 640 ? MIN_FIT_WIDE : Math.max(MIN_FIT_WIDE, Math.min(MIN_FIT, kW));
    let k = Math.min(Math.max(kFit, floor), 1.3);
    // Never leave a Node off-screen: zoom out further (the canvas simplifies objects) until they all fit.
    const m = mustRef.current;
    if (m && m.w > 0 && m.h > 0) k = Math.max(MIN_K, Math.min(k, (w - 32) / m.w, (h - 32) / m.h));
    touched.current = false;
    setAnimating(animate);
    // Too big to fit: show the top of the diagram (workloads + nodes), centred on the Nodes if it doesn't fit across.
    let x = b.w * k <= w ? i.left + w / 2 - (b.x + b.w / 2) * k : m ? i.left + w / 2 - (m.x + m.w / 2) * k : i.left + 24 - b.x * k;
    let y = b.h * k <= h ? i.top + h / 2 - (b.y + b.h / 2) * k : i.top + 8 - b.y * k;
    if (m) {
      // Keep the whole Node area inside the visible rectangle.
      x = Math.min(x, i.left + 16 - m.x * k);
      x = Math.max(x, i.left + w - 16 - (m.x + m.w) * k);
      y = Math.max(y, i.top + h - 16 - (m.y + m.h) * k);
      y = Math.min(y, i.top + 16 - m.y * k);
    }
    setView({ k, x, y });
  }, []);

  // Track container size; fit on first layout and when the scene's shape changes.
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    if (size.w > 0) fit(view !== null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey, size.w > 0]);
  // The canvas changes size when the dock grows or the window resizes (and overlays change the clear area):
  // keep the fit, unless the Learner moved the view.
  const insetKey = `${inset?.top ?? 0},${inset?.right ?? 0},${inset?.bottom ?? 0},${inset?.left ?? 0}`;
  useEffect(() => {
    if (view && !touched.current) fit(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size.w, size.h, insetKey]);

  const zoomAt = useCallback((cx: number, cy: number, factor: number) => {
    touched.current = true;
    setAnimating(false);
    setView((v) => {
      if (!v) return v;
      const k = Math.min(MAX_K, Math.max(MIN_K, v.k * factor));
      const f = k / v.k;
      return { k, x: cx - (cx - v.x) * f, y: cy - (cy - v.y) * f };
    });
  }, []);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      // Embedded in a page: let the page scroll unless this is a pinch (Ctrl+wheel) gesture.
      if (!captureWheel && !e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey || Math.abs(e.deltaY) > Math.abs(e.deltaX) * 2) {
        zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0022)));
      } else {
        touched.current = true;
        setAnimating(false);
        setView((v) => (v ? { ...v, x: v.x - e.deltaX, y: v.y - e.deltaY } : v));
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt, captureWheel]);

  const zoomCenter = (f: number) => {
    const r = wrap.current!.getBoundingClientRect();
    touched.current = true;
    setAnimating(true);
    setView((v) => {
      if (!v) return v;
      const k = Math.min(MAX_K, Math.max(MIN_K, v.k * f));
      const s = k / v.k;
      return { k, x: r.width / 2 - (r.width / 2 - v.x) * s, y: r.height / 2 - (r.height / 2 - v.y) * s };
    });
  };

  const v = view ?? { x: 0, y: 0, k: 1 };
  useEffect(() => {
    onZoom?.(v.k);
  }, [v.k, onZoom]);

  return (
    <div
      ref={wrap}
      data-drop="canvas"
      className={`cv-root canvas-grid relative h-full w-full touch-none overflow-hidden outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/40 ${grabbing ? "cursor-grabbing" : "cursor-grab"}`}
      tabIndex={0}
      role="region"
      aria-label="Cluster View. Arrow keys pan, plus and minus zoom, 0 fits everything; Tab moves between objects."
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        const step = 60;
        const pan = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key];
        if (pan) {
          e.preventDefault();
          touched.current = true;
          setAnimating(true);
          setView((cur) => (cur ? { ...cur, x: cur.x + pan[0], y: cur.y + pan[1] } : cur));
        } else if (e.key === "+" || e.key === "=") zoomCenter(1.25);
        else if (e.key === "-") zoomCenter(1 / 1.25);
        else if (e.key === "0") fit();
      }}
      style={{
        backgroundPosition: `${v.x}px ${v.y}px`,
        backgroundSize: `${GRID * v.k}px ${GRID * v.k}px, ${GRID * v.k}px ${GRID * v.k}px, ${GRID_MAJOR * v.k}px ${GRID_MAJOR * v.k}px, ${GRID_MAJOR * v.k}px ${GRID_MAJOR * v.k}px`,
      }}
      onPointerDown={(e) => {
        if (e.pointerType !== "mouse") pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pointers.current.size === 2) {
          // Second finger: switch from panning to pinch-zoom.
          const [a, b] = [...pointers.current.values()];
          pinch.current = { dist: Math.hypot(a.x - b.x, a.y - b.y) };
          drag.current = null;
          suppressClick.current = true;
          touched.current = true;
          return;
        }
        if (e.button !== 0) return;
        drag.current = { px: e.clientX, py: e.clientY, vx: v.x, vy: v.y, moved: false, id: e.pointerId };
        suppressClick.current = false;
      }}
      onPointerMove={(e) => {
        if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pinch.current && pointers.current.size >= 2) {
          const [a, b] = [...pointers.current.values()];
          const dist = Math.hypot(a.x - b.x, a.y - b.y);
          if (dist > 0 && pinch.current.dist > 0) {
            const r = wrap.current!.getBoundingClientRect();
            zoomAt((a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top, dist / pinch.current.dist);
          }
          pinch.current.dist = dist;
          return;
        }
        const d = drag.current;
        if (!d) return;
        const dx = e.clientX - d.px;
        const dy = e.clientY - d.py;
        if (!d.moved && Math.hypot(dx, dy) > 4) {
          d.moved = true;
          touched.current = true;
          setGrabbing(true);
          wrap.current?.setPointerCapture(d.id);
        }
        if (d.moved) {
          setAnimating(false);
          setView((cur) => (cur ? { ...cur, x: d.vx + dx, y: d.vy + dy } : cur));
        }
      }}
      onPointerUp={(e) => {
        pointers.current.delete(e.pointerId);
        if (pointers.current.size < 2) pinch.current = null;
        if (drag.current?.moved) suppressClick.current = true;
        drag.current = null;
        setGrabbing(false);
      }}
      onPointerCancel={(e) => {
        pointers.current.delete(e.pointerId);
        if (pointers.current.size < 2) pinch.current = null;
        drag.current = null;
        setGrabbing(false);
      }}
      onClickCapture={(e) => {
        if (suppressClick.current) {
          e.stopPropagation();
          suppressClick.current = false;
        }
      }}
      onClick={() => onBackgroundClick?.()}
      onDoubleClick={(e) => {
        const r = wrap.current!.getBoundingClientRect();
        zoomAt(e.clientX - r.left, e.clientY - r.top, 1.6);
      }}
    >
      <svg className="absolute inset-0 h-full w-full select-none" style={{ opacity: view ? 1 : 0 }} role="group" aria-label="Cluster diagram">
        <g transform={`translate(${v.x} ${v.y}) scale(${v.k})`} style={{ transition: animating ? "transform 0.5s cubic-bezier(0.22,1,0.36,1)" : undefined }}>
          {children}
        </g>
      </svg>

      <div data-overlay="zoom" className="absolute bottom-4 right-4 flex items-center gap-0.5 rounded-xl border border-slate-200 bg-white/95 p-1 shadow-[0_1px_2px_rgba(15,23,42,.04),0_4px_16px_rgba(15,23,42,.06)] backdrop-blur" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
        <IconBtn label="Zoom out" onClick={() => zoomCenter(1 / 1.25)}>
          <path d="M5 10h10" />
        </IconBtn>
        <button onClick={() => zoomCenter(1 / v.k)} className="w-12 rounded-lg py-1 text-center font-mono text-[11px] text-slate-600 hover:bg-slate-100" title="Zoom to 100%" aria-label={`Zoom ${Math.round(v.k * 100)}%, reset to 100%`}>
          {Math.round(v.k * 100)}%
        </button>
        <IconBtn label="Zoom in" onClick={() => zoomCenter(1.25)}>
          <path d="M5 10h10M10 5v10" />
        </IconBtn>
        <div className="mx-1 h-5 w-px bg-slate-200" />
        <IconBtn label="Fit to screen" onClick={() => fit()}>
          <path d="M4 8V4h4M16 8V4h-4M4 12v4h4M16 12v4h-4" />
        </IconBtn>
      </div>
      {minimap && view && size.w > 0 && (
        <Minimap
          rects={minimap}
          bounds={bounds}
          view={v}
          size={size}
          onJump={(wx, wy) => {
            touched.current = true;
            setAnimating(true);
            setView((cur) => (cur ? { ...cur, x: size.w / 2 - wx * cur.k, y: size.h / 2 - wy * cur.k } : cur));
          }}
        />
      )}
    </div>
  );
}

function IconBtn({ children, label, onClick }: { children: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} title={label} aria-label={label} className="grid h-7 w-7 place-items-center rounded-lg text-slate-600 hover:bg-slate-100">
      <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
        {children}
      </svg>
    </button>
  );
}

/** Overview of the whole diagram with the visible area outlined. Only shown when something is off-screen. */
function Minimap({ rects, bounds: b, view: v, size, onJump }: { rects: MiniRect[]; bounds: Bounds; view: View; size: { w: number; h: number }; onJump: (wx: number, wy: number) => void }) {
  const vis = { x: -v.x / v.k, y: -v.y / v.k, w: size.w / v.k, h: size.h / v.k };
  const overflows = b.x < vis.x - 1 || b.y < vis.y - 1 || b.x + b.w > vis.x + vis.w + 1 || b.y + b.h > vis.y + vis.h + 1;
  // On a short canvas the map would cover the diagram it summarises.
  if (!overflows || !rects.length || size.h < 560 || size.w < 900) return null;
  const s = Math.min(168 / b.w, 104 / b.h);
  const W = b.w * s;
  const H = b.h * s;
  // The visible area, clipped to the map.
  const vx = Math.max(0, (vis.x - b.x) * s);
  const vy = Math.max(0, (vis.y - b.y) * s);
  const vw = Math.min(W, (vis.x + vis.w - b.x) * s) - vx;
  const vh = Math.min(H, (vis.y + vis.h - b.y) * s) - vy;
  const jump = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    onJump(b.x + (e.clientX - r.left) / s, b.y + (e.clientY - r.top) / s);
  };
  return (
    <div
      data-overlay="minimap"
      className="absolute bottom-16 right-4 z-10 hidden rounded-xl border border-slate-200 bg-white/95 p-2 shadow-[0_1px_2px_rgba(15,23,42,.04),0_4px_16px_rgba(15,23,42,.06)] backdrop-blur lg:block"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <div
        role="img"
        aria-label="Minimap: click to move the view there"
        className="relative cursor-pointer"
        style={{ width: W, height: H }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          jump(e);
        }}
        onPointerMove={(e) => e.buttons === 1 && jump(e)}
      >
        {rects.map((r, i) => (
          <div key={i} data-kind={r.kind} className="cv-minimap-node" style={{ left: (r.x - b.x) * s, top: (r.y - b.y) * s, width: Math.max(2, r.w * s), height: Math.max(2, r.h * s) }} />
        ))}
        {vw > 0 && vh > 0 && <div className="absolute rounded-[3px] border-[1.5px] border-blue-600 bg-blue-600/10" style={{ left: vx, top: vy, width: vw, height: vh }} />}
      </div>
    </div>
  );
}
