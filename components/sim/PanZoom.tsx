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
/** On a wide screen, fitting goes this far to keep a wide row of workloads in view; the Cluster View still shows labels at this zoom. */
const MIN_FIT_ACROSS = 0.5;
/** Fitting the whole diagram, top to bottom, is worth zooming out this far: the Cluster View enlarges its text below 0.85. */
const MIN_FIT_ALL = 0.64;


const GRID = 24;
const HINT_KEY = "kubesim.canvasHint.v1";
const GRID_MAJOR = GRID * 4;

/** Enlarged on a tall screen, phone-width ("narrow") or wider ("tall"); "wide" otherwise; null when not enlarged. */
export type FullShape = null | "wide" | "tall" | "narrow";

export function PanZoom({
  bounds,
  mustFit,
  fitKey,
  children,
  onBackgroundClick,
  inset,
  onZoom,
  captureWheel = true,
  onFull,
  controls,
}: {
  bounds: Bounds;
  /** Part of the diagram that fit-to-screen always shows whole (the Nodes), zooming out further if it has to. */
  mustFit?: Bounds;
  fitKey: string;
  children: React.ReactNode;
  onBackgroundClick?: () => void;
  inset?: Inset;
  onZoom?: (k: number) => void;
  /** Zoom with the plain mouse wheel. Off for canvases embedded in a scrolling page: there only pinch / Ctrl+wheel zooms. */
  captureWheel?: boolean;
  /** The shape of the screen while enlarged (null when not), so the diagram can lay itself out for it. */
  onFull?: (shape: FullShape) => void;
  /** Extra buttons at the start of the zoom bar (the Cluster View's Tidy up). */
  controls?: React.ReactNode;
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
  /** Enlarged to the whole screen: the browser's full screen where it has one for elements, else a full-window overlay (iPhone). */
  const [full, setFull] = useState<false | "native" | "overlay">(false);
  /** Enlarged, an embedded canvas works like the Sandbox's: wheel and fingers move the diagram, not the page. */
  const capture = captureWheel || full !== false;
  /** First visit only: how to move around, until the Learner does or a few seconds pass. */
  const [hint, setHint] = useState<"mouse" | "touch" | null>(null);
  useEffect(() => {
    if (!captureWheel) return;
    let seen = true;
    try {
      seen = localStorage.getItem(HINT_KEY) !== null;
    } catch {
      // Private mode: no hint rather than one on every visit.
    }
    if (seen) return;
    const show = setTimeout(() => {
      try {
        localStorage.setItem(HINT_KEY, "1");
      } catch {
        // Private mode: shown this once.
      }
      setHint(window.matchMedia("(pointer: coarse)").matches ? "touch" : "mouse");
    }, 900);
    const hide = setTimeout(() => setHint(null), 9000);
    return () => {
      clearTimeout(show);
      clearTimeout(hide);
    };
  }, [captureWheel]);
  const [grabbing, setGrabbing] = useState(false);
  const boundsRef = useRef(bounds);
  const mustRef = useRef(mustFit);
  const insetRef = useRef(inset);
  const embeddedRef = useRef(!captureWheel);
  useEffect(() => {
    boundsRef.current = bounds;
    mustRef.current = mustFit;
    insetRef.current = inset;
    embeddedRef.current = !capture;
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
    // Prefer readable (≥ MIN_FIT), but zoom out further (to MIN_FIT_ACROSS) so everything fits across the
    // visible width; a tall diagram then shows its top and the Learner scrolls down. Phones always get the
    // overview floor; the canvas simplifies objects instead of shrinking their text.
    const floor = width < 640 ? MIN_FIT_WIDE : Math.max(MIN_FIT_ACROSS, Math.min(MIN_FIT, kW));
    // Embedded in a page, the canvas is a window onto the whole cluster: it always shows all of it.
    let k = Math.min(kFit >= MIN_FIT_ALL || embeddedRef.current ? kFit : Math.max(kFit, floor), 1.3);
    // Never leave a Node off-screen: zoom out further (the canvas simplifies objects) until they all fit.
    const m = mustRef.current;
    if (m && m.w > 0 && m.h > 0) k = Math.max(embeddedRef.current ? 0.1 : MIN_K, Math.min(k, (w - 32) / m.w, (h - 32) / m.h));
    touched.current = false;
    setAnimating(animate);
    // Too big to fit: show the top-left of the diagram (workloads + nodes), so none of the visible width is wasted.
    let x = b.w * k <= w ? i.left + w / 2 - (b.x + b.w / 2) * k : i.left + 16 - b.x * k;
    let y = b.h * k <= h ? i.top + h / 2 - (b.y + b.h / 2) * k : i.top + 8 - b.y * k;
    if (m) {
      // Keep the whole Node area inside the visible rectangle: its left/top edge no further left/up than the
      // margin, its right/bottom edge no further right/down. If it can't fit at all, centre it.
      const keep = (v: number, lo: number, hi: number) => (lo > hi ? (lo + hi) / 2 : Math.min(Math.max(v, lo), hi));
      x = keep(x, i.left + 16 - m.x * k, i.left + w - 16 - (m.x + m.w) * k);
      y = keep(y, i.top + 16 - m.y * k, i.top + h - 16 - (m.y + m.h) * k);
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
    setHint(null);
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
      if (!capture && !e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey || Math.abs(e.deltaY) > Math.abs(e.deltaX) * 2) {
        zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0022)));
      } else {
        touched.current = true;
        setHint(null);
        setAnimating(false);
        setView((v) => (v ? { ...v, x: v.x - e.deltaX, y: v.y - e.deltaY } : v));
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt, capture]);

  // Leaving full screen by the browser's own means (Esc, a gesture) ends it here too; the overlay closes on Esc.
  useEffect(() => {
    if (!full) return;
    const onChange = () => {
      if (full === "native" && !document.fullscreenElement) setFull(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (full === "overlay" && e.key === "Escape") setFull(false);
    };
    const overflow = document.body.style.overflow;
    if (full === "overlay") document.body.style.overflow = "hidden";
    document.addEventListener("fullscreenchange", onChange);
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener("fullscreenchange", onChange);
      window.removeEventListener("keydown", onKey);
    };
  }, [full]);

  const shape: FullShape = !full || size.w === 0 ? null : size.h > size.w * 0.7 ? (size.w < 640 ? "narrow" : "tall") : "wide";
  useEffect(() => {
    onFull?.(shape);
  }, [shape, onFull]);

  const toggleFull = () => {
    const el = wrap.current;
    if (!el) return;
    // Either way the view re-fits to the new size.
    touched.current = false;
    if (full) {
      if (full === "native" && document.fullscreenElement) void document.exitFullscreen();
      setFull(false);
      return;
    }
    if (document.fullscreenEnabled && el.requestFullscreen) el.requestFullscreen().then(() => setFull("native"), () => setFull("overlay"));
    else setFull("overlay");
  };

  const zoomCenter = (f: number) => {
    const r = wrap.current!.getBoundingClientRect();
    touched.current = true;
    setHint(null);
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
      className={`cv-root canvas-grid ${full === "overlay" ? "fixed inset-0 z-[100] h-[100dvh] w-screen" : "relative h-full w-full"} ${capture ? "touch-none" : "touch-pan-y"} overflow-hidden outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-signal/50 ${grabbing ? "cursor-grabbing" : "cursor-grab"}`}
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
          setHint(null);
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
          setHint(null);
          return;
        }
        if (e.button !== 0) return;
        // Embedded in a scrolling page, a finger scrolls the page; only a mouse drags the diagram.
        if (!capture && e.pointerType !== "mouse") return;
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
          setHint(null);
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
      onClick={() => {
        setHint(null);
        onBackgroundClick?.();
      }}
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

      {hint && (
        <div role="status" className="cv-hint pointer-events-none absolute left-1/2 top-16 z-10 -translate-x-1/2 whitespace-nowrap rounded-full bg-[#171717]/95 px-3.5 py-1.5 text-[12.5px] text-white shadow-lg ring-1 ring-white/10">
          {hint === "touch" ? "Drag to move · pinch to zoom · tap anything for details" : "Drag to move · scroll to zoom · click anything for details"}
        </div>
      )}
      <div data-overlay="zoom" className="font-sheet absolute bottom-4 right-4 flex items-center rounded-md border border-ink/15 bg-paper" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
        {controls}
        <IconBtn label="Zoom out" onClick={() => zoomCenter(1 / 1.25)}>
          <path d="M5 10h10" />
        </IconBtn>
        <button onClick={() => zoomCenter(1 / v.k)} className="h-8 w-12 border-x border-ink/15 text-center font-mono text-[11px] text-ink-soft hover:bg-ink/[0.05] hover:text-ink" title="Zoom to 100%" aria-label={`Zoom ${Math.round(v.k * 100)}%, reset to 100%`}>
          {Math.round(v.k * 100)}%
        </button>
        <IconBtn label="Zoom in" onClick={() => zoomCenter(1.25)}>
          <path d="M5 10h10M10 5v10" />
        </IconBtn>
        <span className="h-8 w-px bg-ink/15" />
        <IconBtn label="Fit to screen" onClick={() => fit()}>
          <path d="M3.5 5h13v10h-13zM7.5 8.5h5v3h-5z" />
        </IconBtn>
        <IconBtn label={full ? "Exit full screen" : "Full screen"} onClick={toggleFull}>
          <path d={full ? "M8 3v5H3M12 3v5h5M8 17v-5H3M12 17v-5h5" : "M3 8V3h5M17 8V3h-5M3 12v5h5M17 12v5h-5"} />
        </IconBtn>
      </div>
    </div>
  );
}

function IconBtn({ children, label, onClick }: { children: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} title={label} aria-label={label} className="grid h-8 w-8 place-items-center text-ink hover:bg-ink/[0.05]">
      <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="square">
        {children}
      </svg>
    </button>
  );
}
