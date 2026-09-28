// The one table of API kinds the Simulated Cluster serves: group, version,
// resource names and short names, as `kubectl api-resources` prints them.
// Everything else (namespacing, error messages, kubectl aliases) derives from it.

export interface KindInfo {
  kind: string;
  /** Resource name (plural), e.g. "deployments". */
  plural: string;
  /** Singular name kubectl uses in "deployment.apps/web". */
  singular: string;
  shortNames: string[];
  /** API group; "" is the core group. */
  group: string;
  version: string;
  namespaced: boolean;
}

const k = (kind: string, plural: string, group: string, version: string, namespaced: boolean, shortNames: string[] = []): KindInfo => ({
  kind,
  plural,
  singular: kind.toLowerCase(),
  shortNames,
  group,
  version,
  namespaced,
});

export const KIND_LIST: KindInfo[] = [
  k("Pod", "pods", "", "v1", true, ["po"]),
  k("Service", "services", "", "v1", true, ["svc"]),
  k("Endpoints", "endpoints", "", "v1", true, ["ep"]),
  k("ConfigMap", "configmaps", "", "v1", true, ["cm"]),
  k("Secret", "secrets", "", "v1", true),
  k("ServiceAccount", "serviceaccounts", "", "v1", true, ["sa"]),
  k("PersistentVolumeClaim", "persistentvolumeclaims", "", "v1", true, ["pvc"]),
  k("PersistentVolume", "persistentvolumes", "", "v1", false, ["pv"]),
  k("Node", "nodes", "", "v1", false, ["no"]),
  k("Namespace", "namespaces", "", "v1", false, ["ns"]),
  k("Event", "events", "", "v1", true, ["ev"]),
  k("Deployment", "deployments", "apps", "v1", true, ["deploy"]),
  k("ReplicaSet", "replicasets", "apps", "v1", true, ["rs"]),
  k("StatefulSet", "statefulsets", "apps", "v1", true, ["sts"]),
  k("DaemonSet", "daemonsets", "apps", "v1", true, ["ds"]),
  k("ControllerRevision", "controllerrevisions", "apps", "v1", true),
  k("Job", "jobs", "batch", "v1", true),
  k("CronJob", "cronjobs", "batch", "v1", true, ["cj"]),
  k("HorizontalPodAutoscaler", "horizontalpodautoscalers", "autoscaling", "v2", true, ["hpa"]),
  k("Ingress", "ingresses", "networking.k8s.io", "v1", true, ["ing"]),
  k("IngressClass", "ingressclasses", "networking.k8s.io", "v1", false),
  k("NetworkPolicy", "networkpolicies", "networking.k8s.io", "v1", true, ["netpol"]),
  k("StorageClass", "storageclasses", "storage.k8s.io", "v1", false, ["sc"]),
  k("Role", "roles", "rbac.authorization.k8s.io", "v1", true),
  k("ClusterRole", "clusterroles", "rbac.authorization.k8s.io", "v1", false),
  k("RoleBinding", "rolebindings", "rbac.authorization.k8s.io", "v1", true),
  k("ClusterRoleBinding", "clusterrolebindings", "rbac.authorization.k8s.io", "v1", false),
  k("ResourceQuota", "resourcequotas", "", "v1", true, ["quota"]),
  k("LimitRange", "limitranges", "", "v1", true, ["limits"]),
  k("PodDisruptionBudget", "poddisruptionbudgets", "policy", "v1", true, ["pdb"]),
  k("PriorityClass", "priorityclasses", "scheduling.k8s.io", "v1", false, ["pc"]),
];

export const KINDS: Record<string, KindInfo> = Object.fromEntries(KIND_LIST.map((x) => [x.kind, x]));

export const NAMESPACED_KINDS = new Set(KIND_LIST.filter((x) => x.namespaced).map((x) => x.kind));

export const API_VERSIONS: Record<string, string> = Object.fromEntries(KIND_LIST.map((x) => [x.kind, x.group ? `${x.group}/${x.version}` : x.version]));

/** "deployments.apps" style name used in API error messages. */
export function resourceName(kind: string): string {
  const info = KINDS[kind];
  if (!info) return kind.toLowerCase() + "s";
  return info.group ? `${info.plural}.${info.group}` : info.plural;
}

/** Looks a kind up by any name kubectl accepts: kind, plural, singular, short name, with or without group. */
export function kindByName(word: string): KindInfo | undefined {
  const w = word.toLowerCase();
  for (const x of KIND_LIST) {
    const names = [x.plural, x.singular, ...x.shortNames];
    if (names.includes(w)) return x;
    if (x.group && names.some((n) => w === `${n}.${x.group}` || w === `${n}.${x.version}.${x.group}`)) return x;
  }
  return undefined;
}
