// The objects a Learner can pick on the Cluster View, and what deleting one does: the kubectl
// command (so the UI teaches it) and, in plain English, what Kubernetes does next.

import type { Cluster, Pod } from "@/lib/engine";

export type ObjectKind = "pod" | "node" | "service" | "deployment" | "replicaset" | "statefulset" | "daemonset" | "job" | "cronjob" | "ingress" | "configmap" | "secret" | "pvc" | "networkpolicy" | "hpa" | "rolebinding";

/** API kind for each, as Cluster.raw/list want it. */
export const RAW_KIND: Record<ObjectKind, string> = {
  pod: "Pod",
  node: "Node",
  service: "Service",
  deployment: "Deployment",
  replicaset: "ReplicaSet",
  statefulset: "StatefulSet",
  daemonset: "DaemonSet",
  job: "Job",
  cronjob: "CronJob",
  ingress: "Ingress",
  configmap: "ConfigMap",
  secret: "Secret",
  pvc: "PersistentVolumeClaim",
  networkpolicy: "NetworkPolicy",
  hpa: "HorizontalPodAutoscaler",
  rolebinding: "RoleBinding",
};

/** What a person calls it: "Pod", "Node", "PersistentVolumeClaim"… */
export const KIND_LABEL: Record<ObjectKind, string> = { ...RAW_KIND, hpa: "HorizontalPodAutoscaler" };

const nsFlag = (kind: ObjectKind, ns?: string) => (kind !== "node" && ns && ns !== "default" ? ` -n ${ns}` : "");

/** The command that deletes it. */
export function deleteCommand(kind: ObjectKind, ns: string | undefined, name: string): string {
  return `kubectl delete ${kind} ${name}${nsFlag(kind, ns)}`;
}

/** Deleting the control plane's Node would take the cluster's own components with it; the UI doesn't offer it. */
export function canDelete(c: Cluster, kind: ObjectKind, ns: string | undefined, name: string): boolean {
  if (kind !== "node") return true;
  const n = c.raw("Node", undefined, name);
  return !!n && !("node-role.kubernetes.io/control-plane" in (n.metadata.labels ?? {}));
}

/** What happens after the delete, said before it so the Learner knows what they're doing. */
export function deleteNote(c: Cluster, kind: ObjectKind, ns: string | undefined, name: string): string {
  switch (kind) {
    case "pod": {
      const owned = !!c.raw("Pod", ns, name)?.metadata.ownerReferences?.length;
      return owned ? "Its controller notices one Pod too few and creates a replacement: self-healing. To really remove Pods, scale down or delete the workload." : "A bare Pod has no controller, so nothing brings it back.";
    }
    case "node": {
      const pods = c.list<Pod>("Pod").filter((p) => p.spec?.nodeName === name && !p.metadata.deletionTimestamp);
      const managed = pods.filter((p) => p.metadata.ownerReferences?.some((o) => o.kind !== "Node"));
      return `The Node leaves the cluster and its ${pods.length} Pod${pods.length === 1 ? "" : "s"} go with it. ${managed.length ? "Controllers recreate the ones they manage on the other Nodes" : "None are managed by a controller, so nothing replaces them"}${pods.length - managed.length > 0 && managed.length ? "; bare Pods are gone for good" : ""}.`;
    }
    case "deployment":
      return "The garbage collector removes its ReplicaSets, then their Pods shut down gracefully.";
    case "replicaset":
      return "Its Pods go with it. If a Deployment owns it, the Deployment makes a new one straight away.";
    case "statefulset":
      return "Its Pods go, highest number first. Their PersistentVolumeClaims stay, so the data is still there if you recreate it.";
    case "daemonset":
      return "Its Pod on every Node goes with it.";
    case "job":
      return "Its Pods go with it, finished or not.";
    case "cronjob":
      return "No more runs. The Jobs it created go too.";
    case "service":
      return "The Pods keep running; they lose their stable address and DNS name, so anything calling it starts failing.";
    case "ingress":
      return "Requests from outside stop being routed to its Services.";
    case "configmap":
    case "secret":
      return "Running Pods keep what they loaded, but new Pods that use it can't start (CreateContainerConfigError).";
    case "pvc":
      return "While a Pod still uses it, it waits in Terminating (pvc-protection); then the volume and its data are deleted.";
    case "networkpolicy":
      return "The Pods it selected are no longer isolated by it.";
    case "hpa":
      return "The replica count stays where it is and stops following CPU.";
    case "rolebinding":
      return "Its subjects lose the permissions it granted.";
  }
}
