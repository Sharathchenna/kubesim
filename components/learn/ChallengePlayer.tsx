"use client";

// Challenge mode: a broken cluster and a goal, no step-by-step instructions.
// Goals can be met in any order; their Checks run every frame. Hints and the
// solution stay hidden until the Learner asks.

import Link from "next/link";
import { useEffect, useState } from "react";
import { CHALLENGES, challengeBySlug } from "@/lib/lessons/challenges";
import { solutionCommands } from "@/lib/lessons/lessons";
import { replaySteps } from "@/lib/lessons/replay";
import { useSimulation } from "@/lib/sim/useSimulation";
import { AppHeader } from "../AppHeader";
import { Btn } from "../ui";
import type { Selection } from "../sim/ClusterView";
import { Inspector } from "../sim/Inspector";
import { MobileTabs, SimControls, Workspace } from "../sim/Workspace";
import { Prose } from "./Prose";
import { challengeKey, loadPassed, savePassed } from "./progress";

export const DIFFICULTY: Record<string, { label: string; cls: string }> = {
  easy: { label: "Easy", cls: "bg-green-50 text-green-700 border-green-200" },
  medium: { label: "Medium", cls: "bg-amber-50 text-amber-700 border-amber-200" },
  hard: { label: "Hard", cls: "bg-red-50 text-red-700 border-red-200" },
};

