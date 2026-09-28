import Link from "next/link";
import { AppHeader, Logo } from "@/components/AppHeader";
import { HeroCluster } from "@/components/home/HeroCluster";
import { TryItSection } from "@/components/home/TryItSection";
import { LESSONS, TRACKS, trackOf } from "@/lib/lessons/lessons";
import { EXPLAINERS } from "@/lib/explainers/explainers";
import { CHALLENGES } from "@/lib/lessons/challenges";
import { EXAMS } from "@/lib/lessons/exams";
import { Cluster } from "@/lib/engine";
import { runKubectl } from "@/lib/kubectl/kubectl";

const GITHUB = "https://github.com/Sharathchenna/kubesim";

const SIMULATED: { group: string; kinds: string[] }[] = [
  { group: "Workloads", kinds: ["Pod", "Deployment", "ReplicaSet", "StatefulSet", "DaemonSet", "Job", "CronJob"] },
  { group: "Config", kinds: ["ConfigMap", "Secret", "ServiceAccount", "resources", "probes"] },
  { group: "Networking", kinds: ["Service", "Endpoints", "Ingress", "NetworkPolicy", "DNS"] },
  { group: "Storage", kinds: ["PersistentVolume", "PersistentVolumeClaim", "StorageClass"] },
  { group: "Operations", kinds: ["Node", "Namespace", "HorizontalPodAutoscaler", "metrics-server", "Event"] },
  { group: "Security", kinds: ["Role", "ClusterRole", "RoleBinding", "auth can-i"] },
];

/** Real output, produced by the engine when the site is built. */
function realTranscript(): { cmd: string; out: string }[] {
  const c = new Cluster({ seed: 42 });
  const ctx = { cluster: c, namespace: "default", files: {} };
  const k = (cmd: string) => runKubectl(ctx, cmd).out;
  k("kubectl create deployment web --image=nginx:1.27 --replicas=2");
  k(`kubectl run crashy --image=busybox -- sh -c "echo starting; sleep 2; exit 1"`);
  c.advance(6 * 60_000 + 20_000);
  return ["kubectl get pods", "kubectl logs crashy --previous", "kubectl auth can-i delete pods --as=jane"].map((cmd) => ({ cmd, out: k(cmd) }));
}

function Eyebrow({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`font-mono text-[11.5px] uppercase tracking-[0.14em] text-slate-500 ${className}`}>{children}</div>;
}

