// node-lifecycle-controller + taint-eviction: marks silent Nodes NotReady,
// taints them, and evicts Pods once their tolerationSeconds run out (§8).

import type { Cluster } from "../cluster";
import type { Node, Pod, Taint } from "../types";

const UNREACHABLE = "node.kubernetes.io/unreachable";
const NOT_READY = "node.kubernetes.io/not-ready";

export function runNodeLifecycle(cluster: Cluster): void {
  const now = cluster.now;
  const grace = cluster.state.config.nodeMonitorGracePeriodMs;
  for (const node of cluster.list<Node>("Node")) {
    const name = node.metadata.name;
    const rt = cluster.state.nodes[name];
    if (!rt) continue;
    const ready = node.status?.conditions.find((c) => c.type === "Ready");
    const silent = now - rt.lastHeartbeat > grace;

    if (silent && ready?.status !== "Unknown") {
      cluster.update(node, (n) => {
        n.status!.conditions = n.status!.conditions.map((c) => ({
          ...c,
          status: "Unknown",
          lastTransitionTime: now,
          reason: "NodeStatusUnknown",
          message: "Kubelet stopped posting node status.",
        }));
        const taints = (n.spec!.taints ?? []).filter((t) => t.key !== NOT_READY && t.key !== UNREACHABLE);
        taints.push({ key: UNREACHABLE, effect: "NoExecute", timeAdded: now }, { key: UNREACHABLE, effect: "NoSchedule", timeAdded: now });
        n.spec!.taints = taints;
      });
      cluster.record(node, "Normal", "NodeNotReady", `Node ${name} status is now: NodeNotReady`, "node-controller");
      for (const p of cluster.list<Pod>("Pod")) {
        if (p.spec?.nodeName !== name) continue;
        cluster.update(p, (d) => {
          d.status!.conditions = (d.status!.conditions ?? []).map((c) =>
            c.type === "Ready" ? { ...c, status: "False", lastTransitionTime: now, reason: undefined, message: undefined } : c,
          );
        });
        cluster.record(p, "Warning", "NodeNotReady", "Node is not ready", "node-controller");
      }
      continue;
    }

    // Healthy again (or first Ready): drop the lifecycle taints.
    const cur = cluster.get<Node>("Node", undefined, name);
    const curReady = cur.status?.conditions.find((c) => c.type === "Ready");
    if (curReady?.status === "True" && (cur.spec?.taints ?? []).some((t) => t.key === NOT_READY || t.key === UNREACHABLE)) {
      cluster.update(cur, (n) => {
        n.spec!.taints = (n.spec!.taints ?? []).filter((t) => t.key !== NOT_READY && t.key !== UNREACHABLE);
      });
    }
  }

  // Taint-based eviction.
  for (const node of cluster.list<Node>("Node")) {
    const noExec = (node.spec?.taints ?? []).filter((t) => t.effect === "NoExecute");
    if (noExec.length === 0) continue;
    for (const p of cluster.list<Pod>("Pod")) {
      if (p.spec?.nodeName !== node.metadata.name || p.metadata.deletionTimestamp !== undefined) continue;
      if (noExec.every((t) => now < evictAt(p, t))) continue;
      cluster.record(p, "Normal", "TaintManagerEviction", `Marking for deletion Pod ${p.metadata.namespace}/${p.metadata.name}`, "taint-eviction-controller");
      const updated = cluster.update(p, (d) => {
        d.status!.conditions = [
          ...(d.status!.conditions ?? []),
          { type: "DisruptionTarget", status: "True", lastProbeTime: null, lastTransitionTime: now, reason: "DeletionByTaintManager", message: "Taint manager: deleting due to NoExecute taint" },
        ];
      });
      cluster.deleteObject(updated);
    }
  }
}

/** When a Pod must leave because of a NoExecute taint (Infinity = tolerated forever). */
function evictAt(p: Pod, t: Taint): number {
  const tol = (p.spec?.tolerations ?? []).find((x) => {
    if (x.effect && x.effect !== "NoExecute") return false;
    if (x.operator === "Exists") return !x.key || x.key === t.key;
    return x.key === t.key && (x.value ?? "") === (t.value ?? "");
  });
  if (!tol) return t.timeAdded ?? 0;
  if (tol.tolerationSeconds === undefined) return Infinity;
  return (t.timeAdded ?? 0) + tol.tolerationSeconds * 1000;
}
