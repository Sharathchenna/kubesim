// default-scheduler: filters Nodes in the default plugin order (NodeUnschedulable,
// TaintToleration, NodeAffinity, NodeResourcesFit, VolumeBinding, PodTopologySpread,
// InterPodAffinity), scores the rest (spread replicas of one owner, least allocated,
// preferred node and pod affinity, ScheduleAnyway spread), and when nothing fits tries
// preemption (DefaultPreemption): evicting lower-priority Pods from one Node. Messages
// follow the scheduler framework plugins (behaviour reference §5, v2 §2 and §5).

import type { Cluster } from "../cluster";
import { controllerOf, isPodTerminal } from "../cluster";
import { nodeAllocatable, podRequests, type Resources } from "../quantity";
import type { Namespace, Node, NodeSelectorTerm, PersistentVolume, PersistentVolumeClaim, Pod, PodAffinityTerm, StorageClass, Taint, Toleration, TopologySpreadConstraint } from "../types";
import { matchesLabelSelector } from "../util";

const RETRY_MS = 5_000;
export const SELECTED_NODE = "volume.kubernetes.io/selected-node";
const DEFAULT_SCHEDULER = "default-scheduler";

export function tolerates(tols: Toleration[] | undefined, t: Taint): boolean {
  return (tols ?? []).some((tol) => {
    if (tol.effect && tol.effect !== t.effect) return false;
    if (tol.operator === "Exists") return !tol.key || tol.key === t.key;
    return tol.key === t.key && (tol.value ?? "") === (t.value ?? "");
  });
}

/** Does a Node match one nodeSelectorTerm (matchExpressions on labels, matchFields on metadata.name)? */
export function termMatches(node: Node, term: NodeSelectorTerm): boolean {
  const labels = node.metadata.labels ?? {};
  for (const e of term.matchExpressions ?? []) {
    const v = labels[e.key];
    const has = e.key in labels;
    if (e.operator === "In" && !(has && e.values?.includes(v))) return false;
    if (e.operator === "NotIn" && has && e.values?.includes(v)) return false;
    if (e.operator === "Exists" && !has) return false;
    if (e.operator === "DoesNotExist" && has) return false;
    if (e.operator === "Gt" && !(has && parseInt(v, 10) > parseInt(e.values?.[0] ?? "0", 10))) return false;
    if (e.operator === "Lt" && !(has && parseInt(v, 10) < parseInt(e.values?.[0] ?? "0", 10))) return false;
  }
  for (const f of term.matchFields ?? []) {
    if (f.key !== "metadata.name") return false;
    const ok = f.values?.includes(node.metadata.name) ?? false;
    if ((f.operator === "In" && !ok) || (f.operator === "NotIn" && ok)) return false;
  }
  return true;
}

/** nodeSelector and required node affinity (terms are ORed). */
export function nodeAffinityOk(pod: Pod, node: Node): boolean {
  const sel = pod.spec?.nodeSelector ?? {};
  if (Object.entries(sel).some(([k, v]) => node.metadata.labels?.[k] !== v)) return false;
  const req = pod.spec?.affinity?.nodeAffinity?.requiredDuringSchedulingIgnoredDuringExecution;
  if (req && req.nodeSelectorTerms.length && !req.nodeSelectorTerms.some((t) => termMatches(node, t))) return false;
  return true;
}

const untoleratedTaint = (pod: Pod, n: Node) => (n.spec?.taints ?? []).some((t) => (t.effect === "NoSchedule" || t.effect === "NoExecute") && !tolerates(pod.spec?.tolerations, t));

// ---------------------------------------------------------------- snapshot

/** The scheduler's cache for one pass: bound, non-terminal Pods by Node and their summed requests. Updated as Pods are bound. */
class Snapshot {
  byNode = new Map<string, Pod[]>();
  requested = new Map<string, Resources>();
  nsLabels = new Map<string, Record<string, string>>();
  constructor(cluster: Cluster, pods: Pod[]) {
    for (const p of pods) if (p.spec?.nodeName && !isPodTerminal(p)) this.add(p);
    for (const ns of cluster.list<Namespace>("Namespace")) this.nsLabels.set(ns.metadata.name, ns.metadata.labels ?? {});
  }
  add(p: Pod): void {
    const n = p.spec!.nodeName!;
    (this.byNode.get(n) ?? this.byNode.set(n, []).get(n)!).push(p);
    const r = podRequests(p.spec);
    const cur = this.requested.get(n) ?? { cpu: 0, memory: 0 };
    this.requested.set(n, { cpu: cur.cpu + r.cpu, memory: cur.memory + r.memory });
  }
  podsOn(n: string): Pod[] {
    return this.byNode.get(n) ?? [];
  }
  /** A copy of this snapshot without some Pods (for trying preemption). */
  without(gone: Set<string>): Snapshot {
    const s = Object.create(Snapshot.prototype) as Snapshot;
    s.byNode = new Map();
    s.requested = new Map();
    s.nsLabels = this.nsLabels;
    for (const ps of this.byNode.values()) for (const p of ps) if (!gone.has(p.metadata.uid)) s.add(p);
    return s;
  }
}

