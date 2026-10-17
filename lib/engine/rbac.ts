// The RBAC authorizer (rbac.authorization.k8s.io/v1): a request is allowed if
// any ClusterRoleBinding, or any RoleBinding in the request's namespace, binds
// a subject matching the user to a role with a matching rule. Nothing is ever
// denied explicitly: RBAC only adds permissions. Behaviour reference v2 §9.

import { ApiError, type Cluster } from "./cluster";
import { resourceName } from "./kinds";
import type { AnyObject, PolicyRule, Role, RoleBinding, Subject } from "./types";
import { deepEqual, matchesSelectorString } from "./util";

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

// ---------- escalation prevention ----------
// pkg/registry/rbac: creating or updating a Role/ClusterRole needs either every permission
// it grants or the `escalate` verb on it; a RoleBinding/ClusterRoleBinding needs either
// every permission of the referenced role or the `bind` verb on that role
// (rbacregistryvalidation.ConfirmNoEscalation, BindingAuthorized, EscalationAllowed).

const has = (xs: string[] | undefined, x: string) => (xs ?? []).includes("*") || (xs ?? []).includes(x);

/** Does one owner rule cover one atomic requested rule (rbac/validation.Covers)? */
function covers(owner: PolicyRule, req: { verb: string; group?: string; resource?: string; name?: string; url?: string }): boolean {
  if (!has(owner.verbs, req.verb)) return false;
  if (req.url !== undefined) {
    return (owner.nonResourceURLs ?? []).some((u) => u === "*" || u === req.url || (u.endsWith("*") && req.url!.startsWith(u.slice(0, -1))));
  }
  if (!has(owner.apiGroups, req.group!)) return false;
  const r = req.resource!;
  const resOk = (owner.resources ?? []).some((x) => x === "*" || x === r || (r.includes("/") && x === `${r.split("/")[0]}/*`) || (r.includes("/") && x === `*/${r.split("/")[1]}`));
  if (!resOk) return false;
  if (owner.resourceNames?.length) return req.name !== undefined && owner.resourceNames.includes(req.name);
  return true;
}

/** Requested rules no owner rule covers, in rbac CompactString form. */
function uncovered(owner: PolicyRule[], requested: PolicyRule[]): string[] {
  const out: string[] = [];
  const q = (xs: string[]) => `[${xs.map((x) => JSON.stringify(x)).join(" ")}]`;
  for (const r of requested) {
    const atoms: { verb: string; group?: string; resource?: string; name?: string; url?: string }[] = [];
    for (const verb of r.verbs ?? []) {
      if (r.nonResourceURLs?.length) for (const url of r.nonResourceURLs) atoms.push({ verb, url });
      else
        for (const group of r.apiGroups ?? [])
          for (const resource of r.resources ?? []) {
            if (r.resourceNames?.length) for (const name of r.resourceNames) atoms.push({ verb, group, resource, name });
            else atoms.push({ verb, group, resource });
          }
    }
    if (atoms.every((a) => owner.some((o) => covers(o, a)))) continue;
    const parts = r.nonResourceURLs?.length
      ? [`NonResourceURLs:${q(r.nonResourceURLs)}`, `Verbs:${q(r.verbs ?? [])}`]
      : [`APIGroups:${q(r.apiGroups ?? [])}`, `Resources:${q(r.resources ?? [])}`, ...(r.resourceNames?.length ? [`ResourceNames:${q(r.resourceNames)}`] : []), `Verbs:${q(r.verbs ?? [])}`];
    out.push(`{${parts.join(", ")}}`);
  }
  return out;
}

/**
 * Throws Forbidden if `user` may not create or update this RBAC object because it would
 * grant permissions the user doesn't hold. A no-op for other kinds.
 */
