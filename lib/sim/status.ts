import type { Cluster, Deployment, Pod, ReplicaSet } from "@/lib/engine";

/** The STATUS column kubectl prints for a Pod. */
export function podStatus(p: Pod): string {
  if (p.metadata.deletionTimestamp !== undefined) return "Terminating";
  const cs = p.status?.containerStatuses ?? [];
  for (const c of cs) if (c.state.waiting?.reason && c.state.waiting.reason !== "ContainerCreating") return c.state.waiting.reason;
  for (const c of cs) if (c.state.terminated?.reason && p.status?.phase !== "Succeeded" && p.status?.phase !== "Failed") return c.state.terminated.reason;
  if (p.status?.phase === "Succeeded") return "Completed";
  if (p.status?.phase === "Failed") return "Error";
  if (cs.some((c) => c.state.waiting?.reason === "ContainerCreating")) return "ContainerCreating";
  if (p.spec?.nodeName && p.status?.phase === "Pending") return "ContainerCreating";
  return p.status?.phase ?? "Pending";
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
  if (s === "Pending" || s === "ContainerCreating") return "starting";
  return "bad";
}

export function podReady(p: Pod): string {
  const cs = p.status?.containerStatuses ?? [];
  return `${cs.filter((c) => c.ready).length}/${p.spec?.containers.length ?? 0}`;
}

export function restarts(p: Pod): number {
  return (p.status?.containerStatuses ?? []).reduce((a, c) => a + c.restartCount, 0);
}

export function age(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 120) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 10) return `${m}m${s % 60 ? `${s % 60}s` : ""}`;
  if (m < 180) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
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
