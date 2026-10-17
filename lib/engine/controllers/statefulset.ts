// statefulset-controller: Pods with stable names (<sts>-0, -1, …), stable
// storage (one PVC per Pod from volumeClaimTemplates, kept when Pods go away)
// and stable DNS (hostname + subdomain under a headless Service). With the
// default OrderedReady policy it creates Pods one at a time in order, waits
// for each to be Running and Ready, scales down from the highest ordinal, and
// rolls updates from the highest ordinal down to the partition.

import { controllerOf, isPodReady, isPodTerminal, type Cluster } from "../cluster";
import type { ControllerRevision, PersistentVolumeClaim, Pod, PodTemplateSpec, StatefulSet } from "../types";
import { clone } from "../util";
import { ownerRef } from "./replicaset";
import { templateHash } from "./deployment";

export const REVISION_LABEL = "controller-revision-hash";

export function stsRevision(sts: StatefulSet): string {
  return `${sts.metadata.name}-${templateHash(sts.spec!.template)}`;
}

export const ordinalOf = (sts: StatefulSet, p: Pod) => {
  const m = p.metadata.name.match(new RegExp(`^${sts.metadata.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-(\\d+)$`));
  return m ? parseInt(m[1], 10) : -1;
};

export function claimName(tpl: string, sts: StatefulSet, i: number): string {
  return `${tpl}-${sts.metadata.name}-${i}`;
}

function podFor(sts: StatefulSet, i: number, revision: string, template: PodTemplateSpec): Omit<Pod, "metadata"> & { metadata: Pod["metadata"] } {
  const tpl = clone(template);
  const name = `${sts.metadata.name}-${i}`;
  const volumes = [...(tpl.spec.volumes ?? [])];
  for (const vct of sts.spec!.volumeClaimTemplates ?? []) {
    const v = { name: vct.metadata.name, persistentVolumeClaim: { claimName: claimName(vct.metadata.name, sts, i) } };
    const at = volumes.findIndex((x) => x.name === v.name);
    if (at >= 0) volumes[at] = v;
    else volumes.push(v);
  }
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name,
      namespace: sts.metadata.namespace,
      labels: { ...(tpl.metadata?.labels ?? {}), [REVISION_LABEL]: revision, "statefulset.kubernetes.io/pod-name": name, "apps.kubernetes.io/pod-index": String(i) },
      ...(tpl.metadata?.annotations ? { annotations: tpl.metadata.annotations } : {}),
      ownerReferences: [ownerRef(sts)],
    } as unknown as Pod["metadata"],
    spec: { ...tpl.spec, volumes: volumes.length ? volumes : undefined, hostname: name, ...(sts.spec!.serviceName ? { subdomain: sts.spec!.serviceName } : {}) },
  };
}

function ensureClaims(cluster: Cluster, sts: StatefulSet, i: number): boolean {
  const ns = sts.metadata.namespace!;
  for (const vct of sts.spec!.volumeClaimTemplates ?? []) {
    const name = claimName(vct.metadata.name, sts, i);
    const existing = cluster.raw("PersistentVolumeClaim", ns, name) as unknown as PersistentVolumeClaim | undefined;
    if (existing) {
      if (existing.metadata.deletionTimestamp !== undefined) return false;
      continue;
    }
    const retainDelete = sts.spec!.persistentVolumeClaimRetentionPolicy?.whenDeleted === "Delete";
    try {
      cluster.create<PersistentVolumeClaim>({
        apiVersion: "v1",
        kind: "PersistentVolumeClaim",
        metadata: { name, namespace: ns, labels: { ...(vct.metadata.labels ?? {}), ...(sts.spec!.selector.matchLabels ?? {}) }, ...(retainDelete ? { ownerReferences: [ownerRef(sts)] } : {}) },
        spec: clone(vct.spec),
      });
      cluster.record(sts, "Normal", "SuccessfulCreate", `create Claim ${name} Pod ${sts.metadata.name}-${i} in StatefulSet ${sts.metadata.name} success`, "statefulset-controller");
    } catch (e) {
      cluster.record(sts, "Warning", "FailedCreate", `create Claim ${name} for Pod ${sts.metadata.name}-${i} in StatefulSet ${sts.metadata.name} failed error: ${(e as Error).message}`, "statefulset-controller");
      return false;
    }
  }
  return true;
}

