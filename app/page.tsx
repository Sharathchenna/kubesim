import Link from "next/link";
import { AppHeader } from "@/components/AppHeader";
import { LESSONS } from "@/lib/lessons/lessons";
import { EXPLAINERS } from "@/lib/explainers/explainers";

const PATHS = [
  {
    href: "/learn",
    kicker: `${LESSONS.length} lessons`,
    title: "Lessons",
    text: "Guided, hands-on steps with a real kubectl terminal and checks that tick off as you go. Start here if you're new.",
    cta: "Start learning",
  },
  {
    href: "/explainers",
    kicker: `${EXPLAINERS.length} explainers`,
    title: "Explainers",
    text: "Narrated scenarios that show one idea at a time: self-healing, rolling updates, Services, Node failure.",
    cta: "Watch one",
  },
  {
    href: "/sandbox",
    kicker: "Free play",
    title: "Sandbox",
    text: "Your own cluster to break. Deploy, scale, kill Nodes, and see exactly how Kubernetes responds.",
    cta: "Open sandbox",
  },
];

export default function Home() {
  return (
    <div className="min-h-screen bg-[#f7f8fa]">
      <AppHeader />
      <main className="mx-auto max-w-5xl px-6 pb-24">
        <section className="pt-20 text-center">
          <span className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1 text-[12px] font-medium text-slate-600 shadow-[0_1px_1px_rgba(15,23,42,.04)]">
            <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
            Free &amp; open source · runs in your browser
          </span>
          <h1 className="mx-auto mt-6 max-w-3xl text-[52px] font-semibold leading-[1.05] tracking-[-0.03em] text-slate-900">Learn Kubernetes on a cluster you can see.</h1>
          <p className="mx-auto mt-5 max-w-2xl text-[17px] leading-relaxed text-slate-500">
            A simulated cluster runs right here in your tab. Type real <code className="rounded-md border border-slate-200 bg-white px-1.5 py-0.5 font-mono text-[0.85em] text-slate-700">kubectl</code> commands and watch Pods get scheduled, crash, heal and roll out, with every step explained.
          </p>
          <div className="mt-8 flex justify-center gap-3">
            <Link href="/learn/first-pod" className="inline-flex h-11 items-center rounded-xl bg-slate-900 px-5 text-[14px] font-medium text-white shadow-[0_1px_2px_rgba(15,23,42,.2)] hover:bg-slate-800">
              Start the first lesson →
            </Link>
            <Link href="/sandbox" className="inline-flex h-11 items-center rounded-xl border border-slate-200 bg-white px-5 text-[14px] font-medium text-slate-700 shadow-[0_1px_1px_rgba(15,23,42,.04)] hover:bg-slate-50">
              Jump into the sandbox
            </Link>
          </div>
          <p className="mt-4 text-[12.5px] text-slate-400">No sign-up, no cloud account, nothing to install.</p>
        </section>

        <section className="mt-20 grid grid-cols-1 gap-4 md:grid-cols-3">
          {PATHS.map((p) => (
            <Link key={p.href} href={p.href} className="group flex flex-col rounded-2xl border border-slate-200/80 bg-white p-6 shadow-[0_1px_2px_rgba(15,23,42,.04)] transition hover:border-slate-300 hover:shadow-[0_8px_24px_rgba(15,23,42,.06)]">
              <div className="text-[11.5px] font-semibold uppercase tracking-[0.08em] text-slate-400">{p.kicker}</div>
              <h2 className="mt-2 text-[19px] font-semibold tracking-tight text-slate-900">{p.title}</h2>
              <p className="mt-2 flex-1 text-[14px] leading-relaxed text-slate-500">{p.text}</p>
              <span className="mt-5 text-[13px] font-medium text-slate-900">
                {p.cta} <span className="inline-block transition group-hover:translate-x-0.5">→</span>
              </span>
            </Link>
          ))}
        </section>

        <section className="mt-20 grid grid-cols-1 gap-10 md:grid-cols-3">
          {[
            ["See the chain", "Every Pod on the canvas is linked to the ReplicaSet and Deployment that own it, and to the Services that send it traffic."],
            ["Hear the story", "Cluster events are narrated in plain English: who did what, and why, as it happens."],
            ["Real behaviour", "Timings, error messages and kubectl output follow real Kubernetes, down to CrashLoopBackOff delays and eviction timeouts."],
          ].map(([t, d]) => (
            <div key={t}>
              <h3 className="text-[14.5px] font-semibold text-slate-900">{t}</h3>
              <p className="mt-1.5 text-[13.5px] leading-relaxed text-slate-500">{d}</p>
            </div>
          ))}
        </section>
      </main>
    </div>
  );
}
