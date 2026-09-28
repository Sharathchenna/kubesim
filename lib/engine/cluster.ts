// The Simulated Cluster: an in-memory API server (store + admission +
// validation), a simulated clock, and controllers that reconcile on each step.
// All state is plain JSON so a cluster can be snapshotted and restored.

import type { Program } from "./images";
import {
  API_VERSIONS,
  NAMESPACED_KINDS,
  type AnyObject,
  type KubeEvent,
  type KubeObject,
  type Node,
  type Pod,
  type NewObject,
} from "./types";
import { resourceName } from "./kinds";
import { admit } from "./admission";
import { validate } from "./validation";
import { clone, deepEqual, Rng, randSuffix, SIM_EPOCH } from "./util";
import { runKubelets } from "./controllers/kubelet";
import { runScheduler } from "./controllers/scheduler";
import { runReplicaSets } from "./controllers/replicaset";
import { runDeployments } from "./controllers/deployment";
import { runStatefulSets } from "./controllers/statefulset";
import { runDaemonSets } from "./controllers/daemonset";
import { runJobs } from "./controllers/job";
import { runCronJobs } from "./controllers/cronjob";
import { runHPAs } from "./controllers/hpa";
import { runMetrics, type MetricsState } from "./controllers/metrics";
import { runStorage } from "./controllers/storage";
import { runNetworkControllers, ensureNamespaceDefaults } from "./controllers/network";
import { runNodeLifecycle } from "./controllers/node-lifecycle";
import { runEndpoints } from "./controllers/endpoints";
import { runGarbageCollector } from "./controllers/gc";
import { checkQuota, runDisruptionController, runQuotaController } from "./policy";
import { bootstrap } from "./bootstrap";

export { resourceName };

export const STEP_MS = 100;

export interface NodeConfig {
  name: string;
  role: "control-plane" | "worker";
}

export interface ClusterConfig {
  seed: number;
  nodes: NodeConfig[];
  /** How long without heartbeats before a Node goes NotReady (kube default 50s). */
  nodeMonitorGracePeriodMs: number;
  /** Default tolerationSeconds for not-ready/unreachable taints (kube default 300s). */
  defaultTolerationSeconds: number;
  /** Include kube-system Pods (etcd, apiserver, coredns, kube-proxy…). */
  systemPods: boolean;
}

export const DEFAULT_CONFIG: ClusterConfig = {
  seed: 42,
  nodes: [
    { name: "control-plane", role: "control-plane" },
    { name: "worker-1", role: "worker" },
    { name: "worker-2", role: "worker" },
  ],
  nodeMonitorGracePeriodMs: 50_000,
  defaultTolerationSeconds: 300,
  systemPods: true,
};

export type ContainerPhase =
  | "pulling"
  | "pullError" // shows ErrImagePull
  | "pullBackoff" // shows ImagePullBackOff
  | "configError" // shows CreateContainerConfigError
  | "creating"
  | "running"
  | "exited" // shows terminated (Error/Completed) briefly
  | "crashBackoff" // shows CrashLoopBackOff
  | "done" // terminated for good (restartPolicy says so)
  | "stopping"
  | "dead"; // killed with its Node; status is stale until the Node returns

export interface ContainerRuntime {
  phase: ContainerPhase;
  until: number;
  image: string;
  backoffMs: number;
  program?: Program;
  pc: number;
  wakeAt: number;
  startedAt?: number;
  exitCode?: number;
  exitReason?: string;
  exitMessage?: string;
  pullStartedAt?: number;
  /** Times this container has been restarted (status.restartCount). */
  restarts: number;
  /** Previous termination, shown as lastState. */
  lastTerm?: { exitCode: number; reason: string; startedAt?: number; finishedAt: number; message?: string };
  /** When the last container run started (for back-off reset). */
  lastRunStart?: number;
  /** Set once "Started" etc. have fired for this run. */
  announced?: boolean;
  /** Resolved environment for this run. */
  env?: Record<string, string>;
  /** The container's writable layer: path → content. Reset on every restart. */
  fs?: Record<string, string>;
  /** Exit code of the last command the program ran (for && and ||). */
  lastCode?: number;
  /** Memory the program allocated, CPU it burns (millicores), requests served recently (sim ms). */
  alloc?: number;
  burn?: number;
  reqs?: number[];
  /** Readiness as the prober sees it; startup probe passed. */
  ready?: boolean;
  started?: boolean;
  probes?: { startup?: ProbeState; liveness?: ProbeState; readiness?: ProbeState };
  /** Being killed by a failed probe: exits at this time. */
  killAt?: number;
}

