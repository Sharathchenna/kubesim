// The RBAC authorizer (rbac.authorization.k8s.io/v1): a request is allowed if
// any ClusterRoleBinding, or any RoleBinding in the request's namespace, binds
// a subject matching the user to a role with a matching rule. Nothing is ever
// denied explicitly: RBAC only adds permissions. Behaviour reference v2 §9.

import type { Cluster } from "./cluster";
import type { PolicyRule, Role, RoleBinding } from "./types";

export interface UserInfo {
  name: string;
  groups: string[];
}

/** The Learner's kubeconfig user on a kind/kubeadm cluster. */
export const ADMIN: UserInfo = { name: "kubernetes-admin", groups: ["kubeadm:cluster-admins", "system:authenticated"] };

export function userFor(as: string | undefined, asGroups: string[] = []): UserInfo {
  if (!as) return ADMIN;
  const sa = as.match(/^system:serviceaccount:([^:]+):([^:]+)$/);
  if (sa) return { name: as, groups: ["system:serviceaccounts", `system:serviceaccounts:${sa[1]}`, "system:authenticated", ...asGroups] };
  return { name: as, groups: [...asGroups, "system:authenticated"] };
}

export interface Attributes {
  verb: string;
  group: string;
  resource: string;
  subresource?: string;
  name?: string;
  namespace?: string;
  nonResourceURL?: string;
}

function subjectMatches(b: RoleBinding, user: UserInfo): boolean {
  return (b.subjects ?? []).some((s) => {
    if (s.kind === "User") return s.name === user.name;
    if (s.kind === "Group") return user.groups.includes(s.name);
    if (s.kind === "ServiceAccount") return user.name === `system:serviceaccount:${s.namespace ?? b.metadata.namespace}:${s.name}`;
    return false;
  });
}

export function ruleAllows(r: PolicyRule, a: Attributes): boolean {
  if (!r.verbs.includes("*") && !r.verbs.includes(a.verb)) return false;
  if (a.nonResourceURL) return (r.nonResourceURLs ?? []).some((u) => u === "*" || u === a.nonResourceURL || (u.endsWith("*") && a.nonResourceURL!.startsWith(u.slice(0, -1))));
  if (!(r.apiGroups ?? []).some((g) => g === "*" || g === a.group)) return false;
  const res = a.subresource ? `${a.resource}/${a.subresource}` : a.resource;
  const resOk = (r.resources ?? []).some((x) => x === "*" || x === res || (a.subresource && x === `${a.resource}/*`) || (a.subresource && x === `*/${a.subresource}`));
  if (!resOk) return false;
  if (r.resourceNames && r.resourceNames.length) return !!a.name && r.resourceNames.includes(a.name);
  return true;
}

function rulesOf(cluster: Cluster, kind: "Role" | "ClusterRole", name: string, ns?: string): PolicyRule[] {
  const role = cluster.raw(kind, kind === "Role" ? ns : undefined, name) as unknown as Role | undefined;
  return role?.rules ?? [];
}

/** Every rule that applies to a user in a namespace (cluster-wide rules included). */
export function rulesFor(cluster: Cluster, user: UserInfo, ns?: string): PolicyRule[] {
  const out: PolicyRule[] = [];
  for (const b of cluster.list<RoleBinding>("ClusterRoleBinding")) if (subjectMatches(b, user)) out.push(...rulesOf(cluster, "ClusterRole", b.roleRef.name));
  if (ns) for (const b of cluster.list<RoleBinding>("RoleBinding", ns)) if (subjectMatches(b, user)) out.push(...rulesOf(cluster, b.roleRef.kind, b.roleRef.name, ns));
  return out;
}

export function authorize(cluster: Cluster, user: UserInfo, a: Attributes): boolean {
  if (user.groups.includes("system:masters")) return true;
  return rulesFor(cluster, user, a.namespace).some((r) => ruleAllows(r, a));
}

/** The apiserver's Forbidden message for a denied request. */
export function forbiddenMessage(user: UserInfo, a: Attributes, plural: string, missingRoles: string[] = []): string {
  const res = a.subresource ? `${a.resource}/${a.subresource}` : a.resource;
  const obj = a.name ? `${plural} "${a.name}"` : plural;
  const scope = a.namespace ? `in the namespace "${a.namespace}"` : "at the cluster scope";
  return `Error from server (Forbidden): ${obj} is forbidden: User "${user.name}" cannot ${a.verb} resource "${res}" in API group "${a.group}" ${scope}${missingRoles.length ? `: ${missingRoles.map((m) => `RBAC: ${m}`).join(", ")}` : ""}`;
}

/** Bindings that match the user but point at a role that doesn't exist: the authorizer names them. */
export function missingRoleReasons(cluster: Cluster, user: UserInfo, ns?: string): string[] {
  const out: string[] = [];
  const check = (b: RoleBinding) => {
    if (!subjectMatches(b, user)) return;
    const exists = cluster.raw(b.roleRef.kind, b.roleRef.kind === "Role" ? b.metadata.namespace : undefined, b.roleRef.name);
    if (!exists) out.push(`${b.roleRef.kind === "Role" ? "role" : "clusterrole"}.rbac.authorization.k8s.io "${b.roleRef.name}" not found`);
  };
  for (const b of cluster.list<RoleBinding>("ClusterRoleBinding")) check(b);
  if (ns) for (const b of cluster.list<RoleBinding>("RoleBinding", ns)) check(b);
  return out;
}

