import Link from "next/link";
import { AppHeader, Logo } from "@/components/AppHeader";
import { PodWordmark } from "@/components/home/PodWordmark";
import { TryItSection } from "@/components/home/TryItSection";
import { CHALLENGES, EXAMS, EXAM_TRADEMARK_NOTICE, EXPLAINERS, LESSONS, TRACKS, trackOf } from "@/lib/lessons/meta";
import { heptagon } from "@/lib/heptagon";
import { version } from "@/package.json";

const GITHUB = "https://github.com/Sharathchenna/kubesim";

/** What the simulator covers: API kinds you can create, plus the behaviours and commands around them. */
const SIMULATED: { group: string; kinds: string[]; also?: string[] }[] = [
  { group: "Workloads", kinds: ["Pod", "Deployment", "ReplicaSet", "StatefulSet", "DaemonSet", "Job", "CronJob"] },
  { group: "Config", kinds: ["ConfigMap", "Secret", "ServiceAccount"], also: ["requests & limits", "probes"] },
  { group: "Networking", kinds: ["Service", "EndpointSlice", "Endpoints", "Ingress", "NetworkPolicy"], also: ["DNS"] },
  { group: "Storage", kinds: ["PersistentVolume", "PersistentVolumeClaim", "StorageClass"] },
  { group: "Operations", kinds: ["Node", "Namespace", "HorizontalPodAutoscaler", "Event"], also: ["metrics-server", "kubectl top"] },
  { group: "Security", kinds: ["Role", "ClusterRole", "RoleBinding", "ClusterRoleBinding"], also: ["kubectl auth can-i"] },
];

/** A small Kubernetes-style icon: blue heptagon, white glyph. */
function Badge({ children }: { children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 40 40" className="h-11 w-11 shrink-0 transition-transform duration-300 group-hover:rotate-[-8deg] group-hover:scale-110" aria-hidden>
      <polygon points={heptagon(20, 20, 17)} fill="#326ce5" stroke="#326ce5" strokeWidth={4} strokeLinejoin="round" />
      <g fill="none" stroke="#fff" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        {children}
      </g>
    </svg>
  );
}

const WAYS: { href: string; title: string; text: string; note: string; icon: React.ReactNode }[] = [
  {
    href: "/learn",
    title: "Lessons",
    text: "One step at a time, with the cluster in the spotlight. Each step checks itself as you type.",
    note: `${LESSONS.length} lessons in ${TRACKS.length} tracks`,
    icon: <path d="M13 13.5h6.5a2 2 0 0 1 2 2V27a1.6 1.6 0 0 0-1.6-1.6H13zM27 13.5h-3.5a2 2 0 0 0-2 2" />,
  },
  {
    href: "/challenges",
    title: "Challenges and exams",
    text: "A broken cluster and a goal, no instructions. Or a timed exam in the style of the CKAD and CKA.",
    note: `${CHALLENGES.length} challenges · ${EXAMS.length} practice exams`,
    icon: <path d="M20 12.5l7 3v4.6c0 4-3 6.6-7 7.9-4-1.3-7-3.9-7-7.9v-4.6zM16.8 20l2.2 2.2 4.2-4.4" />,
  },
  {
    href: "/sandbox",
    title: "Sandbox",
    text: "Free play. An empty cluster that's all yours: any kubectl, any YAML, switch Nodes off. Nothing to pass.",
    note: "No rules · share a copy with a link",
    icon: <path d="M20 12.5l7 3.8v7.4l-7 3.8-7-3.8v-7.4zM13 16.3l7 3.8 7-3.8M20 20.1v7.4" />,
  },
];

