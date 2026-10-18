// persistentvolume-controller + the local-path provisioner (as on kind):
// binds PersistentVolumeClaims to PersistentVolumes, provisions volumes for
// the default StorageClass once the first Pod is scheduled
// (WaitForFirstConsumer), honours the pvc/pv-protection finalizers and the
// reclaim policy. Behaviour reference v2 §5.

import { isPodTerminal, type Cluster } from "../cluster";
import { bytes } from "../quantity";
import type { AccessMode, PersistentVolume, PersistentVolumeClaim, Pod, StorageClass } from "../types";
import { SELECTED_NODE } from "./scheduler";

export const PVC_PROTECTION = "kubernetes.io/pvc-protection";
export const PV_PROTECTION = "kubernetes.io/pv-protection";
const PROVISION_MS = 1500;
/** persistentvolume-controller's resync period: unprovisionable claims are retried this often. */
const RESYNC_MS = 15_000;
const LOCAL_PATH = "rancher.io/local-path";

export const ACCESS_SHORT: Record<string, string> = { ReadWriteOnce: "RWO", ReadOnlyMany: "ROX", ReadWriteMany: "RWX", ReadWriteOncePod: "RWOP" };

/**
 * pvc-protection counts only scheduled Pods: the kubelet won't start a Pod whose
 * claim is being deleted, so an unscheduled Pod doesn't hold the claim
 * (pkg/controller/volume/pvcprotection, podUsesPVC checks spec.nodeName).
 */
function claimInUse(cluster: Cluster, pvc: PersistentVolumeClaim): boolean {
  return cluster
    .list<Pod>("Pod", pvc.metadata.namespace)
    .some((p) => !!p.spec?.nodeName && !isPodTerminal(p) && (p.spec?.volumes ?? []).some((v) => v.persistentVolumeClaim?.claimName === pvc.metadata.name));
}

function bind(cluster: Cluster, pvc: PersistentVolumeClaim, pv: PersistentVolume, byController: boolean): void {
  cluster.update(pv, (x) => {
    x.spec!.claimRef = { apiVersion: "v1", kind: "PersistentVolumeClaim", name: pvc.metadata.name, namespace: pvc.metadata.namespace!, uid: pvc.metadata.uid, resourceVersion: pvc.metadata.resourceVersion };
    x.status = { phase: "Bound", lastPhaseTransitionTime: cluster.now };
    if (byController) x.metadata.annotations = { ...(x.metadata.annotations ?? {}), "pv.kubernetes.io/bound-by-controller": "yes" };
  });
  cluster.update(pvc, (x) => {
    x.spec!.volumeName = pv.metadata.name;
    x.metadata.annotations = { ...(x.metadata.annotations ?? {}), "pv.kubernetes.io/bind-completed": "yes", ...(byController ? { "pv.kubernetes.io/bound-by-controller": "yes" } : {}) };
    x.status = { phase: "Bound", accessModes: pv.spec?.accessModes, capacity: pv.spec?.capacity };
  });
  cluster.schedulerWake = true;
}

function matches(pvc: PersistentVolumeClaim, pv: PersistentVolume): boolean {
  if (pv.status?.phase !== "Available" || pv.spec?.claimRef) return false;
  if ((pv.spec?.storageClassName ?? "") !== (pvc.spec?.storageClassName ?? "")) return false;
  const want = pvc.spec?.accessModes ?? [];
  if (!want.every((m: AccessMode) => pv.spec?.accessModes?.includes(m))) return false;
  return bytes(pv.spec?.capacity?.storage) >= bytes(pvc.spec?.resources?.requests?.storage);
}

