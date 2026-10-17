// Defaulting and allocation the API server does on create/update
// (see docs/research/kubernetes-behaviour-reference.md §1, §7.1 and v2 §1).

import { ApiError, type Cluster } from "./cluster";
import { parseImage } from "./images";
import { bytes, canonicalQuantity, qosClass } from "./quantity";
import type {
  AnyObject,
  Container,
  CronJob,
  DaemonSet,
  Deployment,
  HorizontalPodAutoscaler,
  Ingress,
  Job,
  Namespace,
  NetworkPolicy,
  Node,
  PersistentVolume,
  PersistentVolumeClaim,
  Pod,
  PodSpec,
  PodTemplateSpec,
  Probe,
  ReplicaSet,
  Secret,
  Service,
  StatefulSet,
  StorageClass,
  Toleration,
} from "./types";
import { randSuffix } from "./util";
import { PV_PROTECTION, PVC_PROTECTION } from "./controllers/storage";
import { SA_DIR } from "./fs";
import { applyLimitDefaults, checkLimitRanges, defaultLimitRange, resolvePriority } from "./policy";
import type { LimitRange, PriorityClass } from "./types";

const b64encode = (s: string) => (typeof btoa === "function" ? btoa(unescape(encodeURIComponent(s))) : Buffer.from(s, "utf8").toString("base64"));

function defaultProbe(p: Probe | undefined): void {
  if (!p) return;
  p.timeoutSeconds ??= 1;
  p.periodSeconds ??= 10;
  p.successThreshold ??= 1;
  p.failureThreshold ??= 3;
  if (p.httpGet) {
    p.httpGet.path ??= "/";
    p.httpGet.scheme ??= "HTTP";
  }
}

function defaultResources(c: Container, pod: boolean): void {
  const r = (c.resources ??= {});
  // Limits without requests: requests default to the limits.
  if (r.limits && pod) {
    r.requests ??= {};
    for (const [k, v] of Object.entries(r.limits)) r.requests[k] ??= v;
  }
  for (const part of [r.requests, r.limits]) {
    if (!part) continue;
    for (const [k, v] of Object.entries(part)) if (typeof v === "string" || typeof v === "number") part[k] = canonicalQuantity(String(v), k === "cpu" ? "cpu" : "bytes");
  }
}

/** `pod`: only Pods (not Pod templates) get requests defaulted from limits (SetDefaults_Pod). */
export function defaultContainer(c: Container, pod = false): void {
  const { tag } = parseImage(c.image ?? "");
  const hasTag = /:[^/]+$/.test(c.image ?? "") || (c.image ?? "").includes("@");
  c.imagePullPolicy ??= !hasTag || tag === "latest" ? "Always" : "IfNotPresent";
  c.terminationMessagePath ??= "/dev/termination-log";
  c.terminationMessagePolicy ??= "File";
  defaultResources(c, pod);
  for (const p of c.ports ?? []) p.protocol ??= "TCP";
  defaultProbe(c.livenessProbe);
  defaultProbe(c.readinessProbe);
  defaultProbe(c.startupProbe);
}

export function defaultPodSpec(s: PodSpec, pod = false): void {
  s.containers ??= [];
  for (const c of s.initContainers ?? []) defaultContainer(c, pod);
  for (const c of s.containers) defaultContainer(c, pod);
  s.restartPolicy ??= "Always";
  s.terminationGracePeriodSeconds ??= 30;
  s.dnsPolicy ??= "ClusterFirst";
  s.schedulerName ??= "default-scheduler";
  s.securityContext ??= {};
  s.enableServiceLinks ??= true;
  if (s.serviceAccount && !s.serviceAccountName) s.serviceAccountName = s.serviceAccount;
  s.serviceAccountName ??= "default";
  for (const v of s.volumes ?? []) {
    if (v.configMap) v.configMap.defaultMode ??= 420;
    if (v.secret) v.secret.defaultMode ??= 420;
    if (v.hostPath) v.hostPath.type ??= "";
  }
}