export interface ProbeState {
  next: number;
  ok: number;
  fail: number;
}

export interface PodRuntime {
  containers: Record<string, ContainerRuntime>;
  stoppingUntil?: number;
  /** Sandbox is ready (IP assigned) from this time. */
  sandboxAt: number;
  killingAnnounced?: boolean;
  /** Volumes were mounted at this time. */
  mountedAt?: number;
  mountRetryAt?: number;
  /** ConfigMap/Secret volume contents as the kubelet last projected them. */
  projected?: Record<string, Record<string, string>>;
  projectedAt?: number;
  subPaths?: Record<string, Record<string, string>>;
}

export interface NodeRuntime {
  up: boolean;
  lastHeartbeat: number;
  images: string[];
  nextPodIp: number;
  index: number;
  /** When the kubelet first reports Ready after registering. */
  readyAt: number;
}

export interface LogLine {
  t: number;
  text: string;
}

export interface ClusterState {
  config: ClusterConfig;
  now: number;
  rng: number;
  rv: number;
  objects: Record<string, AnyObject>;
  pods: Record<string, PodRuntime>;
  nodes: Record<string, NodeRuntime>;
  /** Logs keyed by `${podUid}/${container}/${restartCount}`. */
  logs: Record<string, LogLine[]>;
  nextClusterIp: number;
  scheduleAttempts: Record<string, number>;
  accum: number;
  /** Data in volumes (emptyDir, PersistentVolumes, hostPath): store key → path → content. */
  volumes: Record<string, Record<string, string>>;
  /** metrics-server's last scrape. */
  metrics: MetricsState;
  /** HPA recommendation history, by HPA uid. */
  hpa: Record<string, { recs: { t: number; n: number }[] }>;
  /** Controller timers and one-shot markers: key → sim ms. */
  timers: Record<string, number>;
  lbNext: number;
  eventSeq: number;
}

export type ClusterSignal =
  | { type: "change" }
  | { type: "event"; event: KubeEvent }
  | { type: "traffic"; serviceUid?: string; ingressUid?: string; podUid: string; fromUid?: string; nodeName?: string; ok: boolean; blocked?: boolean; via: "clusterip" | "nodeport" | "lb" | "ingress" | "pod" };

export class ApiError extends Error {
  constructor(
    message: string,
    public reason: "NotFound" | "AlreadyExists" | "Invalid" | "BadRequest" | "Forbidden" | "Conflict",
  ) {
    super(message);
  }
}

export function objKey(kind: string, namespace: string | undefined, name: string): string {
  return `${kind}/${NAMESPACED_KINDS.has(kind) ? (namespace ?? "default") : ""}/${name}`;
}

export interface DeleteOptions {
  gracePeriodSeconds?: number;
  force?: boolean;
  /** Orphan leaves dependents running with this owner's reference removed (kubectl delete --cascade=orphan). */
  propagationPolicy?: "Background" | "Foreground" | "Orphan";
}

export class Cluster {
  state: ClusterState;
  rng: Rng;
  private listeners = new Set<(s: ClusterSignal) => void>();
  /** kind → store keys, so list() doesn't scan every object. Derived; not part of snapshots. */
  private byKind = new Map<string, Set<string>>();
  private index(): Map<string, Set<string>> {
    if (this.byKind.size === 0 && Object.keys(this.state.objects).length) {
      for (const [key, o] of Object.entries(this.state.objects)) (this.byKind.get(o.kind) ?? this.byKind.set(o.kind, new Set()).get(o.kind)!).add(key);
    }
    return this.byKind;
  }
  private changed = false;
  /** Bumped whenever anything observable changes; handy for React. */
  version = 0;
  /** Set when cluster changes may let unschedulable Pods fit; the scheduler retries at once. */
  schedulerWake = false;

