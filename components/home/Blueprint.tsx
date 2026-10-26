"use client";

// The home page's drawing: what happens when you delete a Pod that a
// ReplicaSet owns, as five numbered steps. The ReplicaSet stops counting a
// Pod as soon as it's marked for deletion (lib/engine/controllers/replicaset.ts),
// so the replacement (2) is made while the old Pod is still stopping (3), as on
// a real cluster. Server-rendered with every step showing; once on screen it
// walks through the steps once, and the notes jump to any step.

import { useEffect, useRef, useState } from "react";

const INK = "#172340";
const SOFT = "#5a6680";
const SIGNAL = "#d9480f";
const PAPER = "#fbfaf6";
const MONO = "var(--font-geist-mono), ui-monospace, monospace";
const STEP_MS = 2600;

export const STEPS: { hot: boolean; text: React.ReactNode }[] = [
  { hot: false, text: <><code>kubectl</code> sends a DELETE to the API server. It marks the Pod for deletion in etcd, and <code>kubectl get pods</code> shows it Terminating.</> },
  { hot: true, text: <>The ReplicaSet controller stops counting a Pod as soon as it&apos;s marked. It sees 2 of 3 and creates a new Pod, with no Node yet.</> },
  { hot: false, text: <>At the same time, the kubelet on worker-2, which watches the API server, sends the container SIGTERM and gives it up to 30 seconds to exit. Then the old Pod is removed.</> },
  { hot: true, text: <>The scheduler rules out Nodes that can&apos;t run it (the control plane is tainted), scores the rest, and binds the new Pod to worker-1.</> },
  { hot: true, text: <>The kubelet on worker-1 starts the container. Once it&apos;s Ready, the Service sends it traffic.</> },
];

type On = (s: number) => string;

function Box({ x, y, w, h, label, sub, hot, dashed, mono, size = 14 }: { x: number; y: number; w: number; h: number; label: string; sub?: string; hot?: boolean; dashed?: boolean; mono?: boolean; size?: number }) {
  const c = hot ? SIGNAL : INK;
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} fill={hot ? "#fdebe2" : PAPER} stroke={c} strokeWidth={hot ? 2 : 1.5} strokeDasharray={dashed ? "5 4" : undefined} />
      <text x={x + 10} y={sub ? y + h / 2 - 3 : y + h / 2 + 5} fill={dashed ? SOFT : c} fontSize={mono ? size - 2 : size} fontFamily={mono ? MONO : undefined}>
        {label}
      </text>
      {sub && (
        <text x={x + 10} y={y + h / 2 + 15} fill={hot ? SIGNAL : SOFT} fontSize={size - 2}>
          {sub}
        </text>
      )}
    </g>
  );
}

function Callout({ n, x, y, r = 12 }: { n: number; x: number; y: number; r?: number }) {
  const c = STEPS[n - 1].hot ? SIGNAL : INK;
  return (
    <g>
      <circle cx={x} cy={y} r={r} fill={PAPER} stroke={c} strokeWidth={1.5} />
      <text x={x} y={y + 4} textAnchor="middle" fontSize={r} fontWeight={600} fill={c}>
        {n}
      </text>
    </g>
  );
}

function Flow({ d, hot, dashed }: { d: string; hot?: boolean; dashed?: boolean }) {
  return <path d={d} fill="none" stroke={hot ? SIGNAL : INK} strokeWidth={1.5} strokeDasharray={dashed ? "6 4" : undefined} markerEnd={`url(#bp-${hot ? "hot" : "ink"})`} />;
}

function Markers() {
  return (
    <defs>
      {([["ink", INK], ["hot", SIGNAL]] as const).map(([id, c]) => (
        <marker key={id} id={`bp-${id}`} viewBox="0 0 10 10" refX={9} refY={5} markerWidth={9} markerHeight={9} orient="auto">
          <path d="M0 1L9 5L0 9" fill="none" stroke={c} strokeWidth={1.5} />
        </marker>
      ))}
    </defs>
  );
}

function NodeLabel({ x, y, children }: { x: number; y: number; children: string }) {
  return (
    <text x={x} y={y} fontSize={12} letterSpacing={1.5} fill={INK}>
      {children}
    </text>
  );
}