export function runScheduler(cluster: Cluster): void {
  const pods = cluster.list<Pod>("Pod");
  // Pods for another scheduler (spec.schedulerName) stay Pending: nothing here binds them.
  const pending = pods.filter((p) => !p.spec?.nodeName && p.metadata.deletionTimestamp === undefined && !isPodTerminal(p) && (p.spec?.schedulerName ?? DEFAULT_SCHEDULER) === DEFAULT_SCHEDULER);
  if (pending.length === 0) {
    cluster.schedulerWake = false;
    return;
  }
  const nodes = cluster.list<Node>("Node");
  // Highest priority first, then oldest, like the scheduling queue.
  pending.sort((a, b) => (b.spec?.priority ?? 0) - (a.spec?.priority ?? 0) || a.metadata.creationTimestamp - b.metadata.creationTimestamp);
  const snap = new Snapshot(cluster, pods);
  for (const pod of pending) {
    const uid = pod.metadata.uid;
    const nextTry = cluster.state.scheduleAttempts[uid];
    if (nextTry !== undefined && cluster.now < nextTry && !cluster.schedulerWake) continue;
    schedule(cluster, pod, nodes, snap);
  }
  cluster.schedulerWake = false;
}

/** Volume checks before looking at Nodes: every claim must exist, and Immediate claims must be bound. */
function volumePreFilter(cluster: Cluster, pod: Pod): string | undefined {
  const ns = pod.metadata.namespace ?? "default";
  for (const v of pod.spec?.volumes ?? []) {
    if (!v.persistentVolumeClaim) continue;
    const pvc = cluster.raw("PersistentVolumeClaim", ns, v.persistentVolumeClaim.claimName) as unknown as PersistentVolumeClaim | undefined;
    if (!pvc) return `persistentvolumeclaim "${v.persistentVolumeClaim.claimName}" not found`;
    if (pvc.metadata.deletionTimestamp !== undefined) return `persistentvolumeclaim "${pvc.metadata.name}" is being deleted`;
    if (pvc.status?.phase === "Bound") continue;
    const sc = pvc.spec?.storageClassName ? (cluster.raw("StorageClass", undefined, pvc.spec.storageClassName) as unknown as StorageClass | undefined) : undefined;
    if (sc?.volumeBindingMode !== "WaitForFirstConsumer") return "pod has unbound immediate PersistentVolumeClaims";
  }
  return undefined;
}

/** A bound PV that only exists on one Node (local-path) pins the Pod there. */
function volumeNodeOk(cluster: Cluster, pod: Pod, node: Node): boolean {
  const ns = pod.metadata.namespace ?? "default";
  for (const v of pod.spec?.volumes ?? []) {
    if (!v.persistentVolumeClaim) continue;
    const pvc = cluster.raw("PersistentVolumeClaim", ns, v.persistentVolumeClaim.claimName) as unknown as PersistentVolumeClaim | undefined;
    if (!pvc?.spec?.volumeName) continue;
    const pv = cluster.raw("PersistentVolume", undefined, pvc.spec.volumeName) as unknown as PersistentVolume | undefined;
    const terms = pv?.spec?.nodeAffinity?.required?.nodeSelectorTerms;
    if (terms?.length && !terms.some((t) => termMatches(node, t))) return false;
  }
  return true;
}

// ---------------------------------------------------------------- inter-pod affinity

/** Does `other` fall under an affinity term written by `owner` (namespaces default to the owner's)? */
function termSelects(snap: Snapshot, owner: Pod, term: PodAffinityTerm, other: Pod): boolean {
  const ns = other.metadata.namespace ?? "default";
  const own = owner.metadata.namespace ?? "default";
  const names = term.namespaces ?? [];
  let nsOk: boolean;
  if (term.namespaceSelector) nsOk = names.includes(ns) || matchesLabelSelector(snap.nsLabels.get(ns), term.namespaceSelector);
  else nsOk = names.length ? names.includes(ns) : ns === own;
  return nsOk && matchesLabelSelector(other.metadata.labels, term.labelSelector);
}

