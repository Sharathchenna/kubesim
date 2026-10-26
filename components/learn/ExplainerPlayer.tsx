"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { EXPLAINERS, explainerById } from "@/lib/explainers/explainers";
import { useSimulation } from "@/lib/sim/useSimulation";
import { AppHeader } from "../AppHeader";
import { Btn } from "../ui";
import type { Selection } from "../sim/ClusterView";
import { SimControls, Workspace } from "../sim/Workspace";

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
            {ex.param && <ParamSlider label={ex.param.label} min={ex.param.min} max={ex.param.max} value={param} onCommit={setParam} />}
            <Btn onClick={restart}>{finished ? "Replay" : "Start over"}</Btn>
          </>
        }
      />
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <aside className="flex max-h-[45vh] w-full shrink-0 flex-col border-ink bg-paper max-lg:border-b-[1.5px] lg:max-h-none lg:w-[380px] lg:border-r-[1.5px]">
          <div className="px-6 pb-5 pt-5">
            <p className="text-[13.5px] text-ink-soft">
              <Link href="/explainers" className="underline-offset-4 hover:text-ink hover:underline md:no-underline">
                Explainer
              </Link>{" "}
              · {beats.length} steps
            </p>
            <h1 className="font-display mt-1 text-[26px] leading-tight">{ex.title}</h1>
            <p className="mt-1.5 text-[14px] leading-snug text-ink-soft">{ex.summary}</p>
          </div>
          <ol className="min-h-0 flex-1 overflow-y-auto border-t-[1.5px] border-ink">
            {beats.map((b, i) => {
              const nextAt = beats[i + 1]?.at ?? end;
              const frac = Math.max(0, Math.min(1, (elapsed - b.at) / (nextAt - b.at)));
              const isCur = i === cur && !finished;
              const past = i < cur || finished;
              return (
                <li key={i} className={`relative border-b border-ink/20 px-6 ${isCur ? "py-4" : "py-2.5"}`}>
                  {isCur && <span aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-signal" />}
                  <div className="flex items-center gap-3">
                    <span className={`grid h-5 w-5 shrink-0 place-items-center border font-mono text-[10.5px] ${past ? "border-ink bg-ink text-paper" : isCur ? "border-signal text-signal" : "border-ink/25 text-ink-soft"}`}>{i + 1}</span>
                    <span className={`text-[15px] ${isCur ? "text-ink" : past ? "text-ink/80" : "text-ink-soft"}`}>{b.title}</span>
                  </div>
                  {(isCur || (finished && i === beats.length - 1)) && (
                    <div className={`pl-8 ${sim.speed <= 5 ? "cv-fade" : ""}`}>
                      <p className="mt-1.5 text-[14px] leading-relaxed text-ink/85">{b.text}</p>
                      {isCur && (
                        <div className="mt-3 flex items-center gap-3">
                          <div className="h-1 flex-1 bg-ink/10">
                            <div className="h-full bg-ink" style={{ width: `${frac * 100}%` }} />
                          </div>
                          {i < beats.length - 1 && (
                            <button onClick={() => c.advance(Math.max(0, beats[i + 1].at - elapsed))} className="min-h-6 shrink-0 border border-ink/30 bg-paper px-2 py-0.5 text-[12.5px] text-ink hover:border-ink">
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
              <li className="m-6 border-[1.5px] border-ink p-4 text-[14px]">
                That&apos;s it. Replay it, change the settings, or {next ? <Link className="underline underline-offset-4 hover:text-signal" href={`/explainers/${next.id}`}>watch the next one: {next.title}</Link> : <Link className="underline underline-offset-4 hover:text-signal" href="/learn">try it yourself in a Lesson</Link>}.
              </li>
            )}
          </ol>
          <div className="border-t border-ink/15 px-6 py-3 text-[13px] leading-snug text-ink-soft">This is the live simulation: pause it, change the speed, or click anything to look closer.</div>
        </aside>
        <Workspace sim={sim} selection={sel} onSelect={setSel} tabs={["events", "commands"]} initialTab="commands" narration={false} dockHeight="h-44" mobileView="canvas" interactive={false} />
      </div>
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
      <input type="range" min={min} max={max} value={draft} onChange={(e) => setDraft(+e.target.value)} className="w-24 accent-[#172340]" />
      <span className="w-4 font-mono text-ink">{draft}</span>
    </label>
  );
}
