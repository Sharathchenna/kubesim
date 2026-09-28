// Namespace policy the API server enforces at admission, and the controllers
// that keep its status: LimitRanger (default and bounded requests/limits),
// Priority (priorityClassName → spec.priority), ResourceQuota (usage caps),
// and PodDisruptionBudgets with the Eviction API that honours them.

import { ApiError, isPodReady, isPodTerminal, type Cluster } from "./cluster";
import { bytes, milliCpu } from "./quantity";
import type { Container, KubeObject, LimitRange, Service, LimitRangeItem, PersistentVolumeClaim, Pod, PodDisruptionBudget, PriorityClass, ResourceQuota } from "./types";
import { KINDS } from "./kinds";
import { intOrPercent, matchesSelector } from "./util";

type Amount = { kind: "cpu" | "bytes" | "count"; v: number };

const CPU = new Set(["cpu", "requests.cpu", "limits.cpu"]);
const isCpu = (res: string) => CPU.has(res);
const isBytes = (res: string) => /(^|\.)(memory|storage|ephemeral-storage)$/.test(res);
const amount = (res: string, q: string | number | undefined): number => (isCpu(res) ? milliCpu(q) : isBytes(res) ? bytes(q) : Number(q ?? 0));

/** How the API server prints a summed quantity: 500m, 2, 128Mi, 1Gi, 3. */
export function formatAmount(res: string, v: number): string {
  if (isCpu(res)) return v % 1000 === 0 ? String(v / 1000) : `${v}m`;
  if (isBytes(res)) {
    for (const [suf, mul] of [["Ei", 2 ** 60], ["Pi", 2 ** 50], ["Ti", 2 ** 40], ["Gi", 2 ** 30], ["Mi", 2 ** 20], ["Ki", 2 ** 10]] as const) if (v >= mul && v % mul === 0) return `${v / mul}${suf}`;
    for (const [suf, mul] of [["G", 1e9], ["M", 1e6], ["k", 1e3]] as const) if (v >= mul && v % mul === 0) return `${v / mul}${suf}`;
  }
  return String(v);
}

// ---------------------------------------------------------------- LimitRange

/** API defaulting of a LimitRange item: default ← max, defaultRequest ← default ← min (SetDefaults_LimitRangeItem). */
export function defaultLimitRange(lr: LimitRange): void {
  for (const it of lr.spec?.limits ?? []) {
    if (it.type !== "Container") continue;
    it.default ??= {};
    it.defaultRequest ??= {};
    for (const [k, v] of Object.entries(it.max ?? {})) it.default[k] ??= v;
    for (const [k, v] of Object.entries(it.default)) it.defaultRequest[k] ??= v;
    for (const [k, v] of Object.entries(it.min ?? {})) it.defaultRequest[k] ??= v;
    if (!Object.keys(it.default).length) delete it.default;
    if (!Object.keys(it.defaultRequest).length) delete it.defaultRequest;
  }
}

const itemsOf = (cluster: Cluster, ns: string, type: LimitRangeItem["type"]) => cluster.list<LimitRange>("LimitRange", ns).flatMap((lr) => (lr.spec?.limits ?? []).filter((it) => it.type === type));

/** LimitRanger's mutating half: fill in default requests and limits for every container. */
export function applyLimitDefaults(cluster: Cluster, pod: Pod): void {
  const items = itemsOf(cluster, pod.metadata.namespace ?? "default", "Container");
  if (!items.length) return;
  const annotate: string[] = [];
  for (const c of [...(pod.spec?.initContainers ?? []), ...(pod.spec?.containers ?? [])]) {
    for (const it of items) {
      for (const [res, v] of Object.entries(it.default ?? {})) {
        if (c.resources?.limits?.[res] !== undefined) continue;
        c.resources = { ...c.resources, limits: { ...c.resources?.limits, [res]: v } };
        annotate.push(`${res} limit for container ${c.name}`);
      }
      for (const [res, v] of Object.entries(it.defaultRequest ?? {})) {
        if (c.resources?.requests?.[res] !== undefined) continue;
        c.resources = { ...c.resources, requests: { ...c.resources?.requests, [res]: v } };
        annotate.push(`${res} request for container ${c.name}`);
      }
    }
  }
  if (annotate.length) pod.metadata.annotations = { ...pod.metadata.annotations, "kubernetes.io/limit-ranger": `LimitRanger plugin set: ${annotate.join("; ")}` };
}

