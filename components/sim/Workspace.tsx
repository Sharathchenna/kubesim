"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
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
import { Segmented, clock } from "../ui";

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
        className="flex h-8 items-center gap-1 border border-ink/30 bg-paper px-2.5 font-mono text-[12.5px] tabular-nums text-ink hover:border-ink"
      >
        {sim.speed}×
        <svg viewBox="0 0 16 16" className={`h-3 w-3 text-ink-soft transition ${open ? "rotate-180" : ""}`} fill="none" stroke="currentColor" strokeWidth={1.8}>
          <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div role="group" aria-label="Simulation speed" className="absolute left-0 top-full z-50 mt-1 flex w-44 flex-col border-[1.5px] border-ink bg-paper py-1">
          {SPEEDS.map((sp) => (
            <button
              key={sp}
              onClick={() => {
                sim.setSpeed(sp);
                setOpen(false);
              }}
              aria-pressed={sim.speed === sp}
              className={`flex items-center justify-between px-3 py-1.5 text-left text-[13px] hover:bg-ink/[0.05] ${sim.speed === sp ? "text-ink underline underline-offset-4" : "text-ink-soft"}`}
            >
              <span className="font-mono tabular-nums">{sp}×</span>
              <span className="text-[12px] text-ink-soft">{sp === 1 ? "real time" : sp === 5 ? "skip waits" : sp === 30 ? "fast" : "fastest"}</span>
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
      <button onClick={() => sim.setPaused(!sim.paused)} className="grid h-8 w-8 place-items-center border border-ink/30 bg-paper text-ink hover:border-ink" title={sim.paused ? "Resume" : "Pause"} aria-label={sim.paused ? "Resume simulation" : "Pause simulation"}>
        {sim.paused ? (
          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="currentColor"><path d="M4 2.5v11l9-5.5z" /></svg>
        ) : (
          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="currentColor"><rect x="3.5" y="2.5" width="3" height="11" /><rect x="9.5" y="2.5" width="3" height="11" /></svg>
        )}
      </button>
      <div className="hidden sm:block">
        <SpeedMenu sim={sim} />
      </div>
      <div className="flex items-center gap-2 font-mono text-[13px] tabular-nums text-ink" title="Simulated time">
        <span className={`h-1.5 w-1.5 rounded-full ${sim.paused ? "bg-ink/25" : "bg-green-700"}`} />
        {clock(c.now)}
      </div>
      {sim.crashed && (
        <div role="alert" className="flex items-center gap-2 border border-red-600/40 bg-red-50 px-2.5 py-1 text-[12.5px] text-red-900" title={sim.crashed}>
          Something went wrong in the simulator, not in your commands.
          <button onClick={() => sim.reset()} className="font-medium underline underline-offset-2 hover:text-red-950" title="Rebuild this cluster from the beginning. Your other Lessons and Challenges keep their progress.">
            Start over
          </button>
        </div>
      )}
    </>
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
/** Width of the folded palette's "+ Add" button. */
const ADD_W = 56;
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
}

export function Workspace({ sim, selection, onSelect, showSystem = false, tabs = ["terminal", "editor", "resources", "events", "commands"], initialTab, overlay, narration = true, dockHeight = "h-[min(18rem,42%)]", mobileView = "canvas", interactive = true, palette = false }: Props) {
  const [tab, setTab] = useState<DockTab>(initialTab ?? tabs[0]);
  const [open, setOpen] = useState(tabs.length > 0);
  const [textView, setTextView] = useState(false);
  const canvasRef = useRef<HTMLDivElement>(null);
  const canvasW = useWidth(canvasRef);
  /** A narrow canvas (phones) can't spare a column for the palette: it floats over the diagram. */
  const wide = canvasW >= 640;
  const [paletteChoice, setPaletteChoice] = useState<boolean | null>(null);
  // The palette starts folded so the diagram is the first thing you see; "Drag to add" opens it.
  const paletteOpen = palette && (paletteChoice ?? false);
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
  // Folded, the palette is just its "+ Add" button.
  const topLeft = palette ? (paletteOpen ? BESIDE_PALETTE : EDGE + ADD_W + 8) : EDGE;
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
        Events <span className="text-ink-soft">{events.length}</span>
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
          <div className="flex shrink-0 items-center gap-3 border border-ink/20 bg-paper/95 px-3 py-1.5 text-[13px] text-ink-soft" aria-label="Cluster summary" data-overlay="summary">
            {[
              [`${readyNodes}/${nodes.length}`, "nodes", readyNodes === nodes.length],
              [`${readyPods}/${pods.length}`, "pods ready", readyPods === pods.length],
              [String(svcs.length), svcs.length === 1 ? "service" : "services", true],
            ].map(([v, k, ok]) => (
              <span key={String(k)} className="whitespace-nowrap">
                <span className={`font-mono tabular-nums ${ok ? "text-ink" : "text-amber-700"}`}>{v}</span> {k}
              </span>
            ))}
            {namespaces.length > 1 && (
              <label className="pointer-events-auto -my-1.5 flex items-center gap-1.5 self-stretch border-l border-ink/15 pl-3">
                namespace
                <select value={ns} onChange={(e) => sim.setViewNs(e.target.value)} className="bg-transparent font-mono text-[12.5px] text-ink outline-none" aria-label="Namespace shown on the canvas">
                  <option value="*">all</option>
                  {namespaces.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          {showStory && (
            <div data-overlay="narration" className="ml-auto flex min-w-0 max-w-[460px] flex-1 items-center gap-2 border border-ink/20 bg-paper/95 px-3 py-1.5 text-[13px]" title={explainEvent(story[0])}>
              {story[0].type === "Warning" && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-600" />}
              <span className="min-w-0 truncate text-ink">{explainEvent(story[0])}</span>
              <span className="ml-auto shrink-0 font-mono text-[11px] text-ink-soft">{age(c.now - story[0].lastTimestamp)}</span>
            </div>
          )}
        </div>

        <div className="pointer-events-none absolute bottom-4 z-10 flex items-end gap-2" style={{ left: bottomLeft, maxWidth: `calc(100% - ${bottomLeft + ZOOM_W}px)` }}>
          <button
            onClick={() => setTextView(!textView)}
            aria-pressed={textView}
            data-overlay="text-view"
            className="pointer-events-auto h-8 shrink-0 border border-ink/30 bg-paper px-2.5 text-[12.5px] text-ink hover:border-ink"
          >
            {textView ? "Diagram view" : "Text view"}
          </button>
        </div>
        {textView && (
          <div className="absolute inset-y-0 right-0 z-20 w-full max-w-md border-l-[1.5px] border-ink bg-paper">
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
        <div className={`flex shrink-0 flex-col border-t-[1.5px] border-ink bg-paper transition-[height] duration-300 ${open ? (idleDock ? "h-[26%] min-h-[150px]" : dockHeight) : "h-11"} ${mobileView === "canvas" ? "max-lg:hidden" : "max-lg:h-auto max-lg:flex-1"}`}>
          <div className="flex h-11 shrink-0 items-stretch gap-3 overflow-x-auto border-b border-ink/15 px-4">
            <Segmented
              value={tab}
              onChange={(v) => {
                setTab(v);
                setOpen(true);
              }}
              options={tabs.map((t) => ({ value: t, label: labels[t] }))}
            />
            <button onClick={() => setOpen(!open)} className="ml-auto hidden h-7 w-7 place-items-center self-center text-ink-soft hover:bg-ink/[0.05] hover:text-ink lg:grid" aria-label={open ? "Collapse panel" : "Expand panel"}>
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
    <nav className="font-sheet flex shrink-0 border-t-[1.5px] border-ink bg-paper lg:hidden" aria-label="Views">
      {options.map((o) => (
        <button key={o.value} onClick={() => onChange(o.value)} className={`flex-1 py-3 text-[14px] ${value === o.value ? "text-ink shadow-[inset_0_3px_0_#172340]" : "text-ink-soft"}`} aria-current={value === o.value ? "page" : undefined}>
          {o.label}
        </button>
      ))}
    </nav>
  );
}
