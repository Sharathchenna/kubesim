// daemonset-controller: one Pod per eligible Node. Pods are pinned with
// required node affinity on metadata.name and scheduled by the default
// scheduler, get the DaemonSet tolerations (so they survive cordon and never
// get evicted from unreachable Nodes), and roll one Node at a time.

import { controllerOf, isPodReady, isPodTerminal, type Cluster } from "../cluster";
import type { DaemonSet, Node, Pod, Toleration } from "../types";
import { clone, intOrPercent } from "../util";
import { ownerRef, isPodAvailable } from "./replicaset";
import { templateHash } from "./deployment";
import { nodeAffinityOk, tolerates } from "./scheduler";

const DS_TOLERATIONS: Toleration[] = [
  { key: "node.kubernetes.io/not-ready", operator: "Exists", effect: "NoExecute" },
  { key: "node.kubernetes.io/unreachable", operator: "Exists", effect: "NoExecute" },
  { key: "node.kubernetes.io/disk-pressure", operator: "Exists", effect: "NoSchedule" },
  { key: "node.kubernetes.io/memory-pressure", operator: "Exists", effect: "NoSchedule" },
  { key: "node.kubernetes.io/pid-pressure", operator: "Exists", effect: "NoSchedule" },
  { key: "node.kubernetes.io/unschedulable", operator: "Exists", effect: "NoSchedule" },
];

/** The Node a DaemonSet Pod is pinned to. */
export function dsTargetNode(p: Pod): string | undefined {
  if (p.spec?.nodeName) return p.spec.nodeName;
  for (const t of p.spec?.affinity?.nodeAffinity?.requiredDuringSchedulingIgnoredDuringExecution?.nodeSelectorTerms ?? []) {
    const f = t.matchFields?.find((m) => m.key === "metadata.name");
    if (f?.values?.[0]) return f.values[0];
  }
  return undefined;
}

function eligible(ds: DaemonSet, node: Node): boolean {
  const probe = { spec: { ...ds.spec!.template.spec, tolerations: [...(ds.spec!.template.spec.tolerations ?? []), ...DS_TOLERATIONS] } } as Pod;
  if (!nodeAffinityOk(probe, node)) return false;
  return !(node.spec?.taints ?? []).some((t) => (t.effect === "NoSchedule" || t.effect === "NoExecute") && !tolerates(probe.spec!.tolerations, t));
}

