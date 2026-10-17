"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { lessonBySlug, solutionCommands } from "@/lib/lessons/lessons";
import { CURRICULUM, curriculumIndex } from "@/lib/lessons/curriculum";
import { useSimulation } from "@/lib/sim/useSimulation";
import { AppHeader } from "../AppHeader";
import { Btn } from "../ui";
import type { Selection } from "../sim/ClusterView";
import { Inspector } from "../sim/Inspector";
import { MobileTabs, SimControls, Workspace } from "../sim/Workspace";
import { Prose } from "./Prose";
import { loadPassed, savePassed } from "./progress";
import { replaySteps } from "@/lib/lessons/replay";
import { prefersReducedMotion, safeCheck } from "./checks";

export function LessonPlayer({ slug }: { slug: string }) {
  const lesson = lessonBySlug(slug)!;
  const [passed, setPassed] = useState<number[]>([]);
  const [restoring, setRestoring] = useState(false);
  const sim = useSimulation({
    setup: lesson.setup,
    warmupMs: lesson.warmupMs ?? 0,
    seed: 7,
    editor: lesson.editor,
    onReset: () => savePassed(slug, [], lesson.steps.length),
    // Restore saved progress: replay the passed Steps' solutions so the cluster matches.
    onStart: (s) => {
      const saved = loadPassed(slug);
      const n = saved.length && saved.every((i, k) => i === k) ? saved.length : 0;
      let restored = 0;
      if (n) {
        try {
          s.history = replaySteps(lesson, s.cluster!, n);
          restored = n;
        } catch {
          savePassed(slug, [], lesson.steps.length);
        }
      }
      setPassed(Array.from({ length: restored }, (_, i) => i));
      setRestoring(restored > 0);
    },
  });
  const [sel, setSel] = useState<Selection>(null);
  const [hint, setHint] = useState(false);
  const [solving, setSolving] = useState<{ step: number; boosted: boolean } | null>(null);
  const [panel, setPanel] = useState<"lesson" | "inspect">("lesson");
  const [mobileTab, setMobileTab] = useState<"steps" | "cluster" | "terminal">("steps");
  const c = sim.cluster;
  const current = lesson.steps.findIndex((_, i) => !passed.includes(i));
  const done = current === -1;
  const idx = curriculumIndex(slug);
  const next = CURRICULUM[idx + 1];
  const stepRef = useRef<HTMLLIElement>(null);

  // Re-evaluate the current step's Check whenever the cluster changes. A Check that throws counts as "not yet".
  const ok = !!c && !done && safeCheck(() => lesson.steps[current].check({ cluster: c, history: sim.history }));
  useEffect(() => {
    if (!ok) return;
    const t = setTimeout(() => {
      setPassed((p) => {
        if (p.includes(current)) return p;
        const nextPassed = [...p, current];
        savePassed(slug, nextPassed, lesson.steps.length);
        return nextPassed;
      });
      setHint(false);
      setSolving((sv) => {
        if (sv?.boosted) sim.setSpeed(1);
        return null;
      });
    }, 450);
    return () => clearTimeout(t);
  }, [ok, current, slug, lesson.steps.length, sim]);
  useEffect(() => {
    stepRef.current?.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "nearest" });
  }, [passed]);

  const openEditor = (yaml: string) => {
    sim.openFile("manifest.yaml", yaml);
    setMobileTab("terminal");
  };
  const run = (cmd: string) => {
    sim.exec(cmd);
    setMobileTab("terminal");
  };
  const showMe = () => {
    const s = lesson.steps[current].solution;
    // A solution can depend on what earlier commands created (e.g. a NodePort
    // is only known after `expose`): re-plan until it asks for nothing new.
    const ranCmds = new Set<string>();
    for (let round = 0; round < 3; round++) {
      const todo = solutionCommands(lesson.steps[current], c!).filter((cmd) => !ranCmds.has(cmd));
      if (!todo.length) break;
      for (const cmd of todo) {
        ranCmds.add(cmd);
        sim.exec(cmd);
      }
    }
    if (s.yaml) {
      openEditor(s.yaml);
      sim.apply(s.yaml);
    }
    setSolving({ step: current, boosted: false });
  };

  if (!c) return <div className="flex h-dvh items-center justify-center bg-[#f7f8fa] text-[13px] text-slate-500">Preparing your cluster…</div>;

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-[#f7f8fa] text-slate-900">
      <AppHeader
        center={<SimControls sim={sim} />}
        right={
          <Btn
            onClick={() => {
              if ((passed.length || sim.history.length) && !window.confirm("Start this lesson over? Your progress in it and its cluster are reset.")) return;
              sim.reset();
              setSel(null);
              setSolving(null);
            }}
          >
            Start over
          </Btn>
        }
      />
      <div className="flex min-h-0 flex-1">
        <aside className={`flex w-full shrink-0 flex-col border-r border-slate-200/80 bg-white lg:w-[380px] xl:w-[440px] ${mobileTab !== "steps" ? "max-lg:hidden" : ""}`}>
          <div className="border-b border-slate-100 px-6 pb-4 pt-5">
            <Link href="/learn" className="inline-flex min-h-6 items-center text-[12px] font-medium text-slate-500 hover:text-slate-700">
              ← All lessons
            </Link>
            <div className="mt-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500">Lesson {idx + 1} of {CURRICULUM.length}</div>
            {restoring && passed.length > 0 && (
              <p className="mt-2 rounded-lg bg-blue-50 px-2.5 py-1.5 text-[12px] text-blue-800">
                Welcome back. We rebuilt your cluster from the {passed.length} step{passed.length > 1 ? "s" : ""} you finished.
              </p>
            )}
            <h1 className="mt-1 text-[20px] font-semibold tracking-tight text-slate-900">{lesson.title}</h1>
            <div className="mt-3 flex items-center gap-3">
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100">
                <div className="h-full rounded-full bg-slate-900 transition-all duration-500" style={{ width: `${(passed.length / lesson.steps.length) * 100}%` }} />
              </div>
              <span className="font-mono text-[11.5px] tabular-nums text-slate-500">
                {passed.length}/{lesson.steps.length}
              </span>
            </div>
            <div className="mt-3 flex rounded-lg bg-slate-100 p-0.5 text-[12px] font-medium">
              {(["lesson", "inspect"] as const).map((p) => (
                <button key={p} onClick={() => setPanel(p)} className={`flex-1 rounded-md py-1 capitalize transition ${panel === p ? "bg-white text-slate-900 shadow-[0_1px_2px_rgba(15,23,42,.1)]" : "text-slate-500"}`}>
                  {p === "lesson" ? "Steps" : "Inspect"}
                  {p === "inspect" && sel && <span className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-blue-500 align-middle" />}
                </button>
              ))}
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {panel === "inspect" ? (
              <Inspector sim={sim} c={c} sel={sel} onSelect={setSel} />
            ) : (
              <ol className="flex flex-col px-4 py-4">
                {lesson.steps.map((s, i) => {
                  const isDone = passed.includes(i);
                  const isCur = i === current;
                  return (
                    <li key={i} ref={isCur ? stepRef : undefined} className={`relative rounded-2xl px-3 py-3 transition ${isCur ? "border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,.04),0_8px_24px_rgba(15,23,42,.05)]" : "border border-transparent"}`}>
                      <div className="flex items-center gap-3">
                        <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-[11px] font-semibold ${isDone ? "bg-green-600 text-white" : isCur ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-500"}`}>
                          {isDone ? (
                            <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={2.2}><path d="M3.5 8.5l3 3 6-7" strokeLinecap="round" strokeLinejoin="round" /></svg>
                          ) : (
                            i + 1
                          )}
                        </span>
                        <span className={`text-[14px] font-medium ${isCur ? "text-slate-900" : isDone ? "text-slate-500" : "text-slate-500"}`}>{s.title}</span>
                        {isCur && ok && <span className="ml-auto text-[11.5px] font-medium text-green-600">Nice!</span>}
                      </div>
                      {isCur && (
                        <div className="mt-3 pl-9">
                          <Prose text={s.body} onRun={run} onEdit={openEditor} />
                          <div className="mt-4 flex items-center gap-2">
                            <span className="flex items-center gap-1.5 text-[12px] text-slate-500">
                              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
                              Waiting for you…
                            </span>
                            <div className="ml-auto flex gap-1.5">
                              <Btn tone="ghost" onClick={() => setHint(!hint)}>
                                Hint
                              </Btn>
                              <Btn onClick={showMe} title="Runs the commands for this step so you can watch how it is done">
                                Show me
                              </Btn>
                            </div>
                          </div>
                          {solving?.step === i && !ok && (
                            <div className="mt-3 flex items-center gap-2 rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-[12.5px] text-blue-800">
                              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-blue-500" />
                              Solution applied. Waiting for the cluster to catch up…
                              {!solving.boosted && sim.speed < 5 && (
                                <button
                                  className="ml-auto rounded-md border border-blue-200 bg-white px-2 py-0.5 text-[11.5px] font-medium hover:bg-blue-50"
                                  onClick={() => {
                                    sim.setSpeed(5);
                                    setSolving({ step: i, boosted: true });
                                  }}
                                >
                                  Skip ahead (5×)
                                </button>
                              )}
                            </div>
                          )}
                          {hint && <p className="mt-2 rounded-lg border border-amber-100 bg-amber-50 px-3 py-2 text-[12.5px] text-amber-800">{s.hint}</p>}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ol>
            )}
            {done && panel === "lesson" && (
              <div className="mx-4 mb-6 rounded-2xl border border-green-200 bg-green-50 p-5">
                <div className="text-[15px] font-semibold text-green-900">Lesson complete</div>
                <p className="mt-1 text-[13px] text-green-800">You practised: {lesson.concepts.join(", ")}. Keep experimenting on this cluster, or move on.</p>
                <div className="mt-3 flex gap-2">
                  {next ? (
                    <Link href={`/learn/${next.slug}`} className="inline-flex h-8 items-center rounded-lg bg-slate-900 px-3 text-[12.5px] font-medium text-white hover:bg-slate-800">
                      Next: {next.title} →
                    </Link>
                  ) : (
                    <Link href="/sandbox" className="inline-flex h-8 items-center rounded-lg bg-slate-900 px-3 text-[12.5px] font-medium text-white hover:bg-slate-800">
                      Open the Sandbox →
                    </Link>
                  )}
                </div>
              </div>
            )}
          </div>
        </aside>
        <div className={`flex min-h-0 min-w-0 flex-1 ${mobileTab === "steps" ? "max-lg:hidden" : ""}`}>
          <Workspace
            sim={sim}
            selection={sel}
            onSelect={(s) => {
              setSel(s);
              if (s) setPanel("inspect");
            }}
            tabs={["terminal", "editor", "events", "resources"]}
            initialTab={lesson.startTab ?? "terminal"}
            dockHeight="h-[38%]"
            mobileView={mobileTab === "cluster" ? "canvas" : "dock"}
          />
        </div>
      </div>
      <MobileTabs
        value={mobileTab}
        onChange={setMobileTab}
        options={[
          { value: "steps", label: `Steps ${passed.length}/${lesson.steps.length}` },
          { value: "cluster", label: "Cluster" },
          { value: "terminal", label: "Terminal" },
        ]}
      />
    </div>
  );
}
