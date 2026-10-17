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
    <div className="min-h-screen bg-[#f7f8fa]">
      <AppHeader />
      <main className="mx-auto max-w-2xl px-6 pb-24 pt-14">
        <Link href="/exams" className="inline-flex min-h-6 items-center text-[12px] font-medium text-slate-500 hover:text-slate-700">
          ← All practice exams
        </Link>
        <div className="mt-4 text-[12px] font-semibold uppercase tracking-[0.1em] text-slate-500">{exam.style}</div>
        <h1 className="font-display mt-3 text-[48px] leading-[1.02] text-slate-900">{exam.title}</h1>
        <p className="mt-3 text-[15px] leading-relaxed text-slate-500">{exam.summary}</p>
        <p className="mt-2 text-[13px] leading-relaxed text-slate-500">This is not the real exam: it&apos;s kubesim&apos;s own practice set, written in the same style.</p>
        <dl className="mt-8 grid grid-cols-3 gap-3">
          {[
            ["Time", `${exam.minutes} min`],
            ["Tasks", String(exam.tasks.length)],
            ["Pass mark", `${exam.passPercent}%`],
          ].map(([k, v]) => (
            <div key={k} className="rounded-xl border border-slate-200 bg-white p-4">
              <dt className="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500">{k}</dt>
              <dd className="mt-1 font-mono text-[18px] font-medium text-slate-900">{v}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-6 rounded-2xl border border-slate-200 bg-white p-5 text-[13.5px] leading-relaxed text-slate-600">
          <div className="text-[14px] font-semibold text-slate-900">How it works</div>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>You get a fresh cluster and a terminal. Tasks are independent; do them in any order.</li>
            <li>Read each task carefully: names, namespaces, images and ports must match exactly.</li>
            <li>There are no hints and no checkmarks while the clock runs, just like the real exam. <code className="rounded bg-slate-100 px-1 font-mono text-[12px]">kubectl explain</code> and <code className="rounded bg-slate-100 px-1 font-mono text-[12px]">--dry-run=client -o yaml</code> are fair game. In the real exam you can also open the Kubernetes docs (kubernetes.io/docs and kubernetes.io/blog) and the Helm docs (helm.sh/docs) in the exam browser, so practising looking things up in the docs is part of preparing.</li>
            <li>Submit when you&apos;re done, or it grades itself when time runs out. Then you see the solutions.</li>
            <li>The clock keeps running if you leave the page; your cluster is saved in this browser.</li>
          </ul>
        </div>
        <div className="mt-6 flex items-center gap-4">
          <button onClick={onStart} className="inline-flex h-11 items-center rounded-xl bg-slate-900 px-5 text-[14px] font-medium text-white shadow-[0_1px_2px_rgba(15,23,42,.2)] hover:bg-slate-800">
            Start the {exam.minutes}-minute exam
          </button>
          {results.length > 0 && (
            <span className="text-[13px] text-slate-500">
              Best score: <b className="text-slate-900">{best}%</b> over {results.length} attempt{results.length === 1 ? "" : "s"}
            </span>
          )}
        </div>
        <p className="mt-10 border-t border-slate-200 pt-4 text-[12px] leading-relaxed text-slate-500">{EXAM_TRADEMARK_NOTICE}</p>
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

  if (!c) return <div className="flex h-dvh items-center justify-center bg-[#f7f8fa] text-[13px] text-slate-500">Preparing the exam cluster…</div>;

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-[#f7f8fa] text-slate-900">
      <AppHeader
        center={
          result ? (
            <span className={`rounded-full px-3 py-1 text-[13px] font-semibold ${result.score >= exam.passPercent ? "bg-green-50 text-green-800" : "bg-red-50 text-red-800"}`}>
              {result.score}% · {result.score >= exam.passPercent ? "Pass" : "Not yet"}
            </span>
          ) : (
            <span className={`flex items-center gap-2 font-mono text-[15px] font-medium tabular-nums ${left < 5 * 60_000 ? "text-red-600" : "text-slate-800"}`} role="timer" aria-label={`Time left ${mmss(left)}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${left < 5 * 60_000 ? "animate-pulse bg-red-500" : "bg-green-500"}`} />
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
        <aside className={`flex w-full shrink-0 flex-col border-r border-slate-200/80 bg-white lg:w-[400px] xl:w-[460px] ${mobileTab !== "tasks" ? "max-lg:hidden" : ""}`}>
          <div className="border-b border-slate-100 px-5 pb-3 pt-4">
            <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500">{exam.style}</div>
            <h1 className="mt-1 text-[18px] font-semibold tracking-tight text-slate-900">{exam.title}</h1>
            <div className="mt-3 flex rounded-lg bg-slate-100 p-0.5 text-[12px] font-medium">
              {(["tasks", "inspect"] as const).map((p) => (
                <button key={p} onClick={() => setPanel(p)} className={`flex-1 rounded-md py-1 transition ${panel === p ? "bg-white text-slate-900 shadow-[0_1px_2px_rgba(15,23,42,.1)]" : "text-slate-500"}`}>
                  {p === "tasks" ? `Tasks · ${exam.tasks.length}` : "Inspect"}
                </button>
              ))}
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {panel === "inspect" ? (
              <Inspector sim={sim} c={c} sel={sel} onSelect={setSel} />
            ) : (
              <div className="flex flex-col gap-2 p-4">
                {result && (
                  <div className={`mb-2 rounded-2xl border p-4 ${result.score >= exam.passPercent ? "border-green-200 bg-green-50" : "border-red-200 bg-red-50"}`} role="status">
                    <div className="text-[15px] font-semibold text-slate-900">
                      You scored {result.score}% ({exam.passPercent}% to pass) in {Math.floor(result.seconds / 60)} min
                    </div>
                    <p className="mt-1 text-[13px] text-slate-600">
                      {result.passed.filter(Boolean).length} of {exam.tasks.length} tasks correct. Open a task to see the fix; the cluster stays yours to keep practising.
                    </p>
                  </div>
                )}
                {exam.tasks.map((t, i) => {
                  const isOpen = open === i;
                  const verdict = result ? result.passed[i] : undefined;
                  return (
                    <section key={i} className={`rounded-2xl border ${isOpen ? "border-slate-300 bg-white shadow-[0_1px_2px_rgba(15,23,42,.04),0_8px_24px_rgba(15,23,42,.05)]" : "border-slate-200 bg-white"}`}>
                      <button onClick={() => setOpen(isOpen ? -1 : i)} className="flex w-full items-center gap-3 px-3.5 py-3 text-left" aria-expanded={isOpen}>
                        <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-[11px] font-semibold ${verdict === true ? "bg-green-600 text-white" : verdict === false ? "bg-red-600 text-white" : "bg-slate-100 text-slate-600"}`}>
                          {verdict === true ? "✓" : verdict === false ? "✕" : i + 1}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-slate-900">{t.title}</span>
                        {flags.includes(i) && !result && <span className="rounded bg-amber-100 px-1.5 text-[10.5px] font-medium text-amber-800">flagged</span>}
                        {t.namespace && <span className="rounded bg-slate-100 px-1.5 font-mono text-[10.5px] text-slate-600">{t.namespace}</span>}
                        <span className="shrink-0 font-mono text-[11px] text-slate-500">{t.points}%</span>
                      </button>
                      {isOpen && (
                        <div className="border-t border-slate-100 px-4 pb-4 pt-3 text-[13px] text-slate-700">
                          <Prose text={t.body} />
                          {!result && (
                            <div className="mt-3">
                              <Btn tone="ghost" onClick={() => setFlags((f) => (f.includes(i) ? f.filter((x) => x !== i) : [...f, i]))}>
                                {flags.includes(i) ? "Unflag" : "Flag for review"}
                              </Btn>
                            </div>
                          )}
                          {result && (
                            <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-2.5">
                              <div className="mb-1.5 text-[11.5px] text-slate-500">{verdict ? "Correct. Compare with the fix:" : "Not quite. Here's the fix:"}</div>
                              <Prose text={[...solutionCommands(t, c).map((cmd) => "```bash\n" + cmd + "\n```"), ...(t.solution.yaml ? ["```yaml\n" + t.solution.yaml + "\n```"] : [])].join("\n\n")} onRun={(cmd) => sim.exec(cmd)} onEdit={(y) => sim.openFile("solution.yaml", y)} />
                            </div>
                          )}
                        </div>
                      )}
                    </section>
                  );
                })}
                <p className="mt-4 text-[11.5px] leading-relaxed text-slate-500">{EXAM_TRADEMARK_NOTICE}</p>
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
