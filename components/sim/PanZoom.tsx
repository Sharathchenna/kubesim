"use client";

// A pan/zoom canvas: drag to move, wheel or pinch to zoom around the cursor,
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

/** Fitting never zooms out past this, so text stays readable; the Learner pans instead. */
const MIN_FIT = 0.65;

export function PanZoom({ bounds, fitKey, children, onBackgroundClick, inset, onZoom }: { bounds: Bounds; fitKey: string; children: React.ReactNode; onBackgroundClick?: () => void; inset?: Inset; onZoom?: (k: number) => void }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const drag = useRef<{ px: number; py: number; vx: number; vy: number; moved: boolean; id: number } | null>(null);
  const suppressClick = useRef(false);
  const [animating, setAnimating] = useState(false);
  const [grabbing, setGrabbing] = useState(false);
  const boundsRef = useRef(bounds);
  const insetRef = useRef(inset);
  useEffect(() => {
    boundsRef.current = bounds;
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
    const kFit = Math.min((w - 48) / b.w, (h - 48) / b.h);
    // Phones get a little more overview; text is kept legible by the canvas's font floor.
    const k = Math.min(Math.max(kFit, width < 640 ? 0.5 : MIN_FIT), 1.3);
    setAnimating(animate);
    // Too big to fit: show the top of the diagram (workloads + nodes), centred if it fits across.
    const x = b.w * k <= w ? i.left + w / 2 - (b.x + b.w / 2) * k : i.left + 24 - b.x * k;
    const y = b.h * k <= h ? i.top + h / 2 - (b.y + b.h / 2) * k : i.top + 8 - b.y * k;
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

  const zoomAt = useCallback((cx: number, cy: number, factor: number) => {
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
      e.preventDefault();
      const r = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey || Math.abs(e.deltaY) > Math.abs(e.deltaX) * 2) {
        zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0022)));
      } else {
        setAnimating(false);
        setView((v) => (v ? { ...v, x: v.x - e.deltaX, y: v.y - e.deltaY } : v));
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  const zoomCenter = (f: number) => {
    const r = wrap.current!.getBoundingClientRect();
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
      className={`canvas-dots relative h-full w-full touch-none overflow-hidden ${grabbing ? "cursor-grabbing" : "cursor-grab"}`}
      style={{ backgroundPosition: `${v.x}px ${v.y}px`, backgroundSize: `${22 * v.k}px ${22 * v.k}px` }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        drag.current = { px: e.clientX, py: e.clientY, vx: v.x, vy: v.y, moved: false, id: e.pointerId };
        suppressClick.current = false;
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const dx = e.clientX - d.px;
        const dy = e.clientY - d.py;
        if (!d.moved && Math.hypot(dx, dy) > 4) {
          d.moved = true;
          setGrabbing(true);
          wrap.current?.setPointerCapture(d.id);
        }
        if (d.moved) {
          setAnimating(false);
          setView((cur) => (cur ? { ...cur, x: d.vx + dx, y: d.vy + dy } : cur));
        }
      }}
      onPointerUp={() => {
        if (drag.current?.moved) suppressClick.current = true;
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
      <svg className="absolute inset-0 h-full w-full select-none" style={{ opacity: view ? 1 : 0 }}>
        <g transform={`translate(${v.x} ${v.y}) scale(${v.k})`} style={{ transition: animating ? "transform 0.5s cubic-bezier(0.22,1,0.36,1)" : undefined }}>
          {children}
        </g>
      </svg>

      <div className="absolute bottom-4 right-4 flex items-center gap-0.5 rounded-xl border border-slate-200 bg-white/95 p-1 shadow-[0_1px_2px_rgba(15,23,42,.04),0_4px_16px_rgba(15,23,42,.06)] backdrop-blur" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
        <IconBtn label="Zoom out" onClick={() => zoomCenter(1 / 1.25)}>
          <path d="M5 10h10" />
        </IconBtn>
        <button onClick={() => fit()} className="w-12 rounded-lg py-1 text-center font-mono text-[11px] text-slate-500 hover:bg-slate-100" title="Reset zoom">
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
      <div className="pointer-events-none absolute bottom-4 left-1/2 hidden -translate-x-1/2 text-[11px] text-slate-400 2xl:block">Drag to pan · scroll to zoom · double-click to zoom in</div>
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