/** Desktop: the three Nodes side by side. */
function Wide({ on }: { on: On }) {
  return (
    <svg viewBox="0 0 1200 420" className="hidden w-full md:block" role="img" aria-label="Drawing: a Pod on worker-2 is deleted; the ReplicaSet controller creates a replacement, which the scheduler places on worker-1. The steps are listed below.">
      <Markers />
      <g fontFamily="var(--font-display), sans-serif" fontSize={14} fill={INK}>
        <rect x={40} y={120} width={330} height={250} fill={PAPER} stroke={INK} strokeWidth={1.5} />
        <rect x={470} y={120} width={300} height={250} fill={PAPER} stroke={INK} strokeWidth={1.5} />
        <rect x={860} y={120} width={300} height={250} fill={PAPER} stroke={INK} strokeWidth={1.5} />
        <NodeLabel x={40} y={392}>NODE · CONTROL-PLANE</NodeLabel>
        <NodeLabel x={470} y={392}>NODE · WORKER-1</NodeLabel>
        <NodeLabel x={860} y={392}>NODE · WORKER-2</NodeLabel>
        <Box x={64} y={144} w={282} h={40} label="kube-apiserver" />
        <Box x={64} y={204} w={100} h={40} label="etcd" />
        <path d="M114 204V184" stroke={INK} strokeWidth={1.5} />
        <Box x={64} y={264} w={282} h={40} label="kube-scheduler" />
        <Box x={494} y={150} w={110} h={64} label="web-…67cn8" sub="Running" mono />
        <Box x={1026} y={150} w={110} h={64} label="web-…nl89k" sub="Running" mono />
        <Box x={884} y={150} w={120} h={64} label="web-…24r6j" sub="Terminating" mono dashed />
        <rect x={494} y={310} width={252} height={40} fill="none" stroke={INK} strokeWidth={1.5} strokeDasharray="2 3" />
        <text x={506} y={335} fontSize={13}>kubelet</text>
        <rect x={884} y={310} width={252} height={40} fill="none" stroke={INK} strokeWidth={1.5} strokeDasharray="2 3" />
        <text x={896} y={335} fontSize={13}>kubelet</text>

        <g className={`bp-part ${on(1)}`}>
          <rect x={40} y={30} width={330} height={40} fill={PAPER} stroke={INK} strokeWidth={1.5} />
          <text x={54} y={55} fontFamily={MONO} fontSize={13}>$ kubectl delete pod web-…24r6j</text>
          <Flow d="M205 70V140" />
          <Callout n={1} x={226} y={102} />
        </g>
        <g className={`bp-part ${on(2)}`}>
          <Box x={180} y={204} w={166} h={40} label="ReplicaSet controller" hot />
          <Flow d="M263 184V200" hot />
          <Callout n={2} x={312} y={192} />
        </g>
        <g className={`bp-part ${on(3)}`}>
          <Flow d="M346 160C560 40 1180 40 1180 180V330H1140" dashed />
          <Flow d="M944 306V218" />
          <text x={954} y={268} fontSize={12} fill={SOFT}>SIGTERM</text>
          <Callout n={3} x={650} y={82} />
        </g>
        <g className={`bp-part ${on(4)}`}>
          <Box x={626} y={150} w={120} h={64} label="web-…zbdbf" sub="new" mono hot />
          <Flow d="M346 284C470 284 560 262 650 218" hot />
          <Callout n={4} x={470} y={278} />
        </g>
        <g className={`bp-part ${on(5)}`}>
          <Flow d="M700 306V218" hot />
          <text x={710} y={268} fontSize={12} fill={SIGNAL}>start</text>
          <Callout n={5} x={686} y={262} />
        </g>
      </g>
    </svg>
  );
}