export function checkEscalation(cluster: Cluster, user: UserInfo, obj: AnyObject, prev: AnyObject | undefined): void {
  if (!["Role", "ClusterRole", "RoleBinding", "ClusterRoleBinding"].includes(obj.kind)) return;
  if (user.groups.includes("system:masters")) return;
  const ns = obj.kind === "Role" || obj.kind === "RoleBinding" ? obj.metadata.namespace : undefined;
  const owner = rulesFor(cluster, user, ns);
  let requested: PolicyRule[];
  if (obj.kind === "Role" || obj.kind === "ClusterRole") {
    const resource = obj.kind === "Role" ? "roles" : "clusterroles";
    if (authorize(cluster, user, { verb: "escalate", group: "rbac.authorization.k8s.io", resource, name: obj.metadata.name, namespace: ns })) return;
    // An aggregated ClusterRole's rules come from the controller; only the selectors matter.
    requested = (obj as unknown as Role).rules ?? [];
  } else {
    const b = obj as unknown as RoleBinding;
    const resource = b.roleRef.kind === "Role" ? "roles" : "clusterroles";
    if (authorize(cluster, user, { verb: "bind", group: "rbac.authorization.k8s.io", resource, name: b.roleRef.name, namespace: ns })) return;
    const role = cluster.raw(b.roleRef.kind, b.roleRef.kind === "Role" ? ns : undefined, b.roleRef.name) as unknown as Role | undefined;
    requested = role?.rules ?? [];
  }
  void prev; // updates are checked like creates
  const missing = uncovered(owner, requested);
  if (!missing.length) return;
  const groups = `[${user.groups.map((g) => JSON.stringify(g)).join(" ")}]`;
  throw new ApiError(
    `Error from server (Forbidden): ${resourceName(obj.kind)} "${obj.metadata.name}" is forbidden: user "${user.name}" (groups=${groups}) is attempting to grant RBAC permissions not currently held:\n${missing.join("\n")}`,
    "Forbidden",
  );
}

// ---------- ClusterRole aggregation ----------

/**
 * The clusterrole-aggregation controller (pkg/controller/clusterroleaggregation): for every
 * ClusterRole with an aggregationRule, `rules` becomes the union (deduplicated, in name order)
 * of the rules of every other ClusterRole matching any of its clusterRoleSelectors. Rules
 * written by hand on an aggregated role are overwritten. Returns true if anything changed.
 */
export function aggregateClusterRoles(cluster: Cluster): boolean {
  const roles = cluster.list<Role>("ClusterRole");
  const aggregated = roles.filter((r) => r.aggregationRule);
  if (!aggregated.length) return false;
  let changed = false;
  for (const role of aggregated) {
    const fresh = cluster.raw("ClusterRole", undefined, role.metadata.name) as unknown as Role;
    const rules: PolicyRule[] = [];
    for (const sel of fresh.aggregationRule?.clusterRoleSelectors ?? []) {
      const matched = cluster
        .list<Role>("ClusterRole")
        .filter((r) => r.metadata.name !== fresh.metadata.name && matchesSelectorString(r.metadata.labels, sel))
        .sort((a, b) => (a.metadata.name < b.metadata.name ? -1 : a.metadata.name > b.metadata.name ? 1 : 0));
      for (const r of matched) for (const rule of r.rules ?? []) if (!rules.some((x) => deepEqual(x, rule))) rules.push(rule);
    }
    if (deepEqual(rules, fresh.rules ?? [])) continue;
    cluster.update(fresh, (x) => {
      x.rules = rules;
    });
    changed = true;
  }
  return changed;
}

// Informer stand-in: skip the work when no ClusterRole changed since the last pass.
const lastSeen = new WeakMap<Cluster, string>();

/** Controller entry point: aggregation chains (view -> edit -> admin) settle over a few passes. */
export function runClusterRoleAggregation(cluster: Cluster, maxPasses = 1): void {
  const sig = () => cluster.list<Role>("ClusterRole").map((r) => r.metadata.resourceVersion).join(",");
  if (lastSeen.get(cluster) === sig()) return;
  for (let i = 0; i < maxPasses; i++) {
    if (!aggregateClusterRoles(cluster)) {
      lastSeen.set(cluster, sig()); // settled
      return;
    }
  }
  lastSeen.delete(cluster); // a chain may still be propagating: look again next step
}