function boundErrors(items: LimitRangeItem[], scope: string, req: (res: string) => string | undefined, lim: (res: string) => string | undefined): string[] {
  const errs: string[] = [];
  for (const it of items) {
    for (const [res, min] of Object.entries(it.min ?? {})) {
      const r = req(res);
      if (r === undefined) errs.push(`minimum ${res} usage per ${scope} is ${min}.  No request is specified`);
      else if (amount(res, r) < amount(res, min)) errs.push(`minimum ${res} usage per ${scope} is ${min}, but request is ${r}`);
    }
    for (const [res, max] of Object.entries(it.max ?? {})) {
      const l = scope === "PersistentVolumeClaim" ? req(res) : lim(res);
      if (l === undefined) errs.push(`maximum ${res} usage per ${scope} is ${max}.  No limit is specified`);
      else if (amount(res, l) > amount(res, max)) errs.push(`maximum ${res} usage per ${scope} is ${max}, but ${scope === "PersistentVolumeClaim" ? "request" : "limit"} is ${l}`);
    }
    for (const [res, ratio] of Object.entries(it.maxLimitRequestRatio ?? {})) {
      const r = req(res);
      const l = lim(res);
      if (r === undefined || l === undefined) continue;
      const got = amount(res, l) / Math.max(1, amount(res, r));
      if (got > Number(ratio)) errs.push(`${res} max limit to request ratio per ${scope} is ${ratio}, but provided ratio is ${Math.round(got * 1000) / 1000}`);
    }
  }
  return errs;
}

/** LimitRanger's validating half. Throws Forbidden like the API server. */
export function checkLimitRanges(cluster: Cluster, obj: Pod | PersistentVolumeClaim): void {
  const ns = obj.metadata.namespace ?? "default";
  let errs: string[] = [];
  if (obj.kind === "Pod") {
    const pod = obj as Pod;
    const cs: Container[] = [...(pod.spec?.initContainers ?? []), ...(pod.spec?.containers ?? [])];
    for (const c of cs) errs.push(...boundErrors(itemsOf(cluster, ns, "Container"), "Container", (r) => c.resources?.requests?.[r], (r) => c.resources?.limits?.[r]));
    const sum = (key: "requests" | "limits", res: string) => {
      const vals = (pod.spec?.containers ?? []).map((c) => c.resources?.[key]?.[res]);
      return vals.some((v) => v === undefined) ? undefined : formatAmount(res, vals.reduce((a, v) => a + amount(res, v), 0));
    };
    errs.push(...boundErrors(itemsOf(cluster, ns, "Pod"), "Pod", (r) => sum("requests", r), (r) => sum("limits", r)));
  } else {
    const pvc = obj as PersistentVolumeClaim;
    errs = boundErrors(itemsOf(cluster, ns, "PersistentVolumeClaim"), "PersistentVolumeClaim", (r) => pvc.spec?.resources?.requests?.[r], () => undefined);
  }
  if (errs.length) throw new ApiError(`Error from server (Forbidden): ${KINDS[obj.kind].plural} "${obj.metadata.name}" is forbidden: ${errs.length > 1 ? `[${errs.join(", ")}]` : errs[0]}`, "Forbidden");
}

// ---------------------------------------------------------------- Priority

/** Classes every cluster has (the API server creates them). */
export const SYSTEM_PRIORITY_CLASSES: { name: string; value: number; description: string }[] = [
  { name: "system-node-critical", value: 2000001000, description: "Used for system critical pods that must not be moved from their current node." },
  { name: "system-cluster-critical", value: 2000000000, description: "Used for system critical pods that must run in the cluster, but can be moved to another node if necessary." },
];

