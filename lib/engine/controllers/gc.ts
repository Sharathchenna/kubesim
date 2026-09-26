// garbage-collector + namespace-controller + PodGC: deletes dependents whose
// owner is gone (background propagation), empties terminating Namespaces, and
// expires old Events.

import type { Cluster } from "../cluster";
import { NAMESPACED_KINDS, type KubeEvent, type Pod } from "../types";

const EVENT_TTL_MS = 60 * 60 * 1000;

export function runGarbageCollector(cluster: Cluster): void {
  const objects = Object.values(cluster.state.objects);
  const uids = new Set(objects.map((o) => o.metadata.uid));

  for (const o of objects) {
    const refs = o.metadata.ownerReferences;
    if (!refs || refs.length === 0) continue;
    if (refs.some((r) => uids.has(r.uid))) continue;
    if (o.kind === "Pod" && o.metadata.deletionTimestamp !== undefined) continue;
    cluster.deleteObject(o);
  }

  // Endpoints outlive nothing: drop them with their Service.
  for (const o of objects) {
    if (o.kind !== "Endpoints") continue;
    if (!cluster.raw("Service", o.metadata.namespace, o.metadata.name)) cluster.remove(o);
  }

  // PodGC: Pods bound to Nodes that no longer exist.
  for (const o of objects) {
    if (o.kind !== "Pod") continue;
    const node = (o as unknown as Pod).spec?.nodeName;
    if (node && !cluster.raw("Node", undefined, node)) cluster.remove(o);
  }

  // Namespace controller.
  for (const ns of cluster.list("Namespace")) {
    if ((ns.status as { phase?: string } | undefined)?.phase !== "Terminating") continue;
    const name = ns.metadata.name;
    let left = 0;
    for (const o of Object.values(cluster.state.objects)) {
      if (!NAMESPACED_KINDS.has(o.kind) || o.metadata.namespace !== name) continue;
      if (o.kind === "Event") {
        cluster.remove(o);
        continue;
      }
      left++;
      if (o.metadata.deletionTimestamp === undefined) cluster.deleteObject(o);
    }
    if (left === 0) cluster.remove(ns);
  }

  // Event TTL.
  if (cluster.now % 10_000 === 0) {
    for (const e of cluster.list<KubeEvent>("Event")) if (cluster.now - e.lastTimestamp > EVENT_TTL_MS) cluster.remove(e);
  }
}
