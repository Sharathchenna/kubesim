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

  if (!c) return <div className="font-sheet flex h-dvh items-center justify-center bg-paper text-[14px] text-ink-soft">Preparing your cluster…</div>;

  return (
    <div className="font-sheet flex h-dvh flex-col overflow-hidden bg-paper text-ink">
      <AppHeader
        trail={[{ href: "/learn", label: "Lessons" }, { label: lesson.title }]}
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
        <aside className={`flex w-full shrink-0 flex-col border-r-[1.5px] border-ink bg-paper lg:w-[380px] xl:w-[440px] ${mobileTab !== "steps" ? "max-lg:hidden" : ""}`}>
          {panel === "inspect" ? (
            <>
              <div className="flex h-11 shrink-0 items-center border-b border-ink/15 px-4">
                <button
                  onClick={() => {
                    setPanel("lesson");
                    setSel(null);
                  }}
                  className="text-[14px] text-ink-soft underline-offset-4 hover:text-ink hover:underline"
                >
                  ← Back to the steps
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto">
                <Inspector sim={sim} c={c} sel={sel} onSelect={setSel} />
              </div>
            </>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <div className="px-6 pb-5 pt-5">
                <p className="text-[13.5px] text-ink-soft">
                  <Link href="/learn" className="underline-offset-4 hover:text-ink hover:underline md:no-underline">
                    Lesson {idx + 1} of {CURRICULUM.length}
                  </Link>
                </p>
                <h1 className="font-display mt-1 text-[26px] leading-tight">{lesson.title}</h1>
                <div className="mt-3 flex items-center gap-3">
                  <div className="h-1 flex-1 bg-ink/10">
                    <div className="h-full bg-ink transition-all duration-500" style={{ width: `${(passed.length / lesson.steps.length) * 100}%` }} />
                  </div>
                  <span className="font-mono text-[12px] tabular-nums text-ink-soft">
                    {passed.length}/{lesson.steps.length}
                  </span>
                </div>
                {restoring && passed.length > 0 && (
                  <p className="mt-3 border border-ink/20 bg-ink/[0.03] px-3 py-2 text-[13px]">
                    Welcome back. We rebuilt your cluster from the {passed.length} step{passed.length > 1 ? "s" : ""} you finished.
                  </p>
                )}
              </div>
              <ol className="border-t-[1.5px] border-ink">
                {lesson.steps.map((s, i) => {
                  const isDone = passed.includes(i);
                  const isCur = i === current;
                  return (
                    <li key={i} ref={isCur ? stepRef : undefined} className={`relative border-b border-ink/20 px-6 ${isCur ? "py-5" : "py-3"}`}>
                      {isCur && <span aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-signal" />}
                      <div className="flex items-center gap-3">
                        <span className={`grid h-6 w-6 shrink-0 place-items-center border font-mono text-[11.5px] ${isDone ? "border-ink bg-ink text-paper" : isCur ? "border-signal text-signal" : "border-ink/25 text-ink-soft"}`}>
                          {isDone ? (
                            <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={2.2}><path d="M3.5 8.5l3 3 6-7" strokeLinecap="square" /></svg>
                          ) : (
                            i + 1
                          )}
                        </span>
                        <span className={`text-[15.5px] ${isCur ? "text-ink" : "text-ink-soft"}`}>{s.title}</span>
                        {isCur && ok && <span className="ml-auto text-[13px] text-green-700">Nice!</span>}
                      </div>
                      {isCur && (
                        <div className="mt-3 pl-9">
                          <Prose text={s.body} onRun={run} onEdit={openEditor} />
                          <div className="mt-4 flex items-center gap-2">
                            <span className="flex items-center gap-1.5 text-[13px] text-ink-soft">
                              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ink/40" />
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
                            <div className="mt-3 flex items-center gap-2 border border-ink/20 bg-ink/[0.03] px-3 py-2 text-[13px]">
                              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ink" />
                              Solution applied. Waiting for the cluster to catch up…
                              {!solving.boosted && sim.speed < 5 && (
                                <button
                                  className="ml-auto border border-ink/30 bg-paper px-2 py-0.5 text-[12px] hover:border-ink"
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
                          {hint && <p className="mt-2 border border-amber-600/40 bg-amber-50 px-3 py-2 text-[13px] text-amber-900">{s.hint}</p>}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ol>
              {done && (
                <div className="mx-6 my-6 border-[1.5px] border-ink p-5">
                  <div className="font-display text-[20px]">Lesson complete</div>
                  <p className="mt-1 text-[14px] text-ink-soft">You practised: {lesson.concepts.join(", ")}. Keep experimenting on this cluster, or move on.</p>
                  <div className="mt-4 flex gap-2">
                    {next ? (
                      <Link href={`/learn/${next.slug}`} className="inline-flex h-9 items-center border border-ink bg-ink px-3.5 text-[14px] text-paper hover:border-signal hover:bg-signal">
                        Next: {next.title} →
                      </Link>
                    ) : (
                      <Link href="/sandbox" className="inline-flex h-9 items-center border border-ink bg-ink px-3.5 text-[14px] text-paper hover:border-signal hover:bg-signal">
                        Open the Sandbox →
                      </Link>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
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