export function ChallengePlayer({ slug }: { slug: string }) {
  const ch = challengeBySlug(slug)!;
  const key = challengeKey(slug);
  const [passed, setPassed] = useState<number[]>([]);
  const sim = useSimulation({
    setup: ch.setup,
    warmupMs: ch.warmupMs ?? 0,
    seed: 7,
    editor: ch.editor,
    onReset: () => savePassed(key, [], ch.steps.length),
    onStart: (s) => {
      // Rebuild progress: replay the solutions of goals already met.
      const saved = loadPassed(key).filter((i) => i < ch.steps.length).sort((a, b) => a - b);
      let ok: number[] = [];
      if (saved.length) {
        try {
          const only = { ...ch, steps: saved.map((i) => ch.steps[i]) };
          s.history = replaySteps(only, s.cluster!, saved.length);
          ok = saved;
        } catch {
          savePassed(key, [], ch.steps.length);
        }
      }
      setPassed(ok);
    },
  });
  const [sel, setSel] = useState<Selection>(null);
  const [hints, setHints] = useState<number[]>([]);
  const [revealed, setRevealed] = useState<number[]>([]);
  const [panel, setPanel] = useState<"goals" | "inspect">("goals");
  const [mobileTab, setMobileTab] = useState<"goals" | "cluster" | "terminal">("goals");
  const c = sim.cluster;
  const idx = CHALLENGES.findIndex((x) => x.slug === slug);
  const next = CHALLENGES[idx + 1];

  // Every goal's Check, every frame.
  const live = c ? ch.steps.map((g) => g.check({ cluster: c, history: sim.history })) : [];
  const newly = live.map((ok, i) => (ok && !passed.includes(i) ? i : -1)).filter((i) => i >= 0);
  useEffect(() => {
    if (!newly.length) return;
    const t = setTimeout(() => {
      setPassed((p) => {
        const nextPassed = [...new Set([...p, ...newly])].sort((a, b) => a - b);
        savePassed(key, nextPassed, ch.steps.length);
        return nextPassed;
      });
    }, 450);
    return () => clearTimeout(t);
  }, [newly.join(","), key, ch.steps.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const done = passed.length === ch.steps.length;

  if (!c) return <div className="flex h-screen items-center justify-center bg-[#f7f8fa] text-[13px] text-slate-400">Breaking your cluster…</div>;

  const run = (cmd: string) => {
    sim.exec(cmd);
    setMobileTab("terminal");
  };
  const d = DIFFICULTY[ch.difficulty];

  return (
    <div className="flex h-screen flex-col bg-[#f7f8fa] text-slate-900">
      <AppHeader
        center={<SimControls sim={sim} />}
        right={
          <Btn
            onClick={() => {
              sim.reset();
              setSel(null);
              setHints([]);
              setRevealed([]);
            }}
          >
            Start over
          </Btn>
        }
      />
      <div className="flex min-h-0 flex-1">
        <aside className={`flex w-full shrink-0 flex-col border-r border-slate-200/80 bg-white lg:w-[380px] xl:w-[440px] ${mobileTab !== "goals" ? "max-lg:hidden" : ""}`}>
          <div className="border-b border-slate-100 px-6 pb-4 pt-5">
            <Link href="/challenges" className="text-[12px] font-medium text-slate-400 hover:text-slate-700">
              ← All challenges
            </Link>
            <div className="mt-2 flex items-center gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-400">Challenge</span>
              <span className={`rounded-full border px-2 py-px text-[11px] font-medium ${d.cls}`}>{d.label}</span>
            </div>
            <h1 className="mt-1 text-[20px] font-semibold tracking-tight text-slate-900">{ch.title}</h1>
            <div className="mt-3 flex rounded-lg bg-slate-100 p-0.5 text-[12px] font-medium">
              {(["goals", "inspect"] as const).map((p) => (
                <button key={p} onClick={() => setPanel(p)} className={`flex-1 rounded-md py-1 transition ${panel === p ? "bg-white text-slate-900 shadow-[0_1px_2px_rgba(15,23,42,.1)]" : "text-slate-500"}`}>
                  {p === "goals" ? `Goals ${passed.length}/${ch.steps.length}` : "Inspect"}
                  {p === "inspect" && sel && <span className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-blue-500 align-middle" />}
                </button>
              ))}
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {panel === "inspect" ? (
              <Inspector sim={sim} c={c} sel={sel} onSelect={setSel} />
            ) : (
              <div className="px-5 py-4">
                <div className="rounded-2xl border border-slate-200 bg-slate-50/60 p-4">
                  <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-400">The situation</div>
                  <Prose text={ch.brief} />
                </div>
                <ol className="mt-4 flex flex-col gap-2" aria-label="Goals">
                  {ch.steps.map((g, i) => {
                    const isDone = passed.includes(i);
                    return (
                      <li key={i} className={`rounded-2xl border p-3.5 ${isDone ? "border-green-200 bg-green-50/60" : "border-slate-200 bg-white"}`}>
                        <div className="flex items-start gap-3">
                          <span className={`mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full text-[11px] font-semibold ${isDone ? "bg-green-600 text-white" : "bg-slate-100 text-slate-500"}`} aria-label={isDone ? "Done" : "Not done yet"}>
                            {isDone ? "✓" : i + 1}
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="text-[14px] font-medium text-slate-900">{g.title}</div>
                            <div className="mt-1 text-[13px] text-slate-600">
                              <Prose text={g.body} />
                            </div>
                            {!isDone && (
                              <div className="mt-3 flex gap-1.5">
                                <Btn tone="ghost" onClick={() => setHints((h) => (h.includes(i) ? h : [...h, i]))}>
                                  Hint
                                </Btn>
                                <Btn tone="ghost" onClick={() => setRevealed((r) => (r.includes(i) ? r : [...r, i]))}>
                                  Show the fix
                                </Btn>
                              </div>
                            )}
                            {hints.includes(i) && !isDone && <p className="mt-2 rounded-lg border border-amber-100 bg-amber-50 px-3 py-2 text-[12.5px] text-amber-800">{g.hint}</p>}
                            {revealed.includes(i) && !isDone && (
                              <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50 p-2.5">
                                <div className="mb-1.5 text-[11.5px] text-slate-500">One way to fix it:</div>
                                <Prose text={[...solutionCommands(g, c).map((cmd) => "```bash\n" + cmd + "\n```"), ...(g.solution.yaml ? ["```yaml\n" + g.solution.yaml + "\n```"] : [])].join("\n\n")} onRun={run} onEdit={(y) => sim.openFile("fix.yaml", y)} />
                              </div>
                            )}
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ol>
                {done && (
                  <div className="mt-4 rounded-2xl border border-green-200 bg-green-50 p-5" role="status">
                    <div className="text-[15px] font-semibold text-green-900">Challenge solved</div>
                    <p className="mt-1 text-[13px] text-green-800">
                      {revealed.length ? "You got there, with a peek at the fix. Try Start over to do it from memory." : "Solved without looking at the fix."} You practised: {ch.concepts.join(", ")}.
                    </p>
                    <div className="mt-3 flex gap-2">
                      <Link href={next ? `/challenges/${next.slug}` : "/challenges"} className="inline-flex h-8 items-center rounded-lg bg-slate-900 px-3 text-[12.5px] font-medium text-white hover:bg-slate-800">
                        {next ? `Next: ${next.title} →` : "All challenges →"}
                      </Link>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </aside>
        <div className={`flex min-h-0 min-w-0 flex-1 ${mobileTab === "goals" ? "max-lg:hidden" : ""}`}>
          <Workspace
            sim={sim}
            selection={sel}
            onSelect={(s) => {
              setSel(s);
              if (s) setPanel("inspect");
            }}
            tabs={["terminal", "editor", "events", "resources"]}
            dockHeight="h-[42%]"
            mobileView={mobileTab === "cluster" ? "canvas" : "dock"}
          />
        </div>
      </div>
      <MobileTabs
        value={mobileTab}
        onChange={setMobileTab}
        options={[
          { value: "goals", label: `Goals ${passed.length}/${ch.steps.length}` },
          { value: "cluster", label: "Cluster" },
          { value: "terminal", label: "Terminal" },
        ]}
      />
    </div>
  );
}
