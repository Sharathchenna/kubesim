// default-scheduler: filters Nodes (unschedulable, taints, nodeSelector and
// node affinity, pod anti-affinity, resource requests, volume topology, pod
// count) and scores them to spread replicas of the same owner across Nodes
// and to prefer the least-allocated Node. Messages follow the scheduler
// framework plugins (behaviour reference §5, v2 §2 and §5).

import type { Cluster } from "../cluster";
import { controllerOf, isPodTerminal } from "../cluster";
import { nodeAllocatable, nodeRequested, podRequests } from "../quantity";
import type { Node, NodeSelectorTerm, PersistentVolume, PersistentVolumeClaim, Pod, StorageClass, Taint, Toleration } from "../types";
import { matchesSelectorString } from "../util";

const RETRY_MS = 5_000;
export const SELECTED_NODE = "volume.kubernetes.io/selected-node";

export function tolerates(tols: Toleration[] | undefined, t: Taint): boolean {
  return (tols ?? []).some((tol) => {
    if (tol.effect && tol.effect !== t.effect) return false;
    if (tol.operator === "Exists") return !tol.key || tol.key === t.key;
    return tol.key === t.key && (tol.value ?? "") === (t.value ?? "");
  });
}

/** Does a Node match one nodeSelectorTerm (matchExpressions on labels, matchFields on metadata.name)? */
export function termMatches(node: Node, term: NodeSelectorTerm): boolean {
  const labels = node.metadata.labels ?? {};
  for (const e of term.matchExpressions ?? []) {
    const v = labels[e.key];
    const has = e.key in labels;
    if (e.operator === "In" && !(has && e.values?.includes(v))) return false;
    if (e.operator === "NotIn" && has && e.values?.includes(v)) return false;
    if (e.operator === "Exists" && !has) return false;
    if (e.operator === "DoesNotExist" && has) return false;
    if (e.operator === "Gt" && !(has && parseInt(v, 10) > parseInt(e.values?.[0] ?? "0", 10))) return false;
    if (e.operator === "Lt" && !(has && parseInt(v, 10) < parseInt(e.values?.[0] ?? "0", 10))) return false;
  }
  for (const f of term.matchFields ?? []) {
    if (f.key !== "metadata.name") return false;
    const ok = f.values?.includes(node.metadata.name) ?? false;
    if ((f.operator === "In" && !ok) || (f.operator === "NotIn" && ok)) return false;
  }
  return true;
}

/** nodeSelector and required node affinity (terms are ORed). */
export function nodeAffinityOk(pod: Pod, node: Node): boolean {
  const sel = pod.spec?.nodeSelector ?? {};
  if (Object.entries(sel).some(([k, v]) => node.metadata.labels?.[k] !== v)) return false;
  const req = pod.spec?.affinity?.nodeAffinity?.requiredDuringSchedulingIgnoredDuringExecution;
  if (req && req.nodeSelectorTerms.length && !req.nodeSelectorTerms.some((t) => termMatches(node, t))) return false;
  return true;
}

export function runScheduler(cluster: Cluster): void {
  const pods = cluster.list<Pod>("Pod");
  const pending = pods.filter((p) => !p.spec?.nodeName && p.metadata.deletionTimestamp === undefined && !isPodTerminal(p));
  if (pending.length === 0) {
    cluster.schedulerWake = false;
    return;
  }
  const nodes = cluster.list<Node>("Node");
  // Oldest first, like the scheduling queue.
  pending.sort((a, b) => (b.spec?.priority ?? 0) - (a.spec?.priority ?? 0) || a.metadata.creationTimestamp - b.metadata.creationTimestamp);
  for (const pod of pending) {
    const uid = pod.metadata.uid;
    const nextTry = cluster.state.scheduleAttempts[uid];
    if (nextTry !== undefined && cluster.now < nextTry && !cluster.schedulerWake) continue;
    schedule(cluster, pod, nodes, cluster.list<Pod>("Pod"));
  }
  cluster.schedulerWake = false;
}

/** Volume checks before looking at Nodes: every claim must exist, and Immediate claims must be bound. */
function volumePreFilter(cluster: Cluster, pod: Pod): string | undefined {
  const ns = pod.metadata.namespace ?? "default";
  for (const v of pod.spec?.volumes ?? []) {
    if (!v.persistentVolumeClaim) continue;
    const pvc = cluster.raw("PersistentVolumeClaim", ns, v.persistentVolumeClaim.claimName) as unknown as PersistentVolumeClaim | undefined;
    if (!pvc) return `persistentvolumeclaim "${v.persistentVolumeClaim.claimName}" not found`;
    if (pvc.metadata.deletionTimestamp !== undefined) return `persistentvolumeclaim "${pvc.metadata.name}" is being deleted`;
    if (pvc.status?.phase === "Bound") continue;
    const sc = pvc.spec?.storageClassName ? (cluster.raw("StorageClass", undefined, pvc.spec.storageClassName) as unknown as StorageClass | undefined) : undefined;
    if (sc?.volumeBindingMode !== "WaitForFirstConsumer") return "pod has unbound immediate PersistentVolumeClaims";
  }
  return undefined;
}

/** A bound PV that only exists on one Node (local-path) pins the Pod there. */
function volumeNodeOk(cluster: Cluster, pod: Pod, node: Node): boolean {
  const ns = pod.metadata.namespace ?? "default";
  for (const v of pod.spec?.volumes ?? []) {
    if (!v.persistentVolumeClaim) continue;
    const pvc = cluster.raw("PersistentVolumeClaim", ns, v.persistentVolumeClaim.claimName) as unknown as PersistentVolumeClaim | undefined;
    if (!pvc?.spec?.volumeName) continue;
    const pv = cluster.raw("PersistentVolume", undefined, pvc.spec.volumeName) as unknown as PersistentVolume | undefined;
    const terms = pv?.spec?.nodeAffinity?.required?.nodeSelectorTerms;
    if (terms?.length && !terms.some((t) => termMatches(node, t))) return false;
  }
  return true;
}

