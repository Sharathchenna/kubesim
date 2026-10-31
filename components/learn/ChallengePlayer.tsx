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
import { Btn, StepMark } from "../ui";
import type { Selection } from "../sim/ClusterView";
import { Inspector } from "../sim/Inspector";
import { LayoutToggle, MobileTabs, SimControls, Workspace, useLayoutChoice } from "../sim/Workspace";
import { Prose } from "./Prose";
import { Burst } from "../Burst";
import { challengeKey, loadPassed, savePassed } from "./progress";
import { DIFFICULTY } from "./difficulty";
import { safeCheck } from "./checks";
import { capture } from "@/lib/posthog-client";


/** A first look that fits any broken cluster. */
const START = ["kubectl get pods -o wide", "kubectl get events --sort-by=.lastTimestamp"];

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
  /** Goals met in this visit: each one gets a little burst. */
  const [celebrate, setCelebrate] = useState(0);
  const [revealed, setRevealed] = useState<number[]>([]);
  const [layout, setLayout] = useLayoutChoice("spotlight");
  const [mobileTab, setMobileTab] = useState<"goals" | "cluster" | "terminal">("goals");
  const c = sim.cluster;
  const idx = CHALLENGES.findIndex((x) => x.slug === slug);
  const next = CHALLENGES[idx + 1];

  // Every goal's Check, every frame.
  const live = c ? ch.steps.map((g) => safeCheck(() => g.check({ cluster: c, history: sim.history }))) : [];
  const newly = live.map((ok, i) => (ok && !passed.includes(i) ? i : -1)).filter((i) => i >= 0);
  useEffect(() => {
    if (!newly.length) return;
    const t = setTimeout(() => {
      setPassed((p) => {
        const nextPassed = [...new Set([...p, ...newly])].sort((a, b) => a - b);
        savePassed(key, nextPassed, ch.steps.length);
        return nextPassed;
      });
      setCelebrate((n) => n + 1);
    }, 450);
    return () => clearTimeout(t);
  }, [newly.join(","), key, ch.steps.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const done = passed.length === ch.steps.length;

  if (!c) return <div className="font-sheet flex h-dvh items-center justify-center bg-paper text-[14px] text-ink-soft">Breaking your cluster…</div>;

  const run = (cmd: string) => {
    sim.exec(cmd);
    setMobileTab("terminal");
  };
  const d = DIFFICULTY[ch.difficulty];

  return (
    <div className="font-sheet flex h-dvh flex-col overflow-hidden bg-paper text-ink">
      <AppHeader
        trail={[{ href: "/challenges", label: "Challenges" }, { label: ch.title }]}
        center={<SimControls sim={sim} />}
        right={
          <>
            <LayoutToggle value={layout} onChange={setLayout} />
            <Btn
              onClick={() => {
                if ((passed.length || sim.history.length) && !window.confirm("Start this challenge over? The cluster is broken again and your progress in it is reset.")) return;
                sim.reset();
                setSel(null);
                setHints([]);
                setRevealed([]);
              }}
            >
              Start over
            </Btn>
          </>
        }
      />
      <Workspace
        sim={sim}
        selection={sel}
        onSelect={setSel}
        inspector={sel && <Inspector sim={sim} c={c} sel={sel} onSelect={setSel} />}
        onCloseInspector={() => setSel(null)}
        tabs={["terminal", "editor", "events", "resources"]}
        layout={layout}
        mobileView={mobileTab === "cluster" ? "canvas" : mobileTab === "goals" ? "side" : "dock"}
        sideLabel="Challenge"
        side={
          <>
              <div className="sticky top-0 z-10 border-b border-ink/10 bg-paper px-5 pb-3.5 pt-4">
                <p className="text-[13.5px] text-ink-soft">
                  <Link href="/challenges" className="underline-offset-4 hover:text-ink hover:underline md:no-underline">
                    Challenge
                  </Link>{" "}
                  · {d.label} · <span className="font-mono tabular-nums">{passed.length}/{ch.steps.length}</span> goals
                </p>
                <h1 className="font-display mt-0.5 text-[22px] leading-tight">{ch.title}</h1>
              </div>
              <div className="px-5 py-4">
                <h2 className="mb-2 text-[15.5px]">The situation</h2>
                <Prose text={ch.brief} onRun={run} />
                {!done && passed.length === 0 && (
                  <div className="mt-5">
                    <p className="mb-2 text-[14px] text-ink-soft">Where to start: look before you change anything. These only read the cluster.</p>
                    <Prose text={"```bash\n" + (ch.start ?? START).join("\n") + "\n```"} onRun={run} />
                  </div>
                )}
              </div>
              <ol className="border-t border-ink/10" aria-label="Goals">
                {ch.steps.map((g, i) => {
                  const isDone = passed.includes(i);
                  return (
                    <li key={i} className="border-b border-ink/10 px-5 py-4">
                      <div className="flex items-start gap-3">
                        <span className="mt-0.5" role="img" aria-label={isDone ? "Done" : "Not done yet"}>
                          <StepMark n={i + 1} state={isDone ? "done" : "current"} />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className={`text-[15.5px] ${isDone ? "text-ink-soft line-through decoration-ink/30" : "text-ink"}`}>{g.title}</div>
                          {!isDone && (
                            <>
                              <div className="mt-1">
                                <Prose text={g.body} />
                              </div>
                              <div className="mt-3 flex gap-1.5">
                                <Btn tone="ghost" onClick={() => { capture("challenge_hint_requested", { challenge_slug: slug, goal_number: i + 1 }); setHints((h) => (h.includes(i) ? h : [...h, i])); }}>
                                  Hint
                                </Btn>
                                <Btn onClick={() => { capture("challenge_solution_revealed", { challenge_slug: slug, goal_number: i + 1 }); setRevealed((r) => (r.includes(i) ? r : [...r, i])); }}>
                                  Show the fix
                                </Btn>
                              </div>
                            </>
                          )}
                          {hints.includes(i) && !isDone && <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-amber-900">{g.hint}</p>}
                          {revealed.includes(i) && !isDone && (
                            <div className="mt-3">
                              <div className="mb-1.5 text-[13px] text-ink-soft">One way to fix it:</div>
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
                <div className="relative mx-5 my-5 rounded-xl bg-signal-soft p-5" role="status">
                  <Burst shot={celebrate} pieces={30} spread={150} />
                  <div className="font-display text-[20px]">Challenge solved</div>
                  <p className="mt-1 text-[14px] text-ink-soft">
                    {revealed.length ? "You got there, with a peek at the fix. Try Start over to do it from memory." : "Solved without looking at the fix."} You practised: {ch.concepts.join(", ")}.
                  </p>
                  <div className="mt-4 flex gap-2">
                    <Link href={next ? `/challenges/${next.slug}` : "/challenges"} className="inline-flex h-9 items-center btn-primary rounded-lg px-3.5 text-[14px] text-white font-medium">
                      {next ? `Next: ${next.title} →` : "All challenges →"}
                    </Link>
                  </div>
                </div>
              )}
                      </>
        }
      />
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