const domainOf = (n: Node, key: string) => n.metadata.labels?.[key];

/** Pods (on any Node) in the same topology domain as `node` for `key`. */
function podsInDomain(snap: Snapshot, nodes: Node[], node: Node, key: string): Pod[] {
  const v = domainOf(node, key);
  if (v === undefined) return [];
  const out: Pod[] = [];
  for (const n of nodes) if (domainOf(n, key) === v) out.push(...snap.podsOn(n.metadata.name));
  return out;
}

/** InterPodAffinity Filter. Returns the failure reason and whether preemption could help. */
function interPodAffinity(snap: Snapshot, nodes: Node[], pod: Pod, node: Node): { reason: string; resolvable: boolean } | undefined {
  const aff = pod.spec?.affinity?.podAffinity?.requiredDuringSchedulingIgnoredDuringExecution ?? [];
  if (aff.length) {
    let exist = true;
    for (const t of aff) {
      if (domainOf(node, t.topologyKey) === undefined) return { reason: "node(s) didn't match pod affinity rules", resolvable: false };
      if (!podsInDomain(snap, nodes, node, t.topologyKey).some((p) => p.metadata.deletionTimestamp === undefined && termSelects(snap, pod, t, p))) exist = false;
    }
    if (!exist) {
      // The first Pod of a group with affinity to itself may go anywhere.
      const anyMatch = [...snap.byNode.values()].some((ps) => ps.some((p) => aff.some((t) => termSelects(snap, pod, t, p))));
      const selfMatch = aff.every((t) => termSelects(snap, pod, t, pod));
      if (anyMatch || !selfMatch) return { reason: "node(s) didn't match pod affinity rules", resolvable: false };
    }
  }
  for (const t of pod.spec?.affinity?.podAntiAffinity?.requiredDuringSchedulingIgnoredDuringExecution ?? []) {
    if (podsInDomain(snap, nodes, node, t.topologyKey).some((p) => termSelects(snap, pod, t, p))) return { reason: "node(s) didn't match pod anti-affinity rules", resolvable: true };
  }
  // Existing Pods' required anti-affinity against this one (symmetry).
  for (const n of nodes) {
    for (const e of snap.podsOn(n.metadata.name)) {
      for (const t of e.spec?.affinity?.podAntiAffinity?.requiredDuringSchedulingIgnoredDuringExecution ?? []) {
        const v = domainOf(n, t.topologyKey);
        if (v !== undefined && domainOf(node, t.topologyKey) === v && termSelects(snap, e, t, pod)) return { reason: "node(s) didn't satisfy existing pods anti-affinity rules", resolvable: true };
      }
    }
  }
  return undefined;
}

/** Preferred pod affinity/anti-affinity score: weight per matching Pod in the Node's domain. */
function interPodScore(snap: Snapshot, nodes: Node[], pod: Pod, node: Node): number {
  let score = 0;
  const pa = pod.spec?.affinity;
  for (const w of pa?.podAffinity?.preferredDuringSchedulingIgnoredDuringExecution ?? []) score += w.weight * podsInDomain(snap, nodes, node, w.podAffinityTerm.topologyKey).filter((p) => termSelects(snap, pod, w.podAffinityTerm, p)).length;
  for (const w of pa?.podAntiAffinity?.preferredDuringSchedulingIgnoredDuringExecution ?? []) score -= w.weight * podsInDomain(snap, nodes, node, w.podAffinityTerm.topologyKey).filter((p) => termSelects(snap, pod, w.podAffinityTerm, p)).length;
  return score;
}

// ---------------------------------------------------------------- topology spread

function spreadSelector(pod: Pod, c: TopologySpreadConstraint) {
  const extra: Record<string, string> = {};
  for (const k of c.matchLabelKeys ?? []) if (pod.metadata.labels?.[k] !== undefined) extra[k] = pod.metadata.labels[k];
  if (!c.labelSelector) return undefined;
  return Object.keys(extra).length ? { ...c.labelSelector, matchLabels: { ...(c.labelSelector.matchLabels ?? {}), ...extra } } : c.labelSelector;
}