function antiAffinityOk(pod: Pod, node: Node, allPods: Pod[]): boolean {
  const terms = pod.spec?.affinity?.podAntiAffinity?.requiredDuringSchedulingIgnoredDuringExecution ?? [];
  for (const t of terms) {
    if (t.topologyKey !== "kubernetes.io/hostname") continue;
    const clash = allPods.some(
      (p) => p.spec?.nodeName === node.metadata.name && !isPodTerminal(p) && p.metadata.namespace === pod.metadata.namespace && matchesSelectorString(p.metadata.labels, t.labelSelector ?? {}),
    );
    if (clash) return false;
  }
  return true;
}

function schedule(cluster: Cluster, pod: Pod, nodes: Node[], allPods: Pod[]): void {
  const reasons: Record<string, number> = {};
  const noVictims: Record<string, number> = {};
  const fit: Node[] = [];
  const bump = (r: string) => (reasons[r] = (reasons[r] ?? 0) + 1);
  const want = podRequests(pod.spec);

  const pre = volumePreFilter(cluster, pod);
  if (pre) return unschedulable(cluster, pod, `0/${nodes.length} nodes are available: ${pre}. preemption: 0/${nodes.length} nodes are available: ${nodes.length} Preemption is not helpful for scheduling.`);

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
    if (!nodeAffinityOk(pod, n)) {
      bump("node(s) didn't match Pod's node affinity/selector");
      continue;
    }
    // NodeResourcesFit (runs before VolumeBinding and InterPodAffinity) reports every resource that doesn't fit.
    const count = allPods.filter((p) => p.spec?.nodeName === n.metadata.name && !isPodTerminal(p)).length;
    const alloc = nodeAllocatable(n);
    const used = nodeRequested(allPods, n.metadata.name);
    const short: string[] = [];
    if (count >= parseInt(n.status?.allocatable.pods ?? "110", 10)) short.push("Too many pods");
    if (want.cpu && used.cpu + want.cpu > alloc.cpu) short.push("Insufficient cpu");
    if (want.memory && used.memory + want.memory > alloc.memory) short.push("Insufficient memory");
    if (short.length) {
      for (const s of short) bump(s);
      noVictims[n.metadata.name] = 1;
      continue;
    }
    if (!volumeNodeOk(cluster, pod, n)) {
      bump("node(s) had volume node affinity conflict");
      continue;
    }
    if (!antiAffinityOk(pod, n, allPods)) {
      // InterPodAffinity is Unschedulable (not UnschedulableAndUnresolvable): preemption could help.
      bump("node(s) didn't match pod anti-affinity rules");
      noVictims[n.metadata.name] = 1;
      continue;
    }
    fit.push(n);
  }

  if (fit.length === 0) {
    const hist = Object.entries(reasons)
      .map(([r, c]) => `${c} ${r}`)
      .sort()
      .join(", ");
    const nv = Object.keys(noVictims).length;
    const tail = [nodes.length - nv > 0 ? `${nodes.length - nv} Preemption is not helpful for scheduling` : "", nv ? `${nv} No preemption victims found for incoming pod` : ""].filter(Boolean).sort().join(", ");
    const msg = `0/${nodes.length} nodes are available: ${hist || "no nodes available to schedule pods"}. preemption: 0/${nodes.length} nodes are available: ${tail || `${nodes.length} Preemption is not helpful for scheduling`}.`;
    return unschedulable(cluster, pod, msg);
  }

  const owner = controllerOf(pod)?.uid;
  const scored = fit.map((n) => {
    const onNode = allPods.filter((p) => p.spec?.nodeName === n.metadata.name && !isPodTerminal(p) && p.metadata.deletionTimestamp === undefined);
    const siblings = owner ? onNode.filter((p) => controllerOf(p)?.uid === owner).length : 0;
    const alloc = nodeAllocatable(n);
    const used = nodeRequested(allPods, n.metadata.name);
    // NodeResourcesFit LeastAllocated: prefer the emptier Node.
    const load = ((used.cpu + want.cpu) / alloc.cpu + (used.memory + want.memory) / alloc.memory) * 50;
    const preferred = (pod.spec?.affinity?.nodeAffinity?.preferredDuringSchedulingIgnoredDuringExecution ?? []).reduce((a, p) => a + (termMatches(n, p.preference) ? p.weight : 0), 0);
    return { n, score: -siblings * 1000 - onNode.length - load + preferred * 10, tie: cluster.rng.next() };
  });
  scored.sort((a, b) => b.score - a.score || a.tie - b.tie);
  const node = scored[0].n;
  // WaitForFirstConsumer: tell the provisioner which Node the Pod landed on.
  for (const v of pod.spec?.volumes ?? []) {
    if (!v.persistentVolumeClaim) continue;
    const pvc = cluster.raw("PersistentVolumeClaim", pod.metadata.namespace, v.persistentVolumeClaim.claimName) as unknown as PersistentVolumeClaim | undefined;
    if (pvc && pvc.status?.phase !== "Bound" && !pvc.metadata.annotations?.[SELECTED_NODE]) {
      cluster.update(pvc, (x) => {
        x.metadata.annotations = { ...(x.metadata.annotations ?? {}), [SELECTED_NODE]: node.metadata.name };
      });
    }
  }
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

function unschedulable(cluster: Cluster, pod: Pod, msg: string): void {
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
}
