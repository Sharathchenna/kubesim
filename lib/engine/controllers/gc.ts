// garbage-collector + namespace-controller + PodGC: deletes dependents whose
// owner is gone (background propagation) or is being deleted in the foreground
// (foregroundDeletion finalizer), empties terminating Namespaces, and expires
// old Events and the logs of Pods that are gone.

import { FOREGROUND, type Cluster } from "../cluster";
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

  // Foreground deletion: delete the dependents (foreground too, if they block their owner),
  // and finish the owner once no blocking dependent is left.
  for (const o of objects) {
    if (o.metadata.deletionTimestamp === undefined || !o.metadata.finalizers?.includes(FOREGROUND)) continue;
    if (!cluster.raw(o.kind, o.metadata.namespace, o.metadata.name)) continue;
    const deps = cluster.dependentsOf(o.metadata.uid);
    for (const d of deps) {
      if (d.metadata.deletionTimestamp !== undefined) continue;
      const blocks = d.metadata.ownerReferences?.some((r) => r.uid === o.metadata.uid && r.blockOwnerDeletion);
      cluster.deleteObject(d, { propagationPolicy: blocks ? "Foreground" : "Background" });
    }
    const blocking = cluster.dependentsOf(o.metadata.uid).filter((d) => d.metadata.ownerReferences?.some((r) => r.uid === o.metadata.uid && r.blockOwnerDeletion));
    if (blocking.length) continue;
    const cur = cluster.raw(o.kind, o.metadata.namespace, o.metadata.name)!;
    const rest = (cur.metadata.finalizers ?? []).filter((f) => f !== FOREGROUND);
    if (rest.length) cluster.update(cur, (x) => void (x.metadata.finalizers = rest));
    else cluster.remove(cur);
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

  // Event TTL, and controller timers for objects that are gone.
  if (cluster.now % 10_000 === 0) {
    for (const e of cluster.list<KubeEvent>("Event")) if (cluster.now - e.lastTimestamp > EVENT_TTL_MS) cluster.remove(e);
    const live = new Set(Object.values(cluster.state.objects).map((o) => o.metadata.uid));
    for (const k of Object.keys(cluster.state.timers)) {
      const uid = k.slice(k.indexOf("/") + 1);
      if (!live.has(uid)) delete cluster.state.timers[k];
    }
    for (const uid of Object.keys(cluster.state.hpa)) if (!live.has(uid)) delete cluster.state.hpa[uid];
    // Container logs of Pods that are gone (snapshots from before logs were pruned on delete).
    for (const k of Object.keys(cluster.state.logs)) if (!live.has(k.slice(0, k.indexOf("/")))) delete cluster.state.logs[k];
  }
}
