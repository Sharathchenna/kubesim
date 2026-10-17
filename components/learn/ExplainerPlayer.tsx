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
  if (!c) return <div className="flex h-dvh items-center justify-center bg-[#f7f8fa] text-[13px] text-slate-500">Setting the scene…</div>;

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
    <div className="flex h-dvh flex-col overflow-hidden bg-[#f7f8fa] text-slate-900">
      <AppHeader
        center={<SimControls sim={sim} />}
        right={
          <>
            {ex.param && <ParamSlider label={ex.param.label} min={ex.param.min} max={ex.param.max} value={param} onCommit={setParam} />}
            <Btn onClick={restart}>{finished ? "Replay" : "Start over"}</Btn>
          </>
        }
      />
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <aside className="flex max-h-[45vh] w-full shrink-0 lg:max-h-none lg:w-[380px] flex-col border-r border-slate-200/80 bg-white">
          <div className="border-b border-slate-100 px-5 py-4">
            <Link href="/explainers" className="inline-flex min-h-6 items-center text-[12px] font-medium text-slate-500 hover:text-slate-700">
              ← All explainers
            </Link>
            <h1 className="mt-2 text-[18px] font-semibold tracking-tight">{ex.title}</h1>
            <p className="mt-1 text-[12.5px] leading-relaxed text-slate-500">{ex.summary}</p>
          </div>
          <ol className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
            {beats.map((b, i) => {
              const nextAt = beats[i + 1]?.at ?? end;
              const frac = Math.max(0, Math.min(1, (elapsed - b.at) / (nextAt - b.at)));
              const isCur = i === cur && !finished;
              return (
                <li key={i} className={`relative mb-1 rounded-xl px-3 py-2.5 ${isCur ? "border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,.04),0_8px_24px_rgba(15,23,42,.05)]" : "border border-transparent"}`}>
                  <div className="flex items-center gap-2.5">
                    <span className={`grid h-5 w-5 shrink-0 place-items-center rounded-full text-[10px] font-semibold ${i < cur || finished ? "bg-slate-900 text-white" : isCur ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-500"}`}>{i + 1}</span>
                    <span className={`text-[13.5px] font-medium ${i <= cur ? "text-slate-900" : "text-slate-500"}`}>{b.title}</span>
                  </div>
                  {(isCur || (finished && i === beats.length - 1)) && (
                    <div className={`pl-[30px] ${sim.speed <= 5 ? "cv-fade" : ""}`}>
                      <p className="mt-1.5 text-[13.5px] leading-relaxed text-slate-600">{b.text}</p>
                      {isCur && (
                        <div className="mt-3 flex items-center gap-2">
                          <div className="h-1 flex-1 overflow-hidden rounded-full bg-slate-100">
                            <div className="h-full rounded-full bg-slate-900" style={{ width: `${frac * 100}%` }} />
                          </div>
                          {i < beats.length - 1 && (
                            <button onClick={() => c.advance(Math.max(0, beats[i + 1].at - elapsed))} className="min-h-6 shrink-0 rounded-md border border-slate-200 bg-white px-2 py-0.5 text-[11px] font-medium text-slate-600 hover:bg-slate-50">
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
              <li className="mt-2 rounded-xl border border-green-200 bg-green-50 p-3 text-[12.5px] text-green-800">
                That&apos;s it. Replay it, change the settings, or {next ? <Link className="font-medium underline" href={`/explainers/${next.id}`}>watch the next one: {next.title}</Link> : <Link className="font-medium underline" href="/learn">try it yourself in a Lesson</Link>}.
              </li>
            )}
          </ol>
          <div className="border-t border-slate-100 p-4 text-[12px] leading-relaxed text-slate-500">Everything here is the live simulation. Pause, change speed, or click any object to look closer.</div>
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
    <label className="flex items-center gap-2 text-[12.5px] text-slate-500">
      {label}
      <input type="range" min={min} max={max} value={draft} onChange={(e) => setDraft(+e.target.value)} className="w-24 accent-slate-900" />
      <span className="w-4 font-mono text-slate-800">{draft}</span>
    </label>
  );
}