/** The Priority admission plugin: resolve priorityClassName (or the global default) into spec.priority. */
export function resolvePriority(cluster: Cluster, pod: Pod): void {
  const spec = pod.spec!;
  const name = spec.priorityClassName;
  let pc: PriorityClass | undefined;
  if (name) {
    pc = cluster.raw("PriorityClass", undefined, name) as unknown as PriorityClass | undefined;
    if (!pc) {
      const sys = SYSTEM_PRIORITY_CLASSES.find((x) => x.name === name);
      if (sys) pc = { apiVersion: "scheduling.k8s.io/v1", kind: "PriorityClass", metadata: { name, uid: "", resourceVersion: "", creationTimestamp: 0 }, value: sys.value } as PriorityClass;
    }
    if (!pc) throw new ApiError(`Error from server (Forbidden): pods "${pod.metadata.name}" is forbidden: no PriorityClass with name ${name} was found`, "Forbidden");
  } else {
    pc = cluster.list<PriorityClass>("PriorityClass").filter((x) => x.globalDefault).sort((a, b) => a.value - b.value)[0];
    if (pc) spec.priorityClassName = pc.metadata.name;
  }
  const value = pc?.value ?? 0;
  if (spec.priority !== undefined && spec.priority !== value) {
    throw new ApiError(`Error from server (Forbidden): pods "${pod.metadata.name}" is forbidden: the integer value of priority (${spec.priority}) must not be provided in pod spec; priority admission controller computed ${value} from the given PriorityClass name`, "Forbidden");
  }
  spec.priority = value;
  spec.preemptionPolicy ??= pc?.preemptionPolicy ?? "PreemptLowerPriority";
}

// ---------------------------------------------------------------- ResourceQuota

const COUNTED: Record<string, string> = { pods: "Pod", services: "Service", configmaps: "ConfigMap", secrets: "Secret", persistentvolumeclaims: "PersistentVolumeClaim", resourcequotas: "ResourceQuota" };

/** Which kind a quota resource name counts, for count/<resource>[.<group>] and the classic names. */
function countedKind(res: string): string | undefined {
  if (COUNTED[res]) return COUNTED[res];
  const m = res.match(/^count\/([a-z0-9-]+)(?:\.(.+))?$/);
  if (!m) return undefined;
  return Object.values(KINDS).find((k) => k.plural === m[1] && k.group === (m[2] ?? ""))?.kind;
}

const quotaActive = (o: { kind: string; metadata: { deletionTimestamp?: number } }) => o.metadata.deletionTimestamp === undefined && !(o.kind === "Pod" && isPodTerminal(o as unknown as Pod));

/** A Pod's compute usage for a quota resource (cpu/memory mean requests.*). */
function podUsage(pod: Pod, res: string): number | undefined {
  const m = res.match(/^(?:(requests|limits)\.)?(cpu|memory|ephemeral-storage)$/);
  if (!m) return undefined;
  const key = (m[1] ?? "requests") as "requests" | "limits";
  return (pod.spec?.containers ?? []).reduce((a, c) => a + amount(m[2], c.resources?.[key]?.[m[2]]), 0);
}

/** Current usage of one quota resource in a namespace. */
function usage(cluster: Cluster, ns: string, res: string): number {
  const kind = countedKind(res);
  if (kind) return cluster.list(kind, ns).filter(quotaActive).length;
  if (res === "services.nodeports" || res === "services.loadbalancers") {
    const type = res === "services.nodeports" ? ["NodePort", "LoadBalancer"] : ["LoadBalancer"];
    return cluster.list<Service>("Service", ns).filter((s) => type.includes(s.spec?.type ?? "")).length;
  }
  if (res === "requests.storage") return cluster.list<PersistentVolumeClaim>("PersistentVolumeClaim", ns).filter(quotaActive).reduce((a, p) => a + bytes(p.spec?.resources?.requests?.storage), 0);
  return cluster.list<Pod>("Pod", ns).filter(quotaActive).reduce((a, p) => a + (podUsage(p, res) ?? 0), 0);
}

