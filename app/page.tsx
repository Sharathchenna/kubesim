import Link from "next/link";
import { AppHeader, Logo } from "@/components/AppHeader";
import { Blueprint } from "@/components/home/Blueprint";
import { TryItSection } from "@/components/home/TryItSection";
import { CHALLENGES, EXAMS, EXAM_TRADEMARK_NOTICE, EXPLAINERS, LESSONS, TRACKS, trackOf } from "@/lib/lessons/meta";
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

/** One labelled row of the index under the drawing. */
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-3 border-b border-ink/25 py-5 md:grid-cols-[11rem_1fr] md:gap-0">
      <h2 className="text-[13px] font-semibold uppercase tracking-[0.08em]">{label}</h2>
      {children}
    </div>
  );
}

function Item({ href, title, note }: { href: string; title: string; note?: string }) {
  return (
    <Link href={href} className="group block py-1">
      <span className="text-[15.5px] underline-offset-4 group-hover:underline">{title}</span>
      {note && <span className="block text-[13px] text-ink-soft">{note}</span>}
    </Link>
  );
}

export default function Home() {
  return (
    <div className="font-sheet min-h-screen bg-paper text-ink">
      <AppHeader sheet />
      <main id="main" className="mx-auto max-w-6xl px-4 pb-10 sm:px-6">
        {/* ---------------------------------------------------------------- the drawing */}
        <section aria-labelledby="title" className="mt-6 border-[1.5px] border-ink sm:mt-8">
          <div className="grid grid-cols-1 border-b-[1.5px] border-ink md:grid-cols-[1fr_auto]">
            <div className="px-5 py-5 sm:px-7 sm:py-6">
              <h1 id="title" className="font-display text-balance text-[34px] leading-[1.08] sm:text-[44px]">
                What happens when you delete a Pod.
              </h1>
              <p className="text-pretty mt-2 max-w-3xl text-[18px] leading-snug text-ink-soft sm:text-[22px]">Learn Kubernetes on a cluster simulated in your browser, and watch every step as it happens.</p>
            </div>
            <div className="flex flex-col justify-center gap-2.5 border-t-[1.5px] border-ink px-5 py-5 text-[15px] sm:flex-row md:flex-col md:border-l-[1.5px] md:border-t-0 md:px-7">
              <Link href="/learn/first-pod" className="border-[1.5px] border-ink bg-ink px-4 py-2.5 text-center text-paper transition-colors hover:bg-signal hover:border-signal">
                Start lesson 1: your first Pod
              </Link>
              <Link href="/sandbox" className="border-[1.5px] border-ink px-4 py-2.5 text-center transition-colors hover:bg-ink/5">
                Open an empty cluster
              </Link>
            </div>
          </div>
          <Blueprint />
        </section>

        {/* ---------------------------------------------------------------- the live cluster */}
        <section aria-labelledby="try" className="mt-12">
          <div className="mb-4 grid grid-cols-1 items-end gap-3 md:grid-cols-[1fr_auto]">
            <div>
              <h2 id="try" className="font-display text-[28px] leading-tight">
                Now do it yourself
              </h2>
              <p className="text-pretty mt-1 max-w-2xl text-[16px] leading-snug text-ink-soft">This cluster is running in the page: three Nodes and a Deployment called web. Delete one of its Pods and watch the ReplicaSet replace it, or type any kubectl command.</p>
            </div>
            <Link href="/sandbox" className="text-[15px] underline decoration-[1.5px] underline-offset-4 hover:text-signal">
              Full-size sandbox
            </Link>
          </div>
          <div className="overflow-hidden border-[1.5px] border-ink bg-paper">
            <TryItSection />
          </div>
        </section>

        {/* ---------------------------------------------------------------- everything else */}
        <div className="mt-12 border-t-[1.5px] border-ink">
          <Row label="Learn">
            <div>
              <ol className="grid grid-cols-2 gap-x-7 gap-y-2 md:grid-cols-4">
                {TRACKS.map((t, i) => {
                  const n = LESSONS.filter((l) => trackOf(l) === t.id).length;
                  return (
                    <li key={t.id}>
                      <Item href={`/learn#${t.id}`} title={`${String(i + 1).padStart(2, "0")} ${t.title}`} note={`${n} lesson${n === 1 ? "" : "s"}`} />
                    </li>
                  );
                })}
              </ol>
              <p className="mt-3 text-[14px] text-ink-soft">
                {LESSONS.length} lessons with a live terminal. Each step checks itself as you type.{" "}
                <Link href="/learn" className="text-ink underline underline-offset-4 hover:text-signal">
                  All lessons
                </Link>
              </p>
            </div>
          </Row>
          <Row label="Practise">
            <div className="grid grid-cols-2 gap-x-7 gap-y-2 md:grid-cols-4">
              <Item href="/challenges" title="Challenges" note={`${CHALLENGES.length} broken clusters to fix`} />
              {EXAMS.map((e) => (
                <Item key={e.slug} href={`/exams/${e.slug}`} title={e.title} note={`${e.tasks.length} tasks · ${e.minutes} min, unofficial`} />
              ))}
              <Item href="/sandbox" title="Sandbox" note="An empty cluster, nobody grading" />
            </div>
          </Row>
          <Row label="Watch">
            <div className="grid grid-cols-2 gap-x-7 gap-y-2 md:grid-cols-4">
              {EXPLAINERS.slice(0, 3).map((e) => (
                <Item key={e.id} href={`/explainers/${e.id}`} title={e.title} note="Narrated replay" />
              ))}
              <Item href="/explainers" title={`${EXPLAINERS.length - 3} more explainers`} note="All explainers" />
            </div>
          </Row>
          <Row label="Simulated">
            <div>
              <dl className="grid grid-cols-1 gap-x-7 gap-y-3 lg:grid-cols-2">
                {SIMULATED.map((s) => (
                  <div key={s.group} className="grid grid-cols-[6.5rem_1fr] gap-3">
                    <dt className="text-[14.5px]">{s.group}</dt>
                    <dd className="text-[13.5px] leading-relaxed text-ink-soft">
                      <span className="font-mono text-[12.5px] text-ink">{s.kinds.join(" · ")}</span>
                      {s.also && <> · {s.also.join(" · ")}</>}
                    </dd>
                  </div>
                ))}
              </dl>
              <p className="text-pretty mt-4 max-w-3xl text-[14px] text-ink-soft">Back-off timings, events, scheduler reasons and kubectl output follow real Kubernetes defaults, and each behaviour is written up from the Kubernetes source and pinned by tests. It&apos;s still a simulation, so some corners are simpler than the real thing.</p>
            </div>
          </Row>
        </div>
      </main>

      {/* ---------------------------------------------------------------- title block */}
      <footer className="mx-auto max-w-6xl px-4 pb-10 sm:px-6">
        <div className="grid grid-cols-1 border-[1.5px] border-ink text-[13.5px] md:grid-cols-[2fr_1fr_1fr_1fr_1fr]">
          {[
            ["Project", <span key="p" className="flex items-center gap-2"><Logo /><span className="text-ink-soft">a Kubernetes cluster simulated in your browser, for learning</span></span>],
            ["Modelled on", "Kubernetes v1.37"],
            ["Licence", "MIT, free and open source"],
            ["Source", <span key="s"><a href={GITHUB} className="underline underline-offset-4 hover:text-signal">GitHub</a> · <a href={`${GITHUB}/blob/main/CONTRIBUTING.md`} className="underline underline-offset-4 hover:text-signal">Contribute</a></span>],
            ["Version", version],
          ].map(([k, v], i) => (
            <div key={i} className={`px-3 py-2.5 ${i ? "border-t border-ink md:border-l md:border-t-0" : ""}`}>
              <div className="text-[10.5px] uppercase tracking-[0.1em] text-ink-soft">{k}</div>
              <div className="mt-0.5">{v}</div>
            </div>
          ))}
        </div>
        <p className="mt-4 text-[12.5px] leading-relaxed text-ink-soft">Kubernetes® is a registered trademark of The Linux Foundation. {EXAM_TRADEMARK_NOTICE}</p>
      </footer>
    </div>
  );
}
