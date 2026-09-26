// default-scheduler: filters Nodes (unschedulable, taints, nodeSelector, pod
// count) and scores them to spread replicas of the same owner across Nodes.

import type { Cluster } from "../cluster";
import { controllerOf, isPodTerminal } from "../cluster";
import type { Node, Pod, Taint, Toleration } from "../types";

const RETRY_MS = 5_000;

export function tolerates(tols: Toleration[] | undefined, t: Taint): boolean {
  return (tols ?? []).some((tol) => {
    if (tol.effect && tol.effect !== t.effect) return false;
    if (tol.operator === "Exists") return !tol.key || tol.key === t.key;
    return tol.key === t.key && (tol.value ?? "") === (t.value ?? "");
  });
}

export function runScheduler(cluster: Cluster): void {
  const pods = cluster.list<Pod>("Pod");
  const pending = pods.filter((p) => !p.spec?.nodeName && p.metadata.deletionTimestamp === undefined && !isPodTerminal(p));
  if (pending.length === 0) return;
  const nodes = cluster.list<Node>("Node");
  // Oldest first, like the scheduling queue.
  pending.sort((a, b) => a.metadata.creationTimestamp - b.metadata.creationTimestamp);
  for (const pod of pending) {
    const uid = pod.metadata.uid;
    const nextTry = cluster.state.scheduleAttempts[uid];
    if (nextTry !== undefined && cluster.now < nextTry && !cluster.schedulerWake) continue;
    schedule(cluster, pod, nodes, cluster.list<Pod>("Pod"));
  }
  cluster.schedulerWake = false;
}

function schedule(cluster: Cluster, pod: Pod, nodes: Node[], allPods: Pod[]): void {
  const reasons: Record<string, number> = {};
  const fit: Node[] = [];
  const bump = (r: string) => (reasons[r] = (reasons[r] ?? 0) + 1);
  for (const n of nodes) {
    if (n.spec?.unschedulable && !tolerates(pod.spec?.tolerations, { key: "node.kubernetes.io/unschedulable", effect: "NoSchedule" })) {
      bump("node(s) were unschedulable");
      continue;
    }
    const bad = (n.spec?.taints ?? []).some((t) => (t.effect === "NoSchedule" || t.effect === "NoExecute") && !tolerates(pod.spec?.tolerations, t));
    if (bad) {
      bump("node(s) had untolerated taint(s)");
      continue;
    }
    const sel = pod.spec?.nodeSelector ?? {};
    if (Object.entries(sel).some(([k, v]) => n.metadata.labels?.[k] !== v)) {
      bump("node(s) didn't match Pod's node affinity/selector");
      continue;
    }
    const count = allPods.filter((p) => p.spec?.nodeName === n.metadata.name && !isPodTerminal(p)).length;
    if (count >= parseInt(n.status?.allocatable.pods ?? "110", 10)) {
      bump("Too many pods");
      continue;
    }
    fit.push(n);
  }

  if (fit.length === 0) {
    const hist = Object.entries(reasons)
      .map(([r, c]) => `${c} ${r}`)
      .sort()
      .join(", ");
    const msg = `0/${nodes.length} nodes are available: ${hist || "no nodes available to schedule pods"}. preemption: 0/${nodes.length} nodes are available: ${nodes.length} Preemption is not helpful for scheduling.`;
    cluster.update(pod, (p) => {
      p.status ??= { phase: "Pending" };
      p.status.conditions = [
        ...(p.status.conditions ?? []).filter((c) => c.type !== "PodScheduled"),
        { type: "PodScheduled", status: "False", lastProbeTime: null, lastTransitionTime: cluster.now, reason: "Unschedulable", message: msg },
      ];
      // Keep the old transition time if nothing changed.
      const old = pod.status?.conditions?.find((c) => c.type === "PodScheduled");
      if (old && old.message === msg) p.status.conditions[p.status.conditions.length - 1].lastTransitionTime = old.lastTransitionTime;
    });
    cluster.record(pod, "Warning", "FailedScheduling", msg, "default-scheduler");
    cluster.state.scheduleAttempts[pod.metadata.uid] = cluster.now + RETRY_MS;
    return;
  }

  const owner = controllerOf(pod)?.uid;
  const scored = fit.map((n) => {
    const onNode = allPods.filter((p) => p.spec?.nodeName === n.metadata.name && !isPodTerminal(p) && p.metadata.deletionTimestamp === undefined);
    const siblings = owner ? onNode.filter((p) => controllerOf(p)?.uid === owner).length : 0;
    return { n, score: -siblings * 1000 - onNode.length, tie: cluster.rng.next() };
  });
  scored.sort((a, b) => b.score - a.score || a.tie - b.tie);
  const node = scored[0].n;
  cluster.update(pod, (p) => {
    p.spec!.nodeName = node.metadata.name;
    p.status ??= { phase: "Pending" };
    p.status.conditions = [
      ...(p.status.conditions ?? []).filter((c) => c.type !== "PodScheduled"),
      { type: "PodScheduled", status: "True", lastProbeTime: null, lastTransitionTime: cluster.now },
    ];
  });
  delete cluster.state.scheduleAttempts[pod.metadata.uid];
  cluster.record(pod, "Normal", "Scheduled", `Successfully assigned ${pod.metadata.namespace}/${pod.metadata.name} to ${node.metadata.name}`, "default-scheduler");
}