/** What creating this object would add to a quota resource. */
function delta(obj: { kind: string; spec?: unknown }, res: string): number {
  const kind = countedKind(res);
  if (kind) return kind === obj.kind ? 1 : 0;
  if (obj.kind === "Service" && (res === "services.nodeports" || res === "services.loadbalancers")) {
    const t = (obj.spec as { type?: string } | undefined)?.type ?? "";
    return (res === "services.nodeports" ? ["NodePort", "LoadBalancer"] : ["LoadBalancer"]).includes(t) ? 1 : 0;
  }
  if (obj.kind === "PersistentVolumeClaim" && res === "requests.storage") return bytes((obj as unknown as PersistentVolumeClaim).spec?.resources?.requests?.storage);
  if (obj.kind === "Pod") return podUsage(obj as unknown as Pod, res) ?? 0;
  return 0;
}

/** The ResourceQuota admission plugin, run last on create. Throws Forbidden like the API server. */
export function checkQuota(cluster: Cluster, obj: { kind: string; metadata: { name: string; namespace?: string }; spec?: unknown }): void {
  const ns = obj.metadata.namespace;
  if (!ns) return;
  const quotas = cluster.list<ResourceQuota>("ResourceQuota", ns);
  if (!quotas.length) return;
  const plural = KINDS[obj.kind]?.plural ?? obj.kind.toLowerCase() + "s";
  for (const q of quotas) {
    const hard = q.spec?.hard ?? {};
    // A quota on compute resources makes every container say how much it wants.
    if (obj.kind === "Pod") {
      const missing: string[] = [];
      for (const res of Object.keys(hard).sort()) {
        const m = res.match(/^(?:(requests|limits)\.)?(cpu|memory)$/);
        if (!m) continue;
        const key = (m[1] ?? "requests") as "requests" | "limits";
        const lacking = ((obj.spec as Pod["spec"])?.containers ?? []).filter((c) => c.resources?.[key]?.[m[2]] === undefined).map((c) => c.name);
        if (lacking.length) missing.push(`${key}.${m[2]} for: ${lacking.join(",")}`);
      }
      if (missing.length) throw new ApiError(`Error from server (Forbidden): ${plural} "${obj.metadata.name}" is forbidden: failed quota: ${q.metadata.name}: must specify ${[...new Set(missing)].join("; ")}`, "Forbidden");
    }
    const over = Object.keys(hard)
      .sort()
      .map((res) => ({ res, add: delta(obj, res), used: usage(cluster, ns, res), limit: amount(res, hard[res]) }))
      .filter((x) => x.add > 0 && x.used + x.add > x.limit);
    if (over.length) {
      const list = (f: (x: (typeof over)[number]) => number) => over.map((x) => `${x.res}=${formatAmount(x.res, f(x))}`).join(",");
      throw new ApiError(
        `Error from server (Forbidden): ${plural} "${obj.metadata.name}" is forbidden: exceeded quota: ${q.metadata.name}, requested: ${list((x) => x.add)}, used: ${list((x) => x.used)}, limited: ${over.map((x) => `${x.res}=${hard[x.res]}`).join(",")}`,
        "Forbidden",
      );
    }
  }
}

/** resourcequota-controller: keep status.hard and status.used current. */
export function runQuotaController(cluster: Cluster): void {
  for (const q of cluster.list<ResourceQuota>("ResourceQuota")) {
    const ns = q.metadata.namespace!;
    const hard = q.spec?.hard ?? {};
    const used = Object.fromEntries(Object.keys(hard).map((res) => [res, formatAmount(res, usage(cluster, ns, res))]));
    cluster.updateStatus(q, (x) => {
      x.status = { hard: { ...hard }, used };
    });
  }
}

// ---------------------------------------------------------------- PodDisruptionBudget

type Scalable = KubeObject<string, { replicas?: number }>;

