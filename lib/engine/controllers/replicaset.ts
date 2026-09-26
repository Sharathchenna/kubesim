// replicaset-controller: adopts/releases Pods by selector, creates or deletes
// Pods to match spec.replicas, and writes status (behaviour reference §3).

import { controllerOf, isPodReady, isPodTerminal, type Cluster } from "../cluster";
import type { Node, OwnerReference, Pod, ReplicaSet } from "../types";
import { clone, matchesSelector } from "../util";

export function isPodActive(p: Pod): boolean {
  return !isPodTerminal(p) && p.metadata.deletionTimestamp === undefined;
}

export function isPodAvailable(p: Pod, minReadySeconds: number, now: number): boolean {
  if (!isPodReady(p)) return false;
  const t = p.status?.conditions?.find((c) => c.type === "Ready")?.lastTransitionTime ?? 0;
  return now - t >= minReadySeconds * 1000;
}

export function ownerRef(o: { apiVersion: string; kind: string; metadata: { name: string; uid: string } }): OwnerReference {
  return { apiVersion: o.apiVersion, kind: o.kind, name: o.metadata.name, uid: o.metadata.uid, controller: true, blockOwnerDeletion: true };
}

/** Scale-down order: which Pods to delete first (ActivePodsWithRanks.Less). */
function victimOrder(cluster: Cluster, pods: Pod[]): Pod[] {
  const phaseRank = (p: Pod) => ({ Pending: 0, Unknown: 1, Running: 2 } as Record<string, number>)[p.status?.phase ?? "Pending"] ?? 2;
  const perNode: Record<string, number> = {};
  for (const p of pods) if (p.spec?.nodeName) perNode[p.spec.nodeName] = (perNode[p.spec.nodeName] ?? 0) + 1;
  const restarts = (p: Pod) => (p.status?.containerStatuses ?? []).reduce((a, c) => a + c.restartCount, 0);
  const readySince = (p: Pod) => p.status?.conditions?.find((c) => c.type === "Ready")?.lastTransitionTime ?? 0;
  const nodeReady = (p: Pod) => {
    const n = p.spec?.nodeName ? cluster.raw("Node", undefined, p.spec.nodeName) : undefined;
    return n ? cluster.nodeReady(n as unknown as Node) : false;
  };
  return [...pods].sort((a, b) => {
    const sa = a.spec?.nodeName ? 1 : 0;
    const sb = b.spec?.nodeName ? 1 : 0;
    if (sa !== sb) return sa - sb;
    if (phaseRank(a) !== phaseRank(b)) return phaseRank(a) - phaseRank(b);
    const ra = isPodReady(a) && nodeReady(a) ? 1 : 0;
    const rb = isPodReady(b) && nodeReady(b) ? 1 : 0;
    if (ra !== rb) return ra - rb;
    const na = perNode[a.spec?.nodeName ?? ""] ?? 0;
    const nb = perNode[b.spec?.nodeName ?? ""] ?? 0;
    if (na !== nb) return nb - na;
    if (ra && rb && readySince(a) !== readySince(b)) return readySince(b) - readySince(a);
    if (restarts(a) !== restarts(b)) return restarts(b) - restarts(a);
    return b.metadata.creationTimestamp - a.metadata.creationTimestamp;
  });
}

export function runReplicaSets(cluster: Cluster): void {
  const now = cluster.now;
  for (const rs of cluster.list<ReplicaSet>("ReplicaSet")) {
    if (rs.metadata.deletionTimestamp !== undefined) continue;
    const ns = rs.metadata.namespace!;
    const sel = rs.spec!.selector;
    const pods = cluster.list<Pod>("Pod", ns);

    // Adopt orphans and release Pods that no longer match.
    for (const p of pods) {
      const ctl = controllerOf(p);
      const matches = matchesSelector(p.metadata.labels, sel);
      if (!ctl && matches && isPodActive(p)) {
        cluster.update(p, (d) => {
          d.metadata.ownerReferences = [...(d.metadata.ownerReferences ?? []), ownerRef(rs)];
        });
      } else if (ctl?.uid === rs.metadata.uid && !matches) {
        cluster.update(p, (d) => {
          d.metadata.ownerReferences = d.metadata.ownerReferences!.filter((r) => r.uid !== rs.metadata.uid);
          if (d.metadata.ownerReferences.length === 0) delete d.metadata.ownerReferences;
        });
      }
    }

    const owned = cluster.list<Pod>("Pod", ns).filter((p) => controllerOf(p)?.uid === rs.metadata.uid);
    const active = owned.filter(isPodActive);
    const want = rs.spec!.replicas ?? 1;
    const diff = active.length - want;
    if (diff < 0) {
      for (let i = 0; i < Math.min(-diff, 500); i++) {
        const tpl = clone(rs.spec!.template);
        try {
          const pod = cluster.create<Pod>({
            apiVersion: "v1",
            kind: "Pod",
            metadata: {
              generateName: `${rs.metadata.name}-`,
              namespace: ns,
              labels: tpl.metadata?.labels,
              ...(tpl.metadata?.annotations ? { annotations: tpl.metadata.annotations } : {}),
              ownerReferences: [ownerRef(rs)],
            },
            spec: tpl.spec,
          });
          cluster.record(rs, "Normal", "SuccessfulCreate", `Created pod: ${pod.metadata.name}`, "replicaset-controller");
        } catch (e) {
          cluster.record(rs, "Warning", "FailedCreate", `Error creating: ${(e as Error).message.replace(/^Error from server \(\w+\): /, "")}`, "replicaset-controller");
          break;
        }
      }
    } else if (diff > 0) {
      for (const p of victimOrder(cluster, active).slice(0, diff)) {
        cluster.deleteObject(p);
        cluster.record(rs, "Normal", "SuccessfulDelete", `Deleted pod: ${p.metadata.name}`, "replicaset-controller");
      }
    }

    const after = cluster.list<Pod>("Pod", ns).filter((p) => controllerOf(p)?.uid === rs.metadata.uid);
    const act = after.filter(isPodActive);
    const minReady = rs.spec!.minReadySeconds ?? 0;
    const status = {
      replicas: act.length,
      fullyLabeledReplicas: act.filter((p) => matchesSelector(p.metadata.labels, { matchLabels: rs.spec!.template.metadata?.labels })).length,
      readyReplicas: act.filter(isPodReady).length,
      availableReplicas: act.filter((p) => isPodAvailable(p, minReady, now)).length,
      observedGeneration: rs.metadata.generation,
    };
    const cur = cluster.get<ReplicaSet>("ReplicaSet", ns, rs.metadata.name);
    cluster.update(cur, (d) => {
      d.status = {
        replicas: status.replicas,
        ...(status.fullyLabeledReplicas ? { fullyLabeledReplicas: status.fullyLabeledReplicas } : {}),
        ...(status.readyReplicas ? { readyReplicas: status.readyReplicas } : {}),
        ...(status.availableReplicas ? { availableReplicas: status.availableReplicas } : {}),
        observedGeneration: status.observedGeneration,
      };
    });
  }
}
