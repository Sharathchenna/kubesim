import { podStatusColumns, type Cluster, type Deployment, type Pod, type ReplicaSet } from "@/lib/engine";

/** The STATUS column kubectl prints for a Pod (printPod: Init:0/1, PodInitializing, CrashLoopBackOff, Terminating…). */
export function podStatus(p: Pod): string {
  return podStatusColumns(p).status;
}

export type PodCategory = "ok" | "starting" | "bad" | "done" | "gone" | "stale";

export function podCategory(p: Pod): PodCategory {
  const s = podStatus(p);
  if (s === "Terminating") return "gone";
  if (s === "Completed") return "done";
  if (s === "Running") {
    const ready = p.status?.conditions?.find((c) => c.type === "Ready")?.status === "True";
    return ready ? "ok" : "starting";
  }
  if (["Pending", "ContainerCreating", "PodInitializing", "NotReady", "SchedulingGated"].includes(s) || /^Init:\d+\/\d+$/.test(s)) return "starting";
  return "bad";
}

/** The READY column: ready containers (and started sidecars) out of all of them. */
export function podReady(p: Pod): string {
  return podStatusColumns(p).ready;
}

/** The RESTARTS count kubectl prints (app containers, plus sidecars once initialized). */
export function restarts(p: Pod): number {
  return podStatusColumns(p).restarts;
}

/** apimachinery's duration.HumanDuration, which kubectl uses for AGE, LAST SEEN and describe's Age. */
export function age(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < -1) return "<invalid>";
  if (s < 0) return "0s";
  if (s < 120) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 10) return s % 60 ? `${m}m${s % 60}s` : `${m}m`;
  if (m < 180) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 8) return m % 60 ? `${h}h${m % 60}m` : `${h}h`;
  if (h < 48) return `${h}h`;
  if (h < 24 * 8) return h % 24 ? `${Math.floor(h / 24)}d${h % 24}h` : `${Math.floor(h / 24)}d`;
  if (h < 24 * 365 * 2) return `${Math.floor(h / 24)}d`;
  const days = Math.floor(h / 24);
  if (h < 24 * 365 * 8) return days % 365 ? `${Math.floor(days / 365)}y${days % 365}d` : `${Math.floor(days / 365)}y`;
  return `${Math.floor(days / 365)}y`;
}

/** True only while a Deployment is actually moving Pods to a new template. */
export function isRollingOut(c: Cluster, d: Deployment): boolean {
  const want = d.spec?.replicas ?? 1;
  const rev = d.metadata.annotations?.["deployment.kubernetes.io/revision"];
  const owned = c.list<ReplicaSet>("ReplicaSet", d.metadata.namespace).filter((r) => r.metadata.ownerReferences?.some((o) => o.uid === d.metadata.uid));
  const withPods = owned.filter((r) => (r.spec?.replicas ?? 0) > 0 || (r.status?.replicas ?? 0) > 0);
  const cur = owned.find((r) => r.metadata.annotations?.["deployment.kubernetes.io/revision"] === rev);
  return withPods.length > 1 || (!!cur && (cur.spec?.replicas ?? 0) < want && want > 0 && withPods.some((r) => r !== cur));
}