export function runStorage(cluster: Cluster): void {
  const now = cluster.now;
  const timers = cluster.state.timers;

  for (const pvc of cluster.list<PersistentVolumeClaim>("PersistentVolumeClaim")) {
    // pvc-protection: a claim in use by a Pod stays Terminating.
    if (pvc.metadata.deletionTimestamp !== undefined) {
      if (!claimInUse(cluster, pvc)) {
        cluster.remove(pvc);
        release(cluster, pvc);
      }
      continue;
    }
    if (pvc.status?.phase === "Bound") {
      expand(cluster, pvc);
      continue;
    }
    const cls = pvc.spec?.storageClassName ?? "";
    // Pre-bound to a named volume.
    if (pvc.spec?.volumeName) {
      const pv = cluster.raw("PersistentVolume", undefined, pvc.spec.volumeName) as unknown as PersistentVolume | undefined;
      if (pv && (!pv.spec?.claimRef || pv.spec.claimRef.uid === pvc.metadata.uid)) bind(cluster, pvc, pv, false);
      continue;
    }
    const sc = cls ? (cluster.raw("StorageClass", undefined, cls) as unknown as StorageClass | undefined) : undefined;
    const wffc = sc?.volumeBindingMode === "WaitForFirstConsumer";
    const selected = pvc.metadata.annotations?.[SELECTED_NODE];
    if (wffc && !selected) {
      if (!timers[`wffc/${pvc.metadata.uid}`]) {
        timers[`wffc/${pvc.metadata.uid}`] = now;
        cluster.record(pvc, "Normal", "WaitForFirstConsumer", "waiting for first consumer to be created before binding", "persistentvolume-controller");
      }
      continue;
    }
    // Static binding first: the smallest Available volume that fits.
    const candidates = cluster
      .list<PersistentVolume>("PersistentVolume")
      .filter((pv) => matches(pvc, pv))
      .sort((a, b) => bytes(a.spec?.capacity?.storage) - bytes(b.spec?.capacity?.storage));
    if (candidates.length) {
      bind(cluster, pvc, candidates[0], true);
      continue;
    }
    if (!cls) {
      if (!timers[`nobind/${pvc.metadata.uid}`]) {
        timers[`nobind/${pvc.metadata.uid}`] = now;
        cluster.record(pvc, "Normal", "FailedBinding", "no persistent volumes available for this claim and no storage class is set", "persistentvolume-controller");
      }
      continue;
    }
    if (!sc) {
      if (!timers[`nosc/${pvc.metadata.uid}`] || now - timers[`nosc/${pvc.metadata.uid}`] > 60_000) {
        timers[`nosc/${pvc.metadata.uid}`] = now;
        cluster.record(pvc, "Warning", "ProvisioningFailed", `storageclass.storage.k8s.io "${cls}" not found`, "persistentvolume-controller");
      }
      continue;
    }
    provision(cluster, pvc, sc, selected);
  }

  // pv-protection: a bound volume stays Terminating until its claim lets go.
  for (const pv of cluster.list<PersistentVolume>("PersistentVolume")) {
    if (pv.metadata.deletionTimestamp !== undefined && pv.status?.phase !== "Bound") {
      cluster.remove(pv);
      delete cluster.state.volumes[`pv/${pv.metadata.name}`];
      continue;
    }
    // A claimRef whose claim is gone: Released (Retain) or deleted (Delete).
    const ref = pv.spec?.claimRef;
    if (ref && pv.status?.phase === "Bound") {
      const pvc = cluster.raw("PersistentVolumeClaim", ref.namespace, ref.name);
      if (!pvc || (ref.uid && pvc.metadata.uid !== ref.uid)) release(cluster, { metadata: { name: ref.name, namespace: ref.namespace, uid: ref.uid ?? "" } } as PersistentVolumeClaim, pv);
    }
  }
}

/**
 * Only kind's local-path provisioner is installed. Any other provisioner is
 * waited for forever, as on a real cluster where it isn't running: the claim
 * stays Pending and ExternalProvisioning repeats each resync. A
 * `kubernetes.io/` name with no in-tree plugin fails outright
 * (pv_controller.go findProvisionablePlugin / provisionClaimOperation).
 */