// ---------- built-in roles ----------
// Mirrors plugin/pkg/auth/authorizer/rbac/bootstrappolicy/policy.go. Rules for the system
// component roles are trimmed to the resources this simulator models plus the obvious extras.

const READ = ["get", "list", "watch"];
const WRITE = ["create", "delete", "deletecollection", "patch", "update"];
const READ_UPDATE = ["get", "list", "watch", "update", "patch"];
const eventsRule: PolicyRule = { apiGroups: ["", "events.k8s.io"], resources: ["events"], verbs: ["create", "update", "patch"] };

const viewRules: PolicyRule[] = [
  { apiGroups: [""], resources: ["configmaps", "endpoints", "persistentvolumeclaims", "persistentvolumeclaims/status", "pods", "pods/log", "pods/status", "replicationcontrollers", "serviceaccounts", "services", "services/status", "bindings", "events", "limitranges", "namespaces/status", "resourcequotas"], verbs: READ },
  { apiGroups: [""], resources: ["namespaces"], verbs: READ },
  { apiGroups: ["apps"], resources: ["controllerrevisions", "daemonsets", "deployments", "deployments/scale", "replicasets", "replicasets/scale", "statefulsets", "statefulsets/scale", "daemonsets/status", "deployments/status", "replicasets/status", "statefulsets/status"], verbs: READ },
  { apiGroups: ["autoscaling"], resources: ["horizontalpodautoscalers", "horizontalpodautoscalers/status"], verbs: READ },
  { apiGroups: ["batch"], resources: ["cronjobs", "jobs", "cronjobs/status", "jobs/status"], verbs: READ },
  { apiGroups: ["networking.k8s.io"], resources: ["ingresses", "networkpolicies", "ingresses/status"], verbs: READ },
  { apiGroups: ["policy"], resources: ["poddisruptionbudgets", "poddisruptionbudgets/status"], verbs: READ },
  { apiGroups: ["discovery.k8s.io"], resources: ["endpointslices"], verbs: READ },
];

/** system:aggregate-to-edit: what edit adds on top of view. */
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
  { apiGroups: ["policy"], resources: ["poddisruptionbudgets"], verbs: WRITE },
];

/** system:aggregate-to-admin: what admin adds on top of edit. */
const adminRules: PolicyRule[] = [
  { apiGroups: ["authorization.k8s.io"], resources: ["localsubjectaccessreviews"], verbs: ["create"] },
  { apiGroups: ["rbac.authorization.k8s.io"], resources: ["rolebindings", "roles"], verbs: [...WRITE, ...READ] },
];

const AGG = "rbac.authorization.k8s.io/aggregate-to-";
const aggregateOf = (to: "admin" | "edit" | "view") => ({ clusterRoleSelectors: [{ matchLabels: { [`${AGG}${to}`]: "true" } }] });

const nodeRules: PolicyRule[] = [
  { apiGroups: ["authentication.k8s.io"], resources: ["tokenreviews"], verbs: ["create"] },
  { apiGroups: ["authorization.k8s.io"], resources: ["localsubjectaccessreviews", "subjectaccessreviews"], verbs: ["create"] },
  { apiGroups: [""], resources: ["services"], verbs: READ },
  { apiGroups: [""], resources: ["nodes"], verbs: ["create", "get", "list", "watch"] },
  { apiGroups: [""], resources: ["nodes/status"], verbs: ["patch", "update"] },
  { apiGroups: [""], resources: ["nodes"], verbs: ["patch", "update"] },
  eventsRule,
  { apiGroups: [""], resources: ["pods"], verbs: READ },
  { apiGroups: [""], resources: ["pods"], verbs: ["create", "delete"] },
  { apiGroups: [""], resources: ["pods/status"], verbs: ["patch", "update"] },
  { apiGroups: [""], resources: ["pods/eviction"], verbs: ["create"] },
  { apiGroups: [""], resources: ["configmaps", "secrets"], verbs: ["get", "list", "watch"] },
  { apiGroups: [""], resources: ["persistentvolumeclaims", "persistentvolumes"], verbs: ["get"] },
  { apiGroups: [""], resources: ["endpoints"], verbs: ["get"] },
  { apiGroups: ["certificates.k8s.io"], resources: ["certificatesigningrequests"], verbs: ["create", "get", "list", "watch"] },
  { apiGroups: ["coordination.k8s.io"], resources: ["leases"], verbs: ["create", "delete", "get", "patch", "update"] },
  { apiGroups: ["storage.k8s.io"], resources: ["volumeattachments", "csidrivers"], verbs: ["get"] },
  { apiGroups: [""], resources: ["serviceaccounts/token"], verbs: ["create"] },
  { apiGroups: ["node.k8s.io"], resources: ["runtimeclasses"], verbs: READ },
];