/** Matching Pods per topology domain, over the Nodes that count for this constraint. */
function spreadCounts(snap: Snapshot, nodes: Node[], pod: Pod, c: TopologySpreadConstraint): { counts: Map<string, number>; min: number } {
  const sel = spreadSelector(pod, c);
  const counts = new Map<string, number>();
  for (const n of nodes) {
    const v = domainOf(n, c.topologyKey);
    if (v === undefined) continue;
    if ((c.nodeAffinityPolicy ?? "Honor") === "Honor" && !nodeAffinityOk(pod, n)) continue;
    if (c.nodeTaintsPolicy === "Honor" && untoleratedTaint(pod, n)) continue;
    const here = snap.podsOn(n.metadata.name).filter((p) => p.metadata.deletionTimestamp === undefined && p.metadata.namespace === pod.metadata.namespace && !!sel && matchesLabelSelector(p.metadata.labels, sel)).length;
    counts.set(v, (counts.get(v) ?? 0) + here);
  }
  let min = counts.size ? Math.min(...counts.values()) : 0;
  if (c.minDomains !== undefined && counts.size < c.minDomains) min = 0;
  return { counts, min };
}

/** PodTopologySpread Filter for the DoNotSchedule constraints. */
function topologySpread(snap: Snapshot, nodes: Node[], pod: Pod, node: Node): { reason: string; resolvable: boolean } | undefined {
  for (const c of (pod.spec?.topologySpreadConstraints ?? []).filter((x) => x.whenUnsatisfiable === "DoNotSchedule")) {
    const v = domainOf(node, c.topologyKey);
    if (v === undefined) return { reason: "node(s) didn't match pod topology spread constraints (missing required label)", resolvable: false };
    const { counts, min } = spreadCounts(snap, nodes, pod, c);
    const sel = spreadSelector(pod, c);
    const self = sel && matchesLabelSelector(pod.metadata.labels, sel) ? 1 : 0;
    if ((counts.get(v) ?? 0) + self - min > c.maxSkew) return { reason: "node(s) didn't match pod topology spread constraints", resolvable: true };
  }
  return undefined;
}

function spreadScore(snap: Snapshot, nodes: Node[], pod: Pod, node: Node): number {
  let score = 0;
  for (const c of (pod.spec?.topologySpreadConstraints ?? []).filter((x) => x.whenUnsatisfiable === "ScheduleAnyway")) {
    const v = domainOf(node, c.topologyKey);
    if (v === undefined) continue;
    score -= spreadCounts(snap, nodes, pod, c).counts.get(v) ?? 0;
  }
  return score;
}

// ---------------------------------------------------------------- filtering

type Verdict = { ok: true } | { ok: false; reasons: string[]; resolvable: boolean; resources?: boolean };

function filterNode(cluster: Cluster, pod: Pod, n: Node, nodes: Node[], snap: Snapshot): Verdict {
  if (n.spec?.unschedulable && !tolerates(pod.spec?.tolerations, { key: "node.kubernetes.io/unschedulable", effect: "NoSchedule" })) return { ok: false, reasons: ["node(s) were unschedulable"], resolvable: false };
  if (untoleratedTaint(pod, n)) return { ok: false, reasons: ["node(s) had untolerated taint(s)"], resolvable: false };
  if (!nodeAffinityOk(pod, n)) return { ok: false, reasons: ["node(s) didn't match Pod's node affinity/selector"], resolvable: false };
  // NodeResourcesFit reports every resource that doesn't fit.
  const want = podRequests(pod.spec);
  const count = snap.podsOn(n.metadata.name).length;
  const alloc = nodeAllocatable(n);
  const used = snap.requested.get(n.metadata.name) ?? { cpu: 0, memory: 0 };
  const short: string[] = [];
  if (count >= parseInt(n.status?.allocatable.pods ?? "110", 10)) short.push("Too many pods");
  if (want.cpu && used.cpu + want.cpu > alloc.cpu) short.push("Insufficient cpu");
  if (want.memory && used.memory + want.memory > alloc.memory) short.push("Insufficient memory");
  if (short.length) return { ok: false, reasons: short, resolvable: true, resources: true };
  if (!volumeNodeOk(cluster, pod, n)) return { ok: false, reasons: ["node(s) had volume node affinity conflict"], resolvable: false };
  const spread = topologySpread(snap, nodes, pod, n);
  if (spread) return { ok: false, reasons: [spread.reason], resolvable: spread.resolvable };
  const ipa = interPodAffinity(snap, nodes, pod, n);
  if (ipa) return { ok: false, reasons: [ipa.reason], resolvable: ipa.resolvable };
  return { ok: true };
}

