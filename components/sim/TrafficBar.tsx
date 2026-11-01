"use client";

// The Sandbox's traffic control: send a steady flow of requests to one Service, watch what it serves,
// how many fail and how slow it gets, and find out what's holding it back. The flow is modelled in the
// engine (lib/engine/controllers/load.ts); this sets it and reads it. Challenges turn it into exercises:
// hold a load for 30 seconds with under 1% of requests failing, from a lunch rush to Black Friday.

import { useEffect, useState, useSyncExternalStore } from "react";
import type { Cluster, HorizontalPodAutoscaler, Service } from "@/lib/engine";
import { SYSTEM_NAMESPACES } from "@/lib/engine/bootstrap";
import type { LoadStats } from "@/lib/engine/controllers/load";
import { performDrop } from "@/lib/sim/drag";
import type { SimStore } from "@/lib/sim/useSimulation";

const PRESETS = [
  { rps: 10, label: "Quiet" },
  { rps: 200, label: "Lunch rush" },
  { rps: 1000, label: "Launch day" },
  { rps: 2000, label: "Viral" },
  { rps: 3000, label: "Black Friday" },
];
/** The slider is logarithmic and grows with the traffic: there's no top end, type any rate into the box. */
const sliderMax = (rps: number) => Math.max(10_000, 10 ** Math.ceil(Math.log10(Math.max(rps, 1) * 2)));
const toPos = (rps: number, max: number) => Math.round((Math.log10(rps + 1) / Math.log10(max + 1)) * 1000);
const fromPos = (pos: number, max: number) => {
  const v = 10 ** ((pos / 1000) * Math.log10(max + 1)) - 1;
  const step = v < 20 ? 1 : v < 100 ? 5 : v < 500 ? 10 : v < 5000 ? 50 : 500;
  return Math.round(v / step) * step;
};
const fmt = (n: number) => Math.round(n).toLocaleString("en-US");
const HOLD_MS = 30_000;
const DONE_KEY = "kubesim.trafficChallenges.v1";

interface Challenge {
  id: string;
  title: string;
  level: "Easy" | "Medium" | "Hard";
  rps: number;
  goal: string;
  maxP95?: number;
  /** Anything else that has to be true while it holds; returns why not. */
  also?: (c: Cluster, base: string) => string | null;
  tip: string;
}

const hasHpa = (c: Cluster, deployment: string) => c.list<HorizontalPodAutoscaler>("HorizontalPodAutoscaler", "default").some((h) => h.spec?.scaleTargetRef.kind === "Deployment" && h.spec.scaleTargetRef.name === deployment);

const CHALLENGES: Challenge[] = [
  { id: "lunch", title: "Lunch rush", level: "Easy", rps: 200, goal: "Serve 200 req/s with under 1% errors for 30 seconds.", tip: "kubectl top pods shows who's pinned at the CPU limit. One more of those Pods is enough." },
  { id: "launch", title: "Launch day", level: "Easy", rps: 1000, goal: "Serve 1,000 req/s with under 1% errors for 30 seconds.", tip: "Each Pod takes about 80 req/s before its 250m CPU limit throttles it. Count how many each tier needs." },
  {
    id: "fast",
    title: "Fast lane",
    level: "Medium",
    rps: 500,
    maxP95: 150,
    goal: "Serve 500 req/s with p95 under 150 ms for 30 seconds.",
    tip: "A Pod near its limit queues requests, and the wait grows fast as it fills. Run each tier well below its limit: more Pods than the load strictly needs.",
  },
  {
    id: "autopilot",
    title: "Autopilot",
    level: "Medium",
    rps: 1000,
    goal: "Serve 1,000 req/s with under 1% errors for 30 seconds, scaled by HorizontalPodAutoscalers, not by hand.",
    also: (c, base) => (hasHpa(c, `${base}-web`) && hasHpa(c, `${base}-api`) ? null : `Needs an HPA on ${base}-web and on ${base}-api.`),
    tip: "kubectl autoscale deployment … --cpu=70% adds Pods while their CPU stays above 70% of their request. It reacts every 15 seconds, so give it a minute.",
  },
  {
    id: "viral",
    title: "Viral",
    level: "Hard",
    rps: 2000,
    goal: "Serve 2,000 req/s with under 1% errors for 30 seconds.",
    tip: "Past about 1,500 req/s the Nodes run out of CPU and the one database becomes the bottleneck. Give the database a bigger CPU request first and wait for it to be Running (its volume ties it to one Node), then add Nodes and scale out.",
  },
  {
    id: "blackfriday",
    title: "Black Friday",
    level: "Hard",
    rps: 3000,
    goal: "Serve 3,000 req/s with under 1% errors for 30 seconds.",
    tip: "Plan the capacity: around 75 web and API Pods at 200m each is 15 CPUs, plus the database. That's more Nodes than you have. Database first, then Nodes, then let HPAs scale.",
  },
];