export function runDaemonSets(cluster: Cluster): void {
  const now = cluster.now;
  const nodes = cluster.list<Node>("Node");
  for (const ds of cluster.list<DaemonSet>("DaemonSet")) {
    if (ds.metadata.deletionTimestamp !== undefined) continue;
    const ns = ds.metadata.namespace!;
    const hash = templateHash(ds.spec!.template);
    const gen = String(ds.metadata.generation ?? 1);
    const owned = cluster.list<Pod>("Pod", ns).filter((p) => controllerOf(p)?.uid === ds.metadata.uid && !isPodTerminal(p));
    const byNode = new Map<string, Pod[]>();
    for (const p of owned) {
      const n = dsTargetNode(p) ?? "";
      (byNode.get(n) ?? byNode.set(n, []).get(n)!).push(p);
    }
    const want = nodes.filter((n) => eligible(ds, n));
    const wantNames = new Set(want.map((n) => n.metadata.name));

    // Remove Pods on Nodes that no longer qualify (or no longer exist).
    for (const [n, ps] of byNode) {
      if (wantNames.has(n)) continue;
      for (const p of ps) {
        if (p.metadata.deletionTimestamp !== undefined) continue;
        cluster.deleteObject(p);
        cluster.record(ds, "Normal", "SuccessfulDelete", `Deleted pod: ${p.metadata.name}`, "daemonset-controller");
      }
    }

    // Create the missing ones.
    for (const n of want) {
      const live = (byNode.get(n.metadata.name) ?? []).filter((p) => p.metadata.deletionTimestamp === undefined);
      if (live.length) continue;
      if ((byNode.get(n.metadata.name) ?? []).length) continue; // wait for the old one to terminate
      const tpl = clone(ds.spec!.template);
      const tols = [...(tpl.spec.tolerations ?? [])];
      const extra = tpl.spec.hostNetwork ? [...DS_TOLERATIONS, { key: "node.kubernetes.io/network-unavailable", operator: "Exists", effect: "NoSchedule" } as Toleration] : DS_TOLERATIONS;
      for (const t of extra) if (!tols.some((x) => x.key === t.key && x.effect === t.effect)) tols.push(t);
      try {
        const pod = cluster.create<Pod>({
          apiVersion: "v1",
          kind: "Pod",
          metadata: {
            generateName: `${ds.metadata.name}-`,
            namespace: ns,
            labels: { ...(tpl.metadata?.labels ?? {}), [`controller-revision-hash`]: hash, "pod-template-generation": gen },
            ...(tpl.metadata?.annotations ? { annotations: tpl.metadata.annotations } : {}),
            ownerReferences: [ownerRef(ds)],
          },
          spec: {
            ...tpl.spec,
            tolerations: tols,
            affinity: {
              ...(tpl.spec.affinity ?? {}),
              nodeAffinity: { requiredDuringSchedulingIgnoredDuringExecution: { nodeSelectorTerms: [{ matchFields: [{ key: "metadata.name", operator: "In", values: [n.metadata.name] }] }] } },
            },
          },
        });
        cluster.record(ds, "Normal", "SuccessfulCreate", `Created pod: ${pod.metadata.name}`, "daemonset-controller");
      } catch (e) {
        cluster.record(ds, "Warning", "FailedCreate", `Error creating: ${(e as Error).message.replace(/^Error from server \(\w+\): /, "")}`, "daemonset-controller");
      }
    }

    // RollingUpdate: replace outdated Pods, maxUnavailable at a time.
    if (ds.spec!.updateStrategy?.type !== "OnDelete") {
      const maxUnavail = Math.max(1, intOrPercent(ds.spec!.updateStrategy?.rollingUpdate?.maxUnavailable, want.length, true, "1"));
      const cur = cluster.list<Pod>("Pod", ns).filter((p) => controllerOf(p)?.uid === ds.metadata.uid && !isPodTerminal(p));
      const unavailable = want.filter((n) => !cur.some((p) => dsTargetNode(p) === n.metadata.name && p.metadata.deletionTimestamp === undefined && isPodReady(p))).length;
      let budget = maxUnavail - unavailable;
      for (const p of cur) {
        if (budget <= 0) break;
        if (p.metadata.deletionTimestamp !== undefined || p.metadata.labels?.["controller-revision-hash"] === hash) continue;
        cluster.deleteObject(p);
        cluster.record(ds, "Normal", "SuccessfulDelete", `Deleted pod: ${p.metadata.name}`, "daemonset-controller");
        budget--;
      }
    }

    const after = cluster.list<Pod>("Pod", ns).filter((p) => controllerOf(p)?.uid === ds.metadata.uid && !isPodTerminal(p) && p.metadata.deletionTimestamp === undefined);
    const scheduled = after.filter((p) => wantNames.has(dsTargetNode(p) ?? ""));
    const ready = scheduled.filter(isPodReady).length;
    const available = scheduled.filter((p) => isPodAvailable(p, ds.spec!.minReadySeconds ?? 0, now)).length;
    const cur = cluster.get<DaemonSet>("DaemonSet", ns, ds.metadata.name);
    cluster.updateStatus(cur, (x) => {
      x.status = {
        currentNumberScheduled: scheduled.length,
        desiredNumberScheduled: want.length,
        numberMisscheduled: after.length - scheduled.length,
        numberReady: ready,
        ...(available ? { numberAvailable: available } : {}),
        ...(want.length - available > 0 ? { numberUnavailable: want.length - available } : {}),
        updatedNumberScheduled: scheduled.filter((p) => p.metadata.labels?.["controller-revision-hash"] === hash).length,
        observedGeneration: x.metadata.generation,
      };
    });
  }
}
