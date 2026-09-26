"use client";

import Link from "next/link";
import { EXPLAINERS } from "@/lib/explainers/explainers";
import { LESSONS } from "@/lib/lessons/lessons";
import { AppHeader } from "../AppHeader";
import { useProgress } from "./progress";

function Shell({ eyebrow, title, intro, children }: { eyebrow: string; title: string; intro: string; children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[#f7f8fa]">
      <AppHeader />
      <main className="mx-auto max-w-5xl px-6 pb-24 pt-14">
        <div className="text-[12px] font-semibold uppercase tracking-[0.1em] text-slate-400">{eyebrow}</div>
        <h1 className="mt-2 text-[34px] font-semibold tracking-tight text-slate-900">{title}</h1>
        <p className="mt-3 max-w-2xl text-[15.5px] leading-relaxed text-slate-500">{intro}</p>
        <div className="mt-10">{children}</div>
      </main>
    </div>
  );
}

export function LessonIndex() {
  const progress = useProgress();
  const firstOpen = LESSONS.find((l) => (progress[l.slug]?.done ?? 0) < l.steps.length);
  return (
    <Shell eyebrow="Lessons" title="Learn Kubernetes by doing" intro="Eight short, hands-on lessons. Each one gives you a live cluster, a real kubectl terminal, and checks that tick off as you go. Start at the top; each builds on the last.">
      <ol className="flex flex-col gap-3">
        {LESSONS.map((l, i) => {
          const p = progress[l.slug];
          const done = !!p && p.done >= l.steps.length;
          const started = !!p && p.done > 0 && !done;
          const isNext = firstOpen?.slug === l.slug;
          return (
            <li key={l.slug}>
              <Link href={`/learn/${l.slug}`} className={`group flex items-center gap-5 rounded-2xl border bg-white p-5 shadow-[0_1px_2px_rgba(15,23,42,.04)] transition hover:border-slate-300 hover:shadow-[0_4px_16px_rgba(15,23,42,.06)] ${isNext ? "border-slate-300" : "border-slate-200/80"}`}>
                <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl font-mono text-[14px] font-semibold ${done ? "bg-green-600 text-white" : isNext ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-500"}`}>
                  {done ? "✓" : String(i + 1).padStart(2, "0")}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h2 className="text-[15.5px] font-semibold text-slate-900">{l.title}</h2>
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
                <span className="text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-slate-600">→</span>
              </Link>
            </li>
          );
        })}
      </ol>
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
};

export function ExplainerIndex() {
  return (
    <Shell eyebrow="Explainers" title="Watch Kubernetes think" intro="Short narrated scenarios running on a real simulated cluster. Sit back and watch each concept play out step by step, then pause, change speed, or click anything to dig in.">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {EXPLAINERS.map((e) => (
          <Link key={e.id} href={`/explainers/${e.id}`} className="group flex flex-col rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[0_1px_2px_rgba(15,23,42,.04)] transition hover:border-slate-300 hover:shadow-[0_4px_16px_rgba(15,23,42,.06)]">
            <span className="grid h-10 w-10 place-items-center rounded-xl border border-slate-200 bg-slate-50 text-slate-700">
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
                {GLYPH[e.id]}
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