export default function Home() {
  return (
    <div className="font-sheet min-h-screen bg-paper text-ink">
      <AppHeader sheet />
      <main id="main">
        {/* ---------------------------------------------------------------- hero: the wordmark is a live cluster */}
        <section aria-labelledby="title" className="bg-signal text-white">
          <div className="mx-auto max-w-6xl px-4 pb-12 pt-8 sm:px-6 sm:pb-14 sm:pt-10">
            <PodWordmark>
              <span className="font-mono text-[11.5px] uppercase tracking-[0.06em] text-white/80">A Kubernetes cluster in your browser</span>
            </PodWordmark>
            <div className="mt-8 grid grid-cols-1 gap-8 lg:grid-cols-[1fr_auto] lg:items-end">
              <div>
                <h1 id="title" className="text-balance font-sans text-[40px] font-extrabold leading-[1.02] tracking-[-0.035em] sm:text-[60px]">
                  Learn Kubernetes by breaking it.
                </h1>
                <p className="text-pretty mt-4 max-w-xl text-[17px] leading-relaxed text-white/80 sm:text-[18px]">
                  Type real kubectl and watch Pods get scheduled, crash, heal and roll out, with every step explained as it happens. Free, open source, nothing to install.
                </p>
              </div>
              <div className="lg:justify-self-end">
                <div className="flex flex-col gap-3 sm:flex-row">
                  <Link href="/learn/first-pod" className="inline-flex h-12 items-center justify-center whitespace-nowrap rounded-full bg-white px-6 text-[15.5px] font-semibold text-[#123a9c] transition-colors hover:bg-white/90">
                    Start lesson 1: your first Pod →
                  </Link>
                  <Link href="/sandbox" className="inline-flex h-12 items-center justify-center whitespace-nowrap rounded-full border border-white/50 px-6 text-[15.5px] font-medium transition-colors hover:border-white hover:bg-white/10">
                    Open the Sandbox
                  </Link>
                </div>
                <p className="mt-3 text-[13px] text-white/70">
                  <span className="[@media(hover:hover)]:hidden">Tap the logo for a node failure.</span>
                  <span className="hidden [@media(hover:hover)]:inline">Hover the logo to kill Pods, or click it for a node failure.</span> They always come back.
                </p>
              </div>
            </div>
            <dl className="mt-10 grid grid-cols-2 gap-y-4 border-t border-white/20 pt-6 sm:grid-cols-4">
              {[
                [LESSONS.length, "lessons"],
                [CHALLENGES.length, "challenges"],
                [EXPLAINERS.length, "explainers"],
                [EXAMS.length, "practice exams"],
              ].map(([n, k]) => (
                <div key={String(k)}>
                  <dt className="sr-only">{k}</dt>
                  <dd>
                    <span className="block font-sans text-[30px] font-extrabold leading-none tracking-[-0.03em]">{n}</span>
                    <span className="mt-1 block text-[13px] text-white/70">{k}</span>
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        {/* ---------------------------------------------------------------- the live cluster, in the spotlight */}
        <section aria-labelledby="try" className="relative mx-auto max-w-6xl px-4 pb-4 pt-16 sm:px-6">
          <div className="overflow-hidden rounded-[20px] border border-ink/10 bg-canvas shadow-[0_1px_2px_rgb(15_23_42/0.04),0_12px_32px_rgb(15_23_42/0.08)]">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-ink/10 bg-paper px-5 py-3">
              <span className="relative flex h-2.5 w-2.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-500 opacity-60" />
                <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-green-500" />
              </span>
              <h2 id="try" className="text-[15px] font-semibold">
                This cluster is live
              </h2>
              <p className="text-[14px] text-ink-soft">Delete a Pod and watch the ReplicaSet bring it back.</p>
              <Link href="/sandbox" className="ml-auto text-[14px] font-medium text-signal hover:underline">
                Full-size Sandbox →
              </Link>
            </div>
            <TryItSection />
          </div>
        </section>

        {/* ---------------------------------------------------------------- three ways in */}
        <section aria-labelledby="ways" className="mx-auto max-w-6xl px-4 pt-20 sm:px-6">
          <h2 id="ways" className="font-display text-[32px] leading-tight tracking-[-0.02em]">
            Three ways to learn
          </h2>
          <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-3">
            {WAYS.map((w) => (
              <Link key={w.href} href={w.href} className="group flex flex-col rounded-2xl border border-ink/10 bg-paper p-5 transition-all duration-300 hover:-translate-y-1 hover:border-ink/20 hover:shadow-[0_12px_32px_-12px_rgb(15_23_42/0.18)]">
                <Badge>{w.icon}</Badge>
                <span className="mt-4 text-[17px] font-semibold group-hover:text-signal">{w.title}</span>
                <span className="mt-1.5 flex-1 text-[14.5px] leading-relaxed text-ink-soft">{w.text}</span>
                <span className="mt-4 text-[13px] text-ink-soft">{w.note}</span>
              </Link>
            ))}
          </div>
        </section>

        {/* ---------------------------------------------------------------- the path */}
        <section aria-labelledby="path" className="mx-auto grid max-w-6xl grid-cols-1 gap-10 px-4 pt-20 sm:px-6 lg:grid-cols-[1fr_1.2fr]">
          <div>
            <h2 id="path" className="font-display text-[28px] leading-tight">
              The path
            </h2>
            <p className="text-pretty mt-3 max-w-md text-[16px] leading-relaxed text-ink-soft">
              Seven tracks, from your first Pod to RBAC. Every lesson gives you a fresh cluster, a terminal and a YAML editor, and most checks look at the cluster, not at what you typed.
            </p>
            <div className="mt-6 flex flex-wrap gap-3 text-[14px]">
              <Link href="/learn" className="font-medium text-signal hover:underline">
                All lessons →
              </Link>
              <Link href="/explainers" className="font-medium text-signal hover:underline">
                {EXPLAINERS.length} narrated explainers →
              </Link>
            </div>
          </div>
          <ol className="divide-y divide-ink/10 border-y border-ink/10">
            {TRACKS.map((t, i) => {
              const n = LESSONS.filter((l) => trackOf(l) === t.id).length;
              return (
                <li key={t.id}>
                  <Link href={`/learn#${t.id}`} className="group flex items-baseline gap-4 py-3">
                    <span className={`w-6 font-mono text-[12.5px] ${i === 0 ? "text-signal" : "text-ink-soft"}`}>{String(i + 1).padStart(2, "0")}</span>
                    <span className="flex-1 text-[16px] font-medium group-hover:text-signal">{t.title}</span>
                    <span className="text-[13px] text-ink-soft">
                      {n} lesson{n === 1 ? "" : "s"}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ol>
        </section>

        {/* ---------------------------------------------------------------- what's simulated */}
        <section aria-labelledby="sim" className="mx-auto max-w-6xl px-4 pt-20 sm:px-6">
          <h2 id="sim" className="font-display text-[28px] leading-tight">
            What&apos;s simulated
          </h2>
          <dl className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {SIMULATED.map((s) => (
              <div key={s.group} className="rounded-2xl border border-ink/10 p-4">
                <dt className="text-[15px] font-semibold">{s.group}</dt>
                <dd className="mt-2 flex flex-wrap gap-1.5">
                  {s.kinds.map((k) => (
                    <span key={k} className="rounded-md bg-signal-soft px-2 py-0.5 font-mono text-[12px] text-ink">
                      {k}
                    </span>
                  ))}
                  {s.also?.map((k) => (
                    <span key={k} className="rounded-md bg-ink/[0.04] px-2 py-0.5 text-[12px] text-ink-soft">
                      {k}
                    </span>
                  ))}
                </dd>
              </div>
            ))}
          </dl>
          <p className="text-pretty mt-5 max-w-3xl text-[14px] leading-relaxed text-ink-soft">
            Back-off timings, events, scheduler reasons and kubectl output follow real Kubernetes defaults, and each behaviour is written up from the Kubernetes source and pinned by tests. It&apos;s still a simulation, so some corners are simpler than the real thing.
          </p>
        </section>
      </main>

      <footer className="mx-auto mt-20 max-w-6xl border-t border-ink/10 px-4 py-8 sm:px-6">
        <div className="flex flex-col gap-4 text-[13.5px] text-ink-soft md:flex-row md:items-center">
          <span className="flex items-center gap-3">
            <Logo />
            <span>A Kubernetes cluster simulated in your browser, for learning.</span>
          </span>
          <span className="md:ml-auto">Modelled on Kubernetes v1.37 · MIT licence · v{version}</span>
          <span>
            <a href={GITHUB} className="text-ink hover:text-signal">
              GitHub
            </a>{" "}
            ·{" "}
            <a href={`${GITHUB}/blob/main/CONTRIBUTING.md`} className="text-ink hover:text-signal">
              Contribute
            </a>
          </span>
        </div>
        <p className="mt-4 text-[12.5px] leading-relaxed text-ink-soft">Kubernetes® is a registered trademark of The Linux Foundation. {EXAM_TRADEMARK_NOTICE}</p>
      </footer>
    </div>
  );
}