export interface BuiltinClusterRole {
  name: string;
  rules?: PolicyRule[];
  labels?: Record<string, string>;
  aggregationRule?: Role["aggregationRule"];
}

export const BUILTIN_CLUSTER_ROLES: BuiltinClusterRole[] = [
  { name: "cluster-admin", rules: [{ apiGroups: ["*"], resources: ["*"], verbs: ["*"] }, { nonResourceURLs: ["*"], verbs: ["*"] }] },
  { name: "system:discovery", rules: [{ nonResourceURLs: ["/api", "/api/*", "/apis", "/apis/*", "/healthz", "/livez", "/openapi", "/openapi/*", "/readyz", "/version", "/version/"], verbs: ["get"] }] },
  {
    name: "system:monitoring",
    rules: [
      { nonResourceURLs: ["/healthz", "/healthz/*", "/livez", "/livez/*", "/metrics", "/metrics/slis", "/readyz", "/readyz/*"], verbs: ["get"] },
      { apiGroups: [""], resources: ["nodes/metrics"], verbs: ["get"] },
    ],
  },
  {
    name: "system:basic-user",
    rules: [{ apiGroups: ["authorization.k8s.io"], resources: ["selfsubjectaccessreviews", "selfsubjectrulesreviews"], verbs: ["create"] }, { apiGroups: ["authentication.k8s.io"], resources: ["selfsubjectreviews"], verbs: ["create"] }],
  },
  { name: "system:public-info-viewer", rules: [{ nonResourceURLs: ["/healthz", "/livez", "/readyz", "/version", "/version/"], verbs: ["get"] }] },
  // User-facing roles are aggregated: their rules are filled in by the aggregation controller.
  { name: "admin", aggregationRule: aggregateOf("admin") },
  { name: "edit", aggregationRule: aggregateOf("edit"), labels: { [`${AGG}admin`]: "true" } },
  { name: "view", aggregationRule: aggregateOf("view"), labels: { [`${AGG}edit`]: "true" } },
  { name: "system:aggregate-to-admin", rules: adminRules, labels: { [`${AGG}admin`]: "true" } },
  { name: "system:aggregate-to-edit", rules: editRules, labels: { [`${AGG}edit`]: "true" } },
  { name: "system:aggregate-to-view", rules: viewRules, labels: { [`${AGG}view`]: "true" } },
  {
    name: "system:heapster",
    rules: [
      { apiGroups: [""], resources: ["events", "pods", "nodes", "namespaces"], verbs: READ },
      { apiGroups: ["extensions"], resources: ["deployments"], verbs: READ },
    ],
  },
  { name: "system:node", rules: nodeRules },
  {
    name: "system:node-problem-detector",
    rules: [{ apiGroups: [""], resources: ["nodes"], verbs: ["get"] }, { apiGroups: [""], resources: ["nodes/status"], verbs: ["patch"] }, eventsRule],
  },
  { name: "system:node-bootstrapper", rules: [{ apiGroups: ["certificates.k8s.io"], resources: ["certificatesigningrequests"], verbs: ["create", "get", "list", "watch"] }] },
  {
    name: "system:auth-delegator",
    rules: [
      { apiGroups: ["authentication.k8s.io"], resources: ["tokenreviews"], verbs: ["create"] },
      { apiGroups: ["authorization.k8s.io"], resources: ["subjectaccessreviews"], verbs: ["create"] },
    ],
  },
  { name: "system:kube-aggregator", rules: [{ apiGroups: [""], resources: ["services", "endpoints"], verbs: READ }] },
  {
    name: "system:kube-controller-manager",
    rules: [
      eventsRule,
      { apiGroups: ["coordination.k8s.io"], resources: ["leases"], verbs: ["create"] },
      { apiGroups: ["coordination.k8s.io"], resources: ["leases"], resourceNames: ["kube-controller-manager"], verbs: ["get", "update"] },
      { apiGroups: [""], resources: ["secrets", "serviceaccounts"], verbs: ["create"] },
      { apiGroups: [""], resources: ["secrets"], verbs: ["delete"] },
      { apiGroups: [""], resources: ["configmaps", "namespaces", "secrets", "serviceaccounts"], verbs: ["get"] },
      { apiGroups: [""], resources: ["secrets", "serviceaccounts"], verbs: ["update"] },
      { apiGroups: ["authentication.k8s.io"], resources: ["tokenreviews"], verbs: ["create"] },
      { apiGroups: ["authorization.k8s.io"], resources: ["subjectaccessreviews"], verbs: ["create"] },
      { apiGroups: ["*"], resources: ["*"], verbs: ["list", "watch"] },
      { apiGroups: [""], resources: ["serviceaccounts/token"], verbs: ["create"] },
    ],
  },
  { name: "system:kube-dns", rules: [{ apiGroups: [""], resources: ["endpoints", "services"], verbs: ["list", "watch"] }] },
  {
    name: "system:persistent-volume-provisioner",
    rules: [
      { apiGroups: [""], resources: ["persistentvolumes"], verbs: ["create", "delete", "get", "list", "watch"] },
      { apiGroups: [""], resources: ["persistentvolumeclaims"], verbs: ["get", "list", "update", "watch"] },
      { apiGroups: ["storage.k8s.io"], resources: ["storageclasses"], verbs: READ },
      { apiGroups: [""], resources: ["events"], verbs: ["watch"] },
      eventsRule,
    ],
  },
  {
    name: "system:volume-scheduler",
    rules: [
      { apiGroups: [""], resources: ["persistentvolumes"], verbs: READ_UPDATE },
      { apiGroups: ["storage.k8s.io"], resources: ["storageclasses"], verbs: READ },
      { apiGroups: [""], resources: ["persistentvolumeclaims"], verbs: READ_UPDATE },
    ],
  },
  { name: "system:certificates.k8s.io:certificatesigningrequests:nodeclient", rules: [{ apiGroups: ["certificates.k8s.io"], resources: ["certificatesigningrequests/nodeclient"], verbs: ["create"] }] },
  { name: "system:certificates.k8s.io:certificatesigningrequests:selfnodeclient", rules: [{ apiGroups: ["certificates.k8s.io"], resources: ["certificatesigningrequests/selfnodeclient"], verbs: ["create"] }] },
  { name: "system:service-account-issuer-discovery", rules: [{ nonResourceURLs: ["/.well-known/openid-configuration", "/.well-known/openid-configuration/", "/openid/v1/jwks", "/openid/v1/jwks/"], verbs: ["get"] }] },
  {
    name: "system:kubelet-api-admin",
    rules: [
      { apiGroups: [""], resources: ["nodes"], verbs: READ },
      { apiGroups: [""], resources: ["nodes"], verbs: ["proxy"] },
      { apiGroups: [""], resources: ["nodes/log", "nodes/metrics", "nodes/proxy", "nodes/stats"], verbs: ["*"] },
    ],
  },
  {
    name: "system:node-proxier",
    rules: [
      { apiGroups: [""], resources: ["endpoints", "services"], verbs: ["list", "watch"] },
      { apiGroups: [""], resources: ["nodes"], verbs: READ },
      { apiGroups: ["networking.k8s.io"], resources: ["servicecidrs"], verbs: ["list", "watch"] },
      eventsRule,
      { apiGroups: ["discovery.k8s.io"], resources: ["endpointslices"], verbs: ["list", "watch"] },
    ],
  },
  {
    name: "system:kube-scheduler",
    rules: [
      eventsRule,
      { apiGroups: ["coordination.k8s.io"], resources: ["leases"], verbs: ["create"] },
      { apiGroups: ["coordination.k8s.io"], resources: ["leases"], resourceNames: ["kube-scheduler"], verbs: ["get", "list", "update", "watch"] },
      { apiGroups: [""], resources: ["nodes"], verbs: READ },
      { apiGroups: [""], resources: ["pods"], verbs: ["delete", "get", "list", "watch"] },
      { apiGroups: [""], resources: ["bindings", "pods/binding"], verbs: ["create"] },
      { apiGroups: [""], resources: ["pods/status"], verbs: ["patch", "update"] },
      { apiGroups: [""], resources: ["replicationcontrollers", "services"], verbs: READ },
      { apiGroups: ["apps", "extensions"], resources: ["replicasets"], verbs: READ },
      { apiGroups: ["apps"], resources: ["statefulsets"], verbs: READ },
      { apiGroups: ["policy"], resources: ["poddisruptionbudgets"], verbs: READ },
      { apiGroups: [""], resources: ["persistentvolumeclaims", "persistentvolumes"], verbs: READ },
      { apiGroups: ["authentication.k8s.io"], resources: ["tokenreviews"], verbs: ["create"] },
      { apiGroups: ["authorization.k8s.io"], resources: ["subjectaccessreviews"], verbs: ["create"] },
      { apiGroups: ["storage.k8s.io"], resources: ["csinodes"], verbs: READ },
      { apiGroups: [""], resources: ["namespaces"], verbs: READ },
      { apiGroups: ["storage.k8s.io"], resources: ["csidrivers", "csistoragecapacities"], verbs: READ },
    ],
  },
];