function provision(cluster: Cluster, pvc: PersistentVolumeClaim, sc: StorageClass, node: string | undefined): void {
  const now = cluster.now;
  const key = `provision/${pvc.metadata.uid}`;
  const ns = pvc.metadata.namespace!;
  if (sc.provisioner !== LOCAL_PATH) {
    if (cluster.state.timers[key] !== undefined && now - cluster.state.timers[key] < RESYNC_MS) return;
    cluster.state.timers[key] = now;
    if (sc.provisioner.startsWith("kubernetes.io/")) {
      cluster.record(pvc, "Warning", "ProvisioningFailed", `no volume plugin matched name: ${sc.provisioner}`, "persistentvolume-controller");
      return;
    }
    if (!pvc.metadata.annotations?.["volume.kubernetes.io/storage-provisioner"]) {
      cluster.update(pvc, (x) => {
        x.metadata.annotations = { ...(x.metadata.annotations ?? {}), "volume.beta.kubernetes.io/storage-provisioner": sc.provisioner, "volume.kubernetes.io/storage-provisioner": sc.provisioner };
      });
    }
    cluster.record(pvc, "Normal", "ExternalProvisioning", `Waiting for a volume to be created either by the external provisioner '${sc.provisioner}' or manually by the system administrator. If volume creation is delayed, please verify that the provisioner is running and correctly registered.`, "persistentvolume-controller");
    return;
  }
  if (cluster.state.timers[key] === undefined) {
    cluster.state.timers[key] = now + PROVISION_MS;
    cluster.update(pvc, (x) => {
      x.metadata.annotations = { ...(x.metadata.annotations ?? {}), "volume.beta.kubernetes.io/storage-provisioner": sc.provisioner, "volume.kubernetes.io/storage-provisioner": sc.provisioner };
    });
    cluster.record(pvc, "Normal", "ExternalProvisioning", `Waiting for a volume to be created either by the external provisioner '${sc.provisioner}' or manually by the system administrator. If volume creation is delayed, please verify that the provisioner is running and correctly registered.`, "persistentvolume-controller");
    cluster.record(pvc, "Normal", "Provisioning", `External provisioner is provisioning volume for claim "${ns}/${pvc.metadata.name}"`, `${sc.provisioner}_local-path-provisioner-7577fdbbfb-5gqxl_6c3b1e0e-0f5b-4c6e-9a55-1d2c9a3b7e10`);
    return;
  }
  if (now < cluster.state.timers[key]) return;
  delete cluster.state.timers[key];
  const name = `pvc-${pvc.metadata.uid}`;
  const pv = cluster.create<PersistentVolume>({
    apiVersion: "v1",
    kind: "PersistentVolume",
    metadata: { name, annotations: { "pv.kubernetes.io/provisioned-by": sc.provisioner, ...(node ? { "local.path.provisioner/selected-node": node } : {}) } },
    spec: {
      capacity: { storage: pvc.spec?.resources?.requests?.storage ?? "1Gi" },
      accessModes: pvc.spec?.accessModes ?? ["ReadWriteOnce"],
      persistentVolumeReclaimPolicy: sc.reclaimPolicy ?? "Delete",
      storageClassName: sc.metadata.name,
      volumeMode: "Filesystem",
      hostPath: { path: `/var/local-path-provisioner/${name}_${ns}_${pvc.metadata.name}`, type: "DirectoryOrCreate" },
      ...(node ? { nodeAffinity: { required: { nodeSelectorTerms: [{ matchExpressions: [{ key: "kubernetes.io/hostname", operator: "In", values: [node] }] }] } } } : {}),
    },
    status: { phase: "Available" },
  } as unknown as PersistentVolume);
  cluster.record(pvc, "Normal", "ProvisioningSucceeded", `Successfully provisioned volume ${name}`, `${sc.provisioner}_local-path-provisioner-7577fdbbfb-5gqxl_6c3b1e0e-0f5b-4c6e-9a55-1d2c9a3b7e10`);
  bind(cluster, cluster.get<PersistentVolumeClaim>("PersistentVolumeClaim", ns, pvc.metadata.name), pv, true);
}

/** Volume expansion (StorageClass allowVolumeExpansion): the volume and claim grow to the new request. */
function expand(cluster: Cluster, pvc: PersistentVolumeClaim): void {
  const want = pvc.spec?.resources?.requests?.storage;
  const have = pvc.status?.capacity?.storage;
  if (!want || !have || bytes(want) <= bytes(have)) return;
  const key = `resize/${pvc.metadata.uid}`;
  const timers = cluster.state.timers;
  if (timers[key] === undefined) {
    timers[key] = cluster.now + PROVISION_MS;
    cluster.record(pvc, "Normal", "ExternalExpanding", "waiting for an external controller to expand this PVC", "volume_expand");
    return;
  }
  if (cluster.now < timers[key]) return;
  delete timers[key];
  const pv = pvc.spec?.volumeName ? (cluster.raw("PersistentVolume", undefined, pvc.spec.volumeName) as unknown as PersistentVolume | undefined) : undefined;
  if (pv) cluster.update(pv, (x) => void (x.spec!.capacity = { ...(x.spec!.capacity ?? {}), storage: want }));
  cluster.updateStatus(pvc, (x) => void (x.status = { ...x.status!, capacity: { ...(x.status?.capacity ?? {}), storage: want } }));
  cluster.record(pvc, "Normal", "VolumeResizeSuccessful", "resize volume succeeded", "volume_expand");
}

/** The claim is gone: apply the volume's reclaim policy. */
function release(cluster: Cluster, pvc: PersistentVolumeClaim, pv0?: PersistentVolume): void {
  const pv =
    pv0 ??
    cluster.list<PersistentVolume>("PersistentVolume").find((v) => v.spec?.claimRef?.name === pvc.metadata.name && v.spec.claimRef.namespace === pvc.metadata.namespace && (!v.spec.claimRef.uid || v.spec.claimRef.uid === pvc.metadata.uid));
  if (!pv) return;
  if ((pv.spec?.persistentVolumeReclaimPolicy ?? "Retain") === "Delete") {
    cluster.remove(pv);
    delete cluster.state.volumes[`pv/${pv.metadata.name}`];
    return;
  }
  cluster.update(pv, (x) => {
    x.status = { phase: "Released", lastPhaseTransitionTime: cluster.now };
  });
}
