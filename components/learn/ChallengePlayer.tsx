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
import { DIFFICULTY } from "./difficulty";
import { safeCheck } from "./checks";


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
  const [revealed, setRevealed] = useState<number[]>([]);
  const [panel, setPanel] = useState<"goals" | "inspect">("goals");
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
        }
      />
      <div className="flex min-h-0 flex-1">
        <aside className={`flex w-full shrink-0 flex-col border-r-[1.5px] border-ink bg-paper lg:w-[380px] xl:w-[440px] ${mobileTab !== "goals" ? "max-lg:hidden" : ""}`}>
          {panel === "inspect" ? (
            <>
              <div className="flex h-11 shrink-0 items-center border-b border-ink/15 px-4">
                <button
                  onClick={() => {
                    setPanel("goals");
                    setSel(null);
                  }}
                  className="text-[14px] text-ink-soft underline-offset-4 hover:text-ink hover:underline"
                >
                  ← Back to the goals
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
                  <Link href="/challenges" className="underline-offset-4 hover:text-ink hover:underline md:no-underline">
                    Challenge
                  </Link>{" "}
                  · {d.label} · <span className="font-mono tabular-nums">{passed.length}/{ch.steps.length}</span> goals
                </p>
                <h1 className="font-display mt-1 text-[26px] leading-tight">{ch.title}</h1>
              </div>
              <div className="border-t-[1.5px] border-ink px-6 py-5">
                <h2 className="mb-2 text-[15.5px]">The situation</h2>
                <Prose text={ch.brief} onRun={run} />
                {!done && passed.length === 0 && (
                  <div className="mt-5">
                    <p className="mb-2 text-[14px] text-ink-soft">Where to start: look before you change anything. These only read the cluster.</p>
                    <Prose text={"```bash\n" + (ch.start ?? START).join("\n") + "\n```"} onRun={run} />
                  </div>
                )}
              </div>
              <ol className="border-t-[1.5px] border-ink" aria-label="Goals">
                {ch.steps.map((g, i) => {
                  const isDone = passed.includes(i);
                  return (
                    <li key={i} className="border-b border-ink/20 px-6 py-4">
                      <div className="flex items-start gap-3">
                        <span className={`mt-0.5 grid h-6 w-6 shrink-0 place-items-center border font-mono text-[11.5px] ${isDone ? "border-ink bg-ink text-paper" : "border-ink/25 text-ink-soft"}`} aria-label={isDone ? "Done" : "Not done yet"}>
                          {isDone ? "✓" : i + 1}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className={`text-[15.5px] ${isDone ? "text-ink-soft line-through decoration-ink/30" : "text-ink"}`}>{g.title}</div>
                          {!isDone && (
                            <>
                              <div className="mt-1">
                                <Prose text={g.body} />
                              </div>
                              <div className="mt-3 flex gap-1.5">
                                <Btn tone="ghost" onClick={() => setHints((h) => (h.includes(i) ? h : [...h, i]))}>
                                  Hint
                                </Btn>
                                <Btn onClick={() => setRevealed((r) => (r.includes(i) ? r : [...r, i]))}>
                                  Show the fix
                                </Btn>
                              </div>
                            </>
                          )}
                          {hints.includes(i) && !isDone && <p className="mt-2 border border-amber-600/40 bg-amber-50 px-3 py-2 text-[13px] text-amber-900">{g.hint}</p>}
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
                <div className="mx-6 my-6 border-[1.5px] border-ink p-5" role="status">
                  <div className="font-display text-[20px]">Challenge solved</div>
                  <p className="mt-1 text-[14px] text-ink-soft">
                    {revealed.length ? "You got there, with a peek at the fix. Try Start over to do it from memory." : "Solved without looking at the fix."} You practised: {ch.concepts.join(", ")}.
                  </p>
                  <div className="mt-4 flex gap-2">
                    <Link href={next ? `/challenges/${next.slug}` : "/challenges"} className="inline-flex h-9 items-center border border-ink bg-ink px-3.5 text-[14px] text-paper hover:border-signal hover:bg-signal">
                      {next ? `Next: ${next.title} →` : "All challenges →"}
                    </Link>
                  </div>
                </div>
              )}
            </div>
          )}
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
            dockHeight="h-[38%]"
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