function schedule(cluster: Cluster, pod: Pod, nodes: Node[], snap: Snapshot): void {
  const reasons: Record<string, number> = {};
  const preemptable: Node[] = [];
  const fit: Node[] = [];

  const pre = volumePreFilter(cluster, pod);
  if (pre) return unschedulable(cluster, pod, `0/${nodes.length} nodes are available: ${pre}. preemption: 0/${nodes.length} nodes are available: ${nodes.length} Preemption is not helpful for scheduling.`);

  for (const n of nodes) {
    const v = filterNode(cluster, pod, n, nodes, snap);
    if (v.ok) {
      fit.push(n);
      continue;
    }
    for (const r of v.reasons) reasons[r] = (reasons[r] ?? 0) + 1;
    if (v.resolvable) preemptable.push(n);
  }

  if (fit.length === 0) {
    const hist = Object.entries(reasons)
      .map(([r, c]) => `${c} ${r}`)
      .sort()
      .join(", ");
    const head = `0/${nodes.length} nodes are available: ${hist || "no nodes available to schedule pods"}.`;
    const tail = preemptionTail(cluster, pod, nodes, snap, preemptable);
    return unschedulable(cluster, pod, tail === null ? head : `${head} preemption: ${tail}`);
  }

  const owner = controllerOf(pod)?.uid;
  const want = podRequests(pod.spec);
  const scored = fit.map((n) => {
    const onNode = snap.podsOn(n.metadata.name).filter((p) => p.metadata.deletionTimestamp === undefined);
    const siblings = owner ? onNode.filter((p) => controllerOf(p)?.uid === owner).length : 0;
    const alloc = nodeAllocatable(n);
    const used = snap.requested.get(n.metadata.name) ?? { cpu: 0, memory: 0 };
    // NodeResourcesFit LeastAllocated: prefer the emptier Node.
    const load = ((used.cpu + want.cpu) / alloc.cpu + (used.memory + want.memory) / alloc.memory) * 50;
    const preferred = (pod.spec?.affinity?.nodeAffinity?.preferredDuringSchedulingIgnoredDuringExecution ?? []).reduce((a, p) => a + (termMatches(n, p.preference) ? p.weight : 0), 0);
    const score = -siblings * 1000 - onNode.length - load + preferred * 10 + interPodScore(snap, nodes, pod, n) * 20 + spreadScore(snap, nodes, pod, n) * 1500;
    return { n, score, tie: cluster.rng.next() };
  });
  scored.sort((a, b) => b.score - a.score || a.tie - b.tie);
  const node = scored[0].n;
  // WaitForFirstConsumer: tell the provisioner which Node the Pod landed on.
  for (const v of pod.spec?.volumes ?? []) {
    if (!v.persistentVolumeClaim) continue;
    const pvc = cluster.raw("PersistentVolumeClaim", pod.metadata.namespace, v.persistentVolumeClaim.claimName) as unknown as PersistentVolumeClaim | undefined;
    if (pvc && pvc.status?.phase !== "Bound" && !pvc.metadata.annotations?.[SELECTED_NODE]) {
      cluster.update(pvc, (x) => {
        x.metadata.annotations = { ...(x.metadata.annotations ?? {}), [SELECTED_NODE]: node.metadata.name };
      });
    }
  }
  const bound = cluster.update(pod, (p) => {
    p.spec!.nodeName = node.metadata.name;
    p.status ??= { phase: "Pending" };
    delete p.status.nominatedNodeName;
    p.status.conditions = [
      ...(p.status.conditions ?? []).filter((c) => c.type !== "PodScheduled"),
      { type: "PodScheduled", status: "True", lastProbeTime: null, lastTransitionTime: cluster.now },
    ];
  });
  snap.add(bound);
  delete cluster.state.scheduleAttempts[pod.metadata.uid];
  cluster.record(pod, "Normal", "Scheduled", `Successfully assigned ${pod.metadata.namespace}/${pod.metadata.name} to ${node.metadata.name}`, "default-scheduler");
}

// ---------------------------------------------------------------- preemption

/**
 * DefaultPreemption PostFilter. Finds the Node where evicting the fewest, lowest-priority
 * Pods lets this one fit, evicts them and nominates the Node. Returns the `preemption: …`
 * text for the FailedScheduling message, or null when victims were chosen (then the
 * message has no preemption part).
 */
