"use client";

import Link from "next/link";
import { EXPLAINERS } from "@/lib/explainers/explainers";
import { LESSONS, TRACKS, trackOf, type Lesson } from "@/lib/lessons/lessons";
import { CHALLENGES } from "@/lib/lessons/challenges";
import { CURRICULUM } from "@/lib/lessons/curriculum";
import { EXAMS } from "@/lib/lessons/exams";
import { AppHeader } from "../AppHeader";
import { DIFFICULTY } from "./ChallengePlayer";
import { challengeKey, examKey, resetAllProgress, useProgress } from "./progress";

function Shell({ eyebrow, title, intro, children }: { eyebrow: string; title: string; intro: string; children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[#f7f8fa]">
      <div className="bg-field">
        <AppHeader glass />
        <header className="mx-auto max-w-5xl px-6 pb-12 pt-16">
          <div className="font-mono text-[11.5px] uppercase tracking-[0.14em] text-slate-500">{eyebrow}</div>
          <h1 className="font-display text-balance mt-3 text-[46px] leading-[1.02] text-slate-900 sm:text-[56px]">{title}</h1>
          <p className="text-pretty mt-4 max-w-2xl text-[16px] leading-relaxed text-slate-600">{intro}</p>
        </header>
      </div>
      <main className="mx-auto max-w-5xl px-6 pb-24 pt-4">{children}</main>
    </div>
  );
}

function LessonRow({ l, i, isNext }: { l: Lesson; i: number; isNext: boolean }) {
  const progress = useProgress();
  const p = progress[l.slug];
  const done = !!p && p.done >= l.steps.length;
  const started = !!p && p.done > 0 && !done;
  return (
    <li>
      <Link href={`/learn/${l.slug}`} className={`group flex items-center gap-5 rounded-2xl border bg-white p-5 shadow-[0_1px_2px_rgba(15,23,42,.04)] transition hover:border-slate-300 hover:shadow-[0_4px_16px_rgba(15,23,42,.06)] ${isNext ? "border-slate-300" : "border-slate-200/80"}`}>
        <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl font-mono text-[14px] font-semibold ${done ? "bg-green-600 text-white" : isNext ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-500"}`} aria-label={done ? "Done" : undefined}>
          {done ? "✓" : String(i + 1).padStart(2, "0")}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-[15.5px] font-semibold text-slate-900">{l.title}</h3>
            {isNext && <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-700">{started ? "Continue" : "Up next"}</span>}
          </div>
          <p className="mt-0.5 text-[13.5px] text-slate-500">{l.summary}</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {l.concepts.map((c) => (
              <span key={c} className="rounded-md border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[11px] text-slate-500">
                {c}
              </span>
            ))}
          </div>
        </div>
        <div className="hidden shrink-0 text-right sm:block">
          <div className="text-[12px] text-slate-400">{l.minutes} min</div>
          <div className="mt-1 font-mono text-[11.5px] text-slate-400">
            {p?.done ?? 0}/{l.steps.length} steps
          </div>
        </div>
        <span className="text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-slate-600" aria-hidden="true">→</span>
      </Link>
    </li>
  );
}

export function LessonIndex() {
  const progress = useProgress();
  const firstOpen = CURRICULUM.find((l) => (progress[l.slug]?.done ?? 0) < l.steps.length);
  const doneCount = LESSONS.filter((l) => (progress[l.slug]?.done ?? 0) >= l.steps.length).length;
  return (
    <Shell eyebrow="Lessons" title="Learn Kubernetes by doing" intro={`${LESSONS.length} short, hands-on lessons in ${TRACKS.length} tracks. Each one gives you a live cluster, a real kubectl terminal, and checks that tick off as you go. Take the tracks in order; each builds on the last.`}>
      <nav aria-label="Curriculum map" className="mb-10 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
        {TRACKS.map((t) => {
          const ls = LESSONS.filter((l) => trackOf(l) === t.id);
          const d = ls.filter((l) => (progress[l.slug]?.done ?? 0) >= l.steps.length).length;
          return (
            <a key={t.id} href={`#${t.id}`} className="rounded-xl border border-slate-200/80 bg-white p-3 hover:border-slate-300">
              <div className="text-[12px] font-semibold text-slate-800">{t.title}</div>
              <div className="mt-2 h-1 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-valuemin={0} aria-valuemax={ls.length} aria-valuenow={d} aria-label={`${t.title}: ${d} of ${ls.length} lessons done`}>
                <div className="h-full rounded-full bg-green-600" style={{ width: `${ls.length ? (d / ls.length) * 100 : 0}%` }} />
              </div>
              <div className="mt-1.5 font-mono text-[11px] text-slate-400">
                {d}/{ls.length}
              </div>
            </a>
          );
        })}
      </nav>
      <p className="-mt-6 mb-10 text-[13px] text-slate-500">
        {doneCount} of {LESSONS.length} lessons done.{" "}
        <Link href="/progress" className="font-medium text-slate-900 hover:underline">
          Your progress →
        </Link>
      </p>
      <div className="flex flex-col gap-12">
        {TRACKS.map((t) => {
          const ls = CURRICULUM.map((l, i) => ({ l, i })).filter(({ l }) => trackOf(l) === t.id);
          if (!ls.length) return null;
          return (
            <section key={t.id} id={t.id} aria-labelledby={`h-${t.id}`} className="scroll-mt-20">
              <h2 id={`h-${t.id}`} className="text-[18px] font-semibold tracking-tight text-slate-900">
                {t.title}
              </h2>
              <p className="mt-1 text-[13.5px] text-slate-500">{t.blurb}</p>
              <ol className="mt-4 flex flex-col gap-3">
                {ls.map(({ l, i }) => (
                  <LessonRow key={l.slug} l={l} i={i} isNext={firstOpen?.slug === l.slug} />
                ))}
              </ol>
            </section>
          );
        })}
      </div>
      <div className="mt-14 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Link href="/challenges" className="rounded-2xl border border-slate-200/80 bg-white p-5 hover:border-slate-300">
          <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-400">{CHALLENGES.length} challenges</div>
          <div className="mt-1 text-[15.5px] font-semibold text-slate-900">Fix a broken cluster →</div>
          <p className="mt-1 text-[13px] text-slate-500">No steps, just a symptom and a goal. Practise troubleshooting.</p>
        </Link>
        <Link href="/exams" className="rounded-2xl border border-slate-200/80 bg-white p-5 hover:border-slate-300">
          <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-400">{EXAMS.length} practice exams</div>
          <div className="mt-1 text-[15.5px] font-semibold text-slate-900">Try a timed, CKAD/CKA-style exam →</div>
          <p className="mt-1 text-[13px] text-slate-500">Independent tasks, a clock, and a score at the end.</p>
        </Link>
      </div>
    </Shell>
  );
}

export function ChallengeIndex() {
  const progress = useProgress();
  const solved = CHALLENGES.filter((c) => (progress[challengeKey(c.slug)]?.done ?? 0) >= c.steps.length).length;
  return (
    <Shell eyebrow="Challenges" title="Fix a broken cluster" intro={`Each challenge starts with something wrong and a goal, like a ticket from a colleague. There are no steps: investigate with kubectl, find the cause, fix it. Hints are there if you're stuck. ${solved} of ${CHALLENGES.length} solved.`}>
      {(["easy", "medium", "hard"] as const).map((level) => {
        const list = CHALLENGES.filter((c) => c.difficulty === level);
        if (!list.length) return null;
        return (
          <section key={level} className="mb-10" aria-labelledby={`h-${level}`}>
            <h2 id={`h-${level}`} className="mb-3 text-[18px] font-semibold tracking-tight text-slate-900">
              {DIFFICULTY[level].label}
            </h2>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {list.map((c) => {
                const p = progress[challengeKey(c.slug)];
                const done = !!p && p.done >= c.steps.length;
                return (
                  <Link key={c.slug} href={`/challenges/${c.slug}`} className="group flex flex-col rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[0_1px_2px_rgba(15,23,42,.04)] transition hover:border-slate-300 hover:shadow-[0_4px_16px_rgba(15,23,42,.06)]">
                    <div className="flex items-center gap-2">
                      <span className={`rounded-full border px-2 py-px text-[11px] font-medium ${DIFFICULTY[c.difficulty].cls}`}>{DIFFICULTY[c.difficulty].label}</span>
                      {done && <span className="rounded-full bg-green-600 px-2 py-px text-[11px] font-medium text-white">Solved</span>}
                      <span className="ml-auto text-[12px] text-slate-400">{c.minutes} min</span>
                    </div>
                    <h3 className="mt-3 text-[15.5px] font-semibold text-slate-900">{c.title}</h3>
                    <p className="mt-1 flex-1 text-[13.5px] leading-relaxed text-slate-500">{c.summary}</p>
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {c.concepts.map((x) => (
                        <span key={x} className="rounded-md border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[11px] text-slate-500">
                          {x}
                        </span>
                      ))}
                    </div>
                  </Link>
                );
              })}
            </div>
          </section>
        );
      })}
      {CHALLENGES.length === 0 && <p className="text-[14px] text-slate-500">Challenges are on their way.</p>}
    </Shell>
  );
}

export function ExamIndex() {
  const progress = useProgress();
  return (
    <Shell eyebrow="Practice exams" title="Timed, exam-style practice" intro="Modelled on the CKAD and CKA: a fixed time, a list of independent tasks worth different points, and a score at the end. There are no hints while the clock runs. These aren't the real exams, but the skills are the same.">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {EXAMS.map((e) => {
          const best = progress[examKey(e.slug)]?.done;
          return (
            <Link key={e.slug} href={`/exams/${e.slug}`} className="group flex flex-col rounded-2xl border border-slate-200/80 bg-white p-6 shadow-[0_1px_2px_rgba(15,23,42,.04)] transition hover:border-slate-300 hover:shadow-[0_8px_24px_rgba(15,23,42,.06)]">
              <div className="text-[11.5px] font-semibold uppercase tracking-[0.08em] text-slate-400">{e.style}</div>
              <h2 className="mt-2 text-[19px] font-semibold tracking-tight text-slate-900">{e.title}</h2>
              <p className="mt-2 flex-1 text-[14px] leading-relaxed text-slate-500">{e.summary}</p>
              <div className="mt-5 flex items-center gap-4 font-mono text-[12px] text-slate-500">
                <span>{e.minutes} min</span>
                <span>{e.tasks.length} tasks</span>
                <span>pass {e.passPercent}%</span>
                {best !== undefined && <span className={`ml-auto rounded-full px-2 py-0.5 font-sans text-[11.5px] font-medium ${best >= e.passPercent ? "bg-green-50 text-green-700" : "bg-slate-100 text-slate-600"}`}>best {best}%</span>}
              </div>
            </Link>
          );
        })}
      </div>
      {EXAMS.length === 0 && <p className="text-[14px] text-slate-500">Practice exams are on their way.</p>}
    </Shell>
  );
}

export function ProgressPage() {
  const progress = useProgress();
  const lessonsDone = LESSONS.filter((l) => (progress[l.slug]?.done ?? 0) >= l.steps.length).length;
  const stepsDone = LESSONS.reduce((a, l) => a + Math.min(progress[l.slug]?.done ?? 0, l.steps.length), 0);
  const stepsTotal = LESSONS.reduce((a, l) => a + l.steps.length, 0);
  const solved = CHALLENGES.filter((c) => (progress[challengeKey(c.slug)]?.done ?? 0) >= c.steps.length).length;
  const next = CURRICULUM.find((l) => (progress[l.slug]?.done ?? 0) < l.steps.length);
  const stats = [
    ["Lessons", `${lessonsDone}/${LESSONS.length}`, `${stepsDone} of ${stepsTotal} steps`],
    ["Challenges", `${solved}/${CHALLENGES.length}`, "solved"],
    ["Practice exams", `${EXAMS.filter((e) => (progress[examKey(e.slug)]?.done ?? -1) >= e.passPercent).length}/${EXAMS.length}`, "passed"],
  ];
  return (
    <Shell eyebrow="Progress" title="Your progress" intro="Everything here is stored in this browser only. There are no accounts, so clearing site data (or the button below) starts you over.">
      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {stats.map(([k, v, sub]) => (
          <div key={k} className="rounded-2xl border border-slate-200/80 bg-white p-5">
            <dt className="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-400">{k}</dt>
            <dd className="mt-1 font-mono text-[26px] font-medium text-slate-900">{v}</dd>
            <dd className="text-[12.5px] text-slate-500">{sub}</dd>
          </div>
        ))}
      </dl>
      {next && (
        <Link href={`/learn/${next.slug}`} className="mt-6 flex items-center justify-between rounded-2xl border border-slate-300 bg-white p-5 hover:bg-slate-50">
          <span>
            <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-400">Up next</span>
            <span className="mt-1 block text-[15.5px] font-semibold text-slate-900">{next.title}</span>
          </span>
          <span aria-hidden="true">→</span>
        </Link>
      )}
      <section className="mt-10" aria-labelledby="h-map">
        <h2 id="h-map" className="text-[18px] font-semibold tracking-tight text-slate-900">
          Curriculum map
        </h2>
        <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
          {TRACKS.map((t) => {
            const ls = LESSONS.filter((l) => trackOf(l) === t.id);
            if (!ls.length) return null;
            return (
              <div key={t.id} className="rounded-2xl border border-slate-200/80 bg-white p-4">
                <div className="text-[14px] font-semibold text-slate-900">{t.title}</div>
                <ul className="mt-2 flex flex-col gap-1">
                  {ls.map((l) => {
                    const p = progress[l.slug];
                    const done = !!p && p.done >= l.steps.length;
                    return (
                      <li key={l.slug}>
                        <Link href={`/learn/${l.slug}`} className="flex items-center gap-2 rounded-md px-1.5 py-1 text-[13px] hover:bg-slate-50">
                          <span className={`grid h-4 w-4 place-items-center rounded-full text-[9px] ${done ? "bg-green-600 text-white" : p?.done ? "bg-amber-400 text-white" : "bg-slate-200"}`} aria-hidden="true">
                            {done ? "✓" : ""}
                          </span>
                          <span className={done ? "text-slate-500" : "text-slate-800"}>{l.title}</span>
                          <span className="sr-only">{done ? "(done)" : p?.done ? "(started)" : "(not started)"}</span>
                          <span className="ml-auto font-mono text-[11px] text-slate-400">
                            {Math.min(p?.done ?? 0, l.steps.length)}/{l.steps.length}
                          </span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>
      </section>
      <button
        className="mt-10 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[12.5px] font-medium text-red-600 hover:bg-red-50"
        onClick={() => {
          if (window.confirm("Forget all Lesson, Challenge and exam progress on this device?")) resetAllProgress();
        }}
      >
        Reset all progress
      </button>
    </Shell>
  );
}

const GLYPH: Record<string, React.ReactNode> = {
  "self-healing": <path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v4h-4" />,
  scaling: <path d="M4 18h4v-4H4zM10 18h4v-8h-4zM16 18h4V6h-4z" />,
  "rolling-update": <path d="M4 8h13l-3-3M20 16H7l3 3" />,
  "service-load-balancing": <path d="M12 4v5M12 9l-6 6M12 9l6 6M12 9v6M6 15v5M18 15v5M12 15v5" />,
  "node-failure": <path d="M12 3v7M7.5 6.5a7 7 0 1 0 9 0" />,
  crashloop: <path d="M12 8v5M12 16.5v.5M10.3 3.9L2.8 17a2 2 0 0 0 1.7 3h15a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />,
  "readiness-vs-liveness": <path d="M3 12h4l2-5 4 10 2-5h6" />,
  autoscaling: <path d="M4 20V10M10 20V6M16 20V13M3 5l6-2 6 3 6-3" />,
  "statefulset-ordering": <path d="M5 5h14v4H5zM5 10h14v4H5zM5 15h14v4H5z" />,
  "ingress-routing": <path d="M3 12h9M12 12l6-6M12 12l6 6M20 4v4M20 16v4" />,
  "network-policy": <path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z M9 12l2 2 4-4" />,
};

export function ExplainerIndex() {
  return (
    <Shell eyebrow="Explainers" title="Watch Kubernetes think" intro="Short narrated scenarios running on a real simulated cluster. Sit back and watch each concept play out step by step, then pause, change speed, or click anything to dig in.">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {EXPLAINERS.map((e) => (
          <Link key={e.id} href={`/explainers/${e.id}`} className="group flex flex-col rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[0_1px_2px_rgba(15,23,42,.04)] transition hover:border-slate-300 hover:shadow-[0_4px_16px_rgba(15,23,42,.06)]">
            <span className="grid h-10 w-10 place-items-center rounded-xl border border-slate-200 bg-slate-50 text-slate-700">
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
                {GLYPH[e.id] ?? <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z" />}
              </svg>
            </span>
            <div className="mt-4 text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-400">{e.concept}</div>
            <h2 className="mt-1 text-[15.5px] font-semibold text-slate-900">{e.title}</h2>
            <p className="mt-1 flex-1 text-[13.5px] leading-relaxed text-slate-500">{e.summary}</p>
            <div className="mt-4 flex items-center gap-1.5 text-[12.5px] font-medium text-slate-900">
              <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="currentColor"><path d="M4 2.5v11l9-5.5z" /></svg>
              Play · {e.beats(e.param?.default ?? 0).length} steps
            </div>
          </Link>
        ))}
      </div>
    </Shell>
  );
}