// ---------- built-in roles ----------

const READ = ["get", "list", "watch"];
const WRITE = ["create", "delete", "deletecollection", "patch", "update"];

const viewRules: PolicyRule[] = [
  { apiGroups: [""], resources: ["configmaps", "endpoints", "persistentvolumeclaims", "persistentvolumeclaims/status", "pods", "pods/log", "pods/status", "replicationcontrollers", "serviceaccounts", "services", "services/status", "bindings", "events", "limitranges", "namespaces/status", "resourcequotas"], verbs: READ },
  { apiGroups: [""], resources: ["namespaces"], verbs: READ },
  { apiGroups: ["apps"], resources: ["controllerrevisions", "daemonsets", "deployments", "deployments/scale", "replicasets", "replicasets/scale", "statefulsets", "statefulsets/scale", "daemonsets/status", "deployments/status", "replicasets/status", "statefulsets/status"], verbs: READ },
  { apiGroups: ["autoscaling"], resources: ["horizontalpodautoscalers", "horizontalpodautoscalers/status"], verbs: READ },
  { apiGroups: ["batch"], resources: ["cronjobs", "jobs", "cronjobs/status", "jobs/status"], verbs: READ },
  { apiGroups: ["networking.k8s.io"], resources: ["ingresses", "networkpolicies", "ingresses/status"], verbs: READ },
  { apiGroups: ["discovery.k8s.io"], resources: ["endpointslices"], verbs: READ },
];

const editRules: PolicyRule[] = [
  { apiGroups: [""], resources: ["pods/attach", "pods/exec", "pods/portforward", "pods/proxy", "secrets", "services/proxy"], verbs: READ },
  { apiGroups: [""], resources: ["serviceaccounts"], verbs: ["impersonate"] },
  { apiGroups: [""], resources: ["pods", "pods/attach", "pods/exec", "pods/portforward", "pods/proxy"], verbs: WRITE },
  { apiGroups: [""], resources: ["pods/eviction"], verbs: ["create"] },
  { apiGroups: [""], resources: ["configmaps", "events", "persistentvolumeclaims", "replicationcontrollers", "replicationcontrollers/scale", "secrets", "serviceaccounts", "services", "services/proxy"], verbs: WRITE },
  { apiGroups: [""], resources: ["serviceaccounts/token"], verbs: ["create"] },
  { apiGroups: ["apps"], resources: ["daemonsets", "deployments", "deployments/rollback", "deployments/scale", "replicasets", "replicasets/scale", "statefulsets", "statefulsets/scale"], verbs: WRITE },
  { apiGroups: ["autoscaling"], resources: ["horizontalpodautoscalers"], verbs: WRITE },
  { apiGroups: ["batch"], resources: ["cronjobs", "jobs"], verbs: WRITE },
  { apiGroups: ["networking.k8s.io"], resources: ["ingresses", "networkpolicies"], verbs: WRITE },
  ...viewRules,
];

const adminRules: PolicyRule[] = [
  { apiGroups: ["authorization.k8s.io"], resources: ["localsubjectaccessreviews"], verbs: ["create"] },
  { apiGroups: ["rbac.authorization.k8s.io"], resources: ["rolebindings", "roles"], verbs: [...WRITE, ...READ] },
  ...editRules,
];

export const BUILTIN_CLUSTER_ROLES: { name: string; rules: PolicyRule[]; labels?: Record<string, string> }[] = [
  { name: "cluster-admin", rules: [{ apiGroups: ["*"], resources: ["*"], verbs: ["*"] }, { nonResourceURLs: ["*"], verbs: ["*"] }] },
  { name: "admin", rules: adminRules, labels: { "kubernetes.io/bootstrapping": "rbac-defaults" } },
  { name: "edit", rules: editRules, labels: { "kubernetes.io/bootstrapping": "rbac-defaults", "rbac.authorization.k8s.io/aggregate-to-admin": "true" } },
  { name: "view", rules: viewRules, labels: { "kubernetes.io/bootstrapping": "rbac-defaults", "rbac.authorization.k8s.io/aggregate-to-edit": "true" } },
  {
    name: "system:basic-user",
    rules: [{ apiGroups: ["authorization.k8s.io"], resources: ["selfsubjectaccessreviews", "selfsubjectrulesreviews"], verbs: ["create"] }, { apiGroups: ["authentication.k8s.io"], resources: ["selfsubjectreviews"], verbs: ["create"] }],
  },
  { name: "system:discovery", rules: [{ nonResourceURLs: ["/api", "/api/*", "/apis", "/apis/*", "/healthz", "/livez", "/openapi", "/openapi/*", "/readyz", "/version", "/version/"], verbs: ["get"] }] },
  { name: "system:public-info-viewer", rules: [{ nonResourceURLs: ["/healthz", "/livez", "/readyz", "/version", "/version/"], verbs: ["get"] }] },
];

export const BUILTIN_CLUSTER_ROLE_BINDINGS: { name: string; role: string; group: string }[] = [
  { name: "cluster-admin", role: "cluster-admin", group: "system:masters" },
  { name: "kubeadm:cluster-admins", role: "cluster-admin", group: "kubeadm:cluster-admins" },
  { name: "system:basic-user", role: "system:basic-user", group: "system:authenticated" },
  { name: "system:discovery", role: "system:discovery", group: "system:authenticated" },
  { name: "system:public-info-viewer", role: "system:public-info-viewer", group: "system:authenticated" },
];
