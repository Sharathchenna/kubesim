"use client";

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Namespace, Node, Pod, Service } from "@/lib/engine";
import { SYSTEM_NAMESPACES } from "@/lib/engine/bootstrap";
import type { SimStore } from "@/lib/sim/useSimulation";
import { podCategory } from "@/lib/sim/status";
import { explainEvent, isNarrated } from "@/lib/sim/explain";
import { age } from "@/lib/sim/status";
import { ClusterView, type Selection } from "./ClusterView";
import { CommandLog, EventsTable, ResourceTable } from "./Inspector";
import { Terminal } from "./Terminal";
import { ClusterText } from "./ClusterText";
import { Editor } from "./Editor";
import { DragProvider, Palette } from "./DragLayer";
import { Dot, Segmented, clock } from "../ui";
import { getItem, setItem } from "../learn/progress";

const SPEEDS = [1, 5, 30, 60];

/** Speed picker: one compact button that opens the choices. */
function SpeedMenu({ sim }: { sim: SimStore }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as globalThis.Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", close);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={`Simulation speed, ${sim.speed}×`}
        title="Simulation speed"
        className="flex h-8 items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 font-mono text-[12.5px] font-medium tabular-nums text-slate-700 shadow-[0_1px_1px_rgba(15,23,42,.04)] hover:bg-slate-50"
      >
        {sim.speed}×
        <svg viewBox="0 0 16 16" className={`h-3 w-3 text-slate-500 transition ${open ? "rotate-180" : ""}`} fill="none" stroke="currentColor" strokeWidth={1.8}>
          <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div role="group" aria-label="Simulation speed" className="absolute left-0 top-full z-50 mt-1.5 flex w-44 flex-col rounded-xl border border-slate-200 bg-white p-1 shadow-[0_8px_24px_rgba(15,23,42,.12)]">
          {SPEEDS.map((sp) => (
            <button
              key={sp}
              onClick={() => {
                sim.setSpeed(sp);
                setOpen(false);
              }}
              aria-pressed={sim.speed === sp}
              className={`flex items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-[12.5px] hover:bg-slate-50 ${sim.speed === sp ? "font-semibold text-slate-900" : "text-slate-600"}`}
            >
              <span className="font-mono tabular-nums">{sp}×</span>
              <span className="text-[11px] font-normal text-slate-500">{sp === 1 ? "real time" : sp === 5 ? "skip waits" : sp === 30 ? "fast" : "fastest"}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export type DockTab = "terminal" | "editor" | "resources" | "events" | "commands";
/** On small screens only one of these is shown at a time. */
export type MobileView = "canvas" | "dock";

export function SimControls({ sim }: { sim: SimStore }) {
  const c = sim.cluster;
  if (!c) return null;
  return (
    <>
      <button onClick={() => sim.setPaused(!sim.paused)} className="grid h-8 w-8 place-items-center rounded-lg border border-slate-200 bg-white text-slate-700 shadow-[0_1px_1px_rgba(15,23,42,.04)] hover:bg-slate-50" title={sim.paused ? "Resume" : "Pause"} aria-label={sim.paused ? "Resume simulation" : "Pause simulation"}>
        {sim.paused ? (
          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="currentColor"><path d="M4 2.5v11l9-5.5z" /></svg>
        ) : (
          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="currentColor"><rect x="3.5" y="2.5" width="3" height="11" rx="1" /><rect x="9.5" y="2.5" width="3" height="11" rx="1" /></svg>
        )}
      </button>
      <div className="hidden sm:block">
        <SpeedMenu sim={sim} />
      </div>
      <div className="flex items-center gap-2 font-mono text-[13px] tabular-nums text-slate-700" title="Simulated time">
        <span className={`h-1.5 w-1.5 rounded-full ${sim.paused ? "bg-slate-300" : "bg-green-500"}`} />
        {clock(c.now)}
      </div>
      {sim.crashed && (
        <div role="alert" className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-2.5 py-1 text-[12px] text-red-800" title={sim.crashed}>
          Something went wrong in the simulator, not in your commands.
          <button onClick={() => sim.reset()} className="font-medium underline underline-offset-2 hover:text-red-950" title="Rebuild this cluster from the beginning. Your other Lessons and Challenges keep their progress.">
            Start over
          </button>
        </div>
      )}
    </>
  );
}

const SAFE_TIP_KEY = "kubesim.tip.safe-to-break.v1";
const tipListeners = new Set<() => void>();

/** One-time, dismissible "you can't break anything" note, remembered on this device. */
function SafeTip({ className = "" }: { className?: string }) {
  const dismissed = useSyncExternalStore(
    (fn) => {
      tipListeners.add(fn);
      window.addEventListener("storage", fn);
      return () => {
        tipListeners.delete(fn);
        window.removeEventListener("storage", fn);
      };
    },
    () => getItem(SAFE_TIP_KEY) === "1",
    () => true,
  );
  if (dismissed) return null;
  return (
    <div
      role="note"
      data-overlay="tip"
      className={`pointer-events-auto flex min-w-0 items-start gap-2 rounded-lg border border-blue-100 bg-blue-50/95 px-2.5 py-1 text-[12px] leading-snug text-blue-900 shadow-[0_1px_2px_rgba(15,23,42,.04)] backdrop-blur ${className}`}
    >
      <span className="min-w-0 flex-1">Safe to break things: Start over rebuilds the cluster.</span>
      <button
        onClick={() => {
          setItem(SAFE_TIP_KEY, "1");
          tipListeners.forEach((l) => l());
        }}
        className="-my-1 grid h-6 w-6 shrink-0 place-items-center rounded text-blue-500 hover:text-blue-800"
        aria-label="Dismiss tip"
      >
        ×
      </button>
    </div>
  );
}

/** Width of an element, tracked as it resizes (0 until measured). */
function useWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.getBoundingClientRect().width);
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

/** Canvas overlay geometry, in px. Kept in one place so overlays and the zoom-to-fit agree. */
const PALETTE_W = 200;
const EDGE = 16;
/** Left edge of the overlays that sit beside the palette. */
const BESIDE_PALETTE = EDGE + PALETTE_W + 12;
/** Clear of the zoom controls (bottom-right). */
const ZOOM_W = 176;

interface Props {
  sim: SimStore;
  selection: Selection;
  onSelect: (s: Selection) => void;
  showSystem?: boolean;
  tabs?: DockTab[];
  initialTab?: DockTab;
  /** Extra overlay on the canvas. */
  overlay?: React.ReactNode;
  narration?: boolean;
  dockHeight?: string;
  mobileView?: MobileView;
  /** Allow drag-and-drop on the canvas (off for Explainers). */
  interactive?: boolean;
  /** Show the drag-to-create palette. */
  palette?: boolean;
  /** Show the one-time "safe to break things" tip. Defaults to on for hands-on views with narration (Sandbox, Lessons, Challenges), off for Explainers and exams. */
  reassure?: boolean;
}

export function Workspace({ sim, selection, onSelect, showSystem = false, tabs = ["terminal", "editor", "resources", "events", "commands"], initialTab, overlay, narration = true, dockHeight = "h-[min(18rem,42%)]", mobileView = "canvas", interactive = true, palette = false, reassure = interactive && narration }: Props) {
  const [tab, setTab] = useState<DockTab>(initialTab ?? tabs[0]);
  const [open, setOpen] = useState(tabs.length > 0);
  const [textView, setTextView] = useState(false);
  const canvasRef = useRef<HTMLDivElement>(null);
  const canvasW = useWidth(canvasRef);
  /** A narrow canvas (phones) can't spare a column for the palette: it starts collapsed and floats over the diagram. */
  const wide = canvasW >= 640;
  const [paletteChoice, setPaletteChoice] = useState<boolean | null>(null);
  const paletteOpen = palette && (paletteChoice ?? wide);
  const paletteColumn = paletteOpen && wide;
  // Follow requests from the store (kubectl edit, "Open in editor", "Run").
  const [seen, setSeen] = useState({ edit: sim.editSeq, term: sim.termSeq });
  if (seen.edit !== sim.editSeq || seen.term !== sim.termSeq) {
    const want: DockTab | null = seen.edit !== sim.editSeq ? "editor" : "terminal";
    setSeen({ edit: sim.editSeq, term: sim.termSeq });
    if (want && tabs.includes(want)) {
      setTab(want);
      setOpen(true);
    }
  }

  const c = sim.cluster!;
  const ns = sim.viewNs;
  // An empty terminal doesn't need 40% of the screen: start short, grow on first output.
  const idleDock = tab === "terminal" && sim.term.length === 0;
  const inView = (n?: string) => (ns === "*" ? showSystem || !SYSTEM_NAMESPACES.has(n ?? "") : n === ns);
  const events = sim.events.filter((e) => inView(e.metadata.namespace));
  const pods = c.list<Pod>("Pod").filter((p) => inView(p.metadata.namespace));
  const readyPods = pods.filter((p) => podCategory(p) === "ok").length;
  const svcs = c.list<Service>("Service").filter((s) => inView(s.metadata.namespace) && s.metadata.name !== "kubernetes");
  const nodes = c.list<Node>("Node");
  const readyNodes = nodes.filter((n) => c.nodeReady(n) && c.state.nodes[n.metadata.name]?.up).length;
  const namespaces = c.list<Namespace>("Namespace").map((n) => n.metadata.name).filter((n) => showSystem || !SYSTEM_NAMESPACES.has(n));
  const story = sim.events.filter((e) => isNarrated(e) && inView(e.metadata.namespace)).slice(0, 1);
  // Overlays share two rows (top: summary + narration, bottom: Text view + tip) so they never stack over the diagram;
  // the zoom-to-fit keeps the diagram clear of both rows and of the palette column.
  const topLeft = palette ? BESIDE_PALETTE : EDGE;
  const bottomLeft = paletteColumn ? BESIDE_PALETTE : EDGE;
  const summaryW = 300 + (namespaces.length > 1 ? 150 : 0);
  const showStory = narration && story.length > 0 && canvasW - topLeft - summaryW - EDGE >= 260;
  const inset = { top: 52, bottom: 60, left: paletteColumn ? BESIDE_PALETTE - 12 : 0 };
  // Phones stack the Nodes so fit-to-screen can show all of them at a readable size.
  const perRow = canvasW > 0 && canvasW < 560 ? 1 : 4;
  const labels: Record<DockTab, React.ReactNode> = {
    terminal: "Terminal",
    editor: "YAML editor",
    resources: "Resources",
    events: (
      <>
        Events <span className="text-slate-500">{events.length}</span>
      </>
    ),
    commands: "Commands",
  };

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div ref={canvasRef} className={`relative min-h-0 flex-1 overflow-hidden ${mobileView === "dock" ? "max-lg:hidden" : ""}`}>
        {interactive ? (
          <DragProvider sim={sim}>
            <ClusterView cluster={c} packets={sim.packets} slots={sim.slots} now={sim.frameNow} selection={selection} onSelect={onSelect} showSystem={showSystem} namespace={ns} inset={inset} perRow={perRow} />
            {palette && <Palette open={paletteOpen} onToggle={() => setPaletteChoice(!paletteOpen)} width={PALETTE_W} floating={!wide} />}
          </DragProvider>
        ) : (
          <ClusterView cluster={c} packets={sim.packets} slots={sim.slots} now={sim.frameNow} selection={selection} onSelect={onSelect} showSystem={showSystem} namespace={ns} inset={inset} perRow={perRow} />
        )}

        <div className="pointer-events-none absolute top-3 z-10 hidden items-center gap-2 md:flex" style={{ left: topLeft, right: EDGE }}>
          <div className="flex shrink-0 items-center gap-3 rounded-lg border border-slate-200/80 bg-white/90 px-3 py-1.5 text-[12px] text-slate-500 shadow-[0_1px_2px_rgba(15,23,42,.04)] backdrop-blur" aria-label="Cluster summary" data-overlay="summary">
            {[
              [`${readyNodes}/${nodes.length}`, "nodes", readyNodes === nodes.length ? "#16a34a" : "#f59e0b"],
              [`${readyPods}/${pods.length}`, "pods ready", readyPods === pods.length ? "#16a34a" : "#f59e0b"],
              [String(svcs.length), svcs.length === 1 ? "service" : "services", "#2563eb"],
            ].map(([v, k, col]) => (
              <span key={k} className="flex items-center gap-1.5 whitespace-nowrap">
                <Dot color={col} />
                <span className="font-mono font-medium tabular-nums text-slate-900">{v}</span>
                {k}
              </span>
            ))}
          </div>
          {namespaces.length > 1 && (
            <label className="pointer-events-auto flex shrink-0 items-center gap-1.5 rounded-lg border border-slate-200/80 bg-white/90 px-3 py-1.5 text-[12px] text-slate-500 shadow-[0_1px_2px_rgba(15,23,42,.04)] backdrop-blur">
              namespace
              <select value={ns} onChange={(e) => sim.setViewNs(e.target.value)} className="bg-transparent font-mono text-[12px] font-medium text-slate-900 outline-none" aria-label="Namespace shown on the canvas">
                <option value="*">all</option>
                {namespaces.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
          )}
          {showStory && (
            <div data-overlay="narration" className="ml-auto flex min-w-0 max-w-[460px] flex-1 items-center gap-2 rounded-lg border border-slate-200/80 bg-white/95 px-3 py-1.5 text-[12px] shadow-[0_1px_2px_rgba(15,23,42,.04)] backdrop-blur" title={explainEvent(story[0])}>
              <span className="shrink-0 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-slate-500">Just now</span>
              <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: story[0].type === "Warning" ? "#f59e0b" : "#94a3b8" }} />
              <span className="min-w-0 truncate text-slate-700">{explainEvent(story[0])}</span>
              <span className="ml-auto shrink-0 font-mono text-[10.5px] text-slate-500">{age(c.now - story[0].lastTimestamp)}</span>
            </div>
          )}
        </div>

        <div className="pointer-events-none absolute bottom-4 z-10 flex items-end gap-2" style={{ left: bottomLeft, maxWidth: `calc(100% - ${bottomLeft + ZOOM_W}px)` }}>
          <button
            onClick={() => setTextView(!textView)}
            aria-pressed={textView}
            data-overlay="text-view"
            className="pointer-events-auto shrink-0 rounded-lg border border-slate-200 bg-white/95 px-2.5 py-1 text-[11.5px] font-medium text-slate-600 shadow-[0_1px_2px_rgba(15,23,42,.04)] hover:bg-slate-50"
          >
            {textView ? "Diagram view" : "Text view"}
          </button>
          {reassure && <SafeTip className="max-w-[340px] max-md:hidden" />}
        </div>
        {/* Phones: the bottom row is full, so the tip sits under the top-left controls. */}
        {reassure && <SafeTip className={`absolute right-3 top-3 z-10 md:hidden ${palette ? "max-w-[calc(100%-168px)]" : "left-3"}`} />}
        {textView && (
          <div className="absolute inset-y-0 right-0 z-20 w-full max-w-md border-l border-slate-200 bg-white shadow-[0_8px_24px_rgba(15,23,42,.08)]">
            <ClusterText c={c} namespace={ns} showSystem={showSystem} onSelect={onSelect} />
          </div>
        )}
        {narration && (
          <div className="sr-only" aria-live="polite">
            {story[0] ? explainEvent(story[0]) : ""}
          </div>
        )}
        {overlay}
      </div>

      {tabs.length > 0 && (
        <div className={`flex shrink-0 flex-col border-t border-slate-200/80 bg-white transition-[height] duration-300 ${open ? (idleDock ? "h-[26%] min-h-[150px]" : dockHeight) : "h-11"} ${mobileView === "canvas" ? "max-lg:hidden" : "max-lg:h-auto max-lg:flex-1"}`}>
          <div className="flex h-11 shrink-0 items-center gap-3 overflow-x-auto border-b border-slate-100 px-3">
            <Segmented
              value={tab}
              onChange={(v) => {
                setTab(v);
                setOpen(true);
              }}
              options={tabs.map((t) => ({ value: t, label: labels[t] }))}
            />
            <button onClick={() => setOpen(!open)} className="ml-auto hidden h-7 w-7 place-items-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-700 lg:grid" aria-label={open ? "Collapse panel" : "Expand panel"}>
              <svg viewBox="0 0 16 16" className={`h-4 w-4 transition ${open ? "" : "rotate-180"}`} fill="none" stroke="currentColor" strokeWidth={1.6}>
                <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>
          <div id="dock-panel" className={`min-h-0 flex-1 ${tab === "terminal" || tab === "editor" ? "" : "overflow-auto px-4 py-2"}`}>
            {tab === "terminal" && <Terminal sim={sim} />}
            {tab === "editor" && <Editor sim={sim} />}
            {tab === "commands" && <CommandLog log={sim.log} />}
            {tab === "resources" && <ResourceTable c={c} namespace={sim.viewNs === "*" ? sim.namespace : sim.viewNs} />}
            {tab === "events" && <EventsTable events={events} now={c.now} />}
          </div>
        </div>
      )}
    </main>
  );
}

/** Bottom tab bar for small screens. */
export function MobileTabs<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <nav className="flex shrink-0 border-t border-slate-200 bg-white lg:hidden" aria-label="Views">
      {options.map((o) => (
        <button key={o.value} onClick={() => onChange(o.value)} className={`flex-1 py-3 text-[13px] font-medium ${value === o.value ? "text-slate-900 shadow-[inset_0_2px_0_#0f172a]" : "text-slate-500"}`} aria-current={value === o.value ? "page" : undefined}>
          {o.label}
        </button>
      ))}
    </nav>
  );
}
