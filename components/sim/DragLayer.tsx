"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { BLUEPRINTS, type BlueprintGroup } from "@/lib/sim/blueprints";
import { canDrop, parseTarget, performDrop, type DragItem, type Target } from "@/lib/sim/drag";
import { podChoices, type PodChoice, type PodChoiceGroup } from "@/lib/sim/podChoices";
import type { Cluster } from "@/lib/engine";
import type { SimStore } from "@/lib/sim/useSimulation";

/** A card being moved on the canvas while it's dragged: told how far the pointer has gone (screen px), then whether to keep the move. */
export type MoveCallback = (dx: number, dy: number, phase: "move" | "commit" | "cancel") => void;

interface DragApi {
  /**
   * Call from onPointerDown; the drag starts once the pointer moves a few px. With `onMove`, the object
   * itself moves with the pointer (no ghost) and is kept where it's let go, unless it's dropped on a
   * target it does something to (a Deployment, the trash): then that happens instead and the move is undone.
   */
  begin: (item: DragItem, e: React.PointerEvent, onMove?: MoveCallback) => void;
  dragging: DragItem | null;
  /** The data-drop string under the pointer, if it's a valid target. */
  over: string | null;
  /** True right after a drag ended, so the click that follows can be ignored. */
  justDropped: () => boolean;
  /** Adds an item to the cluster without dragging (a click, or Enter). */
  add: (item: DragItem) => void;
  /** Deletes an object without dragging (the Delete key), as if it were dropped on the trash. */
  remove: (item: DragItem) => void;
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
  /** The object is moving with the pointer itself: no ghost unless it's over something it can be dropped on. */
  const [moving, setMoving] = useState(false);
  const [note, setNote] = useState<{ text: string; ok: boolean; id: number; file?: string } | null>(null);
  /** Adding a Pod asks what it should run first; `node` is where it was dropped. */
  const [choosing, setChoosing] = useState<{ node?: string } | null>(null);
  const dropped = useRef(0);
  /** performDrop, except a new Pod opens the chooser instead of making an nginx. */
  const perform = useCallback(
    (item: DragItem, t: Target) => {
      if (item.kind === "palette" && item.what === "pod") return setChoosing({ node: t.type === "node" ? t.name : undefined });
      const r = performDrop(sim, item, t);
      setNote({ text: r.note, ok: r.ok, id: performance.now(), file: r.file });
    },
    [sim],
  );