/** Phones: the same drawing with the Nodes stacked. */
function Tall({ on }: { on: On }) {
  return (
    <svg viewBox="0 0 360 780" className="w-full md:hidden" role="img" aria-label="Drawing: a Pod on worker-2 is deleted; the ReplicaSet controller creates a replacement, which the scheduler places on worker-1. The steps are listed below.">
      <Markers />
      <g fontFamily="var(--font-display), sans-serif" fontSize={13} fill={INK}>
        <rect x={16} y={96} width={328} height={196} fill={PAPER} stroke={INK} strokeWidth={1.5} />
        <rect x={16} y={340} width={328} height={180} fill={PAPER} stroke={INK} strokeWidth={1.5} />
        <rect x={16} y={580} width={328} height={180} fill={PAPER} stroke={INK} strokeWidth={1.5} />
        <NodeLabel x={16} y={88}>CONTROL-PLANE</NodeLabel>
        <NodeLabel x={16} y={332}>WORKER-1</NodeLabel>
        <NodeLabel x={16} y={572}>WORKER-2</NodeLabel>
        <Box x={32} y={116} w={296} h={36} label="kube-apiserver" size={13} />
        <Box x={32} y={176} w={96} h={36} label="etcd" size={13} />
        <path d="M80 176V152" stroke={INK} strokeWidth={1.5} />
        <Box x={32} y={236} w={296} h={36} label="kube-scheduler" size={13} />
        <Box x={32} y={362} w={140} h={56} label="web-…67cn8" sub="Running" mono size={13} />
        <Box x={188} y={602} w={140} h={56} label="web-…nl89k" sub="Running" mono size={13} />
        <Box x={32} y={602} w={140} h={56} label="web-…24r6j" sub="Terminating" mono dashed size={13} />
        <rect x={32} y={466} width={296} height={36} fill="none" stroke={INK} strokeWidth={1.5} strokeDasharray="2 3" />
        <text x={44} y={489} fontSize={12}>kubelet</text>
        <rect x={32} y={706} width={296} height={36} fill="none" stroke={INK} strokeWidth={1.5} strokeDasharray="2 3" />
        <text x={44} y={729} fontSize={12}>kubelet</text>

        <g className={`bp-part ${on(1)}`}>
          <rect x={16} y={16} width={328} height={36} fill={PAPER} stroke={INK} strokeWidth={1.5} />
          <text x={28} y={39} fontFamily={MONO} fontSize={12}>$ kubectl delete pod web-…24r6j</text>
          <Flow d="M240 52V112" />
          <Callout n={1} x={262} y={78} r={10} />
        </g>
        <g className={`bp-part ${on(2)}`}>
          <Box x={140} y={176} w={188} h={36} label="ReplicaSet controller" hot size={13} />
          <Flow d="M300 152V172" hot />
          <Callout n={2} x={276} y={163} r={10} />
        </g>
        <g className={`bp-part ${on(3)}`}>
          <Flow d="M328 134H350V724H332" dashed />
          <Flow d="M102 706V662" />
          <text x={110} y={688} fontSize={11} fill={SOFT}>SIGTERM</text>
          <Callout n={3} x={350} y={312} r={10} />
        </g>
        <g className={`bp-part ${on(4)}`}>
          <Box x={188} y={362} w={140} h={56} label="web-…zbdbf" sub="new" mono hot size={13} />
          <Flow d="M180 272V300H258V358" hot />
          <Callout n={4} x={210} y={300} r={10} />
        </g>
        <g className={`bp-part ${on(5)}`}>
          <Flow d="M258 466V422" hot />
          <Callout n={5} x={280} y={444} r={10} />
        </g>
      </g>
    </svg>
  );
}

export function Blueprint() {
  // null: every step showing (the server render, and after the walkthrough).
  const [step, setStep] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Walk through once, the first time the drawing is mostly on screen.
  useEffect(() => {
    const el = ref.current;
    if (!el || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const io = new IntersectionObserver(
      ([e]) => {
        if (!e.isIntersecting) return;
        io.disconnect();
        setStep(1);
        setPlaying(true);
      },
      { threshold: 0.6 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!playing || step === null) return;
    const t = setTimeout(() => {
      if (step < STEPS.length) setStep(step + 1);
      else {
        setStep(null);
        setPlaying(false);
      }
    }, STEP_MS);
    return () => clearTimeout(t);
  }, [playing, step]);

  const on: On = (s) => (step !== null && s <= step ? "bp-on" : "");
  const pick = (s: number) => {
    setPlaying(false);
    setStep(step === s ? null : s);
  };

  return (
    <div ref={ref} className={step !== null ? "bp-stepping" : undefined}>
      <div className="sheet-grid px-2 py-4 md:px-0 md:py-6">
        <Wide on={on} />
        <Tall on={on} />
      </div>
      <ol className="grid grid-cols-1 border-t-[1.5px] border-ink bg-paper md:grid-cols-5">
        {STEPS.map((s, i) => {
          const n = i + 1;
          const current = step === n;
          return (
            <li key={n} className="border-ink/25 max-md:border-t max-md:first:border-t-0 md:border-l md:first:border-l-0">
              <button onClick={() => pick(n)} aria-current={current ? "step" : undefined} className={`flex h-full w-full flex-col items-start justify-start px-4 pb-4 pt-3.5 text-left text-[14px] leading-snug transition-colors [&_code]:font-mono [&_code]:text-[12.5px] ${current ? "bg-ink text-paper" : "text-ink hover:bg-ink/5"} ${step !== null && !current && n > step ? "opacity-45" : ""}`}>
                <span className={`mb-2 grid h-[22px] w-[22px] place-items-center rounded-full border-[1.5px] text-[12px] font-semibold ${current ? "border-paper" : s.hot ? "border-signal text-signal" : "border-ink"}`}>{n}</span>
                <span>{s.text}</span>
              </button>
            </li>
          );
        })}
      </ol>
      <div className="flex items-center justify-between border-t border-ink/25 bg-paper px-4 py-2 text-[13px] text-ink-soft">
        <span>Click a step to see it on its own.</span>
        <button
          onClick={() => {
            setStep(1);
            setPlaying(true);
          }}
          className="text-ink underline decoration-[1.5px] underline-offset-4 hover:text-signal"
        >
          {playing ? "Playing…" : "Replay"}
        </button>
      </div>
    </div>
  );
}