function defaultTemplate(t: PodTemplateSpec | undefined): void {
  if (!t) return;
  t.metadata ??= {};
  t.metadata.creationTimestamp = null;
  if (t.spec) defaultPodSpec(t.spec);
}

/** DefaultTolerationSeconds admission: not-ready/unreachable NoExecute tolerations (runs on create and update). */
export function podTolerations(cluster: Cluster, spec: PodSpec): void {
  const secs = cluster.state.config.defaultTolerationSeconds;
  const tol = (spec.tolerations ??= []);
  for (const key of ["node.kubernetes.io/not-ready", "node.kubernetes.io/unreachable"]) {
    if (tol.some((t) => (t.key === key || (!t.key && t.operator === "Exists")) && (t.effect === "NoExecute" || !t.effect))) continue;
    tol.push({ key, operator: "Exists", effect: "NoExecute", tolerationSeconds: secs } as Toleration);
  }
}

/** The ServiceAccount admission plugin mounts a projected token volume into every container. */
function serviceAccountVolume(cluster: Cluster, pod: Pod): void {
  const spec = pod.spec!;
  // The Pod's own setting wins; otherwise the ServiceAccount's (automountServiceAccountToken: false opts out).
  const sa = cluster.raw("ServiceAccount", pod.metadata.namespace ?? "default", spec.serviceAccountName ?? "default") as { automountServiceAccountToken?: boolean } | undefined;
  if ((spec.automountServiceAccountToken ?? sa?.automountServiceAccountToken) === false) return;
  if ((spec.volumes ?? []).some((v) => v.name.startsWith("kube-api-access-"))) return;
  const name = `kube-api-access-${randSuffix(cluster.rng)}`;
  spec.volumes = [
    ...(spec.volumes ?? []),
    {
      name,
      projected: {
        defaultMode: 420,
        sources: [
          { serviceAccountToken: { expirationSeconds: 3607, path: "token" } },
          { configMap: { name: "kube-root-ca.crt", items: [{ key: "ca.crt", path: "ca.crt" }] } },
          { downwardAPI: { items: [{ fieldRef: { apiVersion: "v1", fieldPath: "metadata.namespace" }, path: "namespace" }] } },
        ],
      },
    },
  ];
  for (const c of [...(spec.initContainers ?? []), ...spec.containers]) {
    if ((c.volumeMounts ?? []).some((m) => m.mountPath === SA_DIR)) continue;
    c.volumeMounts = [...(c.volumeMounts ?? []), { name, mountPath: SA_DIR, readOnly: true }];
  }
}

function randomClusterIp(cluster: Cluster): string {
  const used = new Set(cluster.list<Service>("Service").map((s) => s.spec?.clusterIP));
  for (;;) {
    // Dynamic band of 10.96.0.0/12, above the static lower band.
    const n = 257 + cluster.rng.int((1 << 20) - 258);
    const ip = `10.${96 + (n >> 16)}.${(n >> 8) & 255}.${n & 255}`;
    if (!used.has(ip) && (n & 255) !== 0 && (n & 255) !== 255) return ip;
  }
}

export function usedNodePorts(cluster: Cluster, except?: string): Set<number> {
  const s = new Set<number>();
  for (const svc of cluster.list<Service>("Service")) {
    if (svc.metadata.uid === except) continue;
    for (const p of svc.spec?.ports ?? []) if (p.nodePort) s.add(p.nodePort);
  }
  return s;
}

function randomNodePort(cluster: Cluster, used: Set<number>): number {
  for (;;) {
    const p = 30086 + cluster.rng.int(32767 - 30086 + 1);
    if (!used.has(p)) return p;
  }
}

const firstGeneration = (o: AnyObject, prev: AnyObject | undefined) => {
  if (!prev) o.metadata.generation = 1;
};