// Challenges done, kept in the browser. Read through a tiny store so the count updates the moment one is met.
const DONE_EVENT = "kubesim:traffic-done";
let doneCache = { raw: "", list: [] as string[] };
const NONE: string[] = [];
function readDone(): string[] {
  let raw = "[]";
  try {
    raw = localStorage.getItem(DONE_KEY) ?? "[]";
  } catch {
    // Private mode: nothing saved.
  }
  if (raw !== doneCache.raw) {
    try {
      doneCache = { raw, list: JSON.parse(raw) };
    } catch {
      doneCache = { raw, list: [] };
    }
  }
  return doneCache.list;
}
function onDone(cb: () => void) {
  window.addEventListener(DONE_EVENT, cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener(DONE_EVENT, cb);
    window.removeEventListener("storage", cb);
  };
}
/** Challenges met since they were last started: they stay met, whatever the traffic does next. */
const wonThisRun = new Set<string>();

function services(c: Cluster): Service[] {
  return c.list<Service>("Service").filter((s) => !SYSTEM_NAMESPACES.has(s.metadata.namespace ?? "") && s.metadata.name !== "kubernetes" && s.spec?.type !== "ExternalName");
}

/** Sets the flow; kept in the cluster's state, so it's autosaved and travels with a share link. */
function setLoad(c: Cluster, load: { target: string; rps: number } | undefined) {
  if (load && load.rps > 0) c.state.load = load;
  else delete c.state.load;
  c.state.layoutRev = (c.state.layoutRev ?? 0) + 1;
  c.markChanged();
}

/** How long the flow has met a challenge, counting back from now in simulated time; or why it isn't. */
function holding(stats: LoadStats | undefined, ch: Challenge, c: Cluster, base: string): { held: number; why: string | null } {
  const extra = ch.also?.(c, base) ?? null;
  if (!stats?.samples.length) return { held: 0, why: "Waiting for traffic…" };
  if (extra) return { held: 0, why: extra };
  let held = 0;
  const last = stats.samples[stats.samples.length - 1];
  for (let i = stats.samples.length - 1; i >= 0; i--) {
    const s = stats.samples[i];
    if (s.offered < ch.rps || 1 - s.ok / s.offered >= 0.01 || (ch.maxP95 !== undefined && s.p95 > ch.maxP95)) break;
    held = last.t - s.t;
  }
  const now = last;
  const why =
    held > 0
      ? null
      : now.offered < ch.rps
        ? `Set the traffic to ${fmt(ch.rps)} req/s or more.`
        : 1 - now.ok / now.offered >= 0.01
          ? null
          : ch.maxP95 !== undefined && now.p95 > ch.maxP95
            ? `p95 is ${fmt(now.p95)} ms; it needs to be under ${ch.maxP95} ms.`
            : null;
  return { held, why };
}