const group = (name: string): Subject => ({ apiGroup: "rbac.authorization.k8s.io", kind: "Group", name });
const user = (name: string): Subject => ({ apiGroup: "rbac.authorization.k8s.io", kind: "User", name });

/** Default ClusterRoleBindings (bootstrappolicy.ClusterRoleBindings) plus kubeadm's admin group. Name = role name. */
export const BUILTIN_CLUSTER_ROLE_BINDINGS: { name: string; role: string; subjects?: Subject[] }[] = [
  { name: "cluster-admin", role: "cluster-admin", subjects: [group("system:masters")] },
  { name: "kubeadm:cluster-admins", role: "cluster-admin", subjects: [group("kubeadm:cluster-admins")] },
  { name: "system:monitoring", role: "system:monitoring", subjects: [group("system:monitoring")] },
  { name: "system:discovery", role: "system:discovery", subjects: [group("system:authenticated")] },
  { name: "system:basic-user", role: "system:basic-user", subjects: [group("system:authenticated")] },
  { name: "system:public-info-viewer", role: "system:public-info-viewer", subjects: [group("system:authenticated"), group("system:unauthenticated")] },
  { name: "system:node-proxier", role: "system:node-proxier", subjects: [user("system:kube-proxy")] },
  { name: "system:kube-controller-manager", role: "system:kube-controller-manager", subjects: [user("system:kube-controller-manager")] },
  { name: "system:kube-dns", role: "system:kube-dns", subjects: [{ kind: "ServiceAccount", name: "kube-dns", namespace: "kube-system" }] },
  { name: "system:kube-scheduler", role: "system:kube-scheduler", subjects: [user("system:kube-scheduler")] },
  { name: "system:volume-scheduler", role: "system:volume-scheduler", subjects: [user("system:kube-scheduler")] },
  // Deprecated since the Node authorizer (1.7): kept with no subjects.
  { name: "system:node", role: "system:node" },
  { name: "system:service-account-issuer-discovery", role: "system:service-account-issuer-discovery", subjects: [group("system:serviceaccounts")] },
];
