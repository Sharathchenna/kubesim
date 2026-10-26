"use client";

// A timed practice exam in the style of the CKAD/CKA: independent tasks with
// points, done in any order, graded from cluster state when you submit (or
// when time runs out). No hints during the exam; solutions afterwards.

import Link from "next/link";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { EXAM_TRADEMARK_NOTICE, examBySlug, type Exam } from "@/lib/lessons/exams";
import { solutionCommands } from "@/lib/lessons/lessons";
import { useSimulation } from "@/lib/sim/useSimulation";
import { AppHeader } from "../AppHeader";
import { Btn } from "../ui";
import type { Selection } from "../sim/ClusterView";
import { Inspector } from "../sim/Inspector";
import { MobileTabs, Workspace } from "../sim/Workspace";
import { Prose } from "./Prose";
import { getItem, loadExamResults, removeItem, saveExamResult, setItem, type ExamResult } from "./progress";

const startKey = (slug: string) => `kubesim.exam.${slug}.started.v1`;
const gradedKey = (slug: string) => `kubesim.exam.${slug}.graded.v1`;

function mmss(ms: number) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

const localListeners = new Set<() => void>();
const notifyLocal = () => localListeners.forEach((l) => l());

/** A localStorage value as React state (empty during static rendering). */
function useLocal(key: string): string | null {
  return useSyncExternalStore(
    (fn) => {
      localListeners.add(fn);
      window.addEventListener("storage", fn);
      return () => {
        localListeners.delete(fn);
        window.removeEventListener("storage", fn);
      };
    },
    () => getItem(key),
    () => null,
  );
}

export function ExamPlayer({ slug }: { slug: string }) {
  const exam = examBySlug(slug)!;
  const raw = Number(useLocal(startKey(slug)));
  const graded = Number(useLocal(gradedKey(slug)));
  // Keep showing results in this session; after a reload a graded exam goes back to the start page.
  const [keep, setKeep] = useState(false);
  const startedAt = raw && (graded !== raw || keep) ? raw : null;
  if (!startedAt)
    return (
      <ExamIntro
        exam={exam}
        onStart={() => {
          setItem(startKey(slug), String(Date.now()));
          removeItem(`kubesim.exam.${slug}.cluster.v1`);
          notifyLocal();
        }}
      />
    );
  return (
    <ExamRun
      exam={exam}
      startedAt={startedAt}
      onGraded={() => {
        setKeep(true);
        setItem(gradedKey(slug), String(startedAt));
        notifyLocal();
      }}
      onExit={() => {
        setKeep(false);
        removeItem(startKey(slug));
        removeItem(gradedKey(slug));
        notifyLocal();
      }}
    />
  );
}