function preemptionTail(cluster: Cluster, pod: Pod, nodes: Node[], snap: Snapshot, candidates: Node[]): string | null {
  const n = nodes.length;
  const notHelpful = n - candidates.length;
  const generic = () => {
    const parts = [notHelpful ? `${notHelpful} Preemption is not helpful for scheduling` : "", candidates.length ? `${candidates.length} No preemption victims found for incoming pod` : ""].filter(Boolean).sort();
    return `0/${n} nodes are available: ${parts.join(", ") || `${n} Preemption is not helpful for scheduling`}.`;
  };
  if ((pod.spec?.preemptionPolicy ?? "PreemptLowerPriority") === "Never") return "not eligible due to preemptionPolicy=Never.";
  const nominated = pod.status?.nominatedNodeName;
  if (nominated && snap.podsOn(nominated).some((p) => p.metadata.deletionTimestamp !== undefined && (p.spec?.priority ?? 0) < (pod.spec?.priority ?? 0))) {
    return "not eligible due to a terminating pod on the nominated node.";
  }
  const prio = pod.spec?.priority ?? 0;
  type Plan = { node: Node; victims: Pod[] };
  const plans: Plan[] = [];
  for (const node of candidates) {
    const lower = snap
      .podsOn(node.metadata.name)
      .filter((p) => p.metadata.deletionTimestamp === undefined && (p.spec?.priority ?? 0) < prio && p.metadata.annotations?.["kubernetes.io/config.source"] !== "file");
    if (!lower.length) continue;
    const gone = new Set(lower.map((p) => p.metadata.uid));
    if (!filterNode(cluster, pod, node, nodes, snap.without(gone)).ok) continue;
    // Reprieve as many as possible, highest priority first.
    for (const v of [...lower].sort((a, b) => (b.spec?.priority ?? 0) - (a.spec?.priority ?? 0) || b.metadata.creationTimestamp - a.metadata.creationTimestamp)) {
      gone.delete(v.metadata.uid);
      if (!filterNode(cluster, pod, node, nodes, snap.without(gone)).ok) gone.add(v.metadata.uid);
    }
    plans.push({ node, victims: lower.filter((p) => gone.has(p.metadata.uid)) });
  }
  if (!plans.length) return generic();
  const maxP = (p: Plan) => Math.max(...p.victims.map((v) => v.spec?.priority ?? 0));
  const sumP = (p: Plan) => p.victims.reduce((a, v) => a + (v.spec?.priority ?? 0), 0);
  plans.sort((a, b) => maxP(a) - maxP(b) || sumP(a) - sumP(b) || a.victims.length - b.victims.length || (a.node.metadata.name < b.node.metadata.name ? -1 : 1));
  const { node, victims } = plans[0];
  for (const v of victims) {
    const cur = cluster.get<Pod>("Pod", v.metadata.namespace, v.metadata.name);
    const marked = cluster.update(cur, (d) => {
      d.status!.conditions = [
        ...(d.status?.conditions ?? []).filter((c) => c.type !== "DisruptionTarget"),
        { type: "DisruptionTarget", status: "True", lastProbeTime: null, lastTransitionTime: cluster.now, reason: "PreemptionByScheduler", message: `${DEFAULT_SCHEDULER}: preempting to accommodate a higher priority pod` },
      ];
    });
    cluster.record(marked, "Normal", "Preempted", `Preempted by pod ${pod.metadata.uid} on node ${node.metadata.name}`, "default-scheduler");
    cluster.deleteObject(marked);
  }
  cluster.updateStatus(cluster.get<Pod>("Pod", pod.metadata.namespace, pod.metadata.name), (p) => void (p.status = { ...(p.status ?? { phase: "Pending" }), nominatedNodeName: node.metadata.name }));
  return null;
}

function unschedulable(cluster: Cluster, pod: Pod, msg: string): void {
  const cur = cluster.get<Pod>("Pod", pod.metadata.namespace, pod.metadata.name);
  cluster.update(cur, (p) => {
    p.status ??= { phase: "Pending" };
    p.status.conditions = [
      ...(p.status.conditions ?? []).filter((c) => c.type !== "PodScheduled"),
      { type: "PodScheduled", status: "False", lastProbeTime: null, lastTransitionTime: cluster.now, reason: "Unschedulable", message: msg },
    ];
    // Keep the old transition time if nothing changed.
    const old = cur.status?.conditions?.find((c) => c.type === "PodScheduled");
    if (old && old.message === msg) p.status.conditions[p.status.conditions.length - 1].lastTransitionTime = old.lastTransitionTime;
  });
  cluster.record(pod, "Warning", "FailedScheduling", msg, "default-scheduler");
  cluster.state.scheduleAttempts[pod.metadata.uid] = cluster.now + RETRY_MS;
}