function ensureRevision(cluster: Cluster, sts: StatefulSet, name: string): number {
  const ns = sts.metadata.namespace!;
  const revs = cluster.list<ControllerRevision>("ControllerRevision", ns).filter((r) => controllerOf(r)?.uid === sts.metadata.uid);
  const max = Math.max(0, ...revs.map((r) => r.revision));
  const existing = revs.find((r) => r.metadata.name === name);
  if (existing) {
    if (existing.revision < max) cluster.update(existing, (r) => void (r.revision = max + 1));
    return existing.revision < max ? max + 1 : existing.revision;
  }
  cluster.create<ControllerRevision>({
    apiVersion: "apps/v1",
    kind: "ControllerRevision",
    metadata: { name, namespace: ns, labels: { ...(sts.spec!.selector.matchLabels ?? {}), "controller.kubernetes.io/hash": name.slice(sts.metadata.name.length + 1) }, ownerReferences: [ownerRef(sts)] },
    revision: max + 1,
    data: { spec: { template: { ...clone(sts.spec!.template), $patch: "replace" } } },
  } as unknown as ControllerRevision);
  return max + 1;
}

/**
 * persistentVolumeClaimRetentionPolicy (StatefulSetAutoDeletePVC, GA): whenDeleted Delete gives every
 * claim an ownerReference to the StatefulSet; whenScaled Delete gives a condemned ordinal's claim an
 * ownerReference to its Pod, so the garbage collector removes the claim once the Pod is gone.
 */
function reconcileClaimOwners(cluster: Cluster, sts: StatefulSet, want: number, pods: Map<number, Pod>): void {
  const ns = sts.metadata.namespace!;
  const policy = sts.spec!.persistentVolumeClaimRetentionPolicy ?? {};
  const templates = (sts.spec!.volumeClaimTemplates ?? []).map((v) => `${v.metadata.name}-${sts.metadata.name}-`);
  if (!templates.length) return;
  for (const pvc of cluster.list<PersistentVolumeClaim>("PersistentVolumeClaim", ns)) {
    const tpl = templates.find((t) => pvc.metadata.name.startsWith(t));
    if (!tpl || pvc.metadata.deletionTimestamp !== undefined) continue;
    const i = Number(pvc.metadata.name.slice(tpl.length));
    if (!Number.isInteger(i) || i < 0) continue;
    const pod = pods.get(i);
    const condemned = i >= want;
    if (condemned && policy.whenScaled === "Delete" && !pod) {
      cluster.deleteObject(pvc);
      continue;
    }
    const refs = (pvc.metadata.ownerReferences ?? []).filter((r) => r.uid !== sts.metadata.uid && r.kind !== "Pod");
    // A condemned claim belongs to its Pod alone, so it goes with the Pod.
    if (condemned && policy.whenScaled === "Delete" && pod) refs.push({ apiVersion: "v1", kind: "Pod", name: pod.metadata.name, uid: pod.metadata.uid, controller: false, blockOwnerDeletion: true });
    else if (policy.whenDeleted === "Delete") refs.push(ownerRef(sts));
    const before = JSON.stringify(pvc.metadata.ownerReferences ?? []);
    if (before === JSON.stringify(refs)) continue;
    cluster.update(pvc, (x) => {
      if (refs.length) x.metadata.ownerReferences = refs;
      else delete x.metadata.ownerReferences;
    });
  }
}