function ExamIntro({ exam, onStart }: { exam: Exam; onStart: () => void }) {
  const stored = useLocal(`kubesim.exam.${exam.slug}.results.v1`);
  const results: ExamResult[] = stored ? loadExamResults(exam.slug) : [];
  const best = results.reduce((a, r) => Math.max(a, r.score), 0);
  return (
    <div className="font-sheet min-h-screen bg-paper text-ink">
      <AppHeader sheet />
      <main className="mx-auto max-w-3xl px-6 pb-24 pt-12">
        <Link href="/exams" className="inline-flex min-h-6 items-center text-[13px] text-ink-soft underline-offset-4 hover:text-ink hover:underline">
          ← All practice exams
        </Link>
        <div className="mt-6 text-[13px] font-medium text-ink-soft">{exam.style}</div>
        <h1 className="font-display mt-1 text-balance text-[40px] leading-[1.05] sm:text-[48px]">{exam.title}</h1>
        <p className="text-pretty mt-3 max-w-2xl text-[17px] leading-snug text-ink-soft">{exam.summary}</p>
        <p className="mt-2 text-[14px] leading-snug text-ink-soft">This is not the real exam: it&apos;s kubesim&apos;s own practice set, written in the same style.</p>
        <dl className="mt-8 grid grid-cols-3 border-[1.5px] border-ink">
          {[
            ["Time", `${exam.minutes} min`],
            ["Tasks", String(exam.tasks.length)],
            ["Pass mark", `${exam.passPercent}%`],
          ].map(([k, v]) => (
            <div key={k} className="border-ink p-4 [&+&]:border-l">
              <dt className="text-[13px] text-ink-soft">{k}</dt>
              <dd className="mt-1 font-mono text-[22px] font-medium sm:text-[26px]">{v}</dd>
            </div>
          ))}
        </dl>
        <section className="mt-10" aria-labelledby="h-how">
          <h2 id="h-how" className="font-display text-[24px]">
            How it works
          </h2>
          <ul className="mt-3 border-t-[1.5px] border-ink text-[15px] leading-snug text-ink/85 [&>li]:border-b [&>li]:border-ink/25 [&>li]:px-1 [&>li]:py-2.5">
            <li>You get a fresh cluster and a terminal. Tasks are independent; do them in any order.</li>
            <li>Read each task carefully: names, namespaces, images and ports must match exactly.</li>
            <li>There are no hints and no checkmarks while the clock runs, just like the real exam. <code className="bg-ink/[0.05] px-1 font-mono text-[0.88em] text-ink">kubectl explain</code> and <code className="bg-ink/[0.05] px-1 font-mono text-[0.88em] text-ink">--dry-run=client -o yaml</code> are fair game. In the real exam you can also open the Kubernetes docs (kubernetes.io/docs and kubernetes.io/blog) and the Helm docs (helm.sh/docs) in the exam browser, so practising looking things up in the docs is part of preparing.</li>
            <li>Submit when you&apos;re done, or it grades itself when time runs out. Then you see the solutions.</li>
            <li>The clock keeps running if you leave the page; your cluster is saved in this browser.</li>
          </ul>
        </section>
        <div className="mt-8 flex flex-wrap items-center gap-4">
          <button onClick={onStart} className="inline-flex h-11 items-center border-[1.5px] border-ink bg-ink px-5 text-[15px] text-paper transition-colors hover:border-signal hover:bg-signal">
            Start the {exam.minutes}-minute exam
          </button>
          {results.length > 0 && (
            <span className="text-[14px] text-ink-soft">
              Best score: <b className="font-mono font-medium text-ink">{best}%</b> over {results.length} attempt{results.length === 1 ? "" : "s"}
            </span>
          )}
        </div>
        <p className="mt-12 border-t border-ink/25 pt-4 text-[12.5px] leading-relaxed text-ink-soft">{EXAM_TRADEMARK_NOTICE}</p>
      </main>
    </div>
  );
}