  constructor(configOrState?: Partial<ClusterConfig> | ClusterState) {
    if (configOrState && "objects" in configOrState) {
      this.state = clone(configOrState);
      // Snapshots from before these fields existed.
      this.state.volumes ??= {};
      this.state.metrics ??= { at: 0, pods: {}, nodes: {} };
      this.state.hpa ??= {};
      this.state.timers ??= {};
      this.state.lbNext ??= 0;
      this.state.eventSeq ??= 0;
      this.rng = new Rng(this.state.rng);
    } else {
      const config = { ...DEFAULT_CONFIG, ...(configOrState ?? {}) };
      this.state = {
        config,
        now: 0,
        rng: config.seed,
        rv: 1000,
        objects: {},
        pods: {},
        nodes: {},
        logs: {},
        nextClusterIp: 1,
        scheduleAttempts: {},
        accum: 0,
        volumes: {},
        metrics: { at: 0, pods: {}, nodes: {} },
        hpa: {},
        timers: {},
        lbNext: 0,
        eventSeq: 0,
      };
      this.rng = new Rng(config.seed);
      bootstrap(this);
      // Let system Pods come up before the Learner arrives.
      this.advance(config.systemPods ? 30_000 : 5_000);
      this.state.now = Math.max(this.state.now, 0);
    }
  }

  get now(): number {
    return this.state.now;
  }

  // ---------- signals ----------

