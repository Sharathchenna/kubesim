"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { canDrop, parseTarget, performDrop, type DragItem } from "@/lib/sim/drag";
import type { SimStore } from "@/lib/sim/useSimulation";

interface DragApi {
  /** Call from onPointerDown; the drag starts once the pointer moves a few px. */
  begin: (item: DragItem, e: React.PointerEvent) => void;
  dragging: DragItem | null;
  /** The data-drop string under the pointer, if it's a valid target. */
  over: string | null;
  /** True right after a drag ended, so the click that follows can be ignored. */
  justDropped: () => boolean;
}

const Ctx = createContext<DragApi | null>(null);
export const useDrag = () => useContext(Ctx);

const THRESHOLD = 5;

/** The drop target under the pointer. Elements are stacked (a Pod over its Node over the canvas), so pick the first valid one. */
function targetAt(x: number, y: number, item: DragItem): string | null {
  const seen: string[] = [];
  for (const el of document.elementsFromPoint(x, y)) {
    const v = (el as Element).closest?.("[data-drop]")?.getAttribute("data-drop");
    if (v && !seen.includes(v)) seen.push(v);
  }
  return seen.find((v) => canDrop(item, parseTarget(v))) ?? seen[0] ?? null;
}

export function DragProvider({ sim, children }: { sim: SimStore; children: React.ReactNode }) {
  const [dragging, setDragging] = useState<DragItem | null>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [over, setOver] = useState<string | null>(null);
  const [note, setNote] = useState<{ text: string; ok: boolean; id: number } | null>(null);
  const dropped = useRef(0);

  const begin = useCallback(
    (item: DragItem, e: React.PointerEvent) => {
      if (e.button !== 0) return;
      e.stopPropagation(); // don't pan the canvas
      const sx = e.clientX;
      const sy = e.clientY;
      let active = false;
      let lastOver: string | null = null;
      const move = (ev: PointerEvent) => {
        if (!active && Math.hypot(ev.clientX - sx, ev.clientY - sy) < THRESHOLD) return;
        if (!active) {
          active = true;
          setDragging(item);
          document.body.style.cursor = "grabbing";
        }
        setPos({ x: ev.clientX, y: ev.clientY });
        const raw = targetAt(ev.clientX, ev.clientY, item);
        lastOver = raw;
        setOver(canDrop(item, parseTarget(raw)) ? raw : null);
      };
      const up = (ev: PointerEvent) => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", cancel);
        document.body.style.cursor = "";
        if (!active) return;
        dropped.current = performance.now();
        const t = parseTarget(targetAt(ev.clientX, ev.clientY, item) ?? lastOver);
        setDragging(null);
        setOver(null);
        if (!t) return; // dropped outside the canvas: cancel quietly
        const r = performDrop(sim, item, t);
        setNote({ text: r.note, ok: r.ok, id: performance.now() });
      };
      const cancel = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", cancel);
        document.body.style.cursor = "";
        setDragging(null);
        setOver(null);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", cancel);
    },
    [sim],
  );

  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), 9000);
    return () => clearTimeout(t);
  }, [note]);

  useEffect(() => {
    if (!dragging) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && window.dispatchEvent(new PointerEvent("pointercancel"));
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [dragging]);

  const api: DragApi = { begin, dragging, over, justDropped: () => performance.now() - dropped.current < 250 };
  const isObject = dragging?.kind === "object";

  return (
    <Ctx.Provider value={api}>
      {children}
      {/* trash zone, only while dragging an existing object */}
      {isObject && (
        <div
          data-drop="trash"
          className={`absolute bottom-6 left-1/2 z-30 flex -translate-x-1/2 items-center gap-2 rounded-2xl border-2 border-dashed px-6 py-3 text-[13px] font-medium shadow-lg transition ${over === "trash" ? "scale-105 border-red-500 bg-red-50 text-red-700" : "border-slate-300 bg-white/95 text-slate-500"}`}
        >
          <svg viewBox="0 0 20 20" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 6h12M8 6V4h4v2M6 6l1 10h6l1-10" />
          </svg>
          Drop here to delete
        </div>
      )}
      {/* ghost following the pointer */}
      {dragging && (
        <div className="pointer-events-none fixed z-50 -translate-x-1/2 -translate-y-[130%]" style={{ left: pos.x, top: pos.y }}>
          <div className={`whitespace-nowrap rounded-lg border px-2.5 py-1 text-[12px] font-medium shadow-lg ${over ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 bg-white text-slate-700"}`}>
            {dragging.label}
            {over && <span className="ml-1.5 opacity-70">→ {describe(over)}</span>}
          </div>
        </div>
      )}
      {note && !dragging && (
        <div key={note.id} className="cv-fade absolute bottom-6 left-1/2 z-30 w-[min(560px,calc(100%-2rem))] -translate-x-1/2">
          <div className={`flex items-start gap-2.5 rounded-xl border px-3.5 py-2.5 text-[12.5px] leading-relaxed shadow-lg ${note.ok ? "border-slate-200 bg-white text-slate-700" : "border-amber-200 bg-amber-50 text-amber-900"}`} role="status">
            <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${note.ok ? "bg-green-500" : "bg-amber-500"}`} />
            <span className="min-w-0 flex-1">{note.text}</span>
            <button onClick={() => setNote(null)} className="shrink-0 text-slate-400 hover:text-slate-700" aria-label="Dismiss">
              ×
            </button>
          </div>
        </div>
      )}
    </Ctx.Provider>
  );
}

function describe(target: string): string {
  const t = parseTarget(target);
  if (!t) return "";
  if (t.type === "canvas") return "cluster";
  if (t.type === "trash") return "delete";
  return "name" in t ? t.name : "";
}

const PALETTE: { group: string; items: (DragItem & { hint: string; icon: React.ReactNode })[] }[] = [
  {
    group: "Create",
    items: [
      { kind: "palette", what: "deployment", image: "nginxdemos/hello:plain-text", label: "Deployment · hello", hint: "3 web Pods", icon: <path d="M3 3h5v5H3zM10 3h5v5h-5zM3 10h5v5H3zM10 10h5v5h-5z" /> },
      { kind: "palette", what: "deployment", image: "redis:7", label: "Deployment · redis", hint: "a database", icon: <path d="M3 3h5v5H3zM10 3h5v5h-5zM3 10h5v5H3zM10 10h5v5h-5z" /> },
      { kind: "palette", what: "pod", image: "nginx", label: "Pod · nginx", hint: "drop on a Node to pin", icon: <rect x="4" y="4" width="10" height="10" rx="2" /> },
      { kind: "palette", what: "service", label: "Service", hint: "drop on a Deployment", icon: <path d="M9 2.5a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 0 0 0-3.6zM4 12a1.8 1.8 0 1 0 0 3.6A1.8 1.8 0 0 0 4 12zm10 0a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 0 0 0-3.6zM9 6v3m0 0l-4 3m4-3l4 3" /> },
      { kind: "palette", what: "node", label: "Node", hint: "add a worker", icon: <path d="M3 4h12v4H3zM3 10h12v4H3z" /> },
    ],
  },
  {
    group: "Tools",
    items: [
      { kind: "tool", what: "chaos", label: "Chaos", hint: "kill a Node or Pod", icon: <path d="M10 2L4 10h4l-1 6 6-8H9z" /> },
      { kind: "tool", what: "cordon", label: "Cordon", hint: "stop new Pods on a Node", icon: <path d="M3 6h12v6H3zM5 6l3 6M9 6l3 6M13 6l2 4" /> },
    ],
  },
];

/** Draggable palette of things to add to the cluster. */
export function Palette() {
  const drag = useDrag();
  const [open, setOpen] = useState(true);
  if (!drag) return null;
  return (
    <div className="absolute bottom-4 left-4 top-[88px] z-20 flex flex-col max-md:left-2 max-md:top-4">
      <div className="flex max-h-full w-[176px] flex-col overflow-hidden rounded-xl border border-slate-200/80 bg-white/95 shadow-[0_1px_2px_rgba(15,23,42,.04),0_8px_24px_rgba(15,23,42,.06)] backdrop-blur">
        <button onClick={() => setOpen(!open)} className="flex w-full items-center justify-between px-3 py-2 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-slate-400 hover:text-slate-600" aria-expanded={open}>
          Drag to add
          <svg viewBox="0 0 16 16" className={`h-3.5 w-3.5 transition ${open ? "" : "-rotate-90"}`} fill="none" stroke="currentColor" strokeWidth={1.6}>
            <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        {open && (
          <div className="flex min-h-0 flex-col gap-2 overflow-y-auto px-2 pb-2">
            {PALETTE.map((g) => (
              <div key={g.group}>
                <div className="px-1 pb-1 text-[10px] font-medium text-slate-400">{g.group}</div>
                <div className="flex flex-col gap-1">
                  {g.items.map((it) => (
                    <div
                      key={it.label}
                      onPointerDown={(e) => drag.begin(it, e)}
                      className={`group flex cursor-grab touch-none select-none items-center gap-2 rounded-lg border px-2 py-1.5 transition active:cursor-grabbing ${drag.dragging?.label === it.label ? "border-slate-900 bg-slate-50" : "border-slate-200 bg-white hover:border-slate-300 hover:shadow-[0_1px_3px_rgba(15,23,42,.08)]"}`}
                      title={`Drag: ${it.hint}`}
                    >
                      <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-md ${it.kind === "tool" ? (it.what === "chaos" ? "bg-red-50 text-red-600" : "bg-amber-50 text-amber-600") : "bg-slate-100 text-slate-600"}`}>
                        <svg viewBox="0 0 18 18" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
                          {it.icon}
                        </svg>
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-[12px] font-medium text-slate-800">{it.label}</span>
                        <span className="block truncate text-[10.5px] text-slate-400">{it.hint}</span>
                      </span>
                      <svg viewBox="0 0 10 16" className="ml-auto h-3 w-2 shrink-0 text-slate-300 group-hover:text-slate-400" fill="currentColor">
                        <circle cx="2" cy="3" r="1.2" /><circle cx="8" cy="3" r="1.2" /><circle cx="2" cy="8" r="1.2" /><circle cx="8" cy="8" r="1.2" /><circle cx="2" cy="13" r="1.2" /><circle cx="8" cy="13" r="1.2" />
                      </svg>
                    </div>
                  ))}
                </div>
              </div>
            ))}
            <p className="px-1 text-[10.5px] leading-snug text-slate-400">You can also drag Pods, Deployments and Services already on the canvas.</p>
          </div>
        )}
      </div>
    </div>
  );
}