/** `onInspect` opens a workload in the sidebar, whose "What's wrong" explains what's holding the traffic back. */
export function TrafficBar({ sim, c, onInspect }: { sim: SimStore; c: Cluster; onInspect?: (kind: "deployment" | "statefulset", ns: string, name: string) => void }) {
  const [panel, setPanel] = useState(false);
  const [hints, setHints] = useState(false);
  const [presets, setPresets] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  const done = useSyncExternalStore(onDone, readDone, () => NONE);
  const [typed, setTyped] = useState<string | null>(null);
  const svcs = services(c);
  const load = c.state.load;
  const preferred = svcs.find((s) => s.metadata.name.endsWith("-web")) ?? svcs[0];
  const target = load?.target ?? (preferred ? `${preferred.metadata.namespace}/${preferred.metadata.name}` : "");
  const base = (target.split("/")[1] ?? "").replace(/-web$/, "");
  const rps = load?.rps ?? 0;
  const max = sliderMax(rps);
  const stats = c.state.loadStats;
  const live = !!load && !!stats && stats.offered > 0;
  const err = live ? Math.max(0, 1 - stats.ok / stats.offered) : 0;
  const set = (n: number, to = target) => setLoad(c, to ? { target: to, rps: Math.max(0, Math.round(n)) } : undefined);

  const challenge = CHALLENGES.find((ch) => ch.id === active);
  const progress = challenge ? holding(stats, challenge, c, base) : undefined;
  const metNow = !!challenge && !!progress && progress.held >= HOLD_MS;
  const met = metNow || (!!challenge && wonThisRun.has(challenge.id));
  // A challenge met just now counts as done straight away; it's saved, and the state catches up on the next move.
  const justDone = metNow && challenge && !wonThisRun.has(challenge.id) ? challenge.id : null;
  const doneNow = justDone && !done.includes(justDone) ? [...done, justDone] : done;
  useEffect(() => {
    if (!justDone) return;
    wonThisRun.add(justDone);
    try {
      localStorage.setItem(DONE_KEY, JSON.stringify([...new Set([...readDone(), justDone])]));
    } catch {
      // Private mode: it shows as done until the page reloads.
    }
    window.dispatchEvent(new Event(DONE_EVENT));
  }, [justDone]);
  const start = (ch: Challenge) => {
    wonThisRun.delete(ch.id);
    setActive(ch.id);
    setPanel(false);
    setHints(false);
    if (rps < ch.rps) set(ch.rps);
  };

  if (!svcs.length) {
    return (
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-ink/10 bg-paper px-4 py-3 text-[15px]">
        <TrafficIcon />
        <span className="font-semibold">Traffic</span>
        <span className="text-ink-soft">Nothing to send traffic to yet: it needs a Service.</span>
        <button onClick={() => performDrop(sim, { kind: "blueprint", id: "stack", label: "Full-stack app" }, { type: "canvas" })} className="btn-primary h-10 rounded-lg px-4 text-[15px] font-medium text-white">
          Add the shop (web, API, Postgres, Redis)
        </button>
      </div>
    );
  }

  const next = challenge && CHALLENGES[CHALLENGES.indexOf(challenge) + 1];
  return (
    <div className="relative z-30 border-b border-ink/10 bg-paper text-[14.5px]">
      {/* ---- one row: what to send where, then what it's getting */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5">
        <span className="flex items-center gap-2 font-semibold">
          <TrafficIcon live={live} bad={err >= 0.01} />
          Traffic
        </span>
        <select value={target} onChange={(e) => set(rps, e.target.value)} aria-label="Send traffic to" className="h-9 max-w-[8.5rem] rounded-lg border border-ink/15 bg-paper px-2 font-mono text-[13.5px] text-ink 2xl:max-w-[11rem]">
          {svcs.map((s) => {
            const v = `${s.metadata.namespace}/${s.metadata.name}`;
            return (
              <option key={v} value={v}>
                {s.metadata.namespace === "default" ? s.metadata.name : v}
              </option>
            );
          })}
        </select>
        <input
          type="range"
          min={0}
          max={1000}
          value={toPos(rps, max)}
          onChange={(e) => set(fromPos(+e.target.value, max))}
          aria-label="Requests per second"
          aria-valuetext={`${fmt(rps)} requests per second`}
          className="h-2 w-24 accent-[#326ce5] max-sm:hidden 2xl:w-40"
        />
        <label className="flex h-9 items-center rounded-lg border border-ink/15 focus-within:border-signal">
          <span className="sr-only">Requests per second</span>
          <input
            type="text"
            inputMode="numeric"
            value={typed ?? (rps ? fmt(rps) : "0")}
            onFocus={(e) => (setTyped(rps ? String(rps) : ""), e.target.select())}
            onChange={(e) => setTyped(e.target.value.replace(/[^\d]/g, ""))}
            onBlur={() => {
              if (typed !== null) set(+typed || 0);
              setTyped(null);
            }}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            className="w-20 bg-transparent px-2 text-right font-mono text-[15px] font-semibold tabular-nums outline-none"
          />
          <span className="pr-2 text-[12.5px] text-ink-soft">req/s</span>
          {rps > 0 && (
            <button onClick={() => set(0)} title="Stop the traffic" aria-label="Stop the traffic" className="mr-1 grid h-6 w-6 place-items-center rounded-md text-ink-soft hover:bg-ink/[0.06] hover:text-ink">
              ×
            </button>
          )}
        </label>
        <button onClick={() => set(rps ? rps * 2 : 500)} title="Double the traffic, all at once" className="btn-primary inline-flex h-9 items-center gap-1.5 rounded-lg px-3.5 font-semibold text-white">
          <svg viewBox="0 0 20 20" className="h-4 w-4" fill="currentColor" aria-hidden>
            <path d="M11.5 1.5L4 11h5l-1.5 7.5L16 8h-5z" />
          </svg>
          Spike ×2
        </button>
        <div className="relative">
          <button onClick={() => (setPresets(!presets), setPanel(false))} aria-expanded={presets} className="h-9 rounded-lg px-2.5 text-ink-soft hover:bg-ink/[0.05] hover:text-ink">
            Presets ▾
          </button>
          {presets && (
            <div className="float-card absolute left-0 top-[calc(100%+6px)] z-10 w-56 p-1.5">
              {PRESETS.map((p) => (
                <button key={p.label} onClick={() => (set(p.rps), setPresets(false))} className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left ${rps === p.rps ? "bg-signal-soft font-medium text-signal" : "hover:bg-ink/[0.04]"}`}>
                  {p.label}
                  <span className="font-mono text-[13px] text-ink-soft">{fmt(p.rps)}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-2 max-sm:w-full max-sm:justify-between">
          {live && <Readout stats={stats} err={err} />}
          {live && <Why c={c} stats={stats} err={err} ns={target.split("/")[0] ?? "default"} onInspect={onInspect} />}
          <button onClick={() => (setPanel(!panel), setPresets(false))} aria-expanded={panel} className="inline-flex h-9 items-center gap-2 rounded-lg border border-ink/15 px-3 font-medium hover:border-ink/30">
            Challenges
            <span className="rounded-full bg-signal-soft px-1.5 font-mono text-[12px] text-signal">
              {doneNow.length}/{CHALLENGES.length}
            </span>
          </button>
        </div>
      </div>


      {/* ---- the challenge in play, in one line; its hints float over the canvas */}
      {challenge && progress && (
        <div className={`flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t px-4 py-2 text-[14px] ${met ? "border-green-200 bg-green-50" : "border-ink/10"}`}>
          <span className="font-semibold">{challenge.title}</span>
          <span className="min-w-0 truncate text-ink-soft max-md:hidden">{challenge.goal}</span>
          <div className="h-1.5 w-28 shrink-0 overflow-hidden rounded-full bg-ink/10" role="progressbar" aria-label="Seconds held" aria-valuemin={0} aria-valuemax={30} aria-valuenow={Math.min(30, Math.floor(progress.held / 1000))}>
            <div className={`h-full rounded-full transition-[width] duration-500 ${met ? "bg-green-600" : "bg-signal"}`} style={{ width: `${Math.min(100, (progress.held / HOLD_MS) * 100)}%` }} />
          </div>
          <span className={`shrink-0 font-mono text-[13px] tabular-nums ${met ? "font-semibold text-green-700" : "text-ink-soft"}`}>{met ? "Done ✓" : `${Math.floor(progress.held / 1000)}s / 30s`}</span>
          {!met && progress.why && <span className="min-w-0 truncate text-[13.5px] text-ink-soft">{progress.why}</span>}
          <div className="ml-auto flex shrink-0 gap-1">
            <button onClick={() => setHints(!hints)} aria-expanded={hints} className="h-8 rounded-lg px-2.5 font-medium text-signal hover:bg-signal-soft">
              {hints ? "Hide how" : "Show me how"}
            </button>
            {met && next && (
              <button onClick={() => start(next)} className="btn-primary h-8 rounded-lg px-3 font-medium text-white">
                Next: {next.title} →
              </button>
            )}
            <button onClick={() => (setActive(null), setHints(false))} className="h-8 rounded-lg px-2.5 text-ink-soft hover:text-ink">
              Leave
            </button>
          </div>
          {hints && (
            <div className="float-card absolute right-3 top-[calc(100%+6px)] max-h-[70vh] w-[min(640px,calc(100vw-1.5rem))] overflow-y-auto p-4">
              <p className="text-[14.5px] leading-relaxed">{challenge.tip}</p>
              <Hints sim={sim} c={c} target={target} />
            </div>
          )}
        </div>
      )}

      {/* ---- the list of challenges, over the canvas so it never squeezes the diagram */}
      {panel && (
        <div className="float-card absolute right-3 top-[calc(100%+6px)] max-h-[72vh] w-[min(780px,calc(100vw-1.5rem))] overflow-y-auto p-4">
          <div className="flex items-baseline justify-between gap-3">
            <div className="text-[17px] font-semibold">Traffic challenges</div>
            <div className="text-[13.5px] text-ink-soft">Hold the load for 30 seconds with under 1% of requests failing.</div>
          </div>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            {CHALLENGES.map((ch) => {
              const ok = doneNow.includes(ch.id);
              return (
                <button key={ch.id} onClick={() => start(ch)} className={`flex flex-col rounded-xl border p-4 text-left transition-colors hover:border-signal/50 ${active === ch.id ? "border-signal bg-signal-soft/40" : "border-ink/10"}`}>
                  <span className="flex items-center gap-2">
                    <span className="text-[16px] font-semibold">{ch.title}</span>
                    <span className={`rounded border px-1.5 py-px text-[12px] ${ch.level === "Easy" ? "border-green-200 text-green-700" : ch.level === "Medium" ? "border-amber-200 text-amber-700" : "border-red-200 text-red-700"}`}>{ch.level}</span>
                    <span className="ml-auto font-mono text-[13px] text-ink-soft">{fmt(ch.rps)} req/s</span>
                  </span>
                  <span className="mt-1.5 text-[14px] leading-snug text-ink-soft">{ch.goal}</span>
                  <span className={`mt-3 text-[13.5px] font-medium ${ok ? "text-green-700" : "text-signal"}`}>{ok ? "✓ Done · play again" : active === ch.id ? "In play" : "Start →"}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/** What the traffic is getting, in one line: served, failing, how slow. The dot says whether that's fine. */
function Readout({ stats, err }: { stats: LoadStats; err: number }) {
  const bad = err >= 0.01 || stats.p95 >= 1000;
  const slow = !bad && stats.p95 >= 300;
  return (
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-[13.5px] tabular-nums [&>*]:whitespace-nowrap" aria-live="polite">
      <span className={`h-2 w-2 shrink-0 rounded-full ${bad ? "bg-red-600" : slow ? "bg-amber-500" : "bg-green-600"}`} aria-hidden />
      <span title="Requests answered per second">
        <span className="text-[15px] font-semibold">{fmt(stats.ok)}</span>
        <span className="text-ink-soft">/{fmt(stats.offered)} req/s</span>
      </span>
      <span className="text-ink/25">·</span>
      <span className={err >= 0.01 ? "font-semibold text-red-700" : "text-ink-soft"} title="Share of requests that failed or timed out">
        {err >= 0.001 ? `${(err * 100).toFixed(err < 0.1 ? 1 : 0)}%` : "0%"} errors
      </span>
      <span className="text-ink/25">·</span>
      <span className={stats.p95 >= 1000 ? "font-semibold text-red-700" : stats.p95 >= 300 ? "text-amber-700" : "text-ink-soft"} title="95% of requests are answered faster than this">
        p95 {stats.p95 >= 3000 ? "> 3 s" : `${fmt(stats.p95)} ms`}
      </span>
    </div>
  );
}

/** What's holding the traffic back, said in a tooltip; the link opens the culprit in the sidebar, where "What's wrong" explains it and offers the fix. */
function Why({ c, stats, err, ns, onInspect }: { c: Cluster; stats: LoadStats; err: number; ns: string; onInspect?: (kind: "deployment" | "statefulset", ns: string, name: string) => void }) {
  const b = stats.bottleneck;
  if (!b && err < 0.01 && !stats.problem) return null;
  const text = b
    ? {
        "cpu-limit": `${b.name} is throttled: its Pods are at their CPU limit and can't take more requests.`,
        "node-cpu": `${b.name} is starved: its Node's CPU is used up, and it's sharing what's left with everything else there.`,
        "no-endpoints": `${b.name} has no ready Pods, so every request that needs it fails.`,
        unreachable: `${b.name} can't be reached, so the requests that need it fail.`,
      }[b.why]
    : (stats.problem ?? "Some requests are failing.");
  const kind = b && c.raw("StatefulSet", ns, b.name) ? "statefulset" : "deployment";
  const open = b && onInspect && c.raw(kind === "statefulset" ? "StatefulSet" : "Deployment", ns, b.name);
  return open ? (
    <button onClick={() => onInspect(kind, ns, b.name)} title={text} aria-label={`Why: ${text} Open ${b.name}`} className="text-[13px] text-ink-soft underline decoration-ink/30 underline-offset-2 hover:text-ink hover:decoration-ink">
      Why? <span className="font-mono">{b.name}</span>
    </button>
  ) : (
    <span title={text} className="cursor-help text-[13px] text-ink-soft underline decoration-dotted decoration-ink/30 underline-offset-2">
      Why?
    </span>
  );
}

/** The ways out, each a command to run: look first, then scale by hand or let an HPA do it, then make room. */
function Hints({ sim, c, target }: { sim: SimStore; c: Cluster; target: string }) {
  const name = target.split("/")[1] ?? "web";
  const base = name.replace(/-web$/, "");
  const shop = base !== name;
  const api = shop ? `${base}-api` : undefined;
  const db = shop && c.raw("StatefulSet", "default", `${base}-db`) ? `${base}-db` : undefined;
  const steps: { why: string; cmds: string[] }[] = [
    { why: "Find who's struggling. Pods pinned at their CPU limit (250m here) are being throttled.", cmds: ["kubectl top pods"] },
    { why: "Add replicas: each one brings its own CPU. About 13 web and 13 API Pods carry 1,000 req/s.", cmds: [`kubectl scale deployment ${name} --replicas=14`, ...(api ? [`kubectl scale deployment ${api} --replicas=14`] : [])] },
    { why: "Or let Kubernetes do it: a HorizontalPodAutoscaler adds Pods while their CPU stays above 70% of what they request.", cmds: [`kubectl autoscale deployment ${name} --cpu=70% --min=3 --max=60`, ...(api ? [`kubectl autoscale deployment ${api} --cpu=70% --min=2 --max=60`] : [])] },
    ...(db ? [{ why: "Past ~1,500 req/s the single database is next. Give it more CPU first, and wait until it's Running again: its volume ties it to one Node.", cmds: [`kubectl set resources statefulset ${db} --requests=cpu=2`, `kubectl get pod ${db}-0`] }] : []),
    { why: "Pods stuck Pending with Insufficient cpu? The Nodes are full. Add one: Build tab, “+ join node”. The scheduler puts new Pods there.", cmds: ["kubectl get pods --field-selector=status.phase=Pending"] },
  ];
  return (
    <ol className="mt-3 space-y-3">
      {steps.map((s, i) => (
        <li key={i} className="flex gap-3">
          <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full border border-ink/20 font-mono text-[12px] text-ink-soft">{i + 1}</span>
          <div className="min-w-0">
            <div className="text-[14.5px] leading-snug">{s.why}</div>
            <div className="mt-1.5 flex flex-wrap gap-2">
              {s.cmds.map((cmd) => (
                <button key={cmd} onClick={() => sim.exec(cmd)} title="Run it in the terminal" className="rounded-lg border border-ink/15 bg-paper px-2.5 py-1 text-left font-mono text-[13px] hover:border-signal/50 hover:text-signal">
                  {cmd} <span className="text-ink-soft">↵</span>
                </button>
              ))}
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}

function TrafficIcon({ live, bad }: { live?: boolean; bad?: boolean }) {
  return (
    <svg viewBox="0 0 20 20" className={`h-5 w-5 shrink-0 ${bad ? "text-red-600" : live ? "text-signal" : "text-ink-soft"}`} fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" aria-hidden>
      <path d="M3 6h9M3 10h12M3 14h7" />
      <path d="M13 3l3 3-3 3M16 11l2 2.5-2 2.5" />
    </svg>
  );
}
