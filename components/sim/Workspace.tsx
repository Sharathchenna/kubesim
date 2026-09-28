"use client";

import { useState } from "react";
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
        <Segmented value={String(sim.speed)} onChange={(v) => sim.setSpeed(+v)} options={[1, 5, 30, 60].map((s) => ({ value: String(s), label: `${s}×` }))} />
      </div>
      <div className="flex items-center gap-2 font-mono text-[13px] tabular-nums text-slate-700" title="Simulated time">
        <span className={`h-1.5 w-1.5 rounded-full ${sim.paused ? "bg-slate-300" : "bg-green-500"}`} />
        {clock(c.now)}
      </div>
      {sim.crashed && (
        <div role="alert" className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-2.5 py-1 text-[12px] text-red-800" title={sim.crashed}>
          The simulation hit a bug and stopped.
          <button onClick={() => sim.reset()} className="font-medium underline underline-offset-2 hover:text-red-950">
            Start over
          </button>
        </div>
      )}
    </>
  );
}

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

export function Workspace({ sim, selection, onSelect, showSystem = false, tabs = ["terminal", "editor", "resources", "events", "commands"], initialTab, overlay, narration = true, dockHeight = "h-72", mobileView = "canvas", interactive = true, palette = false }: Props) {
  const [tab, setTab] = useState<DockTab>(initialTab ?? tabs[0]);
  const [open, setOpen] = useState(tabs.length > 0);
  const [textView, setTextView] = useState(false);
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
  const inView = (n?: string) => (ns === "*" ? showSystem || !SYSTEM_NAMESPACES.has(n ?? "") : n === ns);
  const events = sim.events.filter((e) => inView(e.metadata.namespace));
  const pods = c.list<Pod>("Pod").filter((p) => inView(p.metadata.namespace));
  const readyPods = pods.filter((p) => podCategory(p) === "ok").length;
  const svcs = c.list<Service>("Service").filter((s) => inView(s.metadata.namespace) && s.metadata.name !== "kubernetes");
  const nodes = c.list<Node>("Node");
  const readyNodes = nodes.filter((n) => c.nodeReady(n) && c.state.nodes[n.metadata.name]?.up).length;
  const namespaces = c.list<Namespace>("Namespace").map((n) => n.metadata.name).filter((n) => showSystem || !SYSTEM_NAMESPACES.has(n));
  const story = sim.events.filter((e) => isNarrated(e) && inView(e.metadata.namespace)).slice(0, 2);
  const labels: Record<DockTab, React.ReactNode> = {
    terminal: "Terminal",
    editor: "YAML editor",
    resources: "Resources",
    events: (
      <>
        Events <span className="text-slate-400">{events.length}</span>
      </>
    ),
    commands: "History",
  };

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className={`relative min-h-0 flex-1 overflow-hidden ${mobileView === "dock" ? "max-lg:hidden" : ""}`}>
        {interactive ? (
          <DragProvider sim={sim}>
            <ClusterView cluster={c} packets={sim.packets} slots={sim.slots} now={sim.frameNow} selection={selection} onSelect={onSelect} showSystem={showSystem} namespace={ns} inset={{ top: 88, bottom: 36, left: palette ? 196 : 0 }} />
            {palette && <Palette />}
          </DragProvider>
        ) : (
          <ClusterView cluster={c} packets={sim.packets} slots={sim.slots} now={sim.frameNow} selection={selection} onSelect={onSelect} showSystem={showSystem} namespace={ns} inset={{ top: 88, bottom: 36, left: palette ? 196 : 0 }} />
        )}

        <div className="pointer-events-none absolute left-4 top-4 z-10 hidden gap-2 md:flex">
          {[
            ["Nodes", `${readyNodes}/${nodes.length}`, readyNodes === nodes.length ? "#16a34a" : "#f59e0b"],
            ["Pods ready", `${readyPods}/${pods.length}`, readyPods === pods.length ? "#16a34a" : "#f59e0b"],
            ["Services", String(svcs.length), "#2563eb"],
          ].map(([k, v, col]) => (
            <div key={k} className="rounded-xl border border-slate-200/80 bg-white/90 px-3 py-2 shadow-[0_1px_2px_rgba(15,23,42,.04)] backdrop-blur">
              <div className="text-[10.5px] font-medium uppercase tracking-[0.08em] text-slate-400">{k}</div>
              <div className="mt-0.5 flex items-center gap-1.5 font-mono text-[14px] font-medium tabular-nums text-slate-900">
                <Dot color={col} />
                {v}
              </div>
            </div>
          ))}
          {namespaces.length > 1 && (
            <label className="pointer-events-auto rounded-xl border border-slate-200/80 bg-white/90 px-3 py-2 shadow-[0_1px_2px_rgba(15,23,42,.04)] backdrop-blur">
              <div className="text-[10.5px] font-medium uppercase tracking-[0.08em] text-slate-400">Namespace</div>
              <select value={ns} onChange={(e) => sim.setViewNs(e.target.value)} className="mt-0.5 bg-transparent font-mono text-[13px] font-medium text-slate-900 outline-none" aria-label="Namespace shown on the canvas">
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

        <button
          onClick={() => setTextView(!textView)}
          aria-pressed={textView}
          className="absolute bottom-4 left-4 z-10 rounded-lg border border-slate-200 bg-white/95 px-2.5 py-1 text-[11.5px] font-medium text-slate-600 shadow-[0_1px_2px_rgba(15,23,42,.04)] hover:bg-slate-50"
          style={palette ? { left: 212 } : undefined}
        >
          {textView ? "Diagram view" : "Text view"}
        </button>
        {textView && (
          <div className="absolute inset-y-0 right-0 z-20 w-full max-w-md border-l border-slate-200 bg-white shadow-[0_8px_24px_rgba(15,23,42,.08)]">
            <ClusterText c={c} namespace={ns} showSystem={showSystem} onSelect={onSelect} />
          </div>
        )}

        {narration && story.length > 0 && (
          <div className="pointer-events-none absolute right-4 top-4 hidden w-[420px] max-w-[calc(100%-2rem)] rounded-xl border border-slate-200/80 bg-white/95 px-3 py-2.5 shadow-[0_1px_2px_rgba(15,23,42,.04),0_8px_24px_rgba(15,23,42,.06)] backdrop-blur xl:block">
            <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-slate-400">What just happened</div>
            <ol className="flex flex-col gap-0.5">
              {story.map((e, i) => (
                <li key={e.metadata.uid} className="flex items-center gap-2 text-[12px] leading-snug" style={{ opacity: 1 - i * 0.35 }}>
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: e.type === "Warning" ? "#f59e0b" : "#94a3b8" }} />
                  <span className="truncate text-slate-700" title={explainEvent(e)}>
                    {explainEvent(e)}
                  </span>
                  <span className="ml-auto shrink-0 font-mono text-[10.5px] text-slate-400">{age(c.now - e.lastTimestamp)}</span>
                </li>
              ))}
            </ol>
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
        <div className={`flex shrink-0 flex-col border-t border-slate-200/80 bg-white transition-[height] duration-300 ${open ? dockHeight : "h-11"} ${mobileView === "canvas" ? "max-lg:hidden" : "max-lg:h-auto max-lg:flex-1"}`}>
          <div className="flex h-11 shrink-0 items-center gap-3 overflow-x-auto border-b border-slate-100 px-3">
            <Segmented
              value={tab}
              onChange={(v) => {
                setTab(v);
                setOpen(true);
              }}
              options={tabs.map((t) => ({ value: t, label: labels[t] }))}
            />
            <button onClick={() => setOpen(!open)} className="ml-auto hidden h-7 w-7 place-items-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700 lg:grid" aria-label={open ? "Collapse panel" : "Expand panel"}>
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
