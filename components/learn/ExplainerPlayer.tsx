"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { EXPLAINERS, explainerById } from "@/lib/explainers/explainers";
import { useSimulation } from "@/lib/sim/useSimulation";
import { AppHeader } from "../AppHeader";
import { Btn, StepMark } from "../ui";
import { Inspector } from "../sim/Inspector";
import type { Selection } from "../sim/ClusterView";
import { LayoutToggle, SimControls, Workspace, useLayoutChoice } from "../sim/Workspace";

export function ExplainerPlayer({ id }: { id: string }) {
  const ex = explainerById(id)!;
  const [param, setParam] = useState(ex.param?.default ?? 0);
  const [run, setRun] = useState(0);
  return <Player key={`${param}:${run}`} id={id} param={param} setParam={setParam} restart={() => setRun((r) => r + 1)} ex={ex} />;
}

function Player({ id, ex, param, setParam, restart }: { id: string; ex: NonNullable<ReturnType<typeof explainerById>>; param: number; setParam: (n: number) => void; restart: () => void }) {
  const beats = ex.beats(param);
  const sim = useSimulation({
    seed: 11,
    setup: (c) => ex.setup(c, param),
    warmupMs: ex.warmupMs,
    speed: ex.speed,
    onStart: (s) =>
      s.schedule([
        ...beats.map((b) => ({ after: b.at, fn: () => b.run?.(s) })),
        // Pause at the end so the final state stays on screen.
        { after: beats[beats.length - 1].at + 6000, fn: () => s.setPaused(true) },
      ]),
  });
  const [sel, setSel] = useState<Selection>(null);
  const [layout, setLayout] = useLayoutChoice("spotlight");
  /** The beat last scrolled into view, so the list follows the story without fighting the Learner's own scrolling. */
  const shownBeat = useRef(-1);
  const c = sim.cluster;
  if (!c) return <div className="font-sheet flex h-dvh items-center justify-center bg-paper text-[14px] text-ink-soft">Setting the scene…</div>;

  const elapsed = c.now - sim.bootAt;
  let cur = 0;
  beats.forEach((b, i) => {
    if (b.at <= elapsed) cur = i;
  });
  const end = beats[beats.length - 1].at + 6000;
  const finished = elapsed >= end;
  const idx = EXPLAINERS.findIndex((e) => e.id === id);
  const next = EXPLAINERS[idx + 1];

  return (
    <div className="font-sheet flex h-dvh flex-col overflow-hidden bg-paper text-ink">
      <AppHeader
        trail={[{ href: "/explainers", label: "Explainers" }, { label: ex.title }]}
        center={<SimControls sim={sim} />}
        right={
          <>
            <LayoutToggle value={layout} onChange={setLayout} />
            {ex.param && <ParamSlider label={ex.param.label} min={ex.param.min} max={ex.param.max} value={param} onCommit={setParam} />}
            <Btn onClick={restart}>{finished ? "Replay" : "Start over"}</Btn>
          </>
        }
      />
      <Workspace
        sim={sim}
        selection={sel}
        onSelect={setSel}
        inspector={sel && <Inspector sim={sim} c={c} sel={sel} onSelect={setSel} />}
        onCloseInspector={() => setSel(null)}
        tabs={["events", "commands"]}
        initialTab="commands"
        narration={false}
        mobileView="canvas"
        interactive={false}
        layout={layout}
        sideLabel="Explainer"
        sideAboveOnMobile
        side={<>
          <div className="border-b border-ink/10 px-5 pb-4 pt-4">
            <p className="text-[13.5px] text-ink-soft">
              <Link href="/explainers" className="underline-offset-4 hover:text-ink hover:underline md:no-underline">
                Explainer
              </Link>{" "}
              · {beats.length} steps
            </p>
            <h1 className="font-display mt-0.5 text-[22px] leading-tight">{ex.title}</h1>
            <p className="mt-1.5 text-[14px] leading-snug text-ink-soft">{ex.summary}</p>
          </div>
          <ol className="min-h-0 flex-1 pb-1 pt-1">
            {beats.map((b, i) => {
              const nextAt = beats[i + 1]?.at ?? end;
              const frac = Math.max(0, Math.min(1, (elapsed - b.at) / (nextAt - b.at)));
              const isCur = i === cur && !finished;
              const past = i < cur || finished;
              return (
                <li key={i} ref={isCur ? (el) => { if (el && shownBeat.current !== i) { shownBeat.current = i; el.scrollIntoView({ block: "nearest" }); } } : undefined} className={`relative px-5 ${isCur ? "py-3.5" : "py-2"}`}>
                  <div className="flex items-center gap-3">
                    <StepMark n={i + 1} size={22} state={past ? "done" : isCur ? "current" : "todo"} />
                    <span className={`text-[15px] ${isCur ? "text-ink" : past ? "text-ink/80" : "text-ink-soft"}`}>{b.title}</span>
                  </div>
                  {(isCur || (finished && i === beats.length - 1)) && (
                    <div className={`pl-8 ${sim.speed <= 5 ? "cv-fade" : ""}`}>
                      <p className="mt-1.5 text-[14px] leading-relaxed text-ink/85">{b.text}</p>
                      {isCur && (
                        <div className="mt-3 flex items-center gap-3">
                          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-ink/[0.07]">
                            <div className="h-full rounded-full bg-signal" style={{ width: `${frac * 100}%` }} />
                          </div>
                          {i < beats.length - 1 && (
                            <button onClick={() => c.advance(Math.max(0, beats[i + 1].at - elapsed))} className="min-h-6 shrink-0 rounded-md border border-ink/15 bg-paper px-2 py-0.5 text-[12.5px] text-ink hover:border-ink/40">
                              Next step →
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
            {finished && (
              <li className="mx-5 my-3 rounded-xl bg-signal-soft p-4 text-[14px]">
                That&apos;s it. Replay it, change the settings, or {next ? <Link className="underline underline-offset-4 hover:text-signal" href={`/explainers/${next.id}`}>watch the next one: {next.title}</Link> : <Link className="underline underline-offset-4 hover:text-signal" href="/learn">try it yourself in a Lesson</Link>}.
              </li>
            )}
          </ol>
          <div className="border-t border-ink/10 px-5 py-3 text-[13px] leading-snug text-ink-soft">This is the live simulation: pause it, change the speed, or click anything to look closer.</div>
</>}
      />
    </div>
  );
}

/** The explainer's setting. Restarting the scene is expensive, so it only restarts once the slider settles. */
function ParamSlider({ label, min, max, value, onCommit }: { label: string; min: number; max: number; value: number; onCommit: (n: number) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    if (draft === value) return;
    const t = setTimeout(() => onCommit(draft), 350);
    return () => clearTimeout(t);
  }, [draft, value, onCommit]);
  return (
    <label className="flex items-center gap-2 text-[13px] text-ink-soft">
      {label}
      <input type="range" min={min} max={max} value={draft} onChange={(e) => setDraft(+e.target.value)} className="w-24 accent-[#326ce5]" />
      <span className="w-4 font-mono text-ink">{draft}</span>
    </label>
  );
}
