// Defaulting and allocation the API server does on create/update
// (see docs/research/kubernetes-behaviour-reference.md §1, §7.1).

import type { Cluster } from "./cluster";
import { parseImage } from "./images";
import type {
  AnyObject,
  Container,
  Deployment,
  Namespace,
  Node,
  Pod,
  PodSpec,
  PodTemplateSpec,
  ReplicaSet,
  Service,
  Toleration,
} from "./types";

export function defaultContainer(c: Container): void {
  const { tag } = parseImage(c.image ?? "");
  const hasTag = /:[^/]+$/.test(c.image ?? "") || (c.image ?? "").includes("@");
  c.imagePullPolicy ??= !hasTag || tag === "latest" ? "Always" : "IfNotPresent";
  c.terminationMessagePath ??= "/dev/termination-log";
  c.terminationMessagePolicy ??= "File";
  c.resources ??= {};
}

export function defaultPodSpec(s: PodSpec): void {
  s.containers ??= [];
  for (const c of s.containers) defaultContainer(c);
  s.restartPolicy ??= "Always";
  s.terminationGracePeriodSeconds ??= 30;
  s.dnsPolicy ??= "ClusterFirst";
  s.schedulerName ??= "default-scheduler";
  s.securityContext ??= {};
  s.enableServiceLinks ??= true;
  s.preemptionPolicy ??= "PreemptLowerPriority";
  s.priority ??= 0;
  s.serviceAccountName ??= "default";
}

function defaultTemplate(t: PodTemplateSpec | undefined): void {
  if (!t) return;
  t.metadata ??= {};
  t.metadata.creationTimestamp = null;
  if (t.spec) defaultPodSpec(t.spec);
}

function podTolerations(cluster: Cluster, spec: PodSpec): void {
  const secs = cluster.state.config.defaultTolerationSeconds;
  const tol = (spec.tolerations ??= []);
  for (const key of ["node.kubernetes.io/not-ready", "node.kubernetes.io/unreachable"]) {
    if (tol.some((t) => t.key === key && (t.effect === "NoExecute" || !t.effect))) continue;
    tol.push({ key, operator: "Exists", effect: "NoExecute", tolerationSeconds: secs } as Toleration);
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

export function admit(cluster: Cluster, obj: AnyObject, prev: AnyObject | undefined): void {
  switch (obj.kind) {
    case "Pod": {
      const pod = obj as unknown as Pod;
      pod.spec ??= { containers: [] };
      defaultPodSpec(pod.spec);
      podTolerations(cluster, pod.spec);
      if (!prev) pod.status = { phase: "Pending", qosClass: "BestEffort" };
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
      s.strategy ??= { type: "RollingUpdate" };
      if (s.strategy.type === "RollingUpdate") {
        s.strategy.rollingUpdate = { maxSurge: "25%", maxUnavailable: "25%", ...(s.strategy.rollingUpdate ?? {}) };
      } else delete s.strategy.rollingUpdate;
      s.revisionHistoryLimit ??= 10;
      s.progressDeadlineSeconds ??= 600;
      defaultTemplate(s.template);
      if (!prev) {
        d.metadata.generation = 1;
        d.status = {};
      }
      break;
    }
    case "Service": {
      const svc = obj as unknown as Service;
      svc.spec ??= {};
      const s = svc.spec;
      s.type ??= "ClusterIP";
      s.sessionAffinity ??= "None";
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
        if (s.type === "NodePort" || s.type === "LoadBalancer") {
          if (!p.nodePort) {
            p.nodePort = prevSpec?.ports?.find((q) => q.port === p.port)?.nodePort ?? randomNodePort(cluster, used);
          }
          used.add(p.nodePort);
        } else delete p.nodePort;
      }
      if (s.type === "NodePort" || s.type === "LoadBalancer") s.externalTrafficPolicy ??= "Cluster";
      else delete s.externalTrafficPolicy;
      svc.status ??= { loadBalancer: {} };
      break;
    }
    case "Node": {
      const n = obj as unknown as Node;
      n.spec ??= {};
      if (!prev) n.spec.taints = [...(n.spec.taints ?? []), { key: "node.kubernetes.io/not-ready", effect: "NoSchedule" }];
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