function ExamRun({ exam, startedAt, onExit, onGraded }: { exam: Exam; startedAt: number; onExit: () => void; onGraded: () => void }) {
  const sim = useSimulation({ setup: exam.setup, warmupMs: exam.warmupMs ?? 0, seed: 11, persistKey: `kubesim.exam.${exam.slug}.cluster.v1` });
  const [sel, setSel] = useState<Selection>(null);
  const [panel, setPanel] = useState<"tasks" | "inspect">("tasks");
  const [mobileTab, setMobileTab] = useState<"tasks" | "cluster" | "terminal">("tasks");
  const [open, setOpen] = useState(0);
  const [flags, setFlags] = useState<number[]>([]);
  const [result, setResult] = useState<{ passed: boolean[]; score: number; seconds: number } | null>(null);
  const [wall, setWall] = useState(() => Date.now());
  const submitRef = useRef<() => void>(() => {});
  useEffect(() => {
    const t = setInterval(() => {
      setWall(Date.now());
      // Time's up: grade what's there.
      if (Date.now() >= startedAt + exam.minutes * 60_000) submitRef.current();
    }, 500);
    return () => clearInterval(t);
  }, [startedAt, exam.minutes]);
  const c = sim.cluster;
  const left = startedAt + exam.minutes * 60_000 - wall;
  const total = exam.tasks.reduce((a, t) => a + t.points, 0);

  const submit = () => {
    if (!c || result) return;
    const passed = exam.tasks.map((t) => {
      try {
        return t.check({ cluster: c, history: sim.history });
      } catch {
        return false;
      }
    });
    const got = exam.tasks.reduce((a, t, i) => a + (passed[i] ? t.points : 0), 0);
    const score = Math.round((got / total) * 100);
    const seconds = Math.round((Date.now() - startedAt) / 1000);
    saveExamResult(exam.slug, { score, passed: score >= exam.passPercent, at: Date.now(), seconds });
    setResult({ passed, score, seconds });
    onGraded();
  };
  useEffect(() => {
    submitRef.current = submit;
  });

  if (!c) return <div className="font-sheet flex h-dvh items-center justify-center bg-paper text-[13px] text-ink-soft">Preparing the exam cluster…</div>;

  const pass = !!result && result.score >= exam.passPercent;
  return (
    <div className="font-sheet flex h-dvh flex-col overflow-hidden bg-paper text-ink">
      <AppHeader
        trail={[{ href: "/exams", label: "Exams" }, { label: exam.title }]}
        center={
          result ? (
            <span className={`font-mono text-[14px] font-medium tabular-nums ${pass ? "text-green-700" : "text-red-700"}`}>
              {result.score}% · {pass ? "Pass" : "Not yet"}
            </span>
          ) : (
            <span className={`flex items-center gap-2 font-mono text-[15px] font-medium tabular-nums ${left < 5 * 60_000 ? "text-red-700" : "text-ink"}`} role="timer" aria-label={`Time left ${mmss(left)}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${left < 5 * 60_000 ? "animate-pulse bg-red-700" : "bg-green-700"}`} />
              {mmss(left)}
            </span>
          )
        }
        right={
          result ? (
            <Btn onClick={onExit} title="Leave the results and go back to the exam page; a new attempt gets a fresh cluster">
              Back to exam page
            </Btn>
          ) : (
            <Btn
              tone="primary"
              onClick={() => {
                if (window.confirm("Submit your exam for grading now?")) submit();
              }}
            >
              Submit exam
            </Btn>
          )
        }
      />
      <div className="flex min-h-0 flex-1">
        <aside className={`flex w-full shrink-0 flex-col border-r-[1.5px] border-ink bg-paper lg:w-[400px] xl:w-[460px] ${mobileTab !== "tasks" ? "max-lg:hidden" : ""}`}>
          <div className="border-b border-ink/15 px-5 pb-3 pt-4">
            <div className="text-[12px] font-medium text-ink-soft">{exam.style}</div>
            <h1 className="font-display mt-0.5 text-[22px] leading-tight">{exam.title}</h1>
            <div className="mt-3 flex border border-ink/30 text-[12.5px]">
              {(["tasks", "inspect"] as const).map((p) => (
                <button key={p} onClick={() => setPanel(p)} className={`flex-1 py-1 transition-colors [&+&]:border-l [&+&]:border-ink/30 ${panel === p ? "bg-ink text-paper" : "text-ink-soft hover:bg-ink/[0.04] hover:text-ink"}`}>
                  {p === "tasks" ? `Tasks · ${exam.tasks.length}` : "Inspect"}
                </button>
              ))}
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {panel === "inspect" ? (
              <Inspector sim={sim} c={c} sel={sel} onSelect={setSel} />
            ) : (
              <div className="flex flex-col px-4 pb-4 pt-4">
                {result && (
                  <div className="mb-4 border-[1.5px] border-ink p-4" role="status">
                    <div className="text-[15px] font-medium">
                      You scored {result.score}% ({exam.passPercent}% to pass) in {Math.floor(result.seconds / 60)} min
                    </div>
                    <p className="mt-1 text-[13px] leading-snug text-ink-soft">
                      {result.passed.filter(Boolean).length} of {exam.tasks.length} tasks correct. Open a task to see the fix; the cluster stays yours to keep practising.
                    </p>
                  </div>
                )}
                <div className="border-t-[1.5px] border-ink [&>section]:border-b [&>section]:border-ink/25">
                  {exam.tasks.map((t, i) => {
                    const isOpen = open === i;
                    const verdict = result ? result.passed[i] : undefined;
                    return (
                      <section key={i} className={isOpen ? "relative before:absolute before:inset-y-0 before:left-0 before:w-[2px] before:bg-signal" : undefined}>
                        <button onClick={() => setOpen(isOpen ? -1 : i)} className="flex w-full items-baseline gap-3 px-2 py-2.5 text-left transition-colors hover:bg-ink/[0.04]" aria-expanded={isOpen}>
                          <span className={`w-5 shrink-0 font-mono text-[12px] font-medium ${verdict === true ? "text-green-700" : verdict === false ? "text-red-700" : isOpen ? "text-signal" : "text-ink-soft"}`}>
                            {verdict === true ? "✓" : verdict === false ? "✕" : i + 1}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-[14px] font-medium">{t.title}</span>
                          {flags.includes(i) && !result && <span className="text-[11.5px] font-medium text-amber-700">flagged</span>}
                          {t.namespace && <span className="font-mono text-[11px] text-ink-soft">{t.namespace}</span>}
                          <span className="shrink-0 font-mono text-[11px] text-ink-soft">{t.points}%</span>
                        </button>
                        {isOpen && (
                          <div className="px-2 pb-4 pl-10 pt-1 text-[13px]">
                            <Prose text={t.body} />
                            {!result && (
                              <div className="mt-3 -ml-2.5">
                                <Btn tone="ghost" onClick={() => setFlags((f) => (f.includes(i) ? f.filter((x) => x !== i) : [...f, i]))}>
                                  {flags.includes(i) ? "Unflag" : "Flag for review"}
                                </Btn>
                              </div>
                            )}
                            {result && (
                              <div className="mt-4 border-t border-ink/15 pt-3">
                                <div className={`mb-2 text-[12.5px] font-medium ${verdict ? "text-green-700" : "text-red-700"}`}>{verdict ? "Correct. Compare with the fix:" : "Not quite. Here's the fix:"}</div>
                                <Prose text={[...solutionCommands(t, c).map((cmd) => "```bash\n" + cmd + "\n```"), ...(t.solution.yaml ? ["```yaml\n" + t.solution.yaml + "\n```"] : [])].join("\n\n")} onRun={(cmd) => sim.exec(cmd)} onEdit={(y) => sim.openFile("solution.yaml", y)} />
                              </div>
                            )}
                          </div>
                        )}
                      </section>
                    );
                  })}
                </div>
                <p className="mt-6 text-[11.5px] leading-relaxed text-ink-soft">{EXAM_TRADEMARK_NOTICE}</p>
              </div>
            )}
          </div>
        </aside>
        <div className={`flex min-h-0 min-w-0 flex-1 ${mobileTab === "tasks" ? "max-lg:hidden" : ""}`}>
          <Workspace
            sim={sim}
            selection={sel}
            onSelect={(s) => {
              setSel(s);
              if (s) setPanel("inspect");
            }}
            tabs={["terminal", "editor", "events", "resources"]}
            dockHeight="h-[44%]"
            narration={false}
            mobileView={mobileTab === "cluster" ? "canvas" : "dock"}
          />
        </div>
      </div>
      <MobileTabs
        value={mobileTab}
        onChange={setMobileTab}
        options={[
          { value: "tasks", label: "Tasks" },
          { value: "cluster", label: "Cluster" },
          { value: "terminal", label: "Terminal" },
        ]}
      />
    </div>
  );
}