export function admit(cluster: Cluster, obj: AnyObject, prev: AnyObject | undefined): void {
  switch (obj.kind) {
    case "Pod": {
      const pod = obj as unknown as Pod;
      pod.spec ??= { containers: [] };
      defaultPodSpec(pod.spec, true);
      podTolerations(cluster, pod.spec);
      if (!prev) {
        const ns = pod.metadata.namespace ?? "default";
        const sa = pod.spec.serviceAccountName ?? "default";
        if (sa !== "default" && !cluster.raw("ServiceAccount", ns, sa)) {
          throw new ApiError(`Error from server (Forbidden): pods "${pod.metadata.name}" is forbidden: error looking up service account ${ns}/${sa}: serviceaccount "${sa}" not found`, "Forbidden");
        }
        serviceAccountVolume(cluster, pod);
        resolvePriority(cluster, pod);
        applyLimitDefaults(cluster, pod);
        checkLimitRanges(cluster, pod);
        pod.metadata.generation = 1;
        pod.status = { phase: "Pending", qosClass: qosClass(pod.spec) };
      } else {
        // Keep what admission added at creation (an apply of the original manifest doesn't remove it).
        const ps = (prev as unknown as Pod).spec;
        pod.spec.priority ??= ps?.priority;
        pod.spec.preemptionPolicy ??= ps?.preemptionPolicy;
        pod.spec.priorityClassName ??= ps?.priorityClassName;
        const pv = (prev as unknown as Pod).spec?.volumes?.find((v) => v.name.startsWith("kube-api-access-"));
        if (pv && !(pod.spec.volumes ?? []).some((v) => v.name === pv.name)) {
          pod.spec.volumes = [...(pod.spec.volumes ?? []), pv];
          for (const c of [...(pod.spec.initContainers ?? []), ...pod.spec.containers]) if (!(c.volumeMounts ?? []).some((m) => m.mountPath === SA_DIR)) c.volumeMounts = [...(c.volumeMounts ?? []), { name: pv.name, mountPath: SA_DIR, readOnly: true }];
        }
      }
      break;
    }
    case "ReplicaSet": {
      const rs = obj as unknown as ReplicaSet;
      rs.spec ??= {} as ReplicaSet["spec"] & object;
      rs.spec!.replicas ??= 1;
      defaultTemplate(rs.spec!.template);
      if (!prev) {
        rs.metadata.generation = 1;
        rs.status = { replicas: 0 };
      }
      break;
    }
    case "Deployment": {
      const d = obj as unknown as Deployment;
      d.spec ??= {} as Deployment["spec"] & object;
      const s = d.spec!;
      s.replicas ??= 1;
      s.strategy = { ...(s.strategy ?? {}), type: s.strategy?.type ?? "RollingUpdate" };
      // With Recreate, a rollingUpdate block is left for validation to reject.
      if (s.strategy.type === "RollingUpdate") {
        s.strategy.rollingUpdate = { maxSurge: "25%", maxUnavailable: "25%", ...(s.strategy.rollingUpdate ?? {}) };
      }
      s.revisionHistoryLimit ??= 10;
      s.progressDeadlineSeconds ??= 600;
      defaultTemplate(s.template);
      if (!prev) {
        d.metadata.generation = 1;
        d.status = {};
      }
      break;
    }
    case "StatefulSet": {
      const st = obj as unknown as StatefulSet;
      const s = (st.spec ??= {} as StatefulSet["spec"] & object)!;
      s.replicas ??= 1;
      s.podManagementPolicy ??= "OrderedReady";
      s.updateStrategy = { ...(s.updateStrategy ?? {}), type: s.updateStrategy?.type ?? "RollingUpdate" };
      if (s.updateStrategy.type === "RollingUpdate") s.updateStrategy.rollingUpdate = { partition: 0, maxUnavailable: 1, ...(s.updateStrategy.rollingUpdate ?? {}) };
      s.revisionHistoryLimit ??= 10;
      s.persistentVolumeClaimRetentionPolicy ??= { whenDeleted: "Retain", whenScaled: "Retain" };
      for (const v of s.volumeClaimTemplates ?? []) {
        v.apiVersion ??= "v1";
        v.kind ??= "PersistentVolumeClaim";
        v.spec.volumeMode ??= "Filesystem";
      }
      defaultTemplate(s.template);
      firstGeneration(obj, prev);
      if (!prev) st.status = { replicas: 0 };
      break;
    }
    case "DaemonSet": {
      const ds = obj as unknown as DaemonSet;
      const s = (ds.spec ??= {} as DaemonSet["spec"] & object)!;
      s.updateStrategy = { ...(s.updateStrategy ?? {}), type: s.updateStrategy?.type ?? "RollingUpdate" };
      if (s.updateStrategy.type === "RollingUpdate") s.updateStrategy.rollingUpdate = { maxUnavailable: 1, maxSurge: 0, ...(s.updateStrategy.rollingUpdate ?? {}) };
      s.revisionHistoryLimit ??= 10;
      defaultTemplate(s.template);
      firstGeneration(obj, prev);
      if (!prev) ds.status = { currentNumberScheduled: 0, desiredNumberScheduled: 0, numberMisscheduled: 0, numberReady: 0 };
      break;
    }
    case "Job": {
      const job = obj as unknown as Job;
      const s = (job.spec ??= {} as Job["spec"] & object)!;
      if (s.completions === undefined && s.parallelism === undefined) s.completions = 1;
      s.parallelism ??= 1;
      s.backoffLimit ??= 6;
      s.completionMode ??= "NonIndexed";
      s.suspend ??= false;
      s.podReplacementPolicy ??= "TerminatingOrFailed";
      if (prev) {
        const ps = (prev as unknown as Job).spec!;
        s.selector ??= ps.selector;
        s.template.metadata = { ...(s.template.metadata ?? {}), labels: { ...(ps.template.metadata?.labels ?? {}), ...(s.template.metadata?.labels ?? {}) } };
      } else {
        // The Job controller's selector: the Job's own uid.
        const uid = job.metadata.uid;
        const labels = { "batch.kubernetes.io/controller-uid": uid, "batch.kubernetes.io/job-name": job.metadata.name, "controller-uid": uid, "job-name": job.metadata.name };
        if (!s.manualSelector) s.selector = { matchLabels: { "batch.kubernetes.io/controller-uid": uid } };
        s.template ??= { spec: { containers: [] } };
        s.template.metadata = { ...(s.template.metadata ?? {}), labels: { ...(s.template.metadata?.labels ?? {}), ...labels } };
        // Template labels are copied to the Job only when the Job has none of its own.
        if (!job.metadata.labels || !Object.keys(job.metadata.labels).length) job.metadata.labels = { ...s.template.metadata.labels };
        job.status = {};
      }
      defaultTemplate(s.template);
      firstGeneration(obj, prev);
      break;
    }
    case "CronJob": {
      const cj = obj as unknown as CronJob;
      const s = (cj.spec ??= {} as CronJob["spec"] & object)!;
      s.concurrencyPolicy ??= "Allow";
      s.suspend ??= false;
      s.successfulJobsHistoryLimit ??= 3;
      s.failedJobsHistoryLimit ??= 1;
      s.jobTemplate ??= { spec: { template: { spec: { containers: [] } } } };
      s.jobTemplate.metadata ??= {};
      s.jobTemplate.metadata.creationTimestamp = null;
      defaultTemplate(s.jobTemplate.spec?.template);
      firstGeneration(obj, prev);
      if (!prev) cj.status = {};
      break;
    }
    case "HorizontalPodAutoscaler": {
      const h = obj as unknown as HorizontalPodAutoscaler;
      const s = h.spec!;
      s.minReplicas ??= 1;
      s.metrics ??= [{ type: "Resource", resource: { name: "cpu", target: { type: "Utilization", averageUtilization: 80 } } }];
      // autoscaling/v2 fills in the rest of `behavior` only when you set it (the scale-down window stays unset).
      if (s.behavior) {
        s.behavior = {
          scaleUp: { stabilizationWindowSeconds: 0, selectPolicy: "Max", policies: [{ type: "Pods", value: 4, periodSeconds: 15 }, { type: "Percent", value: 100, periodSeconds: 15 }], ...(s.behavior.scaleUp ?? {}) },
          scaleDown: { selectPolicy: "Max", policies: [{ type: "Percent", value: 100, periodSeconds: 15 }], ...(s.behavior.scaleDown ?? {}) },
        };
      }
      firstGeneration(obj, prev);
      if (!prev) h.status = { currentReplicas: 0, desiredReplicas: 0, currentMetrics: null };
      break;
    }
    case "Service": {
      const svc = obj as unknown as Service;
      svc.spec ??= {};
      const s = svc.spec;
      s.type ??= "ClusterIP";
      s.sessionAffinity ??= "None";
      if (s.type === "ExternalName") {
        delete s.clusterIP;
        delete s.clusterIPs;
        svc.status ??= { loadBalancer: {} };
        break;
      }
      s.ipFamilies ??= ["IPv4"];
      s.ipFamilyPolicy ??= "SingleStack";
      s.internalTrafficPolicy ??= "Cluster";
      const prevSpec = (prev as unknown as Service | undefined)?.spec;
      if (!s.clusterIP) s.clusterIP = prevSpec?.clusterIP ?? randomClusterIp(cluster);
      s.clusterIPs = [s.clusterIP];
      const used = usedNodePorts(cluster, prev?.metadata.uid);
      for (const p of s.ports ?? []) {
        p.protocol ??= "TCP";
        p.targetPort ??= p.port;
        const prevNodePort = prevSpec?.ports?.find((q) => q.port === p.port && (q.protocol ?? "TCP") === p.protocol)?.nodePort;
        if (s.type === "NodePort" || (s.type === "LoadBalancer" && s.allocateLoadBalancerNodePorts !== false)) {
          if (!p.nodePort) p.nodePort = prevNodePort ?? randomNodePort(cluster, used);
          used.add(p.nodePort);
        } else if (p.nodePort !== undefined && p.nodePort === prevNodePort) {
          // dropTypeDependentFields: a type change away from NodePort releases the
          // allocated port. A nodePort the user sets on a ClusterIP Service is left for validation to reject.
          delete p.nodePort;
        }
      }
      if (s.type === "LoadBalancer") s.allocateLoadBalancerNodePorts ??= true;
      if (s.type === "NodePort" || s.type === "LoadBalancer") s.externalTrafficPolicy ??= "Cluster";
      else delete s.externalTrafficPolicy;
      svc.status ??= { loadBalancer: {} };
      break;
    }
    case "Secret": {
      const sec = obj as unknown as Secret;
      sec.type ??= "Opaque";
      if (sec.stringData) {
        sec.data = { ...(sec.data ?? {}) };
        for (const [k, v] of Object.entries(sec.stringData)) sec.data[k] = b64encode(String(v));
        delete sec.stringData;
      }
      break;
    }
    case "LimitRange":
      defaultLimitRange(obj as unknown as LimitRange);
      break;
    case "PriorityClass": {
      const pc = obj as unknown as PriorityClass;
      pc.preemptionPolicy ??= "PreemptLowerPriority";
      if (pc.globalDefault) {
        const other = cluster.list<PriorityClass>("PriorityClass").find((x) => x.globalDefault && x.metadata.name !== pc.metadata.name);
        if (other) throw new ApiError(`Error from server (Forbidden): priorityclasses.scheduling.k8s.io "${pc.metadata.name}" is forbidden: PriorityClass "${other.metadata.name}" is already marked as default. Only one default can exist`, "Forbidden");
      }
      break;
    }
    case "PersistentVolumeClaim": {
      const pvc = obj as unknown as PersistentVolumeClaim;
      pvc.spec ??= {};
      if (!prev && pvc.spec.storageClassName === undefined) {
        const def = cluster.list<StorageClass>("StorageClass").find((sc) => sc.metadata.annotations?.["storageclass.kubernetes.io/is-default-class"] === "true");
        if (def) pvc.spec.storageClassName = def.metadata.name;
      }
      pvc.spec.volumeMode ??= "Filesystem";
      if (prev) {
        // PersistentVolumeClaimResize admission: growing a bound claim needs a StorageClass that allows expansion.
        const old = prev as unknown as PersistentVolumeClaim;
        const grow = bytes(pvc.spec.resources?.requests?.storage) > bytes(old.spec?.resources?.requests?.storage);
        if (grow && old.status?.phase === "Bound") {
          const sc = old.spec?.storageClassName ? (cluster.raw("StorageClass", undefined, old.spec.storageClassName) as unknown as StorageClass | undefined) : undefined;
          if (!sc?.allowVolumeExpansion) {
            throw new ApiError(`Error from server (Forbidden): persistentvolumeclaims "${pvc.metadata.name}" is forbidden: only dynamically provisioned pvc can be resized and the storageclass that provisions the pvc must support resize`, "Forbidden");
          }
        }
      }
      if (!prev) {
        checkLimitRanges(cluster, pvc);
        pvc.metadata.finalizers = [...new Set([...(pvc.metadata.finalizers ?? []), PVC_PROTECTION])];
        pvc.status = { phase: "Pending" };
      }
      break;
    }
    case "PersistentVolume": {
      const pv = obj as unknown as PersistentVolume;
      pv.spec ??= {};
      pv.spec.persistentVolumeReclaimPolicy ??= "Retain";
      pv.spec.volumeMode ??= "Filesystem";
      if (!prev) {
        pv.metadata.finalizers = [...new Set([...(pv.metadata.finalizers ?? []), PV_PROTECTION])];
        pv.status ??= { phase: "Available" };
        if (pv.status.phase === "Pending") pv.status.phase = "Available";
      }
      break;
    }
    case "StorageClass": {
      const sc = obj as unknown as StorageClass;
      sc.reclaimPolicy ??= "Delete";
      sc.volumeBindingMode ??= "Immediate";
      break;
    }
    case "Ingress": {
      const ing = obj as unknown as Ingress;
      ing.spec ??= {};
      if (!prev && !ing.spec.ingressClassName) {
        const def = cluster.list("IngressClass").find((c) => c.metadata.annotations?.["ingressclass.kubernetes.io/is-default-class"] === "true");
        if (def) ing.spec.ingressClassName = def.metadata.name;
      }
      if (!prev) ing.status = { loadBalancer: {} };
      firstGeneration(obj, prev);
      break;
    }
    case "NetworkPolicy": {
      const np = obj as unknown as NetworkPolicy;
      np.spec ??= { podSelector: {} };
      np.spec.podSelector ??= {};
      // SetDefaults_NetworkPolicy: Egress only when there is at least one egress rule (`egress: []` doesn't count).
      if (!np.spec.policyTypes || np.spec.policyTypes.length === 0) np.spec.policyTypes = np.spec.egress?.length ? ["Ingress", "Egress"] : ["Ingress"];
      for (const r of [...(np.spec.ingress ?? []), ...(np.spec.egress ?? [])]) for (const p of r.ports ?? []) p.protocol ??= "TCP";
      firstGeneration(obj, prev);
      break;
    }
    case "Node": {
      const n = obj as unknown as Node;
      n.spec ??= {};
      if (!prev) n.spec.taints = [...(n.spec.taints ?? []), { key: "node.kubernetes.io/not-ready", effect: "NoSchedule" }];
      // NoExecute taints carry the time they were added (kept across updates), which taint-based eviction counts from.
      const before = (prev as unknown as Node | undefined)?.spec?.taints ?? [];
      for (const t of n.spec.taints ?? []) {
        if (t.effect !== "NoExecute" || t.timeAdded !== undefined) continue;
        t.timeAdded = before.find((b) => b.key === t.key && b.effect === t.effect && (b.value ?? "") === (t.value ?? ""))?.timeAdded ?? cluster.now;
      }
      break;
    }
    case "Namespace": {
      const ns = obj as unknown as Namespace;
      ns.metadata.labels = { ...(ns.metadata.labels ?? {}), "kubernetes.io/metadata.name": ns.metadata.name };
      ns.spec = { finalizers: ["kubernetes"] };
      ns.status ??= { phase: "Active" };
      break;
    }
  }
}