function Arrow() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 transition group-hover:translate-x-0.5" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
      <path d="M3 8h9M8.5 4.5L12 8l-3.5 3.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function Home() {
  const challenge = CHALLENGES.find((c) => c.slug === "service-selector") ?? CHALLENGES[0];
  const ckad = EXAMS[0];
  const transcript = realTranscript();
  const stats = [
    [LESSONS.length, "lessons"],
    [CHALLENGES.length, "challenges"],
    [EXAMS.length, "practice exams"],
    [EXPLAINERS.length, "explainers"],
  ] as const;

  return (
    <div className="min-h-screen bg-[#f7f8fa] text-slate-900">
      <div className="bg-field">
        <AppHeader glass />

        {/* ---------------------------------------------------------------- hero */}
        <section className="mx-auto grid max-w-6xl grid-cols-1 items-center gap-10 px-6 pb-16 pt-14 lg:grid-cols-[1.05fr_1fr] lg:gap-6 lg:pb-24 lg:pt-20">
          <div>
            <Eyebrow>Free &amp; open source · runs in your browser</Eyebrow>
            <h1 className="font-display text-balance mt-5 text-[52px] leading-[0.98] text-slate-900 sm:text-[68px] lg:text-[80px]">
              Learn Kubernetes on a cluster you can <em className="text-blue-600">see</em>.
            </h1>
            <p className="text-pretty mt-6 max-w-[34rem] text-[17.5px] leading-[1.65] text-slate-600">
              A simulated cluster runs right here in your tab. Type real <code className="rounded-md border border-slate-200 bg-white/80 px-1.5 py-0.5 font-mono text-[0.84em] text-slate-800">kubectl</code>, break things on purpose, and watch the control plane put them back, with every step explained in plain English.
            </p>
            <div className="mt-9 flex flex-wrap items-center gap-3">
              <Link href="/learn/first-pod" className="group inline-flex h-12 items-center gap-2 rounded-xl bg-slate-900 px-5 text-[14.5px] font-medium text-white shadow-[0_1px_2px_rgba(15,23,42,.25),0_8px_24px_rgba(15,23,42,.12)] transition hover:bg-slate-800">
                Start the first lesson <Arrow />
              </Link>
              <Link href="/sandbox" className="inline-flex h-12 items-center rounded-xl border border-slate-300/80 bg-white/70 px-5 text-[14.5px] font-medium text-slate-800 backdrop-blur transition hover:border-slate-400 hover:bg-white">
                Open the sandbox
              </Link>
            </div>
            <p className="mt-4 text-[13px] text-slate-500">No sign-up, no cloud account, nothing to install.</p>
            <dl className="mt-12 grid max-w-md grid-cols-4 divide-x divide-slate-200 border-y border-slate-200">
              {stats.map(([n, label]) => (
                <div key={label} className="px-3 py-3 first:pl-0">
                  <dt className="sr-only">{label}</dt>
                  <dd className="font-mono text-[22px] font-medium tabular-nums text-slate-900">{n}</dd>
                  <dd className="text-[11.5px] leading-tight text-slate-500">{label}</dd>
                </div>
              ))}
            </dl>
          </div>
          <HeroCluster />
        </section>

        {/* ---------------------------------------------------------------- live cluster */}
        <section className="mx-auto max-w-6xl px-6 pb-24" aria-labelledby="try">
          <div className="mb-8 grid grid-cols-1 items-end gap-4 md:grid-cols-[1fr_auto]">
            <div>
              <Eyebrow>Try it</Eyebrow>
              <h2 id="try" className="font-display mt-3 text-[40px] leading-[1.05] sm:text-[48px]">
                This isn&apos;t a video.
              </h2>
              <p className="mt-3 max-w-xl text-[15.5px] leading-relaxed text-slate-600">It&apos;s a three-Node cluster running in this page. Delete a Pod and watch its ReplicaSet replace it, or type any command you like.</p>
            </div>
            <Link href="/sandbox" className="group inline-flex items-center gap-1.5 text-[14px] font-medium text-slate-900">
              Full-size sandbox <Arrow />
            </Link>
          </div>
          <div className="overflow-hidden rounded-2xl border border-slate-200/90 bg-white shadow-[0_1px_2px_rgba(15,23,42,.04),0_24px_60px_-12px_rgba(15,23,42,.18)]">
            <div className="flex h-10 items-center gap-3 border-b border-slate-200/80 bg-slate-50/80 px-4">
              <div className="flex gap-1.5" aria-hidden="true">
                <span className="h-2.5 w-2.5 rounded-full bg-slate-300" />
                <span className="h-2.5 w-2.5 rounded-full bg-slate-300" />
                <span className="h-2.5 w-2.5 rounded-full bg-slate-300" />
              </div>
              <span className="font-mono text-[11.5px] text-slate-500">kind-kubesim · default</span>
              <span className="ml-auto flex items-center gap-1.5 font-mono text-[11px] text-green-700">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-green-500" />
                live
              </span>
            </div>
            <TryItSection />
          </div>
        </section>
      </div>

      {/* ---------------------------------------------------------------- ways to learn */}
      <section className="mx-auto max-w-6xl px-6 py-24" aria-labelledby="ways">
        <Eyebrow>Five ways in</Eyebrow>
        <h2 id="ways" className="font-display mt-3 max-w-2xl text-[40px] leading-[1.05] sm:text-[48px]">
          Learn it, break it, prove it.
        </h2>
        <div className="mt-10 grid grid-cols-1 gap-4 md:grid-cols-6">
          {/* Lessons */}
          <Link href="/learn" className="group relative flex flex-col overflow-hidden rounded-3xl border border-slate-200/80 bg-white p-7 shadow-[0_1px_2px_rgba(15,23,42,.04)] transition hover:border-slate-300 hover:shadow-[0_12px_40px_-12px_rgba(15,23,42,.15)] md:col-span-4 md:row-span-2">
            <Eyebrow>Lessons · {LESSONS.length}</Eyebrow>
            <h3 className="font-display mt-3 text-[34px] leading-tight">A path from your first Pod to RBAC.</h3>
            <p className="mt-2 max-w-md text-[14.5px] leading-relaxed text-slate-600">Short, hands-on steps with a real terminal. Each step ticks off by itself when the cluster reaches the right state.</p>
            <div className="mt-6 rounded-2xl border border-slate-200 bg-slate-50/70 p-4" aria-hidden="true">
              {[
                ["Create a Deployment", "kubectl create deployment web --image=nginx --replicas=2", true],
                ["Scale up", "kubectl scale deployment web --replicas=5", true],
                ["Delete a Pod and watch it heal", "kubectl delete pod web-…", false],
              ].map(([title, cmd, done], i) => (
                <div key={i} className={`flex items-start gap-3 py-2 ${i ? "border-t border-slate-200/70" : ""}`}>
                  <span className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full text-[10px] font-semibold ${done ? "bg-green-600 text-white" : "bg-slate-900 text-white"}`}>{done ? "✓" : i + 1}</span>
                  <div className="min-w-0">
                    <div className={`text-[13.5px] font-medium ${done ? "text-slate-500" : "text-slate-900"}`}>{title}</div>
                    <div className="truncate font-mono text-[11.5px] text-slate-500">{cmd}</div>
                  </div>
                  {!done && <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[11.5px] text-slate-400"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />waiting</span>}
                </div>
              ))}
            </div>
            <ol className="mt-6 grid flex-1 grid-cols-1 content-end gap-x-6 gap-y-2.5 sm:grid-cols-2">
              {TRACKS.map((t, i) => {
                const ls = LESSONS.filter((l) => trackOf(l) === t.id);
                return (
                  <li key={t.id} className="flex items-baseline gap-3 border-t border-slate-100 pt-2.5">
                    <span className="font-mono text-[11px] text-slate-400">{String(i + 1).padStart(2, "0")}</span>
                    <span className="text-[14px] font-medium text-slate-800">{t.title}</span>
                    <span className="ml-auto truncate text-[12px] text-slate-400">{ls.map((l) => l.title.split(" ")[0]).slice(0, 3).join(" · ")}</span>
                  </li>
                );
              })}
            </ol>
            <span className="mt-6 inline-flex items-center gap-1.5 text-[14px] font-medium">
              See the curriculum <Arrow />
            </span>
          </Link>

          {/* Challenges */}
          <Link href="/challenges" className="group flex flex-col rounded-3xl border border-slate-200/80 bg-white p-6 shadow-[0_1px_2px_rgba(15,23,42,.04)] transition hover:border-slate-300 hover:shadow-[0_12px_40px_-12px_rgba(15,23,42,.15)] md:col-span-2">
            <Eyebrow>Challenges · {CHALLENGES.length}</Eyebrow>
            <div className="mt-4 rounded-2xl border border-amber-200/80 bg-amber-50/60 p-4">
              <div className="flex items-center gap-2 font-mono text-[11px] text-amber-800">
                <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                INCIDENT · {challenge.difficulty}
              </div>
              <p className="mt-2 line-clamp-4 text-[13px] leading-relaxed text-slate-700">{challenge.brief.replace(/`/g, "")}</p>
            </div>
            <p className="mt-4 flex-1 text-[13.5px] leading-relaxed text-slate-600">No steps, just a symptom. Find the cause with kubectl.</p>
            <span className="mt-4 inline-flex items-center gap-1.5 text-[14px] font-medium">
              Fix one <Arrow />
            </span>
          </Link>

          {/* Practice exams */}
          <Link href="/exams" className="group flex flex-col rounded-3xl border border-slate-200/80 bg-white p-6 shadow-[0_1px_2px_rgba(15,23,42,.04)] transition hover:border-slate-300 hover:shadow-[0_12px_40px_-12px_rgba(15,23,42,.15)] md:col-span-2">
            <Eyebrow>Practice exams · {EXAMS.length}</Eyebrow>
            <div className="mt-4 flex items-baseline gap-2">
              <span className="font-mono text-[40px] font-medium tabular-nums tracking-tight text-slate-900">{ckad?.minutes ?? 60}:00</span>
              <span className="text-[12px] text-slate-400">on the clock</span>
            </div>
            <p className="mt-2 flex-1 text-[13.5px] leading-relaxed text-slate-600">
              CKAD- and CKA-style task lists, {ckad?.tasks.length ?? 12} tasks each, graded from the cluster&apos;s state. Solutions afterwards.
            </p>
            <span className="mt-4 inline-flex items-center gap-1.5 text-[14px] font-medium">
              Take one <Arrow />
            </span>
          </Link>

          {/* Explainers */}
          <Link href="/explainers" className="group flex flex-col rounded-3xl border border-slate-200/80 bg-white p-6 shadow-[0_1px_2px_rgba(15,23,42,.04)] transition hover:border-slate-300 hover:shadow-[0_12px_40px_-12px_rgba(15,23,42,.15)] md:col-span-3">
            <Eyebrow>Explainers · {EXPLAINERS.length}</Eyebrow>
            <h3 className="font-display mt-3 text-[28px] leading-tight">Sit back and watch it think.</h3>
            <ul className="mt-4 flex-1 space-y-2">
              {EXPLAINERS.slice(-5).map((e) => (
                <li key={e.id} className="flex items-center gap-2.5 text-[13.5px] text-slate-700">
                  <svg viewBox="0 0 16 16" className="h-3 w-3 shrink-0 text-blue-600" fill="currentColor" aria-hidden="true">
                    <path d="M4 2.5v11l9-5.5z" />
                  </svg>
                  {e.title}
                </li>
              ))}
            </ul>
            <span className="mt-5 inline-flex items-center gap-1.5 text-[14px] font-medium">
              Watch one <Arrow />
            </span>
          </Link>

          {/* Sandbox */}
          <Link href="/sandbox" className="group relative flex flex-col overflow-hidden rounded-3xl border border-slate-800 bg-slate-950 p-6 text-slate-100 shadow-[0_12px_40px_-12px_rgba(15,23,42,.4)] transition hover:border-slate-700 md:col-span-3">
            <div className="pointer-events-none absolute inset-0 opacity-40 [background-image:radial-gradient(#334155_1px,transparent_1.2px)] [background-size:18px_18px] [mask-image:linear-gradient(to_bottom,#000,transparent)]" />
            <div className="relative">
              <div className="font-mono text-[11.5px] uppercase tracking-[0.14em] text-slate-400">Sandbox</div>
              <h3 className="font-display mt-3 text-[28px] leading-tight text-white">Your cluster to break.</h3>
              <pre className="mt-4 overflow-hidden rounded-xl border border-slate-800 bg-black/40 p-3 font-mono text-[12px] leading-relaxed text-slate-300">
                <span className="text-slate-500">$ </span>kubectl drain worker-1 --ignore-daemonsets{"\n"}
                <span className="text-slate-500">node/worker-1 cordoned{"\n"}evicting pod default/web-7d4b9-x2k9p{"\n"}</span>
                <span className="text-green-400">node/worker-1 drained</span>
              </pre>
            </div>
            <span className="relative mt-5 inline-flex items-center gap-1.5 text-[14px] font-medium text-white">
              Open the sandbox <Arrow />
            </span>
          </Link>
        </div>
      </section>

      {/* ---------------------------------------------------------------- fidelity */}
      <section className="border-y border-slate-200/80 bg-white" aria-labelledby="real">
        <div className="mx-auto grid max-w-6xl grid-cols-1 gap-12 px-6 py-24 lg:grid-cols-[1fr_1.15fr] lg:items-center">
          <div>
            <Eyebrow>Faithful to v1.37</Eyebrow>
            <h2 id="real" className="font-display mt-3 text-[40px] leading-[1.05] sm:text-[48px]">
              Down to the RESTARTS column.
            </h2>
            <p className="mt-4 max-w-md text-[15.5px] leading-relaxed text-slate-600">
              Back-off timings, event messages, scheduler reasons and kubectl output follow real Kubernetes, so what you learn here is what you&apos;ll see at work. The rules come from the Kubernetes source, and the engine is tested against them.
            </p>
            <dl className="mt-10 space-y-6">
              {SIMULATED.map((s) => (
                <div key={s.group} className="grid grid-cols-[7.5rem_1fr] gap-4">
                  <dt className="pt-0.5 text-[13px] font-medium text-slate-900">{s.group}</dt>
                  <dd className="flex flex-wrap gap-1.5">
                    {s.kinds.map((k) => (
                      <span key={k} className="rounded-md border border-slate-200 bg-slate-50 px-1.5 py-0.5 font-mono text-[11.5px] text-slate-600">
                        {k}
                      </span>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
          <div className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-950 shadow-[0_24px_60px_-16px_rgba(15,23,42,.45)]">
            <div className="flex h-9 items-center border-b border-slate-800 px-4 font-mono text-[11px] text-slate-500">terminal</div>
            <pre className="overflow-x-auto p-5 font-mono text-[12px] leading-[1.75] text-slate-300">
              {transcript.map((t, i) => (
                <span key={i}>
                  {i > 0 && "\n"}
                  <span className="text-slate-500">$ </span>
                  <span className="text-white">{t.cmd}</span>
                  {"\n"}
                  {t.out.split("\n").map((line, j) => (
                    <span key={j} className={/CrashLoopBackOff|Error|^no$/.test(line) ? "text-red-400" : /Warning/.test(line) ? "text-amber-300" : undefined}>
                      {line}
                      {"\n"}
                    </span>
                  ))}
                </span>
              ))}
            </pre>
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------------- closing */}
      <section className="bg-field">
        <div className="mx-auto max-w-6xl px-6 py-28 text-center">
          <h2 className="font-display text-balance mx-auto max-w-3xl text-[44px] leading-[1.02] sm:text-[60px]">
            Your first Pod is <em className="text-blue-600">six minutes</em> away.
          </h2>
          <div className="mt-9 flex flex-wrap justify-center gap-3">
            <Link href="/learn/first-pod" className="group inline-flex h-12 items-center gap-2 rounded-xl bg-slate-900 px-5 text-[14.5px] font-medium text-white shadow-[0_1px_2px_rgba(15,23,42,.25),0_8px_24px_rgba(15,23,42,.12)] transition hover:bg-slate-800">
              Start the first lesson <Arrow />
            </Link>
            <Link href="/learn" className="inline-flex h-12 items-center rounded-xl border border-slate-300/80 bg-white/70 px-5 text-[14.5px] font-medium text-slate-800 backdrop-blur transition hover:border-slate-400 hover:bg-white">
              Browse all lessons
            </Link>
          </div>
        </div>
      </section>

      <footer className="border-t border-slate-200/80 bg-white">
        <div className="mx-auto grid max-w-6xl grid-cols-2 gap-8 px-6 py-12 text-[13px] sm:grid-cols-4">
          <div className="col-span-2">
            <Logo />
            <p className="mt-3 max-w-xs leading-relaxed text-slate-500">A simulated Kubernetes cluster that runs in your browser, for learning. Free and open source under the MIT license.</p>
          </div>
          <nav aria-label="Learn" className="flex flex-col gap-2">
            <div className="font-mono text-[11px] uppercase tracking-[0.14em] text-slate-400">Learn</div>
            {[
              ["/learn", "Lessons"],
              ["/challenges", "Challenges"],
              ["/exams", "Practice exams"],
              ["/explainers", "Explainers"],
              ["/concepts", "Concepts"],
            ].map(([h, l]) => (
              <Link key={h} href={h} className="text-slate-600 hover:text-slate-900">
                {l}
              </Link>
            ))}
          </nav>
          <nav aria-label="Project" className="flex flex-col gap-2">
            <div className="font-mono text-[11px] uppercase tracking-[0.14em] text-slate-400">Project</div>
            <Link href="/sandbox" className="text-slate-600 hover:text-slate-900">
              Sandbox
            </Link>
            <Link href="/progress" className="text-slate-600 hover:text-slate-900">
              Your progress
            </Link>
            <a href={GITHUB} className="text-slate-600 hover:text-slate-900">
              Source on GitHub
            </a>
            <a href={`${GITHUB}/blob/main/CONTRIBUTING.md`} className="text-slate-600 hover:text-slate-900">
              Contribute
            </a>
          </nav>
        </div>
        <div className="border-t border-slate-100">
          <p className="mx-auto max-w-6xl px-6 py-5 text-[12px] text-slate-400">Kubernetes is a registered trademark of The Linux Foundation. kubesim is not affiliated with it.</p>
        </div>
      </footer>
    </div>
  );
}
