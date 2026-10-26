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
          className={`absolute bottom-6 left-1/2 z-30 flex -translate-x-1/2 items-center gap-2 border-[1.5px] border-dashed px-6 py-3 text-[13px] transition-colors ${over === "trash" ? "border-red-700 bg-red-50 text-red-700" : "border-ink/50 bg-paper text-ink-soft"}`}
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
          <div className={`whitespace-nowrap border-[1.5px] px-2.5 py-1 text-[12.5px] ${over ? "border-ink bg-ink text-paper" : "border-dashed border-ink bg-paper text-ink"}`}>
            {dragging.label}
            {over && <span className="ml-1.5 opacity-70">→ {describe(over)}</span>}
          </div>
        </div>
      )}
      {note && !dragging && (
        <div key={note.id} className="cv-fade absolute bottom-6 left-1/2 z-30 w-[min(560px,calc(100%-2rem))] -translate-x-1/2">
          <div className={`flex items-start gap-2.5 px-3.5 py-2.5 text-[12.5px] leading-relaxed ${note.ok ? "border-[1.5px] border-ink bg-paper text-ink" : "border border-amber-600/40 bg-amber-50 text-amber-900"}`} role="status">
            <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${note.ok ? "bg-green-700" : "bg-amber-700"}`} />
            <span className="min-w-0 flex-1">{note.text}</span>
            <button onClick={() => setNote(null)} className="-my-1 grid h-6 w-6 shrink-0 place-items-center text-ink-soft hover:bg-ink/[0.05] hover:text-ink" aria-label="Dismiss">
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

// Labels and hints wrap rather than truncate; keep them short so each stays on one line at the palette width.
const PALETTE: { group: string; items: (DragItem & { hint: string; icon: React.ReactNode })[] }[] = [
  {
    group: "Create",
    items: [
      { kind: "palette", what: "deployment", image: "nginxdemos/hello:plain-text", label: "Deployment · hello", hint: "3 web Pods", icon: <path d="M3 3h5v5H3zM10 3h5v5h-5zM3 10h5v5H3zM10 10h5v5h-5z" /> },
      { kind: "palette", what: "deployment", image: "redis:7", label: "Deployment · redis", hint: "a database", icon: <path d="M3 3h5v5H3zM10 3h5v5h-5zM3 10h5v5H3zM10 10h5v5h-5z" /> },
      { kind: "palette", what: "pod", image: "nginx", label: "Pod · nginx", hint: "drop on a Node to pin", icon: <rect x="4" y="4" width="10" height="10" /> },
      { kind: "palette", what: "service", label: "Service", hint: "drop on a Deployment", icon: <path d="M9 2.5a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 0 0 0-3.6zM4 12a1.8 1.8 0 1 0 0 3.6A1.8 1.8 0 0 0 4 12zm10 0a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 0 0 0-3.6zM9 6v3m0 0l-4 3m4-3l4 3" /> },
      { kind: "palette", what: "node", label: "Node", hint: "add a worker", icon: <path d="M3 4h12v4H3zM3 10h12v4H3z" /> },
    ],
  },
  {
    group: "Tools",
    items: [
      { kind: "tool", what: "chaos", label: "Chaos", hint: "kills a Node or Pod", icon: <path d="M10 2L4 10h4l-1 6 6-8H9z" /> },
      { kind: "tool", what: "cordon", label: "Cordon", hint: "stop new Pods on a Node", icon: <path d="M3 6h12v6H3zM5 6l3 6M9 6l3 6M13 6l2 4" /> },
    ],
  },
];

/** Draggable palette of things to add to the cluster. Open/closed state is owned by the Workspace, which also keeps the diagram clear of it. */
export function Palette({ open, onToggle, width, floating }: { open: boolean; onToggle: () => void; width: number; /** Narrow canvas: float over the diagram, clear of the bottom controls. */ floating?: boolean }) {
  const drag = useDrag();
  if (!drag) return null;
  return (
    <div className={`pointer-events-none absolute left-4 top-3 z-20 flex flex-col ${floating ? "bottom-16" : "bottom-4"}`}>
      <div data-overlay="palette" className={`pointer-events-auto flex max-h-full flex-col overflow-hidden border-[1.5px] border-ink bg-paper text-ink ${open ? "" : "self-start"}`} style={{ width: open ? width : undefined }}>
        <button onClick={onToggle} className={`flex shrink-0 items-center gap-2 text-[12.5px] transition-colors hover:bg-ink/[0.04] ${open ? "w-full justify-between border-b border-ink/15 px-3 py-1.5 text-ink-soft hover:text-ink" : "h-8 px-2.5 font-medium"}`} aria-expanded={open} aria-label="Drag to add">
          {open ? (
            <>
              Drag to add
              <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={1.6} aria-hidden="true">
                <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </>
          ) : (
            <span aria-hidden="true">+ Add</span>
          )}
        </button>
        {open && (
          <div className="flex min-h-0 flex-col overflow-y-auto">
            {PALETTE.map((g) => (
              <div key={g.group}>
                <div className="border-b border-ink/15 px-3 pb-1 pt-2 text-[12px] font-medium text-ink-soft">{g.group}</div>
                <div className="flex flex-col [&>*]:border-b [&>*]:border-ink/15">
                  {g.items.map((it) => (
                    <div
                      key={it.label}
                      data-palette-item
                      onPointerDown={(e) => drag.begin(it, e)}
                      className={`flex cursor-grab touch-none select-none items-start gap-2 px-3 py-1.5 transition-colors active:cursor-grabbing ${drag.dragging?.label === it.label ? "bg-ink/[0.07]" : "hover:bg-ink/[0.04]"}`}
                      title={`Drag ${it.label}: ${it.hint}`}
                    >
                      <svg viewBox="0 0 18 18" className="mt-px h-3.5 w-3.5 shrink-0 text-ink" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        {it.icon}
                      </svg>
                      <span className="min-w-0 flex-1">
                        <span className="block text-[12.5px] leading-tight">{it.label}</span>
                        <span className="block text-[11px] leading-tight text-ink-soft">{it.hint}</span>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
            <p className="px-3 py-2 text-[11px] leading-snug text-ink-soft">You can also drag Pods, Deployments and Services already on the canvas.</p>
          </div>
        )}
      </div>
    </div>
  );
}