  subscribe(fn: (s: ClusterSignal) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(s: ClusterSignal): void {
    for (const l of this.listeners) l(s);
  }

  private flush(): void {
    if (this.changed) {
      this.changed = false;
      this.version++;
      this.emit({ type: "change" });
    }
  }

  // ---------- time ----------

  /** Advances simulated time by `ms`, running controllers every STEP_MS. */
  tick(ms: number): void {
    this.state.accum += ms;
    while (this.state.accum >= STEP_MS) {
      this.state.accum -= STEP_MS;
      this.step();
    }
    this.flush();
  }

  /** Advances time without emitting per-step signals (setup, tests). */
  advance(ms: number): void {
    const steps = Math.round(ms / STEP_MS);
    for (let i = 0; i < steps; i++) this.step();
    this.flush();
  }

  private step(): void {
    this.state.now += STEP_MS;
    runKubelets(this);
    runNodeLifecycle(this);
    runStorage(this);
    runScheduler(this);
    runEndpoints(this);
    runReplicaSets(this);
    runDeployments(this);
    runStatefulSets(this);
    runDaemonSets(this);
    runJobs(this);
    runCronJobs(this);
    runMetrics(this);
    runHPAs(this);
    runNetworkControllers(this);
    runDisruptionController(this);
    if (this.state.now % 1000 === 0) runQuotaController(this);
    // The garbage collector works from an informer cache in real clusters; every 500ms is plenty.
    if (this.state.now % 500 === 0) runGarbageCollector(this);
    this.state.rng = this.rng.state;
  }

  // ---------- raw store ----------

  uid(): string {
    const h = () => this.rng.int(0x10000).toString(16).padStart(4, "0");
    return `${h()}${h()}-${h()}-4${h().slice(1)}-a${h().slice(1)}-${h()}${h()}${h()}`;
  }

  genName(prefix: string): string {
    return `${prefix}${randSuffix(this.rng)}`;
  }

  raw(kind: string, namespace: string | undefined, name: string): AnyObject | undefined {
    return this.state.objects[objKey(kind, namespace, name)];
  }

  list<T extends KubeObject = AnyObject>(kind: string, namespace?: string): T[] {
    const out: T[] = [];
    for (const key of this.index().get(kind) ?? []) {
      const o = this.state.objects[key];
      if (!o) continue;
      if (namespace !== undefined && NAMESPACED_KINDS.has(kind) && o.metadata.namespace !== namespace) continue;
      out.push(o as unknown as T);
    }
    // Byte order, like Go's sort of names.
    return out.sort((a, b) => (a.metadata.name < b.metadata.name ? -1 : a.metadata.name > b.metadata.name ? 1 : 0));
  }

  byUid(uid: string): AnyObject | undefined {
    for (const o of Object.values(this.state.objects)) if (o.metadata.uid === uid) return o;
    return undefined;
  }

  /** Stores an object if it differs from what's stored; bumps resourceVersion. */
  put<T extends KubeObject>(obj: T): T {
    const key = objKey(obj.kind, obj.metadata.namespace, obj.metadata.name);
    const prev = this.state.objects[key];
    if (prev && deepEqual({ ...prev, metadata: { ...prev.metadata, resourceVersion: "" } }, { ...obj, metadata: { ...obj.metadata, resourceVersion: "" } })) {
      return prev as unknown as T;
    }
    const next = { ...obj, metadata: { ...obj.metadata, resourceVersion: String(++this.state.rv) } } as T;
    if (!prev) {
      const idx = this.index();
      (idx.get(obj.kind) ?? idx.set(obj.kind, new Set()).get(obj.kind)!).add(key);
    }
    this.state.objects[key] = next as unknown as AnyObject;
    if (obj.kind === "Node" || obj.kind === "PersistentVolumeClaim" || obj.kind === "PersistentVolume") this.schedulerWake = true;
    this.changed = true;
    return next;
  }

  /** Like update(), for status writers: only `status` is copied, so fn must change nothing else. Cheap when nothing changed. */
  updateStatus<T extends KubeObject>(obj: T, fn: (draft: T) => void): T {
    const draft = { ...obj, status: clone(obj.status) } as T;
    fn(draft);
    return this.put(draft);
  }

  /** Clone-modify-put in one call. */
  update<T extends KubeObject>(obj: T, fn: (draft: T) => void): T {
    const draft = clone(obj);
    fn(draft);
    return this.put(draft);
  }

  remove(obj: KubeObject): void {
    const key = objKey(obj.kind, obj.metadata.namespace, obj.metadata.name);
    if (!this.state.objects[key]) return;
    this.index().get(obj.kind)?.delete(key);
    delete this.state.objects[key];
    this.schedulerWake = true;
    if (obj.kind === "Pod") {
      delete this.state.pods[obj.metadata.uid];
      delete this.state.scheduleAttempts[obj.metadata.uid];
      for (const k of Object.keys(this.state.volumes)) if (k.startsWith(`emptydir/${obj.metadata.uid}/`)) delete this.state.volumes[k];
    }
    this.changed = true;
  }

  markChanged(): void {
    this.changed = true;
  }

  // ---------- events ----------

  record(
    obj: KubeObject,
    type: "Normal" | "Warning",
    reason: string,
    message: string,
    component: string,
    host?: string,
    fieldPath?: string,
  ): void {
    const ns = obj.metadata.namespace ?? "default";
    const existing = this.list<KubeEvent>("Event", ns).find(
      (e) => e.involvedObject.uid === obj.metadata.uid && e.reason === reason && e.message === message,
    );
    let ev: KubeEvent;
    if (existing) {
      ev = this.update(existing, (e) => {
        e.count += 1;
        e.lastTimestamp = this.now;
      });
    } else {
      ev = this.put<KubeEvent>({
        apiVersion: "v1",
        kind: "Event",
        metadata: {
          // <object>.<hex UnixNano>, like client-go's recorder: names sort in recording order.
          name: `${obj.metadata.name}.${(BigInt(SIM_EPOCH + this.now) * BigInt(1_000_000) + BigInt(this.state.eventSeq++ % 1_000_000)).toString(16)}`,
          namespace: ns,
          uid: this.uid(),
          resourceVersion: "",
          creationTimestamp: this.now,
        },
        involvedObject: {
          kind: obj.kind,
          name: obj.metadata.name,
          namespace: obj.metadata.namespace,
          uid: obj.metadata.uid,
          apiVersion: obj.apiVersion,
          ...(fieldPath ? { fieldPath } : {}),
        },
        reason,
        message,
        type,
        count: 1,
        firstTimestamp: this.now,
        lastTimestamp: this.now,
        source: { component, ...(host ? { host } : {}) },
        reportingComponent: component,
      });
    }
    this.emit({ type: "event", event: ev });
  }

  eventsFor(obj: KubeObject): KubeEvent[] {
    return this.list<KubeEvent>("Event", obj.metadata.namespace ?? "default")
      .filter((e) => e.involvedObject.uid === obj.metadata.uid)
      // Names end in hex nanoseconds, so same-tick events keep their recording order.
      .sort((a, b) => a.firstTimestamp - b.firstTimestamp || (a.metadata.name < b.metadata.name ? -1 : 1));
  }

  // ---------- API (what kubectl talks to) ----------

  get<T extends KubeObject = AnyObject>(kind: string, namespace: string | undefined, name: string): T {
    const o = this.raw(kind, namespace, name);
    if (!o) throw new ApiError(`Error from server (NotFound): ${resourceName(kind)} "${name}" not found`, "NotFound");
    return o as unknown as T;
  }

  private ensureNamespace(kind: string, ns: string | undefined, name = ""): void {
    if (!NAMESPACED_KINDS.has(kind)) return;
    const n = this.raw("Namespace", undefined, ns ?? "default");
    if (!n) throw new ApiError(`Error from server (NotFound): namespaces "${ns}" not found`, "NotFound");
    if (n.status && (n.status as { phase: string }).phase === "Terminating")
      throw new ApiError(
        `Error from server (Forbidden): ${resourceName(kind)} "${name}" is forbidden: unable to create new content in namespace ${ns} because it is being terminated`,
        "Forbidden",
      );
  }

  create<T extends KubeObject>(input: NewObject<T> | T): T {
    const obj = clone(input) as unknown as AnyObject;
    obj.apiVersion ??= API_VERSIONS[obj.kind];
    obj.metadata = { ...(obj.metadata ?? {}) } as AnyObject["metadata"];
    const meta = obj.metadata as AnyObject["metadata"] & { generateName?: string };
    if (!meta.name && meta.generateName) meta.name = this.genName(meta.generateName);
    if (NAMESPACED_KINDS.has(obj.kind)) meta.namespace ??= "default";
    else delete meta.namespace;
    validate(this, obj, undefined);
    this.ensureNamespace(obj.kind, meta.namespace, meta.name);
    if (this.raw(obj.kind, meta.namespace, meta.name)) {
      throw new ApiError(`Error from server (AlreadyExists): ${resourceName(obj.kind)} "${meta.name}" already exists`, "AlreadyExists");
    }
    meta.uid = this.uid();
    meta.creationTimestamp = this.now;
    delete (meta as { generateName?: string }).generateName;
    admit(this, obj, undefined);
    // ResourceQuota runs last, on the fully defaulted object.
    checkQuota(this, obj);
    const stored = this.put(obj);
    if (obj.kind === "Namespace") ensureNamespaceDefaults(this, meta.name);
    this.flush();
    return stored as unknown as T;
  }

  /** Replaces an existing object's spec/metadata (like PUT). */
  replace<T extends KubeObject>(input: T): T {
    const prev = this.get(input.kind, input.metadata.namespace, input.metadata.name);
    const obj = clone(input) as unknown as AnyObject;
    obj.apiVersion ??= prev.apiVersion;
    obj.metadata = {
      ...obj.metadata,
      namespace: prev.metadata.namespace,
      uid: prev.metadata.uid,
      creationTimestamp: prev.metadata.creationTimestamp,
      generation: prev.metadata.generation,
      ownerReferences: obj.metadata.ownerReferences ?? prev.metadata.ownerReferences,
      deletionTimestamp: prev.metadata.deletionTimestamp,
    };
    if (!NAMESPACED_KINDS.has(obj.kind)) delete obj.metadata.namespace;
    if (prev.status !== undefined || obj.status === undefined) obj.status = prev.status;
    validate(this, obj, prev);
    admit(this, obj, prev);
    if (!deepEqual(obj.spec, prev.spec) && prev.metadata.generation !== undefined) {
      obj.metadata.generation = (prev.metadata.generation ?? 1) + 1;
    }
    const stored = this.put(obj);
    this.flush();
    return stored as unknown as T;
  }

  /** kubectl-apply semantics, simplified: create, or replace spec/labels/annotations. */
  apply<T extends KubeObject>(input: NewObject<T> | T): { obj: T; action: "created" | "configured" | "unchanged" } {
    const ns = NAMESPACED_KINDS.has(input.kind) ? (input.metadata?.namespace ?? "default") : undefined;
    const annotated = clone(input) as unknown as AnyObject;
    const lastApplied = JSON.stringify(input);
    annotated.metadata = {
      ...annotated.metadata,
      annotations: { ...(annotated.metadata?.annotations ?? {}), "kubectl.kubernetes.io/last-applied-configuration": lastApplied + "\n" },
    };
    const prev = this.raw(input.kind, ns, input.metadata?.name ?? "");
    if (!prev) return { obj: this.create(annotated as unknown as T), action: "created" };
    const merged = clone(prev) as AnyObject;
    merged.metadata.labels = annotated.metadata.labels;
    merged.metadata.annotations = { ...annotated.metadata.annotations };
    // Keep annotations that controllers own.
    for (const [k, v] of Object.entries(prev.metadata.annotations ?? {})) {
      if (k.startsWith("deployment.kubernetes.io/")) merged.metadata.annotations![k] = v;
    }
    const spec = clone(annotated.spec ?? {}) as Record<string, unknown>;
    const prevSpec = (prev.spec ?? {}) as Record<string, unknown>;
    // Fields the applied config leaves out keep their live values (e.g. replicas after `kubectl scale`,
    // or a Service's allocated clusterIP).
    const keeps = ["replicas", "clusterIP", "clusterIPs", "nodeName", "volumeName", "storageClassName", ...(input.kind === "Job" ? ["selector"] : [])];
    for (const keep of keeps) {
      if (spec[keep] === undefined && prevSpec[keep] !== undefined) spec[keep] = prevSpec[keep];
    }
    if (input.kind === "Service" && Array.isArray(spec.ports) && Array.isArray(prevSpec.ports)) {
      spec.ports = (spec.ports as { nodePort?: number; port: number }[]).map((p) => ({
        ...p,
        nodePort: p.nodePort ?? (prevSpec.ports as { nodePort?: number; port: number }[]).find((q) => q.port === p.port)?.nodePort,
      }));
    }
    if (annotated.spec !== undefined || prev.spec !== undefined) merged.spec = spec;
    // Kinds without a spec (ConfigMap data, Secret data, Role rules, binding subjects…) take their top-level fields as applied.
    const TOP = ["subsets", "data", "binaryData", "stringData", "type", "immutable", "rules", "roleRef", "subjects", "provisioner", "reclaimPolicy", "volumeBindingMode", "allowVolumeExpansion", "parameters", "secrets", "automountServiceAccountToken", "aggregationRule", "value", "globalDefault", "description", "preemptionPolicy"];
    for (const k of TOP) {
      if (k in annotated) (merged as Record<string, unknown>)[k] = (annotated as Record<string, unknown>)[k];
      else if (k in merged && k !== "type" && k !== "secrets") delete (merged as Record<string, unknown>)[k];
    }
    // Compare after defaulting so an identical re-apply reports "unchanged".
    const probe = clone(merged);
    admit(this, probe, prev);
    const same = (k: string) => deepEqual((probe as Record<string, unknown>)[k], (prev as Record<string, unknown>)[k]);
    if (same("spec") && TOP.every(same) && deepEqual(probe.metadata.labels, prev.metadata.labels) && deepEqual(probe.metadata.annotations, prev.metadata.annotations)) {
      return { obj: prev as unknown as T, action: "unchanged" };
    }
    return { obj: this.replace(merged) as unknown as T, action: "configured" };
  }

  delete(kind: string, namespace: string | undefined, name: string, opts: DeleteOptions = {}): AnyObject {
    const obj = this.get(kind, namespace, name);
    this.deleteObject(obj, opts);
    this.flush();
    return obj;
  }

  deleteObject(obj: KubeObject, opts: DeleteOptions = {}): void {
    if (opts.propagationPolicy === "Orphan") {
      const uid = obj.metadata.uid;
      for (const o of Object.values(this.state.objects)) {
        if (!o.metadata.ownerReferences?.some((r) => r.uid === uid)) continue;
        this.update(o, (d) => {
          d.metadata.ownerReferences = d.metadata.ownerReferences!.filter((r) => r.uid !== uid);
          if (d.metadata.ownerReferences.length === 0) delete d.metadata.ownerReferences;
        });
      }
    }
    if (obj.kind === "Pod") {
      const pod = obj as Pod;
      if (opts.force || opts.gracePeriodSeconds === 0 || !pod.spec?.nodeName) {
        this.remove(pod);
        return;
      }
      if (pod.metadata.deletionTimestamp !== undefined) return;
      const grace = opts.gracePeriodSeconds ?? pod.spec?.terminationGracePeriodSeconds ?? 30;
      this.update(pod, (p) => {
        p.metadata.deletionTimestamp = this.now + grace * 1000;
        p.metadata.deletionGracePeriodSeconds = grace;
      });
      return;
    }
    if (obj.kind === "Namespace") {
      if (["default", "kube-system", "kube-public", "kube-node-lease"].includes(obj.metadata.name)) {
        throw new ApiError(`Error from server (Forbidden): namespaces "${obj.metadata.name}" is forbidden: this namespace may not be deleted`, "Forbidden");
      }
      this.update(obj, (n) => {
        n.metadata.deletionTimestamp = this.now;
        (n.status as { phase: string }) = { phase: "Terminating" };
      });
      return;
    }
    if (obj.kind === "Node") {
      for (const p of this.list<Pod>("Pod")) if (p.spec?.nodeName === obj.metadata.name) this.remove(p);
      delete this.state.nodes[obj.metadata.name];
    }
    // Finalizers (pvc-protection, pv-protection…): mark for deletion; the owning controller finishes it.
    if (obj.metadata.finalizers?.length) {
      if (obj.metadata.deletionTimestamp === undefined) this.update(obj, (o) => void (o.metadata.deletionTimestamp = this.now));
      return;
    }
    this.remove(obj);
  }

  // ---------- Pod logs ----------

  log(podUid: string, container: string, restart: number, t: number, text: string): void {
    const key = `${podUid}/${container}/${restart}`;
    const lines = (this.state.logs[key] ??= []);
    lines.push({ t, text });
    // Container runtimes rotate logs; keep the tail so busy Pods don't grow without bound.
    if (lines.length > 1200) lines.splice(0, lines.length - 1000);
  }

  logsFor(pod: Pod, container: string, previous = false): LogLine[] | undefined {
    const status = pod.status?.containerStatuses?.find((s) => s.name === container);
    const restart = (status?.restartCount ?? 0) - (previous ? 1 : 0);
    if (restart < 0) return undefined;
    return this.state.logs[`${pod.metadata.uid}/${container}/${restart}`] ?? [];
  }

  // ---------- helpers for controllers ----------

  nodeReady(node: Node): boolean {
    return node.status?.conditions.find((c) => c.type === "Ready")?.status === "True";
  }

  snapshot(): ClusterState {
    this.state.rng = this.rng.state;
    return clone(this.state);
  }
}

export function isPodTerminal(p: Pod): boolean {
  return p.status?.phase === "Succeeded" || p.status?.phase === "Failed";
}

export function isPodReady(p: Pod): boolean {
  return p.status?.conditions?.find((c) => c.type === "Ready")?.status === "True";
}

export function controllerOf(o: KubeObject): { kind: string; name: string; uid: string } | undefined {
  return o.metadata.ownerReferences?.find((r) => r.controller);
}