  const begin = useCallback(
    (item: DragItem, e: React.PointerEvent, onMove?: MoveCallback) => {
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
          setMoving(!!onMove);
          document.body.style.cursor = "grabbing";
        }
        setPos({ x: ev.clientX, y: ev.clientY });
        onMove?.(ev.clientX - sx, ev.clientY - sy, "move");
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
        setMoving(false);
        if (onMove) {
          // Moving: only a drop on something it acts on (not the canvas) does more than move it.
          const acts = !!t && t.type !== "canvas" && canDrop(item, t);
          onMove(ev.clientX - sx, ev.clientY - sy, acts ? "cancel" : "commit");
          if (!acts) return;
        }
        if (!t) return; // dropped outside the canvas: cancel quietly
        perform(item, t);
      };
      const cancel = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", cancel);
        document.body.style.cursor = "";
        setDragging(null);
        setOver(null);
        setMoving(false);
        if (active) onMove?.(0, 0, "cancel");
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", cancel);
    },
    [perform],
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

  const add = useCallback((item: DragItem) => perform(item, { type: "canvas" }), [perform]);

  const remove = useCallback(
    (item: DragItem) => {
      const r = performDrop(sim, item, { type: "trash" });
      setNote({ text: r.note, ok: r.ok, id: performance.now() });
    },
    [sim],
  );

  const api: DragApi = { begin, dragging, over, justDropped: () => performance.now() - dropped.current < 250, add, remove };
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
      {dragging && (!moving || over) && (
        <div className="pointer-events-none fixed z-50 -translate-x-1/2 -translate-y-[130%]" style={{ left: pos.x, top: pos.y }}>
          <div className={`whitespace-nowrap rounded-lg border px-2.5 py-1 text-[12.5px] ${over ? "border-signal bg-signal text-white" : "border-dashed border-ink bg-paper text-ink"}`}>
            {dragging.label}
            {over && <span className="ml-1.5 opacity-70">→ {describe(over)}</span>}
          </div>
        </div>
      )}
      {choosing && sim.cluster && (
        <PodChooser
          c={sim.cluster}
          node={choosing.node}
          onClose={() => setChoosing(null)}
          onPick={(ch) => {
            setChoosing(null);
            const r = sim.exec(ch.cmd);
            setNote({ text: r?.ok ? ch.note : (r?.out ?? "The cluster isn't running."), ok: !!r?.ok, id: performance.now() });
          }}
        />
      )}
      {note && !dragging && (
        <div key={note.id} className="cv-fade absolute bottom-6 left-1/2 z-30 w-[min(560px,calc(100%-2rem))] -translate-x-1/2">
          <div className={`flex items-start gap-2.5 px-3.5 py-2.5 text-[12.5px] leading-relaxed ${note.ok ? "rounded-xl border border-ink/10 bg-paper text-ink" : "border border-amber-600/40 bg-amber-50 text-amber-900"}`} role="status">
            <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${note.ok ? "bg-green-700" : "bg-amber-700"}`} />
            <span className="min-w-0 flex-1">
              {note.text}
              {note.ok && note.file && (
                <button onClick={() => (sim.openFile(note.file!), setNote(null))} className="ml-1.5 font-medium text-signal underline-offset-2 hover:underline">
                  Open {note.file} →
                </button>
              )}
            </span>
            <button onClick={() => setNote(null)} className="-my-1 grid h-6 w-6 shrink-0 place-items-center text-ink-soft hover:bg-ink/[0.05] hover:text-ink" aria-label="Dismiss">
              ×
            </button>
          </div>
        </div>
      )}
    </Ctx.Provider>
  );
}

const GROUPS: PodChoiceGroup[] = ["More of what's running", "Tools", "Break something"];

/** "What should this Pod run?": choices from the cluster as it is, each shown as the kubectl it runs. */
function PodChooser({ c, node, onClose, onPick }: { c: Cluster; node?: string; onClose: () => void; onPick: (ch: PodChoice) => void }) {
  const choices = podChoices(c, node);
  const [focus, setFocus] = useState<string | undefined>(undefined);
  const shown = choices.find((x) => x.id === focus) ?? choices[0];
  return (
    <div className="absolute inset-0 z-40 grid place-items-center bg-ink/20 p-4" onPointerDown={(e) => e.target === e.currentTarget && onClose()} onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), onClose())}>
      <div role="dialog" aria-modal="true" aria-label="What should this Pod run?" className="flex max-h-full w-[min(540px,100%)] flex-col overflow-hidden rounded-xl border border-ink/15 bg-paper text-ink shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-ink/15 px-4 py-3">
          <div>
            <div className="text-[15px] font-medium">What should this Pod run?</div>
            <div className="mt-0.5 text-[12.5px] text-ink-soft">{node ? `You dropped it on ${node}. Bare Pods are pinned there; replicas go where the scheduler puts them.` : "Drop it on a Node to pin it there; otherwise the scheduler picks."}</div>
          </div>
          <button onClick={onClose} aria-label="Close" className="-mr-1 grid h-7 w-7 shrink-0 place-items-center rounded-md text-ink-soft hover:bg-ink/[0.05] hover:text-ink">
            ×
          </button>
        </div>
        <div className="min-h-0 overflow-y-auto">
          {GROUPS.map((g) => {
            const items = choices.filter((x) => x.group === g);
            if (!items.length) return null;
            return (
              <div key={g}>
                <div className="px-4 pb-1 pt-3 text-[11px] font-medium uppercase tracking-[0.06em] text-ink-soft">{g}</div>
                {items.map((ch, i) => (
                  <button
                    key={ch.id}
                    autoFocus={ch === choices[0] && i === 0}
                    onClick={() => onPick(ch)}
                    onMouseEnter={() => setFocus(ch.id)}
                    onFocus={() => setFocus(ch.id)}
                    className={`flex w-full items-baseline justify-between gap-3 px-4 py-2 text-left outline-none transition-colors ${shown?.id === ch.id ? "bg-signal-soft" : "hover:bg-ink/[0.04]"}`}
                  >
                    <span className="text-[13.5px] font-medium">{ch.label}</span>
                    <span className="truncate text-[12px] text-ink-soft">{ch.hint}</span>
                  </button>
                ))}
              </div>
            );
          })}
        </div>
        {shown && <code className="block border-t border-ink/15 bg-ink/[0.03] px-4 py-2.5 font-mono text-[11.5px] leading-snug text-ink-soft [overflow-wrap:anywhere]">$ {shown.cmd}</code>}
      </div>
    </div>
  );
}

function describe(target: string): string {
  const t = parseTarget(target);
  if (!t) return "";
  if (t.type === "canvas") return "cluster";
  if (t.type === "trash") return "delete";
  return "name" in t ? t.name : "";
}

const ICON: Record<string, React.ReactNode> = {
  load: <path d="M2 6h8m-2.5-2.5L10 6 7.5 8.5M2 12h8m-2.5-2.5L10 12l-2.5 2.5M13 3v12" />,
  ingress: <path d="M9 2a7 7 0 1 0 0 14A7 7 0 0 0 9 2zM2 9h14M9 2c1.9 2 2.8 4.4 2.8 7S10.9 14 9 16c-1.9-2-2.8-4.4-2.8-7S7.1 4 9 2z" />,
  web: <path d="M2.5 3.5h13v11h-13zM2.5 6.5h13M4.5 5h.01M6.5 5h.01" />,
  api: <path d="M6.5 3C4.5 3 5 6 4.5 7.5S2.5 9 2.5 9s1.5 0 2 1.5S4.5 15 6.5 15M11.5 3c2 0 1.5 3 2 4.5s2 1.5 2 1.5-1.5 0-2 1.5.5 4.5-2 4.5" />,
  autoscale: <path d="M3 15v-3M7 15V9M11 15V6M15 15V3M12.5 3H15v2.5" />,
  worker: <path d="M9 6a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM9 2v2M9 14v2M2 9h2M14 9h2M4 4l1.4 1.4M12.6 12.6 14 14M4 14l1.4-1.4M12.6 5.4 14 4" />,
  cron: <path d="M9 2.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM9 5.5V9l2.5 1.5" />,
  postgres: <path d="M3 4.5C3 3.1 5.7 2 9 2s6 1.1 6 2.5S12.3 7 9 7 3 5.9 3 4.5zm0 0v9C3 14.9 5.7 16 9 16s6-1.1 6-2.5v-9M3 9c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5" />,
  redis: <path d="M9 3l6 3-6 3-6-3zM3 9.5l6 3 6-3M3 12.5l6 3 6-3" />,
  stack: <path d="M9 2l7 3.5L9 9 2 5.5zM2 9l7 3.5L16 9M2 12.5 9 16l7-3.5" />,
};
ICON.mysql = ICON.postgres;

type PaletteEntry = DragItem & { hint: string; icon: React.ReactNode };

// Labels and hints wrap rather than truncate; keep them short so each stays on one line at the palette width.
const BLUEPRINT_GROUPS: BlueprintGroup[] = ["Traffic", "Compute", "Data", "Stacks"];
const PALETTE: { group: string; items: PaletteEntry[] }[] = [
  ...BLUEPRINT_GROUPS.map((group) => ({
    group,
    items: BLUEPRINTS.filter((b) => b.group === group).map((b): PaletteEntry => ({ kind: "blueprint", id: b.id, label: b.label, hint: b.hint, icon: ICON[b.id] })),
  })),
  {
    group: "Basics",
    items: [
      { kind: "palette", what: "deployment", image: "nginxdemos/hello:plain-text", label: "Deployment", hint: "3 Pods, nothing else", icon: <path d="M3 3h5v5H3zM10 3h5v5h-5zM3 10h5v5H3zM10 10h5v5h-5z" /> },
      { kind: "palette", what: "pod", image: "nginx", label: "Pod", hint: "choose what it runs", icon: <rect x="4" y="4" width="10" height="10" /> },
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

/** Palette of things to add to the cluster: drag onto the canvas, or click. Open/closed state is owned by the Workspace, which also keeps the diagram clear of it. */
export function Palette({ open, onToggle, width, floating }: { open: boolean; onToggle: () => void; width: number; /** Narrow canvas: float over the diagram, clear of the bottom controls. */ floating?: boolean }) {
  const drag = useDrag();
  const [query, setQuery] = useState("");
  if (!drag) return null;
  const q = query.trim().toLowerCase();
  const groups = PALETTE.map((g) => ({ ...g, items: g.items.filter((it) => !q || `${g.group} ${it.label} ${it.hint}`.toLowerCase().includes(q)) })).filter((g) => g.items.length);
  const add = (it: PaletteEntry) => {
    if (!drag.justDropped()) drag.add(it);
  };
  return (
    <div className={`pointer-events-none absolute left-4 top-3 z-20 flex flex-col ${floating ? "bottom-16" : "bottom-4"}`}>
      <div data-overlay="palette" className={`pointer-events-auto flex max-h-full flex-col overflow-hidden rounded-xl border border-ink/10 bg-paper text-ink ${open ? "" : "self-start"}`} style={{ width: open ? width : undefined }}>
        <button onClick={onToggle} className={`flex shrink-0 items-center gap-2 text-[12.5px] transition-colors hover:bg-ink/[0.04] ${open ? "w-full justify-between border-b border-ink/15 px-3 py-1.5 text-ink-soft hover:text-ink" : "h-8 px-2.5 font-medium"}`} aria-expanded={open} aria-label="Add to the cluster">
          {open ? (
            <>
              Add to the cluster
              <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={1.6} aria-hidden="true">
                <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </>
          ) : (
            <span aria-hidden="true">+ Add</span>
          )}
        </button>
        {open && (
          <>
            <div className="shrink-0 border-b border-ink/15 p-2">
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search: database, api…" aria-label="Search things to add" className="w-full rounded-md border border-ink/15 bg-paper px-2 py-1 text-[12.5px] outline-none placeholder:text-ink-soft focus:border-signal" />
            </div>
            <div className="flex min-h-0 flex-col overflow-y-auto">
              {groups.map((g) => (
                <div key={g.group}>
                  <div className="border-b border-ink/15 px-3 pb-1 pt-2 text-[11px] font-medium uppercase tracking-[0.06em] text-ink-soft">{g.group}</div>
                  <div className="flex flex-col [&>*]:border-b [&>*]:border-ink/15">
                    {g.items.map((it) => (
                      <div
                        key={it.label}
                        role="button"
                        tabIndex={0}
                        data-palette-item
                        onPointerDown={(e) => drag.begin(it, e)}
                        onClick={() => add(it)}
                        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), add(it))}
                        className={`flex cursor-grab touch-none select-none items-start gap-2 px-3 py-1.5 outline-none transition-colors focus-visible:bg-signal-soft active:cursor-grabbing ${drag.dragging?.label === it.label ? "bg-ink/[0.07]" : "hover:bg-ink/[0.04]"}`}
                        title={`${it.label}: ${it.hint}. Drag it in, or click to add.`}
                      >
                        <svg viewBox="0 0 18 18" className="mt-px h-3.5 w-3.5 shrink-0 text-signal" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
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
              {!groups.length && <p className="px-3 py-3 text-[12px] text-ink-soft">Nothing matches “{query}”.</p>}
              <p className="px-3 py-2 text-[11px] leading-snug text-ink-soft">Everything here is a real manifest: it opens in the Editor as a file you can change and apply again. You can also drag Pods, Deployments and Services already on the canvas.</p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