/** The workload scale behind a set of Pods (for percentages and maxUnavailable). */
function expectedScale(cluster: Cluster, pods: Pod[]): number {
  const seen = new Map<string, number>();
  for (const p of pods) {
    const ref = p.metadata.ownerReferences?.find((r) => r.controller);
    if (!ref) continue;
    let owner = cluster.list<Scalable>(ref.kind, p.metadata.namespace).find((o) => o.metadata.uid === ref.uid);
    // A ReplicaSet owned by a Deployment: the Deployment's scale is what counts.
    const up = owner?.metadata.ownerReferences?.find((r) => r.controller && r.kind === "Deployment");
    if (up) owner = cluster.list<Scalable>("Deployment", p.metadata.namespace).find((o) => o.metadata.uid === up.uid) ?? owner;
    if (owner) seen.set(owner.metadata.uid, owner.spec?.replicas ?? 1);
  }
  return [...seen.values()].reduce((a, n) => a + n, 0);
}

/** disruption-controller: expectedPods, currentHealthy, desiredHealthy, disruptionsAllowed. */
export function runDisruptionController(cluster: Cluster): void {
  for (const pdb of cluster.list<PodDisruptionBudget>("PodDisruptionBudget")) {
    const ns = pdb.metadata.namespace!;
    const pods = cluster.list<Pod>("Pod", ns).filter((p) => !isPodTerminal(p) && matchesSelector(p.metadata.labels, pdb.spec?.selector));
    const healthy = pods.filter((p) => p.metadata.deletionTimestamp === undefined && isPodReady(p)).length;
    const min = pdb.spec?.minAvailable;
    const max = pdb.spec?.maxUnavailable;
    let expected = pods.length;
    let desired = 0;
    if (min !== undefined && typeof min === "number") desired = min;
    else {
      expected = expectedScale(cluster, pods) || pods.length;
      if (min !== undefined) desired = intOrPercent(min, expected, true, "0");
      else if (max !== undefined) desired = Math.max(0, expected - intOrPercent(max, expected, true, "0"));
    }
    const allowed = Math.max(0, healthy - desired);
    const cond = { type: "DisruptionAllowed", status: allowed > 0 ? "True" : "False", reason: allowed > 0 ? "SufficientPods" : "InsufficientPods", message: "", observedGeneration: pdb.metadata.generation, lastTransitionTime: cluster.now };
    const prev = pdb.status?.conditions?.find((c) => c.type === "DisruptionAllowed");
    if (prev && prev.status === cond.status) cond.lastTransitionTime = prev.lastTransitionTime ?? cluster.now;
    cluster.updateStatus(pdb, (x) => {
      x.status = { observedGeneration: pdb.metadata.generation, disruptionsAllowed: allowed, currentHealthy: healthy, desiredHealthy: desired, expectedPods: expected, conditions: [cond as never] };
    });
  }
}

/** The Eviction API (what kubectl drain calls): refuse if a PodDisruptionBudget has no disruptions left. */
export function evictPod(cluster: Cluster, pod: Pod): { ok: true } | { ok: false; message: string } {
  const ns = pod.metadata.namespace ?? "default";
  const pdbs = cluster.list<PodDisruptionBudget>("PodDisruptionBudget", ns).filter((b) => matchesSelector(pod.metadata.labels, b.spec?.selector));
  if (pdbs.length > 1) return { ok: false, message: "This pod has more than one PodDisruptionBudget, which the eviction subresource does not support." };
  const pdb = pdbs[0];
  // Pods that aren't Ready don't count toward the budget, so evicting them is always allowed (IfHealthyBudget).
  if (pdb && isPodReady(pod) && pod.metadata.deletionTimestamp === undefined) {
    if ((pdb.status?.disruptionsAllowed ?? 0) <= 0) return { ok: false, message: "Cannot evict pod as it would violate the pod's disruption budget." };
    cluster.updateStatus(pdb, (x) => {
      x.status = { ...x.status!, disruptionsAllowed: x.status!.disruptionsAllowed - 1, disruptedPods: { ...x.status?.disruptedPods, [pod.metadata.name]: new Date(cluster.now).toISOString() } };
    });
  }
  cluster.deleteObject(pod);
  return { ok: true };
}