export function runStatefulSets(cluster: Cluster): void {
  for (const sts of cluster.list<StatefulSet>("StatefulSet")) {
    if (sts.metadata.deletionTimestamp !== undefined) continue;
    const ns = sts.metadata.namespace!;
    const want = sts.spec!.replicas ?? 1;
    const updateRev = stsRevision(sts);
    ensureRevision(cluster, sts, updateRev);
    const currentRev = sts.status?.currentRevision ?? updateRev;
    const parallel = sts.spec!.podManagementPolicy === "Parallel";
    const partition = sts.spec!.updateStrategy?.rollingUpdate?.partition ?? 0;
    const onDelete = sts.spec!.updateStrategy?.type === "OnDelete";
    const owned = cluster.list<Pod>("Pod", ns).filter((p) => controllerOf(p)?.uid === sts.metadata.uid);
    const byOrd = new Map(owned.map((p) => [ordinalOf(sts, p), p]));
    const healthy = (p: Pod | undefined) => !!p && !p.metadata.deletionTimestamp && p.status?.phase === "Running" && isPodReady(p);
    const revOf = (p: Pod) => p.metadata.labels?.[REVISION_LABEL];
    // The template a Pod at ordinal i should run: below the partition, keep the current revision.
    const templateFor = (i: number): { rev: string; tpl: PodTemplateSpec } => {
      if (i < partition && currentRev !== updateRev) {
        const cr = cluster.raw("ControllerRevision", ns, currentRev) as unknown as { data?: { spec?: { template?: PodTemplateSpec } } } | undefined;
        const tpl = cr?.data?.spec?.template;
        if (tpl) {
          const t = clone(tpl) as PodTemplateSpec & { $patch?: string };
          delete t.$patch;
          return { rev: currentRev, tpl: t };
        }
      }
      return { rev: updateRev, tpl: sts.spec!.template };
    };

    let busy = false;
    // Create or replace Pods 0..want-1.
    for (let i = 0; i < want; i++) {
      const p = byOrd.get(i);
      if (p && isPodTerminal(p) && !p.metadata.deletionTimestamp) {
        cluster.deleteObject(p);
        cluster.record(sts, "Normal", "SuccessfulDelete", `delete Pod ${p.metadata.name} in StatefulSet ${sts.metadata.name} successful`, "statefulset-controller");
        busy = true;
        if (!parallel) break;
        continue;
      }
      if (!p) {
        if (!ensureClaims(cluster, sts, i)) {
          busy = true;
          if (!parallel) break;
          continue;
        }
        const { rev, tpl } = templateFor(i);
        try {
          cluster.create<Pod>(podFor(sts, i, rev, tpl) as Pod);
          cluster.record(sts, "Normal", "SuccessfulCreate", `create Pod ${sts.metadata.name}-${i} in StatefulSet ${sts.metadata.name} successful`, "statefulset-controller");
        } catch (e) {
          const msg = (e as Error).message.replace(/^Error from server \(\w+\): /, "");
          if (!/already exists/.test(msg)) cluster.record(sts, "Warning", "FailedCreate", `create Pod ${sts.metadata.name}-${i} in StatefulSet ${sts.metadata.name} failed error: ${msg}`, "statefulset-controller");
        }
        busy = true;
        if (!parallel) break;
        continue;
      }
      if (!healthy(p)) {
        busy = true;
        if (!parallel) break;
      }
    }

    reconcileClaimOwners(cluster, sts, want, byOrd);

    // Scale down from the highest ordinal, one at a time (all at once with Parallel).
    const extra = owned.filter((p) => ordinalOf(sts, p) >= want || ordinalOf(sts, p) < 0).sort((a, b) => ordinalOf(sts, b) - ordinalOf(sts, a));
    if (extra.length && (parallel || !busy)) {
      if (!parallel && extra.some((p) => p.metadata.deletionTimestamp !== undefined)) {
        // wait for the one terminating
      } else {
        for (const p of parallel ? extra : extra.slice(0, 1)) {
          if (p.metadata.deletionTimestamp !== undefined) continue;
          cluster.deleteObject(p);
          cluster.record(sts, "Normal", "SuccessfulDelete", `delete Pod ${p.metadata.name} in StatefulSet ${sts.metadata.name} successful`, "statefulset-controller");
        }
      }
      busy = true;
    }

    // Rolling update: highest ordinal first, down to the partition, once everything is healthy.
    if (!busy && !onDelete) {
      const stale = [...byOrd.entries()]
        .filter(([i, p]) => i >= partition && i < want && revOf(p) !== updateRev)
        .sort((a, b) => b[0] - a[0]);
      if (stale.length && owned.every((p) => healthy(p) || ordinalOf(sts, p) >= want)) {
        const p = stale[0][1];
        cluster.deleteObject(p);
        cluster.record(sts, "Normal", "SuccessfulDelete", `delete Pod ${p.metadata.name} in StatefulSet ${sts.metadata.name} successful`, "statefulset-controller");
      }
    }

    // Status.
    const after = cluster.list<Pod>("Pod", ns).filter((p) => controllerOf(p)?.uid === sts.metadata.uid && !isPodTerminal(p));
    const ready = after.filter((p) => isPodReady(p) && !p.metadata.deletionTimestamp).length;
    const updated = after.filter((p) => revOf(p) === updateRev).length;
    const current = after.filter((p) => revOf(p) === currentRev).length;
    const done = updated === want && ready === want && after.length === want;
    const cur = cluster.get<StatefulSet>("StatefulSet", ns, sts.metadata.name);
    cluster.updateStatus(cur, (x) => {
      x.status = {
        observedGeneration: x.metadata.generation,
        replicas: after.length,
        ...(ready ? { readyReplicas: ready } : {}),
        ...(done ? { currentReplicas: updated } : current ? { currentReplicas: current } : {}),
        ...(updated ? { updatedReplicas: updated } : {}),
        ...(ready ? { availableReplicas: ready } : {}),
        currentRevision: done ? updateRev : currentRev,
        updateRevision: updateRev,
        collisionCount: 0,
      };
    });
  }
}
