import Link from "next/link";
import { AppHeader, Logo } from "@/components/AppHeader";
import { ExplainerStill } from "@/components/home/ExplainerStill";
import { IncidentDemo } from "@/components/home/IncidentDemo";
import { PodWordmark } from "@/components/home/PodWordmark";
import { WaysBento } from "@/components/home/WaysBento";
import { TryItSection } from "@/components/home/TryItSection";
import { CHALLENGES, EXAMS, EXAM_TRADEMARK_NOTICE, EXPLAINERS, LESSONS, TRACKS, trackOf } from "@/lib/lessons/meta";
import { INCIDENTS } from "@/lib/sim/incidents";
import { version } from "@/package.json";

const GITHUB = "https://github.com/Sharathchenna/kubesim";
const FIRST_LESSON_MINUTES = LESSONS.find((l) => l.slug === "first-pod")?.minutes ?? 6;

/** What the simulator covers: API kinds you can create, plus the behaviours and commands around them. */
const SIMULATED: { group: string; kinds: string[]; also?: string[] }[] = [
  { group: "Workloads", kinds: ["Pod", "Deployment", "ReplicaSet", "StatefulSet", "DaemonSet", "Job", "CronJob"] },
  { group: "Config", kinds: ["ConfigMap", "Secret", "ServiceAccount"], also: ["requests & limits", "probes"] },
  { group: "Networking", kinds: ["Service", "EndpointSlice", "Endpoints", "Ingress", "NetworkPolicy"], also: ["DNS"] },
  { group: "Storage", kinds: ["PersistentVolume", "PersistentVolumeClaim", "StorageClass"] },
  { group: "Operations", kinds: ["Node", "Namespace", "HorizontalPodAutoscaler", "Event"], also: ["metrics-server", "kubectl top"] },
  { group: "Security", kinds: ["Role", "ClusterRole", "RoleBinding", "ClusterRoleBinding"], also: ["kubectl auth can-i"] },
];

export default function Home() {
  return (
    <div className="font-sheet min-h-screen bg-paper text-ink">
      <AppHeader sheet />
      <main id="main">
        {/* ---------------------------------------------------------------- hero: the wordmark is a live cluster */}
        <section aria-labelledby="title" className="bg-[#326ce5] text-white">
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
            <dl className="mt-10 grid grid-cols-2 gap-y-4 border-t border-white/20 pt-6 sm:grid-cols-5">
              {[
                [LESSONS.length, "lessons"],
                [CHALLENGES.length, "challenges"],
                [INCIDENTS.length, "live incidents"],
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
              <p className="text-[14px] text-ink-soft">A shop with real traffic. Kill its database and watch the errors travel up, then heal.</p>
              <Link href="/sandbox" className="ml-auto text-[14px] font-medium text-signal hover:underline">
                Full-size Sandbox →
              </Link>
            </div>
            <TryItSection />
          </div>
        </section>

        {/* ---------------------------------------------------------------- on call: the Daily Incident */}
        <section aria-labelledby="oncall" className="mx-auto max-w-6xl px-4 pt-20 sm:px-6">
          <div className="grid grid-cols-1 items-center gap-8 rounded-[20px] bg-[#111827] p-6 text-white ring-1 ring-white/10 sm:p-10 dark:bg-[#161616] lg:grid-cols-[1.2fr_1fr]">
            <div>
              <p className="font-mono text-[12px] uppercase tracking-[0.08em] text-white/60">Daily Incident</p>
              <h2 id="oncall" className="mt-2 text-balance font-sans text-[32px] font-extrabold leading-[1.05] tracking-[-0.03em] sm:text-[40px]">
                You&apos;re on call. Production is down.
              </h2>
              <p className="text-pretty mt-3 max-w-lg text-[16px] leading-relaxed text-white/75">
                A shop is serving real traffic when something breaks. Find the cause with kubectl and get it serving again before the clock runs up. One new outage a day, the same for everyone: share your time, keep your streak.
              </p>
              <div className="mt-6 flex flex-wrap items-center gap-4">
                <Link href="/daily" className="btn-primary inline-flex h-12 items-center rounded-full px-6 text-[15.5px] font-semibold text-white">
                  Take today&apos;s incident →
                </Link>
                <Link href="/incidents" className="text-[14.5px] font-medium text-white/80 hover:text-white hover:underline">
                  All {INCIDENTS.length} incidents
                </Link>
              </div>
            </div>
            {/* The incident, played: paged, found and fixed with kubectl, resolved. */}
            <div aria-hidden className="w-full min-w-0">
              <IncidentDemo />
            </div>
          </div>
        </section>

        {/* ---------------------------------------------------------------- three ways in */}
        <section aria-labelledby="ways" className="mx-auto max-w-6xl px-4 pt-20 sm:px-6">
          <h2 id="ways" className="font-display text-[32px] leading-tight tracking-[-0.02em]">
            Ways to learn
          </h2>
          <WaysBento lessons={LESSONS.length} tracks={TRACKS.length} challenges={CHALLENGES.length} exams={EXAMS.length} />
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
            {/* A narrated Explainer, mid-play: the left column's room goes to the other way in. */}
            <Link href="/explainers/self-healing" aria-label="Play the self-healing explainer" className="mt-8 hidden max-w-[440px] lg:block">
              <ExplainerStill />
            </Link>
          </div>
          <ol className="divide-y divide-ink/10 self-start border-y border-ink/10">
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

        {/* ---------------------------------------------------------------- one more nudge before the footer */}
        <section aria-labelledby="go" className="mx-auto max-w-6xl px-4 pt-20 sm:px-6">
          <div className="flex flex-col gap-6 rounded-[20px] bg-[#326ce5] px-6 py-10 text-white sm:px-10 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <h2 id="go" className="text-balance font-sans text-[32px] font-extrabold leading-[1.05] tracking-[-0.03em] sm:text-[44px]">
                Break your first cluster.
              </h2>
              <p className="mt-3 text-[16px] text-white/80">The first lesson takes about {FIRST_LESSON_MINUTES} minutes. Your progress stays in this browser.</p>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row">
              <Link href="/learn/first-pod" className="inline-flex h-12 items-center justify-center whitespace-nowrap rounded-full bg-white px-6 text-[15.5px] font-semibold text-[#123a9c] transition-colors hover:bg-white/90">
                Start lesson 1 →
              </Link>
              <Link href="/daily" className="inline-flex h-12 items-center justify-center whitespace-nowrap rounded-full border border-white/50 px-6 text-[15.5px] font-medium transition-colors hover:border-white hover:bg-white/10">
                Take today&apos;s incident
              </Link>
            </div>
          </div>
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
